/**
 * Run-to-run diff: "did the new version of the prompt change what the agent
 * did?"
 *
 * This is the eval half of the package. Two runs of the same scenario are
 * compared structurally, and the answer has to survive the fact that **tool call
 * ids are not stable across runs**. A model asked the same question twice will
 * call `search` with the same arguments and get a different `toolCallId`, because
 * the id comes from the provider's request. Matching on ids alone would report
 * every call as added and removed, which is noise so uniform it hides the one
 * call that genuinely changed.
 *
 * So calls are matched in two passes:
 *
 *  1. by `toolCallId`, when both runs reused the id;
 *  2. by `name` + `argsHash`, for whatever is left over.
 *
 * A greedy second pass can in principle pair two identical calls
 * (`search("x")` called three times) in either order. That is why every match
 * records *how* it was made: `match: 'id'` and `match: 'signature'` mean
 * different confidence, and a caller that only trusts ids can filter on it.
 *
 * Surfaces are compared with `surfaceSignature` from the protocol package, which
 * hashes component-and-depth structure with ids deliberately excluded. That is
 * the right granularity: a run that renamed a node id is unchanged, and a run
 * that swapped a `List` for a `Table` is not, even when both render "the same".
 */

import { surfaceSignature } from '@agent-surface/protocol';
import type { SurfaceFrame, SurfaceNode, Usage } from '@agent-surface/protocol';

import { assembleRun, type RunTrace } from './run.js';
import { collectTools, stableStringify, type ToolCallNode } from './tree.js';

export type MatchKind = 'id' | 'signature';

export interface ToolMatch {
  kind: MatchKind;
  baseline?: ToolCallNode;
  candidate?: ToolCallNode;
  /** What differs about a matched pair. Empty for an unchanged call. */
  changes: ToolChange[];
}

export type ToolChangeKind = 'status' | 'args' | 'result' | 'duration' | 'name' | 'nesting';

export interface ToolChange {
  kind: ToolChangeKind;
  baseline?: string;
  candidate?: string;
  /** `+40` or `-15`; only for `duration`. */
  deltaMs?: number;
}

export interface SurfaceDiff {
  surfaceId: string;
  change: 'added' | 'removed' | 'changed' | 'same';
  signatureBaseline?: string;
  signatureCandidate?: string;
  nodeCountBaseline?: number;
  nodeCountCandidate?: number;
  /** `data` differs beyond the node structure. */
  dataChanged?: boolean;
}

export interface MessageDiff {
  messageId?: string;
  change: 'added' | 'removed' | 'changed';
  textBaseline?: string;
  textCandidate?: string;
}

export interface MetricDelta {
  baseline: number;
  candidate: number;
  delta: number;
  /** `delta / baseline`, or undefined when the baseline was zero. */
  ratio?: number;
}

export interface RunDiff {
  baselineRunId: string;
  candidateRunId: string;
  /** True when both traces describe the same scenario; set by `sameScenario`. */
  comparable: boolean;
  tools: {
    added: ToolMatch[];
    removed: ToolMatch[];
    changed: ToolMatch[];
    unchanged: number;
    matchedById: number;
    matchedBySignature: number;
  };
  surfaces: readonly SurfaceDiff[];
  messages: {
    added: readonly MessageDiff[];
    removed: readonly MessageDiff[];
    changed: readonly MessageDiff[];
  };
  subagents: MetricDelta;
  totals: {
    wallClockMs: MetricDelta;
    costUsd: MetricDelta;
    inputTokens: MetricDelta;
    outputTokens: MetricDelta;
    toolCalls: MetricDelta;
    warnings: MetricDelta;
    errors: MetricDelta;
  };
  outcome: { baseline: string; candidate: string; changed: boolean };
}

export function diffRuns(baseline: RunTrace, candidate: RunTrace): RunDiff {
  const pairs = pairTools(collectTools(baseline.tree), collectTools(candidate.tree));
  const added = pairs.filter((pair) => pair.baseline === undefined);
  const removed = pairs.filter((pair) => pair.candidate === undefined);
  const matched = pairs.filter((pair) => pair.baseline !== undefined && pair.candidate !== undefined);
  const changed = matched.filter((pair) => pair.changes.length > 0);

  return {
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    comparable: sameScenario(baseline, candidate),
    tools: {
      added,
      removed,
      changed,
      unchanged: matched.length - changed.length,
      matchedById: matched.filter((pair) => pair.kind === 'id').length,
      matchedBySignature: matched.filter((pair) => pair.kind === 'signature').length,
    },
    surfaces: diffSurfaces(baseline, candidate),
    messages: diffMessages(baseline, candidate),
    subagents: delta(baseline.totals.subagents.total, candidate.totals.subagents.total),
    totals: {
      wallClockMs: delta(baseline.totals.wallClockMs, candidate.totals.wallClockMs),
      costUsd: delta(baseline.totals.costUsd ?? 0, candidate.totals.costUsd ?? 0),
      inputTokens: delta(baseline.totals.usage.inputTokens, candidate.totals.usage.inputTokens),
      outputTokens: delta(baseline.totals.usage.outputTokens, candidate.totals.usage.outputTokens),
      toolCalls: delta(baseline.totals.tools.total, candidate.totals.tools.total),
      warnings: delta(baseline.totals.warnings, candidate.totals.warnings),
      errors: delta(baseline.totals.errors, candidate.totals.errors),
    },
    outcome: {
      baseline: baseline.tree.status,
      candidate: candidate.tree.status,
      changed: baseline.tree.status !== candidate.tree.status,
    },
  };
}

/**
 * Two runs are comparable when they are the same protocol on the same thread.
 *
 * Refused across protocols on purpose: an AG-UI run and an A2UI run of "the same
 * scenario" have no shared frame vocabulary, so every surface and tool count
 * would read as a change when nothing changed. The comparison is still returned
 * -- a caller may want it -- but `comparable: false` says not to trust it.
 */
export function sameScenario(baseline: RunTrace, candidate: RunTrace): boolean {
  return baseline.protocol === candidate.protocol && baseline.threadId === candidate.threadId;
}

// ---------------------------------------------------------------------------
// Tool pairing
// ---------------------------------------------------------------------------

function pairTools(baseline: readonly ToolCallNode[], candidate: readonly ToolCallNode[]): ToolMatch[] {
  const pairs: ToolMatch[] = [];
  const usedCandidates = new Set<number>();

  // Pass 1: ids. A reused id is a stronger signal than matching arguments.
  const baselineById = new Map<string, ToolCallNode>();
  for (const tool of baseline) baselineById.set(tool.toolCallId, tool);
  const claimedBaselines = new Set<ToolCallNode>();
  for (const [index, tool] of candidate.entries()) {
    const match = baselineById.get(tool.toolCallId);
    if (!match || claimedBaselines.has(match)) continue;
    claimedBaselines.add(match);
    usedCandidates.add(index);
    pairs.push({ kind: 'id', baseline: match, candidate: tool, changes: changesBetween(match, tool) });
  }

  // Pass 2: name + argument hash for everything unmatched. First candidate wins,
  // which is the order the agent made the calls in.
  const bySignature = new Map<string, ToolCallNode[]>();
  for (const tool of baseline) {
    if (claimedBaselines.has(tool)) continue;
    const key = signatureOf(tool);
    const bucket = bySignature.get(key);
    if (bucket) bucket.push(tool);
    else bySignature.set(key, [tool]);
  }
  for (const [index, tool] of candidate.entries()) {
    if (usedCandidates.has(index)) continue;
    const bucket = bySignature.get(signatureOf(tool));
    const match = bucket?.shift();
    if (!match) continue;
    usedCandidates.add(index);
    claimedBaselines.add(match);
    pairs.push({ kind: 'signature', baseline: match, candidate: tool, changes: changesBetween(match, tool) });
  }

  // Whatever is left is a genuine addition or removal.
  for (const tool of baseline) {
    if (!claimedBaselines.has(tool)) pairs.push({ kind: 'signature', baseline: tool, changes: [] });
  }
  for (const [index, tool] of candidate.entries()) {
    if (!usedCandidates.has(index)) pairs.push({ kind: 'signature', candidate: tool, changes: [] });
  }
  return pairs;
}

/**
 * Structural signature of a surface's final node list.
 *
 * Delegated to the protocol package's `surfaceSignature` rather than
 * reimplemented: the tracer's diff and the eval harness's structural scoring
 * have to agree on what "the same surface" means, or a surface that passes the
 * gate can still look changed here.
 */
function signatureOfNodes(nodes: readonly SurfaceNode[]): string {
  return surfaceSignature(nodes);
}

function signatureOf(tool: ToolCallNode): string {
  return `${tool.name}\u0000${tool.argsHash}`;
}

function changesBetween(baseline: ToolCallNode, candidate: ToolCallNode): ToolChange[] {
  const changes: ToolChange[] = [];
  if (baseline.status !== candidate.status) {
    changes.push({ kind: 'status', baseline: baseline.status, candidate: candidate.status });
  }
  if (baseline.name !== candidate.name) {
    changes.push({ kind: 'name', baseline: baseline.name, candidate: candidate.name });
  }
  const baselineArgs = stableStringify(baseline.args);
  const candidateArgs = stableStringify(candidate.args);
  if (baselineArgs !== candidateArgs) {
    changes.push({ kind: 'args', baseline: baselineArgs, candidate: candidateArgs });
  }
  const baselineResult = baseline.result ?? '';
  const candidateResult = candidate.result ?? '';
  if (baselineResult !== candidateResult) {
    changes.push({ kind: 'result', baseline: truncateForDiff(baselineResult), candidate: truncateForDiff(candidateResult) });
  }
  const baselineDuration = baseline.durationMs;
  const candidateDuration = candidate.durationMs;
  if (baselineDuration !== candidateDuration) {
    changes.push({
      kind: 'duration',
      ...(baselineDuration !== undefined ? { baseline: String(baselineDuration) } : {}),
      ...(candidateDuration !== undefined ? { candidate: String(candidateDuration) } : {}),
      deltaMs: (candidateDuration ?? 0) - (baselineDuration ?? 0),
    });
  }
  const baselineParent = parentPath(baseline);
  const candidateParent = parentPath(candidate);
  if (baselineParent !== candidateParent) {
    changes.push({ kind: 'nesting', baseline: baselineParent, candidate: candidateParent });
  }
  return changes;
}

/**
 * Where a call sits in the tree, as a readable path.
 *
 * Nesting is a behaviour change like any other: a prompt tweak that moves a tool
 * call from inside a sub-agent to the root changed the agent's strategy even
 * though the call itself is byte-identical.
 */
function parentPath(tool: ToolCallNode): string {
  return tool.subagentRunId ?? tool.parentMessageId ?? '(root)';
}

function truncateForDiff(value: string): string {
  return value.length > 512 ? `${value.slice(0, 512)}…[${String(value.length - 512)} more]` : value;
}

// ---------------------------------------------------------------------------
// Surfaces and messages
// ---------------------------------------------------------------------------

/**
 * Structural comparison of every surface in both runs.
 *
 * Exported on its own because surface regression is worth watching on its own:
 * a prompt change that adds a tool call is interesting, one that makes the agent
 * render a structurally different surface is usually a layout bug.
 */
export function diffSurfaces(baseline: RunTrace, candidate: RunTrace): SurfaceDiff[] {
  const out: SurfaceDiff[] = [];
  const candidateById = new Map(candidate.state.surfaces.map((surface) => [surface.id, surface]));

  for (const baseSurface of baseline.state.surfaces) {
    const against = candidateById.get(baseSurface.id);
    if (!against) {
      out.push({
        surfaceId: baseSurface.id,
        change: 'removed',
        signatureBaseline: signatureOfNodes(surfaceNodes(baseline, baseSurface.id)),
        nodeCountBaseline: baseSurface.nodes.length,
      });
      continue;
    }
    const baselineSignature = signatureOfNodes(surfaceNodes(baseline, baseSurface.id));
    const candidateSignature = signatureOfNodes(surfaceNodes(candidate, baseSurface.id));
    const dataChanged = stableStringify(baseSurface.data) !== stableStringify(against.data);
    const structural = baselineSignature !== candidateSignature;
    out.push({
      surfaceId: baseSurface.id,
      change: structural || dataChanged ? 'changed' : 'same',
      signatureBaseline: baselineSignature,
      signatureCandidate: candidateSignature,
      nodeCountBaseline: baseSurface.nodes.length,
      nodeCountCandidate: against.nodes.length,
      ...(dataChanged ? { dataChanged: true } : {}),
    });
  }

  for (const against of candidate.state.surfaces) {
    if (baseline.state.surfaces.some((surface) => surface.id === against.id)) continue;
    out.push({
      surfaceId: against.id,
      change: 'added',
      signatureCandidate: signatureOfNodes(surfaceNodes(candidate, against.id)),
      nodeCountCandidate: against.nodes.length,
    });
  }
  return out;
}

/** The node list a surface ended with, as the reducer accumulated it. */
function surfaceNodes(run: RunTrace, surfaceId: string): readonly SurfaceNode[] {
  const surface = run.state.surfaces.find((candidate) => candidate.id === surfaceId);
  return surface?.nodes ?? [];
}

function diffMessages(baseline: RunTrace, candidate: RunTrace): RunDiff['messages'] {
  const candidateById = new Map(candidate.state.messages.map((message) => [message.messageId, message]));
  const added: MessageDiff[] = [];
  const removed: MessageDiff[] = [];
  const changed: MessageDiff[] = [];
  const seen = new Set<string>();

  for (const baseMessage of baseline.state.messages) {
    const against = candidateById.get(baseMessage.messageId);
    if (!against) {
      removed.push({ messageId: baseMessage.messageId, change: 'removed', textBaseline: truncateForDiff(baseMessage.text) });
      continue;
    }
    seen.add(baseMessage.messageId);
    if (baseMessage.text !== against.text) {
      changed.push({
        messageId: baseMessage.messageId,
        change: 'changed',
        textBaseline: truncateForDiff(baseMessage.text),
        textCandidate: truncateForDiff(against.text),
      });
    }
  }
  for (const against of candidate.state.messages) {
    if (seen.has(against.messageId)) continue;
    if (baseline.state.messages.some((message) => message.messageId === against.messageId)) continue;
    added.push({ messageId: against.messageId, change: 'added', textCandidate: truncateForDiff(against.text) });
  }
  return { added, removed, changed };
}

function delta(baseline: number, candidate: number): MetricDelta {
  const difference = candidate - baseline;
  return {
    baseline,
    candidate,
    delta: difference,
    ...(baseline !== 0 ? { ratio: difference / baseline } : {}),
  };
}

/** Totals for a list of traces; for a batch eval page or a nightly summary. */
export function summarizeDiffs(diffs: readonly RunDiff[]): {
  runs: number;
  regressed: number;
  improved: number;
  costDelta: number;
  latencyDelta: number;
  newToolCalls: number;
  removedToolCalls: number;
} {
  let regressed = 0;
  let improved = 0;
  let costDelta = 0;
  let latencyDelta = 0;
  let newToolCalls = 0;
  let removedToolCalls = 0;
  for (const diff of diffs) {
    if (diff.totals.errors.delta > 0 || diff.tools.added.length > diff.tools.removed.length) regressed += 1;
    else if (diff.totals.errors.delta < 0 || diff.tools.removed.length > diff.tools.added.length) improved += 1;
    costDelta += diff.totals.costUsd.delta;
    latencyDelta += diff.totals.wallClockMs.delta;
    newToolCalls += diff.tools.added.length;
    removedToolCalls += diff.tools.removed.length;
  }
  return { runs: diffs.length, regressed, improved, costDelta, latencyDelta, newToolCalls, removedToolCalls };
}

/** Cost/usage comparison without a full run pair, for a totals-only report. */
export function diffUsage(baseline: Usage, candidate: Usage): {
  inputTokens: MetricDelta;
  outputTokens: MetricDelta;
  costUsd: MetricDelta;
} {
  return {
    inputTokens: delta(baseline.inputTokens, candidate.inputTokens),
    outputTokens: delta(baseline.outputTokens, candidate.outputTokens),
    costUsd: delta(baseline.costUsd ?? 0, candidate.costUsd ?? 0),
  };
}

/** Convenience for a caller that only has frames, not assembled traces. */
export function diffFrameTranscripts(
  baseline: readonly SurfaceFrame[],
  candidate: readonly SurfaceFrame[],
): RunDiff {
  return diffRuns(assembleRun(baseline), assembleRun(candidate));
}
