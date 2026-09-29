/**
 * The canonical frame -> state reducer.
 *
 * Two consumers depend on this file agreeing with itself: the live view (via
 * `Tracer`) and time-travel replay (via `createReplay`). If they each had their
 * own folding logic, a scrubber UI would show one thing while the screen showed
 * another and no test could prove which was right. So this is the only place a
 * frame is interpreted, and `replay.seek(n)` is defined as exactly
 * `reduce(frames.slice(0, n + 1))`.
 *
 * ## Totality is a hard requirement
 *
 * `ir.ts` states that a hostile or buggy agent is a normal operating condition
 * and that adapters emit a `warning` rather than throwing. The tracer inherits
 * that contract and adds a stronger one: *this reducer is total*. Any frame, in
 * any order, produces a new state and never an exception -- not even a frame
 * whose payload is the wrong shape, because a trace that is one bad payload away
 * from crashing is a trace that stops recording exactly when it is needed.
 *
 * Where a frame cannot be applied faithfully (a `tool.result` with no
 * `tool.started`), the outcome is a `TracerWarning` with `origin: 'tracer'`
 * plus whatever salvage is possible. Nothing is dropped: the adapters made the
 * same promise ("a transcript that omits what the agent sent is worse than a
 * noisy one"), and a missing tool call is exactly the thing a human opens a
 * trace to find.
 *
 * ## Immutability
 *
 * Every path returns a new `RunState`. Replay rewinds by folding from the start
 * of the transcript, and a reducer that mutated its input would make `seek(3)`
 * depend on what `seek(5)` did first.
 */

import type {
  DataModel,
  FrameKind,
  JsonObject,
  JsonPointer,
  JsonValue,
  ProtocolId,
  SurfaceFrame,
  SurfaceNode,
  Usage,
} from '@agent-surface/protocol';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

/**
 * A surface as the tracer knows it.
 *
 * `pseudo` marks AG-UI's reserved state document surface: the adapter writes
 * `surface.data` against `__agui_state__` without ever sending a
 * `surface.created` for it, because the agent's state is not tied to anything
 * rendered. Treating that as a missing-surface fault would put a warning in
 * front of every AG-UI state snapshot, which trains operators to ignore
 * warnings. The constant is duplicated from
 * `@agent-surface/adapter-ag-ui`'s `AGUI_STATE_SURFACE_ID` rather than imported,
 * because a tracer that depends on one adapter cannot describe the other two.
 */
export const AGUI_STATE_SURFACE_ID = '__agui_state__';

export interface SurfaceRecord {
  id: string;
  catalogId: string;
  title?: string;
  data: DataModel;
  nodes: readonly SurfaceNode[];
  sendDataModel?: boolean;
  /** True for a surface implied by a frame rather than announced by one. */
  pseudo?: boolean;
  createdAt: number;
  updatedAt: number;
  createdSeq: number;
  lastSeq: number;
  deleted: boolean;
  deletedAt?: number;
  /** Frame kinds that touched this surface, for a per-surface activity strip. */
  writeCount: number;
}

export interface MessageBuffer {
  messageId: string;
  text: string;
  startedAt: number;
  lastSeq: number;
  deltaCount: number;
  step?: number;
  subagentRunId?: string;
}

export interface AssembledMessage {
  messageId: string;
  text: string;
  startedAt?: number;
  endedAt: number;
  deltaCount: number;
  step?: number;
  subagentRunId?: string;
  /**
   * True when `text.done` arrived with no `text.delta` behind it. A host that
   * attached mid-stream legitimately sees this, so it is reported rather than
   * treated as a fault.
   */
  synthesized: boolean;
}

/**
 * Everything known about one tool call, open or closed.
 *
 * `RunState.tools` is the complete list rather than only the open calls so that
 * a result which arrived before its start is still inspectable; `openTools()`
 * selects the subset that has no result yet.
 */
export interface ToolRecord {
  toolCallId: string;
  name: string;
  args: JsonObject;
  /** Raw streamed argument text, kept because a parse failure needs the input. */
  argsText: string;
  parseError?: string;
  parentMessageId?: string;
  subagentRunId?: string;
  step?: number;
  /** Absent when a result arrived before any start. */
  startedAt?: number;
  argsDoneAt?: number;
  result?: string;
  isError?: boolean;
  endedAt?: number;
  /** Taken from the frame when the adapter measured it, derived otherwise. */
  durationMs?: number;
  /**
   * - `open`   started, no result seen yet
   * - `ok`     resolved, not flagged as an error
   * - `error`  resolved and flagged `isError`
   * - `orphan` a result exists but no start was ever seen
   */
  status: 'open' | 'ok' | 'error' | 'orphan';
  firstSeq: number;
  lastSeq: number;
}

/**
 * One sub-agent invocation, keyed by `subagentRunId`.
 *
 * Membership (which tool calls and messages belong to it) is deliberately *not*
 * stored here: a sub-agent's frames can interleave with its children's in any
 * order, so a snapshot taken at a `subagent` frame would be stale by the next
 * one. `subagentToolCalls` and `subagentMessages` derive it from the frames
 * instead, which is the only ordering-independent answer.
 */
export interface SubAgentRecord {
  subagentRunId: string;
  name: string;
  phase: 'started' | 'finished' | 'error';
  detail?: string;
  /** Innermost sub-agent open when this one started; see `tree.ts`. */
  parentSubagentRunId?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  status: 'open' | 'ok' | 'error' | 'orphan';
  firstSeq: number;
  lastSeq: number;
}

export interface AppRecord {
  id: string;
  title: string;
  sandbox: string;
  bridgeVersion?: string;
  transport?: string;
  attachedAt: number;
  subagentRunId?: string;
}

export interface ActionRecord {
  surfaceId: string;
  componentId: string;
  name: string;
  context: JsonObject;
  seq: number;
  ts: number;
  subagentRunId?: string;
}

export interface InterruptRecord {
  reason: string;
  resumeToken?: string;
  resumable: boolean;
  seq: number;
  ts: number;
  subagentRunId?: string;
}

/**
 * A warning, whether the agent's adapter emitted it or the tracer invented it.
 *
 * `origin` is the field an on-call engineer needs first: "the agent sent this"
 * and "our tracer could not place this" call for completely different
 * responses, and a transcript that does not distinguish them is a transcript
 * that gets blamed on the wrong side.
 */
export interface TracerWarning {
  seq: number;
  ts: number;
  code: string;
  message: string;
  frameKind: FrameKind;
  origin: 'adapter' | 'tracer';
  detail?: JsonObject;
}

export interface TracerError {
  seq: number;
  ts: number;
  code: string;
  message: string;
  fatal: boolean;
  detail?: JsonObject;
}

export type RunOutcome = 'success' | 'cancelled' | 'interrupt';

export interface RunState {
  runId: string;
  threadId: string;
  protocol: ProtocolId;
  agentName?: string;
  capabilities?: JsonObject;
  /** Highest `seq` applied; `-1` before anything has been applied. */
  lastSeq: number;
  frameCount: number;
  /** Number of `run.started` frames seen after the first one. */
  restarts: number;
  started: boolean;
  finished: boolean;
  outcome?: RunOutcome;
  firstTs?: number;
  lastTs?: number;
  surfaces: readonly SurfaceRecord[];
  apps: readonly AppRecord[];
  tools: readonly ToolRecord[];
  buffers: readonly MessageBuffer[];
  messages: readonly AssembledMessage[];
  subagents: readonly SubAgentRecord[];
  actions: readonly ActionRecord[];
  interrupts: readonly InterruptRecord[];
  usage: Usage;
  /** How many frames contributed usage, for spotting double-reported totals. */
  usageReports: number;
  warnings: readonly TracerWarning[];
  errors: readonly TracerError[];
  /** Every usage-bearing payload, kept so a cost re-derivation can audit them. */
  usageLedger: readonly UsageReport[];
}

export interface UsageReport {
  seq: number;
  ts: number;
  /** Where the numbers came from; the two paths are not equally trustworthy. */
  source: 'run.finished' | 'error.detail';
  usage: Usage;
}

// ---------------------------------------------------------------------------
// Tracer warning codes
// ---------------------------------------------------------------------------

/** Prefix on every code the tracer invents, so it is filterable against agent codes. */
export const TRACER_WARNING_PREFIX = 'TRACER_';

export const TRACER_CODES = {
  seqOutOfOrder: 'TRACER_SEQ_OUT_OF_ORDER',
  frameAfterFinish: 'TRACER_FRAME_AFTER_RUN_FINISHED',
  runRestarted: 'TRACER_RUN_RESTARTED',
  frameThrew: 'TRACER_FRAME_THREW',
  toolResultWithoutStart: 'TRACER_TOOL_RESULT_WITHOUT_START',
  toolArgsWithoutStart: 'TRACER_TOOL_ARGS_WITHOUT_START',
  toolStartDuplicate: 'TRACER_TOOL_START_DUPLICATE',
  toolResultDuplicate: 'TRACER_TOOL_RESULT_DUPLICATE',
  textDoneWithoutBuffer: 'TRACER_TEXT_DONE_WITHOUT_BUFFER',
  surfaceWithoutCreate: 'TRACER_SURFACE_WITHOUT_CREATE',
  surfaceRecreated: 'TRACER_SURFACE_RECREATED',
  surfaceDeleteUnknown: 'TRACER_SURFACE_DELETE_UNKNOWN',
  streamsLeftOpen: 'TRACER_STREAMS_LEFT_OPEN',
  usageIgnored: 'TRACER_USAGE_IGNORED',
  subagentFinishedUnknown: 'TRACER_SUBAGENT_FINISH_UNKNOWN',
} as const;

/** Stands in for a tool name no frame ever supplied. Matches the AG-UI adapter. */
export const UNNAMED_TOOL = 'unknown_tool';
/** Stands in for a sub-agent name no frame ever supplied. Matches AG-UI. */
export const ANONYMOUS_SUBAGENT = 'subagent';
/** Catalog id for a surface implied by a frame that never announced one. */
export const UNKNOWN_CATALOG = 'unknown_catalog';

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface RunStateMeta {
  runId: string;
  threadId: string;
  protocol: ProtocolId;
  agentName?: string;
}

export function emptyRunState(meta: RunStateMeta): RunState {
  return {
    runId: meta.runId,
    threadId: meta.threadId,
    protocol: meta.protocol,
    ...(meta.agentName !== undefined ? { agentName: meta.agentName } : {}),
    lastSeq: -1,
    frameCount: 0,
    restarts: 0,
    started: false,
    finished: false,
    surfaces: [],
    apps: [],
    tools: [],
    buffers: [],
    messages: [],
    subagents: [],
    actions: [],
    interrupts: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    usageReports: 0,
    warnings: [],
    errors: [],
    usageLedger: [],
  };
}

/** Fold a whole transcript. Order is the caller's responsibility, not ours. */
export function reduce(frames: readonly SurfaceFrame[]): RunState {
  const first = frames[0];
  const agentName = agentNameOf(first);
  let state = emptyRunState({
    runId: first?.runId ?? 'unknown-run',
    threadId: first?.threadId ?? 'unknown-thread',
    protocol: first?.source ?? 'ag-ui',
    ...(agentName !== undefined ? { agentName } : {}),
  });
  for (const frame of frames) state = applyFrame(state, frame);
  return state;
}

/** The subset of `RunState.tools` that has no result yet. */
export function openTools(state: RunState): readonly ToolRecord[] {
  return state.tools.filter((tool) => tool.status === 'open');
}

/** Tool calls correlated to one sub-agent, in first-seen order. */
export function subagentToolCalls(state: RunState, subagentRunId: string): readonly ToolRecord[] {
  return state.tools.filter((tool) => tool.subagentRunId === subagentRunId);
}

/**
 * Assembled messages correlated to one sub-agent.
 *
 * A message has no id of its own for this, so the sub-agent is whatever the
 * frames that produced it were stamped with. Keeping it on the record (rather
 * than in a side table) is what keeps `reduce` a pure function of its input --
 * a module-level memo would leak one run's correlation into the next `reduce`,
 * and replay folds the same transcript repeatedly.
 */
export function subagentMessages(state: RunState, subagentRunId: string): readonly AssembledMessage[] {
  return state.messages.filter((message) => message.subagentRunId === subagentRunId);
}

function agentNameOf(frame: SurfaceFrame | undefined): string | undefined {
  if (!frame || frame.kind !== 'run.started') return undefined;
  const name = (frame.payload as { agentName?: unknown } | undefined)?.agentName;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

// ---------------------------------------------------------------------------
// applyFrame
// ---------------------------------------------------------------------------

/**
 * Apply one frame. Total: a fault becomes a warning on the returned state.
 */
export function applyFrame(state: RunState, frame: SurfaceFrame): RunState {
  let next = state;
  try {
    next = withSeqChecks(state, frame);
    next = withRunLifecycle(next, frame);
    next = withText(next, frame);
    next = withTools(next, frame);
    next = withSurfaces(next, frame);
    next = withAppsAndActions(next, frame);
    next = withSubagents(next, frame);
    next = withInterrupts(next, frame);
    next = withDiagnostics(next, frame);
    next = withUsage(next, frame);
  } catch (err) {
    // Reaching here means the frame's payload did not match the IR's declared
    // shape. Recording the shape is safe; reading a throwing getter off the
    // offending value is not, so only the message is kept.
    next = appendWarning(next, {
      seq: num(frame.seq),
      ts: num(frame.ts),
      code: TRACER_CODES.frameThrew,
      message: `Could not apply a ${String(frame.kind)} frame: ${messageOf(err)}`,
      frameKind: frame.kind,
      origin: 'tracer',
    });
  }
  return { ...next, frameCount: state.frameCount + 1 };
}

function withSeqChecks(state: RunState, frame: SurfaceFrame): RunState {
  let next: RunState = state;
  if (next.started && num(frame.seq) <= next.lastSeq) {
    // A sequence regression means the transcript was reassembled out of order
    // (a JSONL trace read back, two runs interleaved). Applying it anyway is
    // the tolerant choice; refusing would lose the frame entirely.
    next = appendWarning(next, {
      seq: num(frame.seq),
      ts: num(frame.ts),
      code: TRACER_CODES.seqOutOfOrder,
      message: `Frame seq ${String(frame.seq)} is not newer than the last applied seq ${String(next.lastSeq)}`,
      frameKind: frame.kind,
      origin: 'tracer',
      detail: { seq: frame.seq, lastSeq: next.lastSeq },
    });
  }
  if (next.finished && frame.kind !== 'run.finished') {
    next = appendWarning(next, {
      seq: num(frame.seq),
      ts: num(frame.ts),
      code: TRACER_CODES.frameAfterFinish,
      message: `A ${frame.kind} frame arrived after the run finished; kept, because a transcript that omits it would misreport the run`,
      frameKind: frame.kind,
      origin: 'tracer',
    });
  }
  return {
    ...next,
    lastSeq: Math.max(next.lastSeq, num(frame.seq)),
    firstTs: next.firstTs === undefined ? num(frame.ts) : Math.min(next.firstTs, num(frame.ts)),
    lastTs: next.lastTs === undefined ? num(frame.ts) : Math.max(next.lastTs, num(frame.ts)),
  };
}

function withRunLifecycle(state: RunState, frame: SurfaceFrame): RunState {
  if (frame.kind === 'run.started') {
    const payload = frame.payload as { agentName?: unknown; capabilities?: unknown };
    const agentName =
      typeof payload?.agentName === 'string' && payload.agentName !== ''
        ? payload.agentName
        : (state.agentName ?? ANONYMOUS_SUBAGENT);
    if (state.started) {
      // A second `run.started` means a new run opened on the same stream. The
      // AG-UI adapter restarts `seq` there, so keeping the old run's tools and
      // surfaces would produce totals for two runs at once. Warnings and errors
      // survive deliberately: they are the history of the connection.
      const reopened: RunState = {
        ...state,
        restarts: state.restarts + 1,
        surfaces: [],
        apps: [],
        tools: [],
        buffers: [],
        messages: [],
        subagents: [],
        actions: [],
        interrupts: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        usageReports: 0,
        usageLedger: [],
        finished: false,
        outcome: undefined,
      };
      return appendWarning(
        {
          ...reopened,
          started: true,
          agentName,
          ...(payload?.capabilities !== undefined
            ? { capabilities: payload.capabilities as JsonObject }
            : {}),
        },
        {
          seq: num(frame.seq),
          ts: num(frame.ts),
          code: TRACER_CODES.runRestarted,
          message: 'A second run.started arrived on this stream; run-scoped state was reset and warnings were kept',
          frameKind: frame.kind,
          origin: 'tracer',
        },
      );
    }
    return {
      ...state,
      started: true,
      agentName,
      ...(payload?.capabilities !== undefined
        ? { capabilities: payload.capabilities as JsonObject }
        : {}),
    };
  }
  if (frame.kind === 'run.finished') {
    const payload = frame.payload as { outcome?: unknown };
    const outcome: RunOutcome =
      payload?.outcome === 'cancelled' || payload?.outcome === 'interrupt' ? payload.outcome : 'success';
    let next: RunState = { ...state, finished: true, outcome };
    next = reportUnclosedStreams(next, frame);
    return next;
  }
  return state;
}

/**
 * Report -- never close -- streams the run ended on.
 *
 * AG-UI's adapter already flushes its buffers before `run.finished`; a host that
 * attaches mid-run, or a producer that simply disappears, leaves them open. The
 * text was delivered as deltas, so the honest record is a warning that says how
 * many streams never closed rather than a synthesised `text.done` that would
 * claim the message is final.
 */
function reportUnclosedStreams(state: RunState, frame: SurfaceFrame): RunState {
  const openToolsLeft = state.tools.filter((tool) => tool.status === 'open');
  const openBuffersLeft = state.buffers;
  if (openToolsLeft.length === 0 && openBuffersLeft.length === 0) return state;
  return appendWarning(
    state,
    {
      seq: num(frame.seq),
      ts: num(frame.ts),
      code: TRACER_CODES.streamsLeftOpen,
      message: `The run ended with ${String(openToolsLeft.length)} tool call(s) and ${String(openBuffersLeft.length)} message(s) still open; their fragments were recorded but never marked final`,
      frameKind: frame.kind,
      origin: 'tracer',
      detail: {
        toolCallIds: openToolsLeft.map((tool) => tool.toolCallId),
        messageIds: openBuffersLeft.map((buffer) => buffer.messageId),
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function withText(state: RunState, frame: SurfaceFrame): RunState {
  if (frame.kind === 'text.delta') {
    const payload = frame.payload as { messageId?: unknown; delta?: unknown };
    const messageId = str(payload?.messageId);
    if (messageId === undefined) return state;
    const delta = typeof payload?.delta === 'string' ? payload.delta : '';
    const existing = state.buffers.find((buffer) => buffer.messageId === messageId);
    // A delta with no buffer is legitimate: a host that attached mid-stream sees
    // content before content it missed. Synthesise the buffer instead of
    // dropping text, exactly as the AG-UI adapter does.
    const buffer: MessageBuffer = existing
      ? {
          ...existing,
          text: existing.text + delta,
          deltaCount: existing.deltaCount + 1,
          lastSeq: num(frame.seq),
          ...(frame.subagentRunId !== undefined ? { subagentRunId: frame.subagentRunId } : {}),
        }
      : {
          messageId,
          text: delta,
          startedAt: num(frame.ts),
          lastSeq: num(frame.seq),
          deltaCount: 1,
          ...(frame.step !== undefined ? { step: frame.step } : {}),
          ...(frame.subagentRunId !== undefined ? { subagentRunId: frame.subagentRunId } : {}),
        };
    return { ...state, buffers: upsert(state.buffers, byMessageId, buffer.messageId, buffer) };
  }

  if (frame.kind === 'text.done') {
    const payload = frame.payload as { messageId?: unknown; text?: unknown };
    const messageId = str(payload?.messageId);
    if (messageId === undefined) return state;
    const buffer = state.buffers.find((candidate) => candidate.messageId === messageId);
    const text = typeof payload?.text === 'string' ? payload.text : (buffer?.text ?? '');
    const message: AssembledMessage = {
      messageId,
      text,
      ...(buffer?.startedAt !== undefined ? { startedAt: buffer.startedAt } : {}),
      endedAt: num(frame.ts),
      deltaCount: buffer?.deltaCount ?? 0,
      ...(frame.step !== undefined ? { step: frame.step } : {}),
      ...(frame.subagentRunId !== undefined
        ? { subagentRunId: frame.subagentRunId }
        : buffer?.subagentRunId !== undefined
          ? { subagentRunId: buffer.subagentRunId }
          : {}),
      synthesized: buffer === undefined,
    };
    const next: RunState = {
      ...state,
      buffers: state.buffers.filter((candidate) => candidate.messageId !== messageId),
      messages: upsert(state.messages, byMessageId, message.messageId, message),
    };
    // The buffer being absent is only noteworthy when text was claimed: a
    // host that attached mid-stream legitimately never saw the start.
    return buffer === undefined
      ? appendWarning(next, {
          seq: num(frame.seq),
          ts: num(frame.ts),
          code: TRACER_CODES.textDoneWithoutBuffer,
          message: `text.done for ${messageId} with no buffered text.delta; the message text came from the done frame alone`,
          frameKind: frame.kind,
          origin: 'tracer',
          detail: { messageId },
        })
      : next;
  }
  return state;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function withTools(state: RunState, frame: SurfaceFrame): RunState {
  if (frame.kind === 'tool.started') {
    const payload = frame.payload as {
      toolCallId?: unknown;
      toolName?: unknown;
      parentMessageId?: unknown;
    };
    const toolCallId = str(payload?.toolCallId);
    if (toolCallId === undefined) return state;
    const existing = findTool(state, toolCallId);
    if (existing) {
      // A `tool.started` arriving after its own result is not a duplicate call:
      // it is the late half of a stream that was reassembled out of order. Merge
      // it in and keep the status the result established.
      const merged: ToolRecord = {
        ...existing,
        name: str(payload?.toolName) ?? existing.name,
        startedAt: existing.startedAt ?? num(frame.ts),
        parentMessageId: str(payload?.parentMessageId) ?? existing.parentMessageId,
        subagentRunId: frame.subagentRunId ?? existing.subagentRunId,
        lastSeq: num(frame.seq),
        // The result already established the outcome; only the classification
        // changes, because the call is no longer missing its start.
        ...(existing.status === 'orphan'
          ? { status: existing.isError === true ? 'error' : 'ok' }
          : {}),
      };
      return mergeTool(state, merged);
    }
    const record: ToolRecord = {
      toolCallId,
      name: str(payload?.toolName) ?? UNNAMED_TOOL,
      args: {},
      argsText: '',
      ...(str(payload?.parentMessageId) !== undefined
        ? { parentMessageId: str(payload?.parentMessageId) }
        : {}),
      ...(frame.subagentRunId !== undefined ? { subagentRunId: frame.subagentRunId } : {}),
      ...(frame.step !== undefined ? { step: frame.step } : {}),
      startedAt: num(frame.ts),
      status: 'open',
      firstSeq: num(frame.seq),
      lastSeq: num(frame.seq),
    };
    return { ...state, tools: [...state.tools, record] };
  }

  if (frame.kind === 'tool.args.delta') {
    const payload = frame.payload as { toolCallId?: unknown; delta?: unknown };
    const toolCallId = str(payload?.toolCallId);
    if (toolCallId === undefined) return state;
    const delta = typeof payload?.delta === 'string' ? payload.delta : '';
    const existing = findTool(state, toolCallId);
    if (!existing) {
      const seeded: ToolRecord = {
        toolCallId,
        name: UNNAMED_TOOL,
        args: {},
        argsText: delta,
        ...(frame.subagentRunId !== undefined ? { subagentRunId: frame.subagentRunId } : {}),
        ...(frame.step !== undefined ? { step: frame.step } : {}),
        status: 'open',
        firstSeq: num(frame.seq),
        lastSeq: num(frame.seq),
      };
      return appendWarning(
        { ...state, tools: [...state.tools, seeded] },
        {
          seq: num(frame.seq),
          ts: num(frame.ts),
          code: TRACER_CODES.toolArgsWithoutStart,
          message: `tool.args.delta for ${toolCallId} with no tool.started; the argument stream was kept`,
          frameKind: frame.kind,
          origin: 'tracer',
          detail: { toolCallId },
        },
      );
    }
    return mergeTool(state, {
      ...existing,
      argsText: existing.argsText + delta,
      lastSeq: num(frame.seq),
    });
  }

  if (frame.kind === 'tool.args.done') {
    const payload = frame.payload as {
      toolCallId?: unknown;
      args?: unknown;
      parseError?: unknown;
    };
    const toolCallId = str(payload?.toolCallId);
    if (toolCallId === undefined) return state;
    const existing = findTool(state, toolCallId);
    const args =
      payload?.args !== null && typeof payload?.args === 'object' && !Array.isArray(payload.args)
        ? (payload.args as JsonObject)
        : {};
    const parseError = str(payload?.parseError);
    if (!existing) {
      const seeded: ToolRecord = {
        toolCallId,
        name: UNNAMED_TOOL,
        args,
        argsText: '',
        ...(parseError !== undefined ? { parseError } : {}),
        ...(frame.subagentRunId !== undefined ? { subagentRunId: frame.subagentRunId } : {}),
        argsDoneAt: num(frame.ts),
        status: 'open',
        firstSeq: num(frame.seq),
        lastSeq: num(frame.seq),
      };
      return appendWarning(
        { ...state, tools: [...state.tools, seeded] },
        {
          seq: num(frame.seq),
          ts: num(frame.ts),
          code: TRACER_CODES.toolArgsWithoutStart,
          message: `tool.args.done for ${toolCallId} with no tool.started; the arguments were kept`,
          frameKind: frame.kind,
          origin: 'tracer',
          detail: { toolCallId },
        },
      );
    }
    return mergeTool(state, {
      ...existing,
      args,
      ...(parseError !== undefined ? { parseError } : {}),
      argsDoneAt: num(frame.ts),
      lastSeq: num(frame.seq),
    });
  }

  if (frame.kind === 'tool.result') {
    const payload = frame.payload as {
      toolCallId?: unknown;
      content?: unknown;
      isError?: unknown;
      durationMs?: unknown;
      messageId?: unknown;
    };
    const toolCallId = str(payload?.toolCallId);
    if (toolCallId === undefined) return state;
    const content = typeof payload?.content === 'string' ? payload.content : '';
    const isError = payload?.isError === true;
    const frameDuration = typeof payload?.durationMs === 'number' ? payload.durationMs : undefined;
    const existing = findTool(state, toolCallId);
    if (!existing) {
      // The case the brief calls out: a result with no start. It becomes an
      // orphan record rather than a dropped frame, and it stays in the state so
      // a diff against another run can see the call at all.
      const orphan: ToolRecord = {
        toolCallId,
        name: UNNAMED_TOOL,
        args: {},
        argsText: '',
        ...(str(payload?.messageId) !== undefined ? { parentMessageId: str(payload?.messageId) } : {}),
        ...(frame.subagentRunId !== undefined ? { subagentRunId: frame.subagentRunId } : {}),
        ...(frame.step !== undefined ? { step: frame.step } : {}),
        result: content,
        isError,
        endedAt: num(frame.ts),
        ...(frameDuration !== undefined ? { durationMs: frameDuration } : {}),
        status: 'orphan',
        firstSeq: num(frame.seq),
        lastSeq: num(frame.seq),
      };
      return appendWarning(
        { ...state, tools: [...state.tools, orphan] },
        {
          seq: num(frame.seq),
          ts: num(frame.ts),
          code: TRACER_CODES.toolResultWithoutStart,
          message: `tool.result for ${toolCallId} with no matching tool.started; recorded as an orphan call rather than dropped`,
          frameKind: frame.kind,
          origin: 'tracer',
          detail: { toolCallId, ...(str(payload?.messageId) !== undefined ? { messageId: str(payload?.messageId) } : {}) },
        },
      );
    }
    const resolved: ToolRecord = {
      ...existing,
      result: content,
      isError,
      endedAt: num(frame.ts),
      status: isError ? 'error' : 'ok',
      lastSeq: num(frame.seq),
    };
    return mergeTool(state, {
      ...resolved,
      ...(frameDuration !== undefined ? { durationMs: frameDuration } : {}),
    });
  }
  return state;
}

/**
 * Duration is taken from the frame when the adapter measured it and derived
 * otherwise.
 *
 * The preference is deliberate. The AG-UI adapter computes `durationMs` from the
 * same two timestamps the tracer has, but a host-side tool can report
 * server-side latency the tracer cannot observe at all. When both exist the
 * reported number is the one that includes time the transport did not account
 * for, and losing it would make every slow remote tool look fast.
 */
function resolveDuration(
  record: ToolRecord,
  startedAt: number | undefined,
  endedAt: number | undefined,
  reported: number | undefined,
): number | undefined {
  if (typeof reported === 'number') return reported;
  if (startedAt === undefined || endedAt === undefined) return undefined;
  return Math.max(0, endedAt - startedAt);
}

function findTool(state: RunState, toolCallId: string): ToolRecord | undefined {
  return state.tools.find((tool) => tool.toolCallId === toolCallId);
}

function mergeTool(state: RunState, record: ToolRecord): RunState {
  const durationMs = resolveDuration(record, record.startedAt, record.endedAt, record.durationMs);
  const withDuration: ToolRecord =
    durationMs === undefined || durationMs === record.durationMs
      ? record
      : { ...record, durationMs };
  return {
    ...state,
    tools: upsert(state.tools, byToolCallId, record.toolCallId, withDuration),
  };
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

function withSurfaces(state: RunState, frame: SurfaceFrame): RunState {
  if (frame.kind === 'surface.created') {
    const payload = frame.payload as {
      surfaceId?: unknown;
      catalogId?: unknown;
      title?: unknown;
      data?: unknown;
      sendDataModel?: unknown;
    };
    const surfaceId = str(payload?.surfaceId);
    if (surfaceId === undefined) return state;
    const existing = findSurface(state, surfaceId);
    const data = asData(payload?.data);
    const record: SurfaceRecord = {
      id: surfaceId,
      catalogId: str(payload?.catalogId) ?? UNKNOWN_CATALOG,
      ...(str(payload?.title) !== undefined ? { title: str(payload?.title) } : {}),
      data,
      nodes: existing?.nodes ?? [],
      ...(payload?.sendDataModel !== undefined ? { sendDataModel: payload.sendDataModel === true } : {}),
      pseudo: false,
      createdAt: existing?.createdAt ?? num(frame.ts),
      updatedAt: num(frame.ts),
      createdSeq: existing?.createdSeq ?? num(frame.seq),
      lastSeq: num(frame.seq),
      deleted: false,
      writeCount: existing?.writeCount ?? 0,
    };
    const next: RunState = {
      ...state,
      surfaces: upsert(state.surfaces, bySurfaceId, surfaceId, record),
    };
    // Re-creating a live surface usually means the agent recycled an id. The
    // nodes are kept because the new `created` frame does not carry them, and
    // dropping them would make the surface look empty for reasons that have
    // nothing to do with what the agent sent.
    return existing && !existing.deleted
      ? appendWarning(next, {
          seq: num(frame.seq),
          ts: num(frame.ts),
          code: TRACER_CODES.surfaceRecreated,
          message: `surface.created for ${surfaceId} while it was still live; the existing nodes were kept and the data model was replaced`,
          frameKind: frame.kind,
          origin: 'tracer',
          detail: { surfaceId },
        })
      : next;
  }

  if (frame.kind === 'surface.nodes') {
    const payload = frame.payload as {
      surfaceId?: unknown;
      nodes?: unknown;
      mode?: unknown;
    };
    const surfaceId = str(payload?.surfaceId);
    if (surfaceId === undefined) return state;
    const incoming = Array.isArray(payload?.nodes) ? (payload.nodes as SurfaceNode[]) : [];
    const mode = payload?.mode === 'replace' ? 'replace' : 'merge';
    const { surface, next } = touchSurface(state, frame, surfaceId, { pseudo: isPseudo(surfaceId) });
    const nodes = mode === 'replace' ? incoming : mergeNodes(surface?.nodes ?? [], incoming);
    const withNodes: RunState = {
      ...next,
      surfaces: upsert(next.surfaces, bySurfaceId, surfaceId, {
        ...(surface ?? newSurface(surfaceId, num(frame.ts), num(frame.seq), { pseudo: isPseudo(surfaceId) })),
        nodes,
        lastSeq: num(frame.seq),
        updatedAt: num(frame.ts),
        writeCount: (surface?.writeCount ?? 0) + 1,
      }),
    };
    return surface === undefined
      ? appendWarning(withNodes, {
          seq: num(frame.seq),
          ts: num(frame.ts),
          code: TRACER_CODES.surfaceWithoutCreate,
          message: `surface.nodes for ${surfaceId} with no surface.created; an implicit surface was opened`,
          frameKind: frame.kind,
          origin: 'tracer',
          detail: { surfaceId },
        })
      : withNodes;
  }

  if (frame.kind === 'surface.data') {
    const payload = frame.payload as {
      surfaceId?: unknown;
      path?: unknown;
      value?: unknown;
      mode?: unknown;
    };
    const surfaceId = str(payload?.surfaceId) ?? '';
    const path: JsonPointer = str(payload?.path) ?? '';
    const value = payload?.value as JsonValue;
    const mode = payload?.mode === 'merge' ? 'merge' : 'set';
    const { surface, next } = touchSurface(state, frame, surfaceId, { pseudo: isPseudo(surfaceId) });
    const base = surface?.data ?? {};
    let data: DataModel;
    try {
      data = writeData(base, path, value, mode);
    } catch (err) {
      // A malformed pointer is the agent's fault, and the previous document is
      // the state that actually rendered, so it is what stays.
      return appendWarning(next, {
        seq: num(frame.seq),
        ts: num(frame.ts),
        code: TRACER_CODES.surfaceWithoutCreate,
        message: `surface.data for ${surfaceId} could not be applied at '${path}': ${messageOf(err)}; the previous data model was kept`,
        frameKind: frame.kind,
        origin: 'tracer',
        detail: { surfaceId, path },
      });
    }
    const withData: RunState = {
      ...next,
      surfaces: upsert(next.surfaces, bySurfaceId, surfaceId, {
        ...(surface ?? newSurface(surfaceId, num(frame.ts), num(frame.seq), { pseudo: isPseudo(surfaceId) })),
        data,
        lastSeq: num(frame.seq),
        updatedAt: num(frame.ts),
        writeCount: (surface?.writeCount ?? 0) + 1,
      }),
    };
    return surface === undefined
      ? appendWarning(withData, {
          seq: num(frame.seq),
          ts: num(frame.ts),
          code: TRACER_CODES.surfaceWithoutCreate,
          message: `surface.data for ${surfaceId} with no surface.created; an implicit surface was opened`,
          frameKind: frame.kind,
          origin: 'tracer',
          detail: { surfaceId, path },
        })
      : withData;
  }

  if (frame.kind === 'surface.deleted') {
    const payload = frame.payload as { surfaceId?: unknown };
    const surfaceId = str(payload?.surfaceId);
    if (surfaceId === undefined) return state;
    const existing = findSurface(state, surfaceId);
    if (!existing || existing.deleted) {
      return appendWarning(state, {
        seq: num(frame.seq),
        ts: num(frame.ts),
        code: TRACER_CODES.surfaceDeleteUnknown,
        message: `surface.deleted for ${surfaceId} which is not a live surface`,
        frameKind: frame.kind,
        origin: 'tracer',
        detail: { surfaceId },
      });
    }
    return {
      ...state,
      // The record is kept and marked deleted rather than removed: the last
      // known structure of a deleted surface is what a diff needs to explain why
      // it disappeared.
      surfaces: upsert(state.surfaces, bySurfaceId, surfaceId, {
        ...existing,
        deleted: true,
        deletedAt: num(frame.ts),
        lastSeq: num(frame.seq),
        updatedAt: num(frame.ts),
      }),
    };
  }
  return state;
}

function isPseudo(surfaceId: string): boolean {
  return surfaceId === AGUI_STATE_SURFACE_ID;
}

function newSurface(surfaceId: string, ts: number, seq: number, opts: { pseudo?: boolean } = {}): SurfaceRecord {
  return {
    id: surfaceId,
    catalogId: UNKNOWN_CATALOG,
    data: {},
    nodes: [],
    ...(opts.pseudo === true ? { pseudo: true } : {}),
    createdAt: ts,
    updatedAt: ts,
    createdSeq: seq,
    lastSeq: seq,
    deleted: false,
    writeCount: 0,
  };
}

function touchSurface(
  state: RunState,
  frame: SurfaceFrame,
  surfaceId: string,
  opts: { pseudo?: boolean },
): { surface: SurfaceRecord | undefined; next: RunState } {
  const surface = findSurface(state, surfaceId);
  if (surface) {
    // A write after a delete revives the surface: the agent is still using an id
    // it previously released, and the frames after the delete are the truth.
    return { surface: surface.deleted ? { ...surface, deleted: false } : surface, next: state };
  }
  const created = newSurface(surfaceId, num(frame.ts), num(frame.seq), opts);
  return {
    surface: undefined,
    next: { ...state, surfaces: upsert(state.surfaces, bySurfaceId, surfaceId, created) },
  };
}

/**
 * `merge` replaces same-id roots and appends the rest.
 *
 * A2UI emits `mode: 'merge'` carrying only the components a message changed,
 * each of which is a complete subtree rooted at a node id. Matching on the root
 * id is therefore the only merge that preserves the subtrees the agent actually
 * sent, and nodes without an id cannot be matched by anything, so they append.
 */
function mergeNodes(existing: readonly SurfaceNode[], incoming: readonly SurfaceNode[]): readonly SurfaceNode[] {
  if (incoming.length === 0) return existing;
  const out = existing.slice();
  for (const node of incoming) {
    const id = node?.id;
    if (id === undefined) {
      out.push(node);
      continue;
    }
    const index = out.findIndex((candidate) => candidate?.id === id);
    if (index === -1) out.push(node);
    else out[index] = node;
  }
  return out;
}

/**
 * Apply a data-model write.
 *
 * `merge` means "the keys of this value are written onto what is there", which
 * is what both producers need: the AG-UI adapter uses it for a whole-document
 * snapshot precisely because the host's copy holds optimistic `action.dispatched`
 * writes the agent has never seen, and A2UI uses it for partial updates. A
 * wholesale replace would silently discard a user's click.
 *
 * An empty pointer (or `/`) is the RFC 6901 whole-document pointer, the only
 * path that can express "replace the entire data model".
 */
export function writeData(
  base: DataModel,
  path: JsonPointer,
  value: JsonValue,
  mode: 'set' | 'merge',
): DataModel {
  if (path === '' || path === '/') {
    if (mode === 'merge' && isPlainObject(value) && isPlainObject(base)) {
      return { ...base, ...value };
    }
    return isPlainObject(value) ? { ...value } : {};
  }
  const cloned = structuredClone(base) as DataModel;
  const tokens = parseTokens(path);
  if (tokens.length === 0) return isPlainObject(value) ? { ...value } : {};

  let cursor: Record<string, unknown> = cloned;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i]!;
    const next = cursor[token];
    if (!isPlainObject(next)) cursor[token] = {};
    cursor = cursor[token] as Record<string, unknown>;
  }
  const last = tokens[tokens.length - 1]!;
  const existing = cursor[last];
  if (mode === 'merge' && isPlainObject(existing) && isPlainObject(value)) {
    cursor[last] = { ...existing, ...value };
  } else {
    cursor[last] = structuredClone(value);
  }
  return cloned;
}

/** RFC 6901 parse. Throws on a non-pointer, which `withSurfaces` catches. */
function parseTokens(pointer: JsonPointer): string[] {
  if (!pointer.startsWith('/')) throw new Error(`Invalid JSON Pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

// ---------------------------------------------------------------------------
// Apps, actions, sub-agents, interrupts
// ---------------------------------------------------------------------------

function withAppsAndActions(state: RunState, frame: SurfaceFrame): RunState {
  if (frame.kind === 'app.attached') {
    const payload = frame.payload as { app?: Record<string, unknown> };
    const app = payload?.app;
    if (!app || typeof app !== 'object') return state;
    const id = str(app['id']);
    if (id === undefined) return state;
    const record: AppRecord = {
      id,
      title: str(app['title']) ?? id,
      sandbox: str(app['sandbox']) ?? 'sandboxed',
      ...(str(app['bridgeVersion']) !== undefined ? { bridgeVersion: str(app['bridgeVersion']) } : {}),
      ...(str(app['transport']) !== undefined ? { transport: str(app['transport']) } : {}),
      attachedAt: num(frame.ts),
      ...(frame.subagentRunId !== undefined ? { subagentRunId: frame.subagentRunId } : {}),
    };
    return { ...state, apps: upsert(state.apps, byAppId, id, record) };
  }
  if (frame.kind === 'action.dispatched') {
    const payload = frame.payload as {
      surfaceId?: unknown;
      componentId?: unknown;
      name?: unknown;
      context?: unknown;
    };
    const surfaceId = str(payload?.surfaceId);
    const name = str(payload?.name);
    if (surfaceId === undefined || name === undefined) return state;
    const record: ActionRecord = {
      surfaceId,
      componentId: str(payload?.componentId) ?? '',
      name,
      context: isPlainObject(payload?.context) ? (payload.context as JsonObject) : {},
      seq: num(frame.seq),
      ts: num(frame.ts),
      ...(frame.subagentRunId !== undefined ? { subagentRunId: frame.subagentRunId } : {}),
    };
    return { ...state, actions: [...state.actions, record] };
  }
  return state;
}

function withSubagents(state: RunState, frame: SurfaceFrame): RunState {
  if (frame.kind !== 'subagent') return state;
  const payload = frame.payload as { phase?: unknown; name?: unknown; detail?: unknown };
  const phase = payload?.phase === 'finished' || payload?.phase === 'error' ? payload.phase : 'started';
  const name = str(payload?.name) ?? ANONYMOUS_SUBAGENT;
  const detail = str(payload?.detail);
  const id = frame.subagentRunId;
  if (id === undefined) {
    // A finish with no correlation id cannot be attached to a start. Recording a
    // synthetic id keeps the phase visible without pretending it correlates.
    const synthetic = `subagent#${String(frame.seq)}`;
    return mergeSubagent(state, synthetic, name, phase, detail, frame, undefined);
  }
  const existing = state.subagents.find((candidate) => candidate.subagentRunId === id);
  if (!existing && phase !== 'started') {
    return appendWarning(
      mergeSubagent(state, id, name, phase, detail, frame, undefined),
      {
        seq: num(frame.seq),
        ts: num(frame.ts),
        code: TRACER_CODES.subagentFinishedUnknown,
        message: `subagent ${phase} for ${id} with no matching subagent start; the terminal phase was recorded`,
        frameKind: frame.kind,
        origin: 'tracer',
        detail: { subagentRunId: id, name },
      },
    );
  }
  return mergeSubagent(state, id, name, phase, detail, frame, existing?.parentSubagentRunId);
}

function mergeSubagent(
  state: RunState,
  id: string,
  name: string,
  phase: 'started' | 'finished' | 'error',
  detail: string | undefined,
  frame: SurfaceFrame,
  parentSubagentRunId: string | undefined,
): RunState {
  const existing = state.subagents.find((candidate) => candidate.subagentRunId === id);
  const opened = existing?.startedAt ?? num(frame.ts);
  const base: SubAgentRecord = existing ?? {
    subagentRunId: id,
    name,
    phase,
    startedAt: num(frame.ts),
    status: 'open',
    firstSeq: num(frame.seq),
    lastSeq: num(frame.seq),
  };
  const terminal = phase !== 'started';
  const record: SubAgentRecord = {
    ...base,
    name: base.name === ANONYMOUS_SUBAGENT ? name : base.name,
    phase,
    ...(detail !== undefined ? { detail } : {}),
    ...(parentSubagentRunId !== undefined ? { parentSubagentRunId } : {}),
    ...(terminal ? { endedAt: num(frame.ts), durationMs: Math.max(0, num(frame.ts) - opened) } : {}),
    // A terminal phase for a sub-agent that never started is an orphan: the
    // agent reported an end with no beginning, which is a protocol fault rather
    // than a successful short invocation.
    status: terminal ? (phase === 'error' ? 'error' : existing ? 'ok' : 'orphan') : 'open',
    lastSeq: Math.max(base.lastSeq, num(frame.seq)),
  };
  return { ...state, subagents: upsert(state.subagents, bySubagentId, id, record) };
}

function withInterrupts(state: RunState, frame: SurfaceFrame): RunState {
  if (frame.kind !== 'interrupt') return state;
  const payload = frame.payload as { reason?: unknown; resumeToken?: unknown; resumable?: unknown };
  const record: InterruptRecord = {
    reason: str(payload?.reason) ?? 'interrupted',
    ...(str(payload?.resumeToken) !== undefined ? { resumeToken: str(payload?.resumeToken) } : {}),
    resumable: payload?.resumable !== false,
    seq: num(frame.seq),
    ts: num(frame.ts),
    ...(frame.subagentRunId !== undefined ? { subagentRunId: frame.subagentRunId } : {}),
  };
  return { ...state, interrupts: [...state.interrupts, record] };
}

// ---------------------------------------------------------------------------
// Diagnostics and usage
// ---------------------------------------------------------------------------

function withDiagnostics(state: RunState, frame: SurfaceFrame): RunState {
  if (frame.kind === 'warning') {
    const payload = frame.payload as { code?: unknown; message?: unknown; detail?: unknown };
    const record: TracerWarning = {
      seq: num(frame.seq),
      ts: num(frame.ts),
      code: str(payload?.code) ?? 'UNSPECIFIED',
      message: str(payload?.message) ?? '',
      frameKind: frame.kind,
      origin: 'adapter',
      ...(isPlainObject(payload?.detail) ? { detail: payload.detail as JsonObject } : {}),
    };
    return { ...state, warnings: [...state.warnings, record] };
  }
  if (frame.kind === 'error') {
    const payload = frame.payload as {
      code?: unknown;
      message?: unknown;
      fatal?: unknown;
      detail?: unknown;
    };
    const record: TracerError = {
      seq: num(frame.seq),
      ts: num(frame.ts),
      code: str(payload?.code) ?? 'UNSPECIFIED',
      message: str(payload?.message) ?? '',
      fatal: payload?.fatal === true,
      ...(isPlainObject(payload?.detail) ? { detail: payload.detail as JsonObject } : {}),
    };
    return { ...state, errors: [...state.errors, record] };
  }
  return state;
}

/**
 * Accumulate usage from both places a producer can put it.
 *
 * `run.finished` carries `usage` directly. AG-UI's `RUN_ERROR` has no usage
 * field on the IR's `error` payload, so the adapter stashes the tokens it
 * actually spent into `detail.usage`. Those tokens are real money; ignoring
 * them would under-report every failed run, which is precisely the run an
 * operator is most worried about.
 */
function withUsage(state: RunState, frame: SurfaceFrame): RunState {
  if (frame.kind === 'run.finished') {
    const usage = readUsage((frame.payload as { usage?: unknown })?.usage);
    if (!usage) return state;
    return recordUsage(state, frame, 'run.finished', usage);
  }
  if (frame.kind === 'error') {
    const detail = (frame.payload as { detail?: unknown })?.detail;
    const usage = readUsage(isPlainObject(detail) ? detail['usage'] : undefined);
    if (!usage) return state;
    return recordUsage(state, frame, 'error.detail', usage);
  }
  return state;
}

function recordUsage(
  state: RunState,
  frame: SurfaceFrame,
  source: UsageReport['source'],
  usage: Usage,
): RunState {
  const report: UsageReport = { seq: num(frame.seq), ts: num(frame.ts), source, usage };
  return {
    ...state,
    usage: addUsage(state.usage, usage),
    usageReports: state.usageReports + 1,
    usageLedger: [...state.usageLedger, report],
  };
}

/** Sum two usages, omitting optional keys that neither side reported. */
export function addUsage(total: Usage, next: Usage): Usage {
  const merged: Usage = {
    inputTokens: num(total.inputTokens) + num(next.inputTokens),
    outputTokens: num(total.outputTokens) + num(next.outputTokens),
  };
  const optionalKeys = ['cachedInputTokens', 'reasoningTokens', 'costUsd'] as const;
  for (const key of optionalKeys) {
    const a = total[key];
    const b = next[key];
    if (typeof a !== 'number' && typeof b !== 'number') continue;
    // Summing an absent key as zero would report a precise number the producer
    // never sent, so it stays absent until something actually reports it.
    merged[key] = (typeof a === 'number' ? a : 0) + (typeof b === 'number' ? b : 0);
  }
  return merged;
}

function readUsage(value: unknown): Usage | undefined {
  if (!isPlainObject(value)) return undefined;
  const inputTokens = value['inputTokens'];
  const outputTokens = value['outputTokens'];
  if (typeof inputTokens !== 'number' && typeof outputTokens !== 'number') return undefined;
  const usage: Usage = {
    inputTokens: typeof inputTokens === 'number' ? inputTokens : 0,
    outputTokens: typeof outputTokens === 'number' ? outputTokens : 0,
  };
  if (typeof value['cachedInputTokens'] === 'number') usage.cachedInputTokens = value['cachedInputTokens'];
  if (typeof value['reasoningTokens'] === 'number') usage.reasoningTokens = value['reasoningTokens'];
  if (typeof value['costUsd'] === 'number') usage.costUsd = value['costUsd'];
  return usage;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function appendWarning(state: RunState, warning: TracerWarning): RunState {
  return { ...state, warnings: [...state.warnings, warning] };
}

export function appendError(state: RunState, error: TracerError): RunState {
  return { ...state, errors: [...state.errors, error] };
}

function findSurface(state: RunState, surfaceId: string): SurfaceRecord | undefined {
  return state.surfaces.find((surface) => surface.id === surfaceId);
}

function upsert<T>(items: readonly T[], keyOf: (item: T) => string, key: string, item: T): readonly T[] {
  const index = items.findIndex((candidate) => keyOf(candidate) === key);
  if (index === -1) return [...items, item];
  const copy = items.slice();
  copy[index] = item;
  return copy;
}

const bySurfaceId = (surface: SurfaceRecord): string => surface.id;
const byToolCallId = (tool: ToolRecord): string => tool.toolCallId;
const byMessageId = (message: MessageBuffer | AssembledMessage): string => message.messageId;
const byAppId = (app: AppRecord): string => app.id;
const bySubagentId = (subagent: SubAgentRecord): string => subagent.subagentRunId;

function asData(value: unknown): DataModel {
  return isPlainObject(value) ? structuredClone(value) as DataModel : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
