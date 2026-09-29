/**
 * The execution tree.
 *
 * A transcript is flat and an operator's question is not: "what did that tool
 * call, and what did it call in turn?" The tree answers it by nesting on the
 * two correlations the IR actually carries:
 *
 *  - `parentMessageId` links a tool call to the message that requested it, or to
 *    the tool result a nested call descends from.
 *  - `subagentRunId` links any frame to the sub-agent it belongs to, which
 *    becomes a container.
 *
 * ## Orphans are results, not noise
 *
 * Two cases both land on `status: 'orphan'` and both are kept:
 *  - a `tool.started` with no result by the end of the run -- the call hung, or
 *    the run died mid-call. During a live view this is `pending`; once the run
 *    is closed, "still open" is no longer a transient state, it is a finding.
 *  - a `tool.result` with no `tool.started` -- a reassembled or truncated
 *    transcript. Dropping it would make the transcript claim the agent never
 *    made a call it demonstrably made, and `diffRuns` could not see it either.
 *
 * `buildTree` reads frames rather than `RunState` on purpose: this is a
 * *structural* projection (who is inside whom), and deriving it from the
 * transcript keeps it independent of accumulation order.
 */

import type { FramePayloadMap, JsonObject, ProtocolId, SurfaceFrame } from '@agent-surface/protocol';

import { ANONYMOUS_SUBAGENT, TRACER_WARNING_PREFIX, UNNAMED_TOOL } from './reducer.js';

export type ToolCallStatus = 'pending' | 'ok' | 'error' | 'orphan';

export interface ToolCallNode {
  kind: 'tool';
  toolCallId: string;
  name: string;
  args: JsonObject;
  /** Stable hash of `args`, so two runs can match a call whose ids differ. */
  argsHash: string;
  result?: string;
  isError?: boolean;
  status: ToolCallStatus;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  parentMessageId?: string;
  subagentRunId?: string;
  step?: number;
  /** `seq` of the frame that opened the call, or of the result for an orphan. */
  seq: number;
  children: ExecNode[];
}

export interface MessageNode {
  kind: 'message';
  messageId: string;
  text: string;
  deltaCount: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  subagentRunId?: string;
  step?: number;
  seq: number;
  synthesized: boolean;
  children: ExecNode[];
}

export interface SubAgentNode {
  kind: 'subagent';
  subagentRunId: string;
  name: string;
  status: 'open' | 'ok' | 'error' | 'orphan';
  detail?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  children: ExecNode[];
}

export type ExecNode = MessageNode | ToolCallNode | SubAgentNode;

export interface RunNode {
  kind: 'run';
  runId: string;
  threadId: string;
  protocol: ProtocolId;
  agentName?: string;
  status: 'running' | 'success' | 'cancelled' | 'interrupt' | 'error';
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  frameCount: number;
  children: ExecNode[];
}

export interface BuildTreeOptions {
  /**
   * Whether the transcript is finished. `true` (the default) promotes an
   * unresolved call from `pending` to `orphan`; `false` is for a live view,
   * where "no result yet" is the truth rather than a finding.
   */
  closed?: boolean;
  /**
   * Nest a sub-agent that starts while another is still open inside that one.
   *
   * True by default because overlapping invocations are the normal shape of a
   * supervisor agent, and the IR carries no parent pointer for them. The
   * failure mode is two genuinely parallel *root* sub-agents, where the second
   * is drawn inside the first -- visible in the output, and cheap to turn off.
   */
  nestSubagents?: boolean;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

interface Builder {
  readonly frames: readonly SurfaceFrame[];
  readonly options: Required<BuildTreeOptions>;
  readonly run: MutableRun;
  readonly tools: Map<string, ToolCallNode>;
  /** messageId -> the node that message belongs to, message or tool. */
  readonly owners: Map<string, MessageNode | ToolCallNode>;
  readonly buffers: Map<string, { text: string; startedAt: number; deltaCount: number }>;
  /** Innermost-first stack of sub-agents that have started and not finished. */
  openSubagents: string[];
  readonly subagents: Map<string, SubAgentNode>;
  lastTs: number | undefined;
  fatalError: boolean;
  outcome: 'success' | 'cancelled' | 'interrupt' | undefined;
}

type MutableRun = {
  runId: string;
  threadId: string;
  protocol: ProtocolId;
  agentName?: string;
  startedAt?: number;
  endedAt?: number;
  children: ExecNode[];
  frameCount: number;
};

export function buildTree(
  frames: readonly SurfaceFrame[],
  options: BuildTreeOptions = {},
): RunNode {
  const first = frames[0];
  const builder: Builder = {
    frames,
    options: { closed: options.closed ?? true, nestSubagents: options.nestSubagents ?? true },
    run: {
      runId: first?.runId ?? 'unknown-run',
      threadId: first?.threadId ?? 'unknown-thread',
      protocol: first?.source ?? 'ag-ui',
      children: [],
      frameCount: frames.length,
    },
    tools: new Map(),
    owners: new Map(),
    buffers: new Map(),
    openSubagents: [],
    subagents: new Map(),
    lastTs: undefined,
    fatalError: false,
    outcome: undefined,
  };

  for (const frame of frames) {
    try {
      applyToTree(builder, frame);
    } catch {
      // `buildTree` shares the reducer's totality contract: a malformed frame
      // costs one node, not the whole tree. The reducer records the same fault
      // as a warning, so dropping it here would duplicate nothing.
    }
  }

  closeOpenStreams(builder);
  return finalizeRun(builder);
}

function applyToTree(b: Builder, frame: SurfaceFrame): void {
  b.lastTs = b.lastTs === undefined ? ts(frame) : Math.max(b.lastTs, ts(frame));
  switch (frame.kind) {
    case 'run.started': {
      const payload = frame.payload as FramePayloadMap['run.started'];
      b.run.startedAt = ts(frame);
      b.run.agentName = payload?.agentName ?? b.run.agentName;
      break;
    }
    case 'run.finished': {
      const payload = frame.payload as FramePayloadMap['run.finished'];
      b.run.endedAt = ts(frame);
      b.outcome = payload?.outcome === 'cancelled' || payload?.outcome === 'interrupt' ? payload.outcome : 'success';
      break;
    }
    case 'error': {
      const payload = frame.payload as FramePayloadMap['error'];
      if (payload?.fatal === true) b.fatalError = true;
      break;
    }
    case 'text.delta': {
      const payload = frame.payload as FramePayloadMap['text.delta'];
      const id = payload?.messageId;
      if (typeof id !== 'string') break;
      const buffer = b.buffers.get(id);
      if (buffer) {
        buffer.text += payload.delta ?? '';
        buffer.deltaCount += 1;
      } else {
        b.buffers.set(id, { text: payload.delta ?? '', startedAt: ts(frame), deltaCount: 1 });
      }
      break;
    }
    case 'text.done': {
      const payload = frame.payload as FramePayloadMap['text.done'];
      const id = payload?.messageId;
      if (typeof id !== 'string') break;
      const buffer = b.buffers.get(id);
      const node = b.owners.get(id);
      const text = typeof payload?.text === 'string' ? payload.text : (buffer?.text ?? '');
      if (node && node.kind === 'message') {
        node.text = text;
        node.endedAt = ts(frame);
        node.deltaCount = buffer?.deltaCount ?? node.deltaCount;
        node.synthesized = false;
      } else {
        const created = messageNode(id, text, frame, buffer?.deltaCount ?? 0, buffer?.startedAt);
        attach(b, created, frame);
        b.owners.set(id, created);
      }
      b.buffers.delete(id);
      break;
    }
    case 'tool.started': {
      const payload = frame.payload as FramePayloadMap['tool.started'];
      const id = payload?.toolCallId;
      if (typeof id !== 'string') break;
      const name = payload?.toolName ?? UNNAMED_TOOL;
      const existingNode = b.tools.get(id);
      if (existingNode) {
        // A start that arrives after its result, or a duplicate from a split
        // stream. Backfill what the node is missing rather than dropping the
        // frame: an out-of-order result leaves the node unnamed and orphaned,
        // and the late start is the only evidence that can fix either.
        if (existingNode.name === UNNAMED_TOOL && name !== UNNAMED_TOOL) {
          existingNode.name = name;
        }
        if (existingNode.startedAt === undefined) {
          existingNode.startedAt = ts(frame);
          // An orphan became attributable, so it is no longer orphaned. The
          // result already resolved the call, so its status stays as the
          // result set it.
          if (existingNode.status === 'orphan' && existingNode.result !== undefined) {
            existingNode.status = existingNode.isError === true ? 'error' : 'ok';
          }
        }
        if (existingNode.parentMessageId === undefined && payload?.parentMessageId !== undefined) {
          existingNode.parentMessageId = payload.parentMessageId;
        }
        break;
      }
      const node: ToolCallNode = {
        kind: 'tool',
        toolCallId: id,
        name,
        args: {},
        argsHash: hashArgs({}),
        status: b.options.closed ? 'orphan' : 'pending',
        startedAt: ts(frame),
        ...(payload?.parentMessageId !== undefined ? { parentMessageId: payload.parentMessageId } : {}),
        ...(frame.subagentRunId !== undefined ? { subagentRunId: frame.subagentRunId } : {}),
        ...(frame.step !== undefined ? { step: frame.step } : {}),
        seq: seq(frame),
        children: [],
      };
      attach(b, node, frame);
      b.tools.set(id, node);
      break;
    }
    case 'tool.args.done': {
      const payload = frame.payload as FramePayloadMap['tool.args.done'];
      const node = typeof payload?.toolCallId === 'string' ? b.tools.get(payload.toolCallId) : undefined;
      if (!node) break;
      node.args = payload?.args ?? {};
      node.argsHash = hashArgs(node.args);
      break;
    }
    case 'tool.result': {
      const payload = frame.payload as FramePayloadMap['tool.result'];
      const id = payload?.toolCallId;
      if (typeof id !== 'string') break;
      const existing = b.tools.get(id);
      if (existing) {
        existing.result = payload?.content ?? '';
        existing.isError = payload?.isError === true;
        existing.status = payload?.isError === true ? 'error' : 'ok';
        existing.endedAt = ts(frame);
        existing.durationMs =
          typeof payload?.durationMs === 'number'
            ? payload.durationMs
            : existing.startedAt === undefined
              ? undefined
              : Math.max(0, ts(frame) - existing.startedAt);
      } else {
        // Result before start. Kept, named, and marked: the transcript says the
        // agent produced an output nobody can attribute to a call.
        const node: ToolCallNode = {
          kind: 'tool',
          toolCallId: id,
          name: UNNAMED_TOOL,
          args: {},
          argsHash: hashArgs({}),
          result: payload?.content ?? '',
          isError: payload?.isError === true,
          status: 'orphan',
          endedAt: ts(frame),
          ...(frame.subagentRunId !== undefined ? { subagentRunId: frame.subagentRunId } : {}),
          ...(frame.step !== undefined ? { step: frame.step } : {}),
          seq: seq(frame),
          children: [],
        };
        attach(b, node, frame);
        b.tools.set(id, node);
      }
      // A tool result is itself a message in AG-UI, and a later call may name
      // it as `parentMessageId`. Registering it is what makes that nest.
      const messageId = payload?.messageId;
      if (typeof messageId === 'string' && !b.owners.has(messageId)) {
        b.owners.set(messageId, b.tools.get(id)!);
      }
      break;
    }
    case 'subagent': {
      const payload = frame.payload as FramePayloadMap['subagent'];
      const phase = payload?.phase ?? 'started';
      const name = payload?.name ?? ANONYMOUS_SUBAGENT;
      const id = frame.subagentRunId ?? syntheticSubagentId(b, name, frame);
      const existing = b.subagents.get(id);
      if (phase === 'started' && !existing) {
        const container = b.options.nestSubagents ? currentSubagent(b) : undefined;
        const node: SubAgentNode = {
          kind: 'subagent',
          subagentRunId: id,
          name,
          status: 'open',
          startedAt: ts(frame),
          children: [],
        };
        if (container) container.children.push(node);
        else b.run.children.push(node);
        b.subagents.set(id, node);
        b.openSubagents.push(id);
        break;
      }
      const node = b.subagents.get(id);
      if (phase === 'started' && node) break;
      if (node) {
        node.status = phase === 'error' ? 'error' : 'ok';
        node.endedAt = ts(frame);
        node.durationMs = node.startedAt === undefined ? undefined : Math.max(0, ts(frame) - node.startedAt);
        if (payload?.detail !== undefined) node.detail = payload.detail;
        b.openSubagents = b.openSubagents.filter((open) => open !== id);
      } else {
        // A terminal phase with no start. Recorded as an orphan so a scrubber
        // still shows the sub-agent rather than a gap where it should be.
        const orphan: SubAgentNode = {
          kind: 'subagent',
          subagentRunId: id,
          name,
          status: phase === 'error' ? 'error' : 'orphan',
          endedAt: ts(frame),
          children: [],
        };
        attach(b, orphan, frame);
        b.subagents.set(id, orphan);
      }
      break;
    }
    default:
      break;
  }
}

function messageNode(
  id: string,
  text: string,
  frame: SurfaceFrame,
  deltaCount: number,
  startedAt: number | undefined,
): MessageNode {
  return {
    kind: 'message',
    messageId: id,
    text,
    deltaCount,
    ...(startedAt !== undefined ? { startedAt } : {}),
    endedAt: ts(frame),
    ...(frame.subagentRunId !== undefined ? { subagentRunId: frame.subagentRunId } : {}),
    ...(frame.step !== undefined ? { step: frame.step } : {}),
    seq: seq(frame),
    synthesized: true,
    children: [],
  };
}

/**
 * Where a frame lands when nothing named a parent: inside the innermost open
 * sub-agent, else at the run root. A message whose id was named by a tool's
 * `parentMessageId` before its own `text.done` arrives gets its node created on
 * demand, which is why `owners` is consulted before the buffers.
 *
 * An explicit `subagentRunId` outranks message ownership. A message node created
 * in the parent conversation is a legal `parentMessageId` for a sub-agent's
 * tool call, and following that link would strand the call outside the
 * sub-agent it belongs to -- the correlation id is the stronger evidence.
 */
function attach(b: Builder, node: ExecNode, frame: SurfaceFrame): void {
  if (frame.subagentRunId !== undefined) {
    attachTo(b, node, frame.subagentRunId);
    return;
  }
  const parentMessageId = node.kind === 'tool' ? node.parentMessageId : undefined;
  if (parentMessageId !== undefined) {
    const owner = b.owners.get(parentMessageId);
    if (owner) {
      owner.children.push(node);
      return;
    }
    const buffer = b.buffers.get(parentMessageId);
    if (buffer) {
      const provisional = messageNode(
        parentMessageId,
        buffer.text,
        frame,
        buffer.deltaCount,
        buffer.startedAt,
      );
      provisional.synthesized = false;
      provisional.children.push(node);
      b.owners.set(parentMessageId, provisional);
      const container = currentSubagent(b);
      (container?.children ?? b.run.children).push(provisional);
      return;
    }
  }
  const container = currentSubagent(b);
  (container?.children ?? b.run.children).push(node);
}

function attachTo(b: Builder, node: ExecNode, subagentRunId: string): void {
  const parent = b.subagents.get(subagentRunId);
  if (!parent) {
    b.run.children.push(node);
    return;
  }
  parent.children.push(node);
}

function currentSubagent(b: Builder): SubAgentNode | undefined {
  for (let i = b.openSubagents.length - 1; i >= 0; i -= 1) {
    const node = b.subagents.get(b.openSubagents[i]!);
    if (node) return node;
  }
  return undefined;
}

function currentSubagentId(b: Builder): string | undefined {
  return currentSubagent(b)?.subagentRunId;
}

/**
 * A `subagent` frame with no `subagentRunId` still needs a key. A terminal phase
 * with no correlation id is matched to the innermost open sub-agent of the same
 * name when one exists, because that is the only defensible guess; a start with
 * no id at all gets a synthetic key derived from its sequence number.
 */
function syntheticSubagentId(b: Builder, name: string, frame: SurfaceFrame): string {
  const matching = currentSubagent(b);
  if (matching && matching.name === name && matching.status === 'open') return matching.subagentRunId;
  return `subagent#${String(seq(frame))}`;
}

/**
 * Promote text that never reached a `text.done`.
 *
 * The adapter contract says a stream left open is reported rather than closed,
 * because `text.done` asserts the message is final and a truncated transcript
 * cannot make that claim. A tree node still has to exist, though, or a tool call
 * that names the message as its parent would have nowhere to attach.
 */
function closeOpenStreams(b: Builder): void {
  for (const [id, buffer] of b.buffers) {
    if (b.owners.has(id)) continue;
    const node: MessageNode = {
      kind: 'message',
      messageId: id,
      text: buffer.text,
      deltaCount: buffer.deltaCount,
      startedAt: buffer.startedAt,
      endedAt: b.lastTs ?? buffer.startedAt,
      seq: 0,
      synthesized: true,
      children: [],
    };
    const container = currentSubagent(b);
    (container?.children ?? b.run.children).push(node);
    b.owners.set(id, node);
  }
  b.buffers.clear();

  for (const tool of b.tools.values()) {
    if (tool.status !== 'pending' && tool.status !== 'orphan') continue;
    if (!b.options.closed) continue;
    // `pending` was assigned at creation for a closed transcript; an orphan
    // result keeps its status. Both need their window closed.
    tool.status = 'orphan';
    tool.endedAt ??= b.lastTs ?? tool.startedAt;
    if (tool.durationMs === undefined && tool.startedAt !== undefined && tool.endedAt !== undefined) {
      tool.durationMs = Math.max(0, tool.endedAt - tool.startedAt);
    }
  }
  for (const id of b.openSubagents) {
    const node = b.subagents.get(id);
    if (node && node.status === 'open') node.status = 'orphan';
  }
  b.openSubagents.length = 0;
}

function finalizeRun(b: Builder): RunNode {
  const startedAt = b.run.startedAt ?? b.frames[0]?.ts;
  const endedAt = b.run.endedAt ?? b.lastTs;
  const status: RunNode['status'] = b.fatalError
    ? 'error'
    : b.outcome === 'cancelled'
      ? 'cancelled'
      : b.outcome === 'interrupt'
        ? 'interrupt'
        : b.outcome === 'success'
          ? 'success'
          : 'running';
  const run: RunNode = {
    kind: 'run',
    runId: b.run.runId,
    threadId: b.run.threadId,
    protocol: b.run.protocol,
    ...(b.run.agentName !== undefined ? { agentName: b.run.agentName } : {}),
    status,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(startedAt !== undefined && endedAt !== undefined ? { durationMs: Math.max(0, endedAt - startedAt) } : {}),
    frameCount: b.run.frameCount,
    children: b.run.children,
  };
  return run;
}

// ---------------------------------------------------------------------------
// Queries over a built tree
// ---------------------------------------------------------------------------

/** Depth-first walk, parents before children. */
export function walkTree(node: ExecNode | RunNode, visit: (node: ExecNode | RunNode) => void): void {
  visit(node);
  for (const child of node.children) walkTree(child, visit);
}

export function collectTools(node: RunNode | ExecNode): readonly ToolCallNode[] {
  const out: ToolCallNode[] = [];
  walkTree(node, (visited) => {
    if (visited.kind === 'tool') out.push(visited);
  });
  return out;
}

export function collectSubAgents(node: RunNode | ExecNode): readonly SubAgentNode[] {
  const out: SubAgentNode[] = [];
  walkTree(node, (visited) => {
    if (visited.kind === 'subagent') out.push(visited);
  });
  return out;
}

/** Calls that will never resolve, or resolved from a start nobody saw. */
export function collectOrphans(node: RunNode | ExecNode): readonly ToolCallNode[] {
  return collectTools(node).filter((tool) => tool.status === 'orphan');
}

// ---------------------------------------------------------------------------
// Stable hashing
// ---------------------------------------------------------------------------

/**
 * Key-order-independent JSON, so two runs that serialised the same arguments in
 * a different order hash identically.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
}

/**
 * FNV-1a, 32-bit.
 *
 * Not a security hash and not trying to be: this only has to make an accidental
 * argument change visible as a different key in a diff, which a collision would
 * merely mis-label once.
 */
export function hashArgs(args: JsonObject): string {
  return fnv1a(stableStringify(args));
}

export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** True when a code came from the tracer rather than from an adapter. */
export function isTracerCode(code: string): boolean {
  return code.startsWith(TRACER_WARNING_PREFIX);
}

function seq(frame: SurfaceFrame): number {
  return typeof frame.seq === 'number' ? frame.seq : 0;
}

function ts(frame: SurfaceFrame): number {
  return typeof frame.ts === 'number' ? frame.ts : 0;
}
