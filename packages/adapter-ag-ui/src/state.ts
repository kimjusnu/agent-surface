/**
 * Internal state the adapter keeps between events: the agent's state document,
 * the tool calls currently streaming arguments, the text messages currently
 * buffering fragments, and the names of subagent invocations.
 *
 * Split out of `adapter.ts` because none of it is IR-facing -- it exists so the
 * adapter can answer "which message was that fragment for?" and "did this tool
 * error?" on an event that carries neither answer by itself.
 */

import type { TokenUsage } from '@ag-ui/core';
import { applyPatch, getAtPointer, setAtPointer } from '@agent-surface/protocol';
import type { DataModel, JsonObject, JsonPatchOperation, JsonValue, Usage } from '@agent-surface/protocol';

/**
 * A JSON Patch operation bound to this adapter's document.
 *
 * Structurally identical to the IR's `JsonPatchOperation`; the alias exists so
 * internal call sites read as patch operations without restating the union.
 */
export type DraftPatchOperation = JsonPatchOperation;

/** A tool call whose arguments are still arriving. */
export interface OpenToolCall {
  toolCallId: string;
  toolName: string;
  parentMessageId: string | undefined;
  /** Raw argument text, concatenated from TOOL_CALL_ARGS / TOOL_CALL_CHUNK. */
  argsText: string;
  /** Adapter clock reading when the call opened, for `tool.result.durationMs`. */
  startedAt: number;
}

/** A text message that is still accepting fragments. */
export interface OpenMessage {
  messageId: string;
  role: string;
  text: string;
}

/** Outcome of a patch applied to the state document. */
export interface PatchOutcome {
  ok: boolean;
  applied: number;
  error?: { index: number; code: string; message: string };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a value is representable in the IR's closed `JsonValue` type.
 *
 * AG-UI declares `State`, `Metadata` and `CustomEvent.value` as `any`, so
 * nothing upstream stops a producer sending a function, a `Date`, or a circular
 * reference. The IR is closed, so the boundary needs a real check rather than a
 * cast that would push the fault into the renderer.
 */
export function isJsonValue(value: unknown, seen: Set<object> = new Set()): value is JsonValue {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(value);
  if (t !== 'object') return false;
  const obj = value as object;
  if (seen.has(obj)) return false;
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return obj.every((v) => isJsonValue(v, seen));
    // `toJSON` and prototype-polluting keys are excluded: the IR's JsonObject
    // is a plain bag of values, and a Date reaching it would render as {}.
    if (!isPlainObject(obj) || Object.getPrototypeOf(obj) !== Object.prototype) return false;
    if ('toJSON' in obj) return false;
    return Object.entries(obj).every(([k, v]) => k !== '__proto__' && isJsonValue(v, seen));
  } finally {
    seen.delete(obj);
  }
}

/**
 * Like {@link toJsonValue} but returns undefined for anything that is not a
 * plain JSON object, falling back to a JSON round trip for the values AG-UI
 * declares as `any`.
 *
 * A structural cast is not enough: AG-UI's message and state types are
 * interfaces with open `any` payloads, so they are not assignable to the IR's
 * index-signature `JsonObject` and a cast would only silence the compiler. The
 * round trip is also the one place where a non-JSON value (a function, a bigint,
 * a cycle) fails loudly, at the protocol boundary, instead of deep inside a
 * renderer.
 */
export function toJsonObject(value: unknown): JsonObject {
  if (isJsonValue(value) && isPlainObject(value)) {
    return structuredClone(value) as JsonObject;
  }
  const cloned = structuredClone(JSON.parse(JSON.stringify(value ?? null)) as unknown);
  return isPlainObject(cloned) ? (cloned as JsonObject) : { value: cloned as JsonValue };
}

/** Like {@link toJsonObject} but keeps arrays and primitives as-is. */
export function toJsonValue(value: unknown): JsonValue | undefined {
  return isJsonValue(value) ? structuredClone(value) : undefined;
}

/**
 * A `ToolMessage` worth remembering, so its `error` can flag the matching
 * result. Only the flag is kept: the result event carries its own content, and
 * holding a second copy of a tool's output would double the memory a long run
 * spends on text nobody reads.
 */
export interface TrackedToolMessage {
  toolCallId: string;
  error: string | undefined;
}

/**
 * State for one thread. Run-scoped accumulators are reset on `RUN_STARTED`; the
 * state document deliberately is not, because the IR's `StatePatch` is keyed by
 * `threadId` and an agent that wants a fresh document sends a STATE_SNAPSHOT.
 */
export class ThreadState {
  #doc: DataModel = {};
  /** Highest host-side revision applied. Guards replay of a stale patch. */
  #revision = 0;

  readonly toolCalls = new Map<string, OpenToolCall>();
  readonly messages = new Map<string, OpenMessage>();
  readonly subagentNames = new Map<string, string>();
  readonly toolMessages = new Map<string, TrackedToolMessage>();
  /** Open time per tool call, retained after the call closes. */
  readonly toolCallStarts = new Map<string, number>();

  /** The message currently accepting fragments, for chunk events with no id. */
  openMessageId: string | undefined;
  /** The tool call currently accepting arguments, for chunk events with no id. */
  openToolCallId: string | undefined;
  stepCount = 0;

  get document(): DataModel {
    return this.#doc;
  }

  get revision(): number {
    return this.#revision;
  }

  /** Bump and return the next host-write revision. */
  nextRevision(): number {
    this.#revision += 1;
    return this.#revision;
  }

  /**
   * Record the revision a host patch declared, without inventing a new one.
   * Taking the caller's number rather than incrementing is what makes replay
   * detection work: the caller owns the ordering, and an adapter that bumped it
   * itself would reject the next patch as stale.
   */
  adoptRevision(revision: number): void {
    if (Number.isFinite(revision) && revision > this.#revision) this.#revision = revision;
  }

  /** Replace the document wholesale, as AG-UI's STATE_SNAPSHOT specifies. */
  setDocument(doc: DataModel): void {
    this.#doc = doc;
  }

  /**
   * Apply RFC 6902 operations to the document.
   *
   * `applyPatch` from the protocol package is the validator, and it is
   * deliberately non-mutating: it clones its target, applies atomically, and
   * returns a `PatchResult` that does not carry the resulting document. So it
   * decides *whether* the patch applies -- giving us RFC-correct "all or
   * nothing" and the `test` semantics for free -- and the same operations are
   * then mirrored into a fresh document with the shared pointer helpers, so the
   * adapter's document is never the caller's object by reference.
   */
  applyOperations(ops: readonly DraftPatchOperation[]): PatchOutcome {
    const probe = applyPatch(this.#doc, ops);
    if (!probe.ok) {
      return { ok: false, applied: probe.applied, ...(probe.error ? { error: probe.error } : {}) };
    }
    const next = structuredClone(this.#doc) as DataModel;
    for (const op of ops) mutateInPlace(next, op);
    this.#doc = next;
    return { ok: true, applied: probe.applied };
  }

  /** Read a value out of the document, for building messages back to the agent. */
  read(pointer: string): unknown {
    return getAtPointer(this.#doc, pointer);
  }

  /** Drop every run-scoped accumulator. The state document survives. */
  beginRun(): void {
    this.reset();
  }

  private reset(): void {
    this.toolCalls.clear();
    this.messages.clear();
    this.subagentNames.clear();
    this.toolMessages.clear();
    this.toolCallStarts.clear();
    this.openMessageId = undefined;
    this.openToolCallId = undefined;
    this.stepCount = 0;
  }

  /**
   * Detach and return every stream still open, so the caller can publish the
   * text and arguments accumulated so far.
   *
   * AG-UI's own `transformChunks` middleware does not synthesise
   * `TEXT_MESSAGE_END` / `TOOL_CALL_END` per chunk: it holds the lane open and
   * closes it at the next run boundary. Without this, a run that ends mid-stream
   * would silently lose its last words, and a `text.done` that never arrives
   * leaves a renderer showing an append-only string forever.
   */
  takeOpenStreams(): { messages: OpenMessage[]; toolCalls: OpenToolCall[] } {
    const messages = [...this.messages.values()];
    const toolCalls = [...this.toolCalls.values()];
    this.messages.clear();
    this.toolCalls.clear();
    this.openMessageId = undefined;
    this.openToolCallId = undefined;
    return { messages, toolCalls };
  }

  /**
   * Install a fresh buffer for a message id, returning the one it displaced.
   *
   * Replacing rather than reusing is what keeps a reused id from concatenating
   * two producers' text into one transcript entry; the caller publishes the
   * displaced buffer so nothing is lost.
   */
  openMessage(messageId: string, role = 'assistant'): { message: OpenMessage; replaced: OpenMessage | undefined } {
    const replaced = this.messages.get(messageId);
    const message: OpenMessage = { messageId, role, text: '' };
    this.messages.set(messageId, message);
    this.openMessageId = messageId;
    return { message, replaced };
  }

  /**
   * Find the message a fragment belongs to. A `TEXT_MESSAGE_CONTENT` names its
   * message explicitly; a `TEXT_MESSAGE_CHUNK` may omit the id, in which case
   * the protocol says it continues the message already open.
   */
  resolveMessage(messageId: string | undefined): OpenMessage | undefined {
    if (messageId !== undefined) return this.messages.get(messageId);
    if (this.openMessageId === undefined) return undefined;
    return this.messages.get(this.openMessageId);
  }

  closeMessage(messageId: string): OpenMessage | undefined {
    const message = this.messages.get(messageId);
    this.messages.delete(messageId);
    if (this.openMessageId === messageId) this.openMessageId = undefined;
    return message;
  }

  openToolCall(
    toolCallId: string,
    toolName: string,
    parentMessageId: string | undefined,
    now: number,
  ): OpenToolCall {
    const call: OpenToolCall = { toolCallId, toolName, parentMessageId, argsText: '', startedAt: now };
    this.toolCalls.set(toolCallId, call);
    this.toolCallStarts.set(toolCallId, now);
    this.openToolCallId = toolCallId;
    return call;
  }

  /** As with messages: a chunk may omit the id and continue the open call. */
  resolveToolCall(toolCallId: string | undefined): OpenToolCall | undefined {
    if (toolCallId !== undefined) return this.toolCalls.get(toolCallId);
    if (this.openToolCallId === undefined) return undefined;
    return this.toolCalls.get(this.openToolCallId);
  }

  closeToolCall(toolCallId: string): OpenToolCall | undefined {
    const call = this.toolCalls.get(toolCallId);
    this.toolCalls.delete(toolCallId);
    if (this.openToolCallId === toolCallId) this.openToolCallId = undefined;
    return call;
  }

  /**
   * When a call opened, kept after the call closes. `TOOL_CALL_RESULT` routinely
   * arrives after `TOOL_CALL_END`, so the start time has to outlive the open call
   * for `tool.result.durationMs` to mean anything.
   */
  toolCallStartedAt(toolCallId: string): number | undefined {
    return this.toolCallStarts.get(toolCallId);
  }

  trackToolMessage(message: TrackedToolMessage): void {
    this.toolMessages.set(message.toolCallId, message);
  }
}

/**
 * Mirror of `applyPatch`'s mutation step, built on the protocol's pointer
 * helpers so the adapter cannot drift from the applier's semantics. Only the
 * ops `applyPatch` already accepted can reach here.
 */
function mutateInPlace(doc: DataModel, op: DraftPatchOperation): void {
  switch (op.op) {
    case 'add':
    case 'replace':
      setAtPointer(doc, op.path, structuredClone(op.value));
      break;
    case 'remove': {
      const parentPath = op.path.slice(0, op.path.lastIndexOf('/')) || '';
      const key = op.path.slice(op.path.lastIndexOf('/') + 1);
      const parent = getAtPointer(doc, parentPath);
      if (Array.isArray(parent)) {
        const index = Number(key);
        if (Number.isInteger(index)) parent.splice(index, 1);
      } else if (isPlainObject(parent)) {
        delete parent[key];
      }
      break;
    }
    case 'move': {
      const value = structuredClone(getAtPointer(doc, op.from));
      mutateInPlace(doc, { op: 'remove', path: op.from });
      setAtPointer(doc, op.path, value);
      break;
    }
    case 'copy': {
      const value = structuredClone(getAtPointer(doc, op.from));
      setAtPointer(doc, op.path, value);
      break;
    }
    case 'test':
      break;
  }
}

/**
 * Aggregate AG-UI's `TokenUsage[]` into the IR's single `Usage` record.
 *
 * AG-UI reports one entry per (provider, model) and states that the entries add
 * up without double-counting, with a consumer that wants totals summing across
 * them -- which is exactly this. `cacheWriteInputTokens` and `totalTokens` have
 * no field in the IR's `Usage`, so they are dropped here and the untouched
 * array stays on the frame's `raw` for the cost layer to read.
 */
export function aggregateUsage(entries: readonly TokenUsage[] | undefined): Usage | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let reasoningTokens = 0;
  let sawInput = false;
  let sawOutput = false;
  let sawCached = false;
  let sawReasoning = false;

  for (const entry of entries) {
    if (typeof entry?.inputTokens === 'number') {
      inputTokens += entry.inputTokens;
      sawInput = true;
    }
    if (typeof entry?.outputTokens === 'number') {
      outputTokens += entry.outputTokens;
      sawOutput = true;
    }
    if (typeof entry?.cachedInputTokens === 'number') {
      cachedInputTokens += entry.cachedInputTokens;
      sawCached = true;
    }
    if (typeof entry?.reasoningTokens === 'number') {
      reasoningTokens += entry.reasoningTokens;
      sawReasoning = true;
    }
  }

  if (!sawInput && !sawOutput && !sawCached && !sawReasoning) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(sawCached ? { cachedInputTokens } : {}),
    ...(sawReasoning ? { reasoningTokens } : {}),
  };
}
