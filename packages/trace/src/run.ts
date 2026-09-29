/**
 * The assembled view of one run.
 *
 * `RunTrace` is what gets stored, diffed and exported. It is deliberately *not*
 * the source of truth -- `frames` is, and `state`/`tree`/`totals` are derived
 * from it every time the trace is built. That is what lets `FileTraceStore`
 * persist frames and re-derive the rest on read, which in turn means a stored
 * trace can never disagree with a live view of the same transcript: both come
 * out of the same reducer and the same tree builder.
 *
 * Totals are computed here rather than accumulated inside `Tracer` for the same
 * reason. A partial total during a live run is still correct; a total that was
 * wrong because a frame was missed is not recoverable.
 */

import type { ProtocolId, SurfaceFrame, Usage } from '@agent-surface/protocol';

import { reduce, type RunOutcome, type RunState, type ToolRecord, type TracerWarning } from './reducer.js';
import { buildTree, collectTools, type RunNode, type ToolCallNode } from './tree.js';

/**
 * Bumped when the persisted shape changes incompatibly.
 *
 * A store reads this before trusting a file: re-deriving a trace written by an
 * older reducer would produce a plausible-looking object with the wrong shape,
 * which is worse than a loud failure.
 */
export const RUN_TRACE_VERSION = 'agent-surface.trace/1' as const;

export interface RunTraceMeta {
  runId: string;
  threadId: string;
  protocol: ProtocolId;
  agentName?: string;
  startedAt: number;
  endedAt?: number;
  finalized: boolean;
}

export interface RunTotals {
  /** Wall clock from the first to the last frame's `ts`. */
  wallClockMs: number;
  frameCount: number;
  messages: number;
  outputChars: number;
  usage: Usage;
  costUsd?: number;
  tools: {
    total: number;
    ok: number;
    error: number;
    pending: number;
    orphan: number;
    totalDurationMs: number;
    slowest?: { toolCallId: string; name: string; durationMs: number };
  };
  subagents: {
    total: number;
    ok: number;
    error: number;
    open: number;
    orphan: number;
    totalDurationMs: number;
  };
  surfaces: { created: number; live: number; deleted: number; writes: number };
  warnings: number;
  /** Warnings this tracer invented, as opposed to the ones the agent sent. */
  tracerWarnings: number;
  errors: number;
  fatalErrors: number;
  interrupts: number;
  actions: number;
  apps: number;
}

export interface RunTrace {
  readonly version: typeof RUN_TRACE_VERSION;
  readonly runId: string;
  readonly threadId: string;
  readonly protocol: ProtocolId;
  readonly agentName?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly finalized: boolean;
  readonly frames: readonly SurfaceFrame[];
  readonly state: RunState;
  readonly tree: RunNode;
  readonly totals: RunTotals;
  /** True when any usage report or error-detail usage contributed. */
  usageReported: boolean;
}

export interface AssembleOptions extends Partial<RunTraceMeta> {
  /** Whether the transcript is finished; drives `pending` vs `orphan`. */
  closed?: boolean;
}

/**
 * Build a trace from a transcript.
 *
 * Every path that needs a `RunTrace` goes through here -- `Tracer.getRun`,
 * `FileTraceStore.get`, `diffRuns` -- so "the assembled view" has one definition.
 */
export function assembleRun(frames: readonly SurfaceFrame[], options: AssembleOptions = {}): RunTrace {
  const state = reduce(frames);
  const tree = buildTree(frames, { closed: options.closed ?? options.finalized ?? true });
  const totals = computeTotals(frames, state);
  const startedAt = options.startedAt ?? state.firstTs ?? frames[0]?.ts ?? 0;
  const endedAt = options.endedAt ?? (state.finished ? state.lastTs : undefined);
  return {
    version: RUN_TRACE_VERSION,
    runId: options.runId ?? state.runId,
    threadId: options.threadId ?? state.threadId,
    protocol: options.protocol ?? state.protocol,
    ...(resolveAgentName(options.agentName, state) !== undefined
      ? { agentName: resolveAgentName(options.agentName, state)! }
      : {}),
    startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    finalized: options.finalized ?? state.finished,
    frames: frames.slice(),
    state,
    tree,
    totals,
    usageReported: state.usageReports > 0,
  };
}

function resolveAgentName(explicit: string | undefined, state: RunState): string | undefined {
  if (explicit !== undefined && explicit !== '') return explicit;
  if (state.agentName !== undefined && state.agentName !== '') return state.agentName;
  return undefined;
}

/**
 * Totals come from `RunState`, not from the tree.
 *
 * Both describe the same calls; the state is the accumulator the reducer
 * maintains frame by frame, so summing it cannot miss a call the structural
 * walk skipped. Cross-checking the two would be a nice invariant test, but not
 * a better source of truth.
 */
export function computeTotals(frames: readonly SurfaceFrame[], state: RunState): RunTotals {
  const tools = state.tools;
  const resolved = tools.filter((tool) => tool.status === 'ok' || tool.status === 'error');
  const durations = resolved.map((tool) => tool.durationMs ?? 0);
  const slowest = pickSlowest(tools);
  const subagentStatuses = state.subagents.map((subagent) => subagent.status);
  const outputChars = state.messages.reduce((total, message) => total + message.text.length, 0);
  const wallClockMs =
    state.firstTs !== undefined && state.lastTs !== undefined
      ? Math.max(0, state.lastTs - state.firstTs)
      : 0;

  const totals: RunTotals = {
    wallClockMs,
    frameCount: frames.length,
    messages: state.messages.length,
    outputChars,
    usage: state.usage,
    tools: {
      total: tools.length,
      ok: tools.filter((tool) => tool.status === 'ok').length,
      error: tools.filter((tool) => tool.status === 'error').length,
      pending: tools.filter((tool) => tool.status === 'open').length,
      orphan: tools.filter((tool) => tool.status === 'orphan').length,
      totalDurationMs: durations.reduce((total, duration) => total + duration, 0),
      ...(slowest !== undefined ? { slowest } : {}),
    },
    subagents: {
      total: state.subagents.length,
      ok: subagentStatuses.filter((status) => status === 'ok').length,
      error: subagentStatuses.filter((status) => status === 'error').length,
      open: subagentStatuses.filter((status) => status === 'open').length,
      orphan: subagentStatuses.filter((status) => status === 'orphan').length,
      totalDurationMs: state.subagents.reduce((total, subagent) => total + (subagent.durationMs ?? 0), 0),
    },
    surfaces: {
      created: state.surfaces.length,
      live: state.surfaces.filter((surface) => !surface.deleted).length,
      deleted: state.surfaces.filter((surface) => surface.deleted).length,
      writes: state.surfaces.reduce((total, surface) => total + surface.writeCount, 0),
    },
    warnings: state.warnings.length,
    tracerWarnings: countTracerWarnings(state.warnings),
    errors: state.errors.length,
    fatalErrors: state.errors.filter((error) => error.fatal).length,
    interrupts: state.interrupts.length,
    actions: state.actions.length,
    apps: state.apps.length,
  };
  if (typeof state.usage.costUsd === 'number') totals.costUsd = state.usage.costUsd;
  return totals;
}

function pickSlowest(tools: readonly ToolRecord[]): { toolCallId: string; name: string; durationMs: number } | undefined {
  let best: { toolCallId: string; name: string; durationMs: number } | undefined;
  for (const tool of tools) {
    const duration = tool.durationMs;
    if (duration === undefined) continue;
    if (best !== undefined && duration <= best.durationMs) continue;
    best = { toolCallId: tool.toolCallId, name: tool.name, durationMs: duration };
  }
  return best;
}

function countTracerWarnings(warnings: readonly TracerWarning[]): number {
  return warnings.filter((warning) => warning.origin === 'tracer').length;
}

/** Run outcome as a word, for a status chip. Defaults to `running`. */
export function outcomeOf(state: RunState): RunOutcome | 'running' {
  if (!state.finished) return 'running';
  return state.outcome ?? 'success';
}

/** Tool calls the tree considers unresolved; used by the tracer's health check. */
export function unresolvedTools(run: RunTrace): readonly ToolCallNode[] {
  return collectTools(run.tree).filter((tool) => tool.status === 'pending' || tool.status === 'orphan');
}
