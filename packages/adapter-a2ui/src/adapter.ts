/**
 * `ProtocolAdapter` implementation for A2UI.
 *
 * Responsibilities kept here rather than in the bridge: transport framing
 * (`seq`, correlation ids, JSONL vs batch envelope) and the outbound direction
 * (action encoding, optimistic local state). The bridge owns A2UI semantics.
 */

import {
  applyPatch,
  buildPointer,
  getAtPointer,
  parsePointer,
  setAtPointer,
  type ActionEvent,
  type AdapterInput,
  type DataModel,
  type EncodedAction,
  type JsonObject,
  type JsonPatchOperation,
  type JsonPointer,
  type JsonValue,
  type PatchOp,
  type ProtocolAdapter,
  type ProtocolId,
  type StatePatch,
  type SurfaceFrame,
  type UnstampedFrame,
} from '@agent-surface/protocol';
import { A2uiBridge, type BridgeOptions } from './bridge.js';
import { extractInlineCatalogs } from './catalog.js';
import { JsonlReader, type JsonlReaderOptions, type JsonlRecord } from './jsonl.js';
import { A2UI_PREFERRED_VERSION, A2UI_SUPPORTED_VERSIONS, collectMessages, type A2uiVersion } from './messages.js';

export interface A2uiAdapterOptions extends BridgeOptions {
  readonly jsonl?: JsonlReaderOptions;
  /**
   * `a2uiClientCapabilities` from the agent. Any `inlineCatalogs` it carries
   * are registered, which is how an agent that ships its own catalog is
   * supported without pre-configuration.
   */
  readonly agentCapabilities?: unknown;
  /**
   * Namespace for action-driven optimistic writes. Defaults to `_action`.
   * Underscore-prefixed so it can never collide with agent-owned data keys.
   */
  readonly localNamespace?: string;
}

/** Fallback pointer for an action that carries a value but no explicit path. */
const DEFAULT_ACTION_POINTER_TOKENS = ['_action'] as const;

export class A2uiAdapter implements ProtocolAdapter {
  readonly id: ProtocolId = 'a2ui';
  readonly supportedVersions: string[] = [...A2UI_SUPPORTED_VERSIONS];

  readonly #bridge: A2uiBridge;
  readonly #readers = new Map<string, JsonlReader>();
  readonly #jsonlOptions: JsonlReaderOptions;
  readonly #localNamespace: string;
  #seq = 0;
  /** Latest applied host-write revision per surface, for replay suppression. */
  readonly #revisions = new Map<string, number>();
  readonly #localData = new Map<string, DataModel>();
  #agentName = 'a2ui';

  constructor(options: A2uiAdapterOptions = {}) {
    const { jsonl, agentCapabilities, localNamespace, ...bridgeOptions } = options;
    this.#jsonlOptions = jsonl ?? {};
    this.#localNamespace = localNamespace ?? '_action';

    const rawCatalogs = [...(bridgeOptions.rawCatalogs ?? [])];
    for (const inline of extractInlineCatalogs(agentCapabilities)) {
      rawCatalogs.push(inline);
    }
    if (isJsonObjectLike(agentCapabilities) && typeof agentCapabilities['agentName'] === 'string') {
      this.#agentName = agentCapabilities['agentName'];
    }

    this.#bridge = new A2uiBridge({ ...bridgeOptions, rawCatalogs });
  }

  get bridge(): A2uiBridge {
    return this.#bridge;
  }

  get agentName(): string {
    return this.#agentName;
  }

  /**
   * Real `a2uiClientCapabilities`, generated once per supported version so the
   * agent can pick either. `A2uiClientCapabilities` is a union that allows both
   * keys to be present, and `getClientCapabilities` only ever returns one
   * version per call, so the versions are merged here.
   */
  getClientCapabilities(options?: { includeInlineCatalogs?: boolean }): JsonObject {
    const includeInlineCatalogs = options?.includeInlineCatalogs === true;
    const out: JsonObject = {};
    for (const version of A2UI_SUPPORTED_VERSIONS) {
      const caps = this.#bridge.processor.getClientCapabilities({ includeInlineCatalogs, version });
      const perVersion = caps[version];
      if (perVersion !== undefined) out[version] = toJsonObject(perVersion);
    }
    return out;
  }

  /**
   * Accepts a JSONL text chunk, a single message, a message array, or an
   * `A2uiMessageListWrapper`. Never throws.
   */
  ingest(input: AdapterInput): Iterable<SurfaceFrame> {
    const messages: unknown[] = [];
    const frames: SurfaceFrame[] = [];

    if (input.text !== undefined) {
      // The transport handed over the original text, so the streaming reader
      // owns line framing. A partial trailing line stays buffered until the
      // next chunk or until `flushTransport()`.
      const reader = this.#readerFor(input.threadId);
      for (const record of reader.push(input.text)) this.#pushRecord(record, messages, frames, input);
    } else if (input.raw !== undefined) {
      for (const message of collectMessages(input.raw)) messages.push(message);
    }

    for (const message of messages) this.#emit(this.#bridge.ingest(message), input, frames);
    return frames;
  }

  /**
   * Close the JSONL readers: emit a trailing line that arrived without its
   * newline, then any surface errors raised asynchronously.
   */
  flushTransport(options: { threadId?: string; runId?: string } = {}): SurfaceFrame[] {
    const runId = options.runId ?? '';
    const frames: SurfaceFrame[] = [];
    const targets =
      options.threadId === undefined ? [...this.#readers.keys()] : [options.threadId];

    for (const threadId of targets) {
      const reader = this.#readers.get(threadId);
      if (!reader) continue;
      this.#readers.delete(threadId);
      const messages: unknown[] = [];
      const input: AdapterInput = { threadId, runId };
      for (const record of reader.flush()) this.#pushRecord(record, messages, frames, input);
      for (const message of messages) this.#emit(this.#bridge.ingest(message), input, frames);
    }
    for (const frame of this.#bridge.drainPending()) {
      frames.push(this.#stamp(frame, { threadId: options.threadId ?? '', runId }));
    }
    return frames;
  }

  /**
   * Encode a user action as an A2UI client action message, plus a JSON Patch
   * for the optimistic local write.
   *
   * The data-model sync block is only attached for surfaces that opted into
   * `sendDataModel`, which is the same rule `getClientDataModel` applies.
   */
  encodeAction(action: ActionEvent): EncodedAction {
    const version = this.#bridge.version;
    const context: JsonObject = { ...(action.context ?? {}) };
    if (action.value !== undefined) context['value'] = action.value;

    const pointer = this.#actionPointer(action, context);
    const operations: JsonPatchOperation[] =
      action.value === undefined ? [] : [valueOp('add', pointer, action.value)];

    const surface = this.#bridge.processor.model.getSurface(action.surfaceId);
    const input: JsonObject = {
      version,
      action: {
        name: action.name,
        surfaceId: action.surfaceId,
        sourceComponentId: action.componentId,
        timestamp: new Date().toISOString(),
        context,
      },
    };
    if (surface?.sendDataModel === true) {
      const doc = this.#localData.get(action.surfaceId) ?? this.#bridge.snapshot(action.surfaceId)?.data ?? {};
      input['dataModel'] = { version, surfaces: { [action.surfaceId]: doc } };
    }

    return {
      protocol: this.id,
      input,
      patch: { threadId: '', runId: '', surfaceId: action.surfaceId, operations, revision: 0 },
    };
  }

  /**
   * Apply a host-owned write.
   *
   * Idempotent twice over: a revision at or below the last applied one for the
   * same surface is dropped outright, and the surviving write is an RFC 6902
   * `add`/`replace` at a fixed pointer, which overwrites rather than appends.
   *
   * `applyPatch` gates the write because it is the monorepo's single RFC 6902
   * implementation, shared with time-travel replay: an operation set that
   * replay would reject must not be applied locally either. It reports a
   * summary rather than the new document, so the document is advanced with the
   * same pointer helpers it uses internally.
   */
  applyLocalState(patch: StatePatch): void {
    const key = patch.surfaceId ?? '';
    const last = this.#revisions.get(key);
    if (last !== undefined && patch.revision <= last) return;

    const current = this.#localData.get(key) ?? this.#bridge.snapshot(key)?.data ?? {};
    const result = applyPatch(current, asPatchOps(patch.operations));
    if (!result.ok) return;

    if (result.applied > 0) {
      const next = applyOperations(structuredClone(current), asPatchOps(patch.operations));
      if (next !== undefined) this.#localData.set(key, next);
    }
    this.#revisions.set(key, patch.revision);
  }

  /** Local doc for a surface, for tests and optimistic-render assertions. */
  localData(surfaceId: string): DataModel | undefined {
    return this.#localData.get(surfaceId);
  }

  localRevision(surfaceId: string): number | undefined {
    return this.#revisions.get(surfaceId);
  }

  dispose(): void {
    this.#bridge.dispose();
    this.#readers.clear();
  }

  // -------------------------------------------------------------------------

  #readerFor(threadId: string): JsonlReader {
    let reader = this.#readers.get(threadId);
    if (!reader) {
      reader = new JsonlReader(this.#jsonlOptions);
      this.#readers.set(threadId, reader);
    }
    return reader;
  }

  #pushRecord(
    record: JsonlRecord,
    messages: unknown[],
    frames: SurfaceFrame[],
    input: AdapterInput,
  ): void {
    if (record.kind === 'json') {
      messages.push(record.value);
      return;
    }
    frames.push(
      this.#stamp(
        {
          kind: 'warning',
          payload: {
            code: record.code,
            message: `JSONL line ${record.line} is not valid JSON: ${record.error}`,
            detail: { line: record.line },
          },
        },
        input,
      ),
    );
  }

  #emit(unstamped: readonly UnstampedFrame[], input: AdapterInput, frames: SurfaceFrame[]): void {
    for (const frame of unstamped) frames.push(this.#stamp(frame, input));
  }

  #stamp(frame: UnstampedFrame, input: AdapterInput): SurfaceFrame {
    return {
      ...frame,
      seq: this.#seq++,
      source: this.id,
      ts: Date.now(),
      threadId: frame.threadId ?? input.threadId,
      runId: frame.runId ?? input.runId,
      ...(input.step !== undefined ? { step: input.step } : {}),
      ...(input.subagentRunId !== undefined ? { subagentRunId: input.subagentRunId } : {}),
    } as SurfaceFrame;
  }

  #actionPointer(action: ActionEvent, context: JsonObject): JsonPointer {
    const explicit = context['path'];
    if (typeof explicit === 'string' && explicit.length > 0) {
      // `context.path` is agent-authored, so it is normalised through
      // parse/build rather than trusted: that rejects a non-pointer string and
      // guarantees RFC 6901 escaping.
      try {
        return buildPointer(parsePointer(explicit));
      } catch {
        return buildPointer([...DEFAULT_ACTION_POINTER_TOKENS, 'invalid']);
      }
    }
    return buildPointer([...DEFAULT_ACTION_POINTER_TOKENS, action.componentId, action.name]);
  }
}

function removeAtPointer(doc: DataModel, pointer: JsonPointer): boolean {
  const tokens = parsePointer(pointer);
  const key = tokens[tokens.length - 1];
  if (key === undefined) return false;
  const parent = tokens.length > 1 ? getAtPointer(doc, buildPointer(tokens.slice(0, -1))) : doc;
  if (Array.isArray(parent)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) return false;
    parent.splice(index, 1);
    return true;
  }
  if (isJsonObjectLike(parent) && key in parent) {
    delete parent[key];
    return true;
  }
  return false;
}

/**
 * Advance a cloned document by an operation set already validated by
 * `applyPatch`. Returns undefined rather than throwing if a pointer turns out
 * to be unapplicable here, so a host write can never leave a partial document.
 */
function applyOperations(doc: DataModel, ops: readonly PatchOp[]): DataModel | undefined {
  try {
    for (const op of ops) {
      switch (op.op) {
        case 'add':
        case 'replace':
          setAtPointer(doc, op.path, structuredClone(op.value ?? null));
          break;
        case 'remove':
          if (!removeAtPointer(doc, op.path)) return undefined;
          break;
        case 'move': {
          const value = getAtPointer(doc, op.from);
          if (value === undefined) return undefined;
          if (!removeAtPointer(doc, op.from)) return undefined;
          setAtPointer(doc, op.path, structuredClone(value));
          break;
        }
        case 'copy': {
          const value = getAtPointer(doc, op.from);
          if (value === undefined) return undefined;
          setAtPointer(doc, op.path, structuredClone(value));
          break;
        }
        case 'test':
          break;
      }
    }
    return doc;
  } catch {
    return undefined;
  }
}

function isJsonObjectLike(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toJsonObject(value: unknown): JsonObject {
  if (!isJsonObjectLike(value)) return {};
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) out[key] = item as JsonValue;
  return out;
}

/** Version a caller should negotiate, newest first. */
export function preferredA2uiVersion(): A2uiVersion {
  return A2UI_PREFERRED_VERSION;
}

/**
 * Build a value-carrying JSON Patch operation.
 *
 * `ir.ts` declares `JsonPatchOperation` as `{op: 'add'|'replace'|'remove', path}`
 * with no `value`, while the implementation these ops are handed to --
 * `applyPatch` in `json-patch.ts` -- types its input as `PatchOp`, which *does*
 * carry `value?: JsonValue` for exactly these operations. The declared union
 * therefore cannot represent a value-carrying write, and a `StatePatch` for an
 * optimistic action has no type-level way to state what it is setting.
 *
 * The runtime contract is unambiguous, so the operation is built as a `PatchOp`
 * and widened at this single boundary. The alternative -- dropping `value` --
 * would make `encodeAction`'s patch a silent no-op.
 */
function valueOp(op: 'add' | 'replace', path: JsonPointer, value: JsonValue): JsonPatchOperation {
  return { op, path, value } as unknown as JsonPatchOperation;
}

/** Widen `StatePatch.operations` to the shape `applyPatch` actually consumes. */
function asPatchOps(operations: readonly JsonPatchOperation[]): readonly PatchOp[] {
  return operations as readonly PatchOp[];
}
