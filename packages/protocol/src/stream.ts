/**
 * Adapter runtime: ordering, transport-agnostic streaming, and the registry.
 *
 * The host never calls `adapter.ingest` directly. It pushes raw transport
 * units through a `SurfaceStream`, which guarantees a total order, isolates
 * adapter exceptions, and fans out to subscribers.
 */

import type {
  ActionEvent,
  AdapterInput,
  EncodedAction,
  FramePayloadMap,
  FrameKind,
  JsonObject,
  ProtocolAdapter,
  ProtocolId,
  ProtocolSupport,
  StatePatch,
  SurfaceFrame,
  UnstampedFrame,
} from './ir.js';
import { IR_VERSION } from './ir.js';

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

export type FrameListener = (frame: SurfaceFrame) => void;
export type Unsubscribe = () => void;

/**
 * Total-ordered fan-out of normalized frames.
 *
 * Ordering rules:
 *  - `seq` is assigned by the stream, not the adapter, and is gap-free.
 *  - A frame that throws during fan-out is caught and reported as an `error`
 *    frame so one bad subscriber cannot kill the run.
 */
export class SurfaceStream {
  #seq = 0;
  readonly #listeners = new Set<FrameListener>();
  readonly #protocol: ProtocolId;
  readonly #threadId: string;
  readonly #runId: string;
  #closed = false;

  constructor(protocol: ProtocolId, threadId: string, runId: string) {
    this.#protocol = protocol;
    this.#threadId = threadId;
    this.#runId = runId;
  }

  get protocol(): ProtocolId {
    return this.#protocol;
  }
  get threadId(): string {
    return this.#threadId;
  }
  get runId(): string {
    return this.#runId;
  }
  get closed(): boolean {
    return this.#closed;
  }

  subscribe(listener: FrameListener): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Push raw transport units through an adapter. Never throws: adapter faults
   * become `error` frames.
   */
  push(adapter: ProtocolAdapter, input: AdapterInput): void {
    if (this.#closed) return;
    let frames: Iterable<SurfaceFrame>;
    try {
      frames = adapter.ingest(input);
    } catch (err) {
      this.emit({
        kind: 'error',
        payload: {
          code: 'ADAPTER_THREW',
          message: err instanceof Error ? err.message : String(err),
          fatal: true,
        },
      });
      this.close();
      return;
    }
    for (const frame of frames) this.emit(frame);
  }

  /**
   * Emit a frame, stamping sequence and correlation ids.
   *
   * `seq` is owned by the stream: any value an adapter supplied is ignored, so
   * ordering cannot be corrupted by a misbehaving or third-party adapter.
   */
  emit(partial: UnstampedFrame): void {
    if (this.#closed && partial.kind !== 'run.finished') return;
    // Any `seq` an adapter supplied is discarded: ordering is the stream's
    // responsibility, so a third-party adapter cannot corrupt it.
    const { seq: _ignoredSeq, ...rest } = partial as UnstampedFrame & { seq?: number };
    const frame: SurfaceFrame = {
      ...rest,
      seq: this.#seq++,
      source: rest.source ?? this.#protocol,
      ts: rest.ts ?? Date.now(),
      threadId: rest.threadId ?? this.#threadId,
      runId: rest.runId ?? this.#runId,
    } as SurfaceFrame;

    for (const listener of this.#listeners) {
      try {
        listener(frame);
      } catch (err) {
        // Report asynchronously: emitting an error frame inline would recurse
        // into the very listeners that just failed.
        queueMicrotask(() => {
          this.#emitListenerError(err);
        });
      }
    }
    if (frame.kind === 'run.finished') this.close();
  }

  /** Convenience for the `payload` map's narrower variants. */
  emitPayload<K extends FrameKind>(kind: K, payload: FramePayloadMap[K], extra?: Partial<SurfaceFrame>): void {
    this.emit({ kind, payload, ...extra } as never);
  }

  #emitListenerError(err: unknown): void {
    const frame: SurfaceFrame = {
      seq: this.#seq++,
      kind: 'error',
      source: this.#protocol,
      ts: Date.now(),
      threadId: this.#threadId,
      runId: this.#runId,
      payload: {
        code: 'SUBSCRIBER_THREW',
        message: err instanceof Error ? err.message : String(err),
        fatal: false,
      },
    };
    for (const listener of this.#listeners) {
      try {
        listener(frame);
      } catch {
        /* A subscriber that fails on the error frame is ignored. */
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
  }

  /** Build a stream plus a running total of frames seen, for the tracer. */
  collect(): { frames: SurfaceFrame[]; unsubscribe: Unsubscribe } {
    const frames: SurfaceFrame[] = [];
    const unsubscribe = this.subscribe((f) => {
      frames.push(f);
    });
    return { frames, unsubscribe };
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface AdapterRegistryOptions {
  adapters: ProtocolAdapter[];
  /** Protocols the host is willing to negotiate. */
  enabled?: ProtocolId[];
}

/**
 * Holds one instance of each adapter and negotiates capabilities.
 *
 * Adapters are stateful (streaming tool args, open surfaces), so a registry
 * must not be shared across concurrent runs -- construct one per connection.
 */
export class AdapterRegistry {
  readonly #byId = new Map<ProtocolId, ProtocolAdapter>();
  readonly #enabled: Set<ProtocolId>;

  constructor(options: AdapterRegistryOptions) {
    for (const adapter of options.adapters) this.#byId.set(adapter.id, adapter);
    this.#enabled = new Set(options.enabled ?? [...this.#byId.keys()]);
  }

  get(id: ProtocolId): ProtocolAdapter {
    const adapter = this.#byId.get(id);
    if (!adapter) throw new Error(`No adapter registered for protocol: ${id}`);
    if (!this.#enabled.has(id)) throw new Error(`Protocol not enabled: ${id}`);
    return adapter;
  }

  has(id: ProtocolId): boolean {
    return this.#byId.has(id) && this.#enabled.has(id);
  }

  /** Advertised to the agent so it can pick an interaction model. */
  capabilities(): {
    irVersion: typeof IR_VERSION;
    protocols: ProtocolSupport[];
  } {
    const protocols: ProtocolSupport[] = [...this.#byId.values()]
      .filter((a) => this.#enabled.has(a.id))
      .map((a) => ({
        id: a.id,
        supported: true,
        versions: [...a.supportedVersions],
        supportsEmbeddedApps: a.id === 'mcp-apps',
        supportsBidirectionalState: a.id !== 'mcp-apps',
      }));
    return { irVersion: IR_VERSION, protocols };
  }

  /** Full capability payload for a single protocol, as the agent expects it. */
  clientCapabilities(id: ProtocolId, options?: { includeInlineCatalogs?: boolean }): JsonObject {
    return this.get(id).getClientCapabilities(options);
  }
}

// ---------------------------------------------------------------------------
// Action round-trip helpers
// ---------------------------------------------------------------------------

/**
 * Encode a user action through a registry. Returns null when the protocol has
 * no way to express it (e.g. an MCP App that did not opt into the bridge), so
 * the caller can surface a "not supported" affordance instead of silently
 * dropping the interaction.
 */
export function encodeAction(
  registry: AdapterRegistry,
  protocol: ProtocolId,
  action: ActionEvent,
): EncodedAction | null {
  if (!registry.has(protocol)) return null;
  return registry.get(protocol).encodeAction(action);
}

export function applyLocalState(registry: AdapterRegistry, protocol: ProtocolId, patch: StatePatch): void {
  registry.get(protocol).applyLocalState(patch);
}
