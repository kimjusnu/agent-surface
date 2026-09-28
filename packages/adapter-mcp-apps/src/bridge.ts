/**
 * Host side of the MCP Apps frame bridge.
 *
 * The frame is untrusted. Everything in this file is written from the
 * assumption that the peer is hostile until a message has been validated:
 *
 *   - the target origin is never `'*'`. It is either a validated absolute
 *     origin or the literal opaque origin, both of which a browser treats as
 *     an exact match, so a document that navigates itself elsewhere stops
 *     receiving host messages;
 *   - the `event.origin` of every inbound message is checked against the origin
 *     we believe the frame is running on, and `event.source` is checked against
 *     the frame's `contentWindow` when the host knows it;
 *   - every payload is parsed with zod and anything that fails is counted and
 *     dropped, never partially applied;
 *   - features the policy engine did not grant are refused at the bridge even
 *     if the app asks for them, so a policy bug cannot be undone by a chatty
 *     app;
 *   - every request has a deadline, and teardown rejects everything still in
 *     flight, so a frame that stops answering cannot leak a promise, a timer,
 *     or a listener past the end of a run.
 *
 * Message names follow the MCP Apps bridge where one exists
 * (`ui/initialize`, `ui/notifications/size-changed`, `tools/call`,
 * `ui/update-model-context`) so a conforming app can be wired to this host
 * without a translation layer.
 */

import { z } from 'zod';
import type { JsonObject, JsonPatchOperation, JsonValue } from '@agent-surface/protocol';
import { OPAQUE_ORIGIN } from './iframe-src.js';
import type { BridgeFeatures } from './policy.js';

export type Theme = 'light' | 'dark';

export interface BridgeMessageEvent {
  readonly data: unknown;
  readonly origin: string;
  readonly source?: unknown;
}

export interface BridgeWindow {
  addEventListener(type: 'message', listener: (event: BridgeMessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: BridgeMessageEvent) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
}

/**
 * A real `Window` is not structurally a {@link BridgeWindow} (its message
 * listener takes a DOM `Event`). One cast here keeps the bridge itself testable
 * against a plain object and free of any DOM dependency.
 */
export function asBridgeWindow(target: Window): BridgeWindow {
  return target as unknown as BridgeWindow;
}

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(jsonValueSchema)]),
);
const jsonObjectSchema = z.record(jsonValueSchema);

const patchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.enum(['add', 'replace', 'remove']), path: z.string(), value: jsonValueSchema.optional() }),
  z.object({ op: z.enum(['move', 'copy']), from: z.string(), path: z.string() }),
  z.object({ op: z.literal('test'), path: z.string(), value: jsonValueSchema }),
]);

const hostInitSchema = z.object({
  v: z.literal(1),
  dir: z.literal('host'),
  type: z.literal('init'),
  id: z.string().min(1),
  payload: z.object({
    appId: z.string(),
    bridgeVersion: z.enum(['0.1', '0.2']),
    maxFrameHeightPx: z.number().int().positive(),
    hostCapabilities: z.object({
      toolInvoke: z.boolean(),
      a2a: z.boolean(),
      heightResize: z.boolean(),
      openLinks: z.boolean(),
    }),
    hostContext: z.object({
      theme: z.enum(['light', 'dark']),
      locale: z.string().optional(),
      timeZone: z.string().optional(),
      dataModel: jsonObjectSchema.optional(),
    }),
  }),
});

const hostResizeSchema = z.object({
  v: z.literal(1),
  dir: z.literal('host'),
  type: z.literal('resize'),
  id: z.string().min(1),
  payload: z.object({ heightPx: z.number() }),
});

const hostThemeSchema = z.object({
  v: z.literal(1),
  dir: z.literal('host'),
  type: z.literal('theme'),
  id: z.string().min(1),
  payload: z.object({ theme: z.enum(['light', 'dark']) }),
});

export const hostMessageSchema = z.union([hostInitSchema, hostResizeSchema, hostThemeSchema]);

export type HostMessage = z.infer<typeof hostMessageSchema>;

const appReadySchema = z.object({
  v: z.literal(1),
  dir: z.literal('app'),
  type: z.literal('ready'),
  id: z.string().min(1).optional(),
  payload: z.object({ appName: z.string().optional(), bridgeVersion: z.enum(['0.1', '0.2']).optional() }),
});

const appHeightSchema = z.object({
  v: z.literal(1),
  dir: z.literal('app'),
  type: z.literal('height'),
  id: z.string().min(1).optional(),
  payload: z.object({ heightPx: z.number() }),
});

const appToolInvokeSchema = z.object({
  v: z.literal(1),
  dir: z.literal('app'),
  type: z.literal('toolInvoke'),
  id: z.string().min(1),
  payload: z.object({ toolName: z.string().min(1).max(200), args: jsonObjectSchema }),
});

const appStatePatchSchema = z.object({
  v: z.literal(1),
  dir: z.literal('app'),
  type: z.literal('statePatch'),
  id: z.string().min(1).optional(),
  payload: z.object({ operations: z.array(patchOpSchema).max(256) }),
});

const appErrorSchema = z.object({
  v: z.literal(1),
  dir: z.literal('app'),
  type: z.literal('error'),
  id: z.string().min(1).optional(),
  payload: z.object({ code: z.string().max(100).optional(), message: z.string().max(2000) }),
});

const appA2ASchema = z.object({
  v: z.literal(1),
  dir: z.literal('app'),
  type: z.literal('a2a'),
  id: z.string().min(1),
  payload: z.object({ to: z.string().min(1).max(200), text: z.string().max(16000) }),
});

export const appMessageSchema = z.union([
  appReadySchema,
  appHeightSchema,
  appToolInvokeSchema,
  appStatePatchSchema,
  appErrorSchema,
  appA2ASchema,
]);

export type AppMessage = z.infer<typeof appMessageSchema>;
export type AppMessageType = AppMessage['type'];

export type AppEventPayloads = {
  ready: z.infer<typeof appReadySchema>['payload'];
  height: z.infer<typeof appHeightSchema>['payload'];
  toolInvoke: z.infer<typeof appToolInvokeSchema>['payload'];
  statePatch: z.infer<typeof appStatePatchSchema>['payload'];
  error: z.infer<typeof appErrorSchema>['payload'];
  a2a: z.infer<typeof appA2ASchema>['payload'];
};

export type RejectionReason =
  | 'ORIGIN_MISMATCH'
  | 'SOURCE_MISMATCH'
  | 'INVALID_MESSAGE'
  | 'FEATURE_DISABLED'
  | 'POST_DESTROY';

export interface BridgeStats {
  accepted: number;
  rejectedOrigin: number;
  rejectedSource: number;
  rejectedInvalid: number;
  rejectedFeature: number;
  clampedHeights: number;
  timeouts: number;
}

export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

export class BridgeTimeoutError extends BridgeError {
  constructor(method: string, timeoutMs: number) {
    super('BRIDGE_TIMEOUT', `${method} did not answer within ${timeoutMs}ms`);
    this.name = 'BridgeTimeoutError';
  }
}

export class BridgeClosedError extends BridgeError {
  constructor(message = 'bridge was torn down') {
    super('BRIDGE_CLOSED', message);
    this.name = 'BridgeClosedError';
  }
}

export interface BridgeOptions {
  /** The frame's `contentWindow`. */
  targetWindow: BridgeWindow;
  /** Exact origin the frame is expected to run on. Never `'*'`. */
  expectedOrigin: string;
  /** The frame's `contentWindow`, when the host holds a reference to check `event.source` against. */
  expectedSource?: unknown;
  appId: string;
  features: BridgeFeatures;
  bridgeVersion?: '0.1' | '0.2';
  maxFrameHeightPx?: number;
  requestTimeoutMs?: number;
}

export interface InitContext {
  theme: Theme;
  locale?: string;
  timeZone?: string;
  dataModel?: JsonObject;
}

export const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 10_000;

/** Ceiling on a single `toolInvoke` argument payload forwarded to the MCP server. */
export const MAX_TOOL_ARG_BYTES = 64_000;

function oversized(value: unknown, maxBytes: number): boolean {
  try {
    return (JSON.stringify(value)?.length ?? 0) > maxBytes;
  } catch {
    return true;
  }
}

interface PendingRequest {
  method: HostMessage['type'];
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type EventHandler<K extends AppMessageType> = (payload: AppEventPayloads[K]) => void;

export class AppBridge {
  readonly #options: Required<Pick<BridgeOptions, 'targetWindow' | 'expectedOrigin' | 'appId' | 'features'>> &
    Omit<BridgeOptions, 'targetWindow' | 'expectedOrigin' | 'appId' | 'features'>;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #handlers = new Map<AppMessageType, Set<(payload: never) => void>>();
  readonly #rejections = new Set<(reason: RejectionReason, detail: string) => void>();
  readonly #listener: (event: BridgeMessageEvent) => void;
  readonly #maxFrameHeightPx: number;
  readonly #requestTimeoutMs: number;
  #nextId = 0;
  #destroyed = false;
  #ready = false;
  #stats: BridgeStats = {
    accepted: 0,
    rejectedOrigin: 0,
    rejectedSource: 0,
    rejectedInvalid: 0,
    rejectedFeature: 0,
    clampedHeights: 0,
    timeouts: 0,
  };

  constructor(options: BridgeOptions) {
    if (options.expectedOrigin === '*') {
      throw new Error('AppBridge refuses a "*" expected origin: the bridge must know exactly which document it is talking to');
    }
    this.#options = { bridgeVersion: '0.1', ...options };
    this.#maxFrameHeightPx = options.maxFrameHeightPx ?? 2000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS;
    this.#listener = (event) => this.#onMessage(event);
    this.#options.targetWindow.addEventListener('message', this.#listener);
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  get ready(): boolean {
    return this.#ready;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get stats(): Readonly<BridgeStats> {
    return { ...this.#stats };
  }

  get targetOrigin(): string {
    return this.#options.expectedOrigin;
  }

  on<K extends AppMessageType>(type: K, handler: EventHandler<K>): () => void {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(handler as (payload: never) => void);
    return () => {
      set?.delete(handler as (payload: never) => void);
    };
  }

  /** Observe every message the bridge refused. The audit trail SEP-1865 asks for. */
  onRejected(handler: (reason: RejectionReason, detail: string) => void): () => void {
    this.#rejections.add(handler);
    return () => {
      this.#rejections.delete(handler);
    };
  }

  /** `ui/initialize`. Resolves once the app answers with `ready`. */
  init(context: InitContext, timeoutMs?: number): Promise<AppEventPayloads['ready']> {
    return this.request(
      'init',
      {
        appId: this.#options.appId,
        bridgeVersion: this.#options.bridgeVersion ?? '0.1',
        maxFrameHeightPx: this.#maxFrameHeightPx,
        hostCapabilities: {
          toolInvoke: this.#options.features.toolInvoke,
          a2a: this.#options.features.a2a,
          heightResize: this.#options.features.heightResize,
          openLinks: false,
        },
        hostContext: {
          theme: context.theme,
          ...(context.locale !== undefined ? { locale: context.locale } : {}),
          ...(context.timeZone !== undefined ? { timeZone: context.timeZone } : {}),
          ...(context.dataModel !== undefined ? { dataModel: context.dataModel } : {}),
        },
      },
      timeoutMs,
    ) as Promise<AppEventPayloads['ready']>;
  }

  /** Push a hard height the app should honor (`ui/notifications/container-dimensions`). */
  setFrameHeight(heightPx: number): Promise<unknown> {
    if (!this.#options.features.heightResize) {
      return Promise.reject(new BridgeError('FEATURE_DISABLED', 'heightResize was not granted by policy'));
    }
    return this.request('resize', { heightPx: this.#clampHeight(heightPx) });
  }

  setTheme(theme: Theme): Promise<unknown> {
    return this.request('theme', { theme });
  }

  /** Correlation-id request. Rejects on timeout, on app error, and on teardown. */
  request(method: HostMessage['type'], payload: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.#destroyed) return Promise.reject(new BridgeClosedError());
    const id = `host-${++this.#nextId}`;
    const message = { v: 1, dir: 'host', type: method, id, payload } as unknown;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.#stats = { ...this.#stats, timeouts: this.#stats.timeouts + 1 };
        reject(new BridgeTimeoutError(method, timeoutMs ?? this.#requestTimeoutMs));
      }, timeoutMs ?? this.#requestTimeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.#post(message);
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err instanceof Error ? err : new BridgeError('POST_FAILED', String(err)));
      }
    });
  }

  /**
   * Remove the listener, clear every timer, and reject everything in flight.
   * After this returns the bridge holds no reference to the frame, so a run that
   * is torn down cannot leak into the next one.
   */
  destroy(reason = 'host tore down the frame'): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#ready = false;
    this.#options.targetWindow.removeEventListener('message', this.#listener);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeClosedError(reason));
    }
    this.#pending.clear();
    this.#handlers.clear();
    this.#rejections.clear();
  }

  // -------------------------------------------------------------------------

  #post(message: unknown): void {
    this.#options.targetWindow.postMessage(message, this.#options.expectedOrigin);
  }

  #clampHeight(heightPx: number): number {
    if (!Number.isFinite(heightPx) || heightPx <= 0) {
      this.#stats = { ...this.#stats, clampedHeights: this.#stats.clampedHeights + 1 };
      return Math.min(80, this.#maxFrameHeightPx);
    }
    if (heightPx > this.#maxFrameHeightPx) {
      this.#stats = { ...this.#stats, clampedHeights: this.#stats.clampedHeights + 1 };
      return this.#maxFrameHeightPx;
    }
    return Math.floor(heightPx);
  }

  #reject(reason: RejectionReason, detail: string): void {
    switch (reason) {
      case 'ORIGIN_MISMATCH':
        this.#stats = { ...this.#stats, rejectedOrigin: this.#stats.rejectedOrigin + 1 };
        break;
      case 'SOURCE_MISMATCH':
        this.#stats = { ...this.#stats, rejectedSource: this.#stats.rejectedSource + 1 };
        break;
      case 'INVALID_MESSAGE':
        this.#stats = { ...this.#stats, rejectedInvalid: this.#stats.rejectedInvalid + 1 };
        break;
      default:
        this.#stats = { ...this.#stats, rejectedFeature: this.#stats.rejectedFeature + 1 };
        break;
    }
    for (const handler of this.#rejections) handler(reason, detail);
  }

  #onMessage(event: BridgeMessageEvent): void {
    if (this.#destroyed) {
      this.#reject('POST_DESTROY', 'message arrived after teardown');
      return;
    }
    if (this.#options.expectedOrigin !== event.origin) {
      this.#reject('ORIGIN_MISMATCH', `expected ${this.#options.expectedOrigin}, got ${event.origin}`);
      return;
    }
    const expectedSource = this.#options.expectedSource;
    if (expectedSource !== undefined && event.source !== expectedSource) {
      this.#reject('SOURCE_MISMATCH', 'message did not come from the frame window');
      return;
    }

    const parsed = appMessageSchema.safeParse(event.data);
    if (!parsed.success) {
      this.#reject('INVALID_MESSAGE', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    const message = parsed.data;

    if (message.type === 'toolInvoke' && oversized(message.payload.args, MAX_TOOL_ARG_BYTES)) {
      // The frame is untrusted and unbounded: a 500 MB `arguments` object would
      // otherwise be handed straight to the MCP server and to any UI that renders
      // the call. The bridge is the only place that sees the raw payload, so the
      // cap has to live here.
      this.#reject('INVALID_MESSAGE', `toolInvoke args exceed ${MAX_TOOL_ARG_BYTES} bytes`);
      return;
    }

    if (message.type === 'toolInvoke' && !this.#options.features.toolInvoke) {
      this.#reject('FEATURE_DISABLED', `toolInvoke refused: policy did not grant it (${message.payload.toolName})`);
      return;
    }
    if (message.type === 'a2a' && !this.#options.features.a2a) {
      this.#reject('FEATURE_DISABLED', `a2a refused: policy did not grant it (${message.payload.to})`);
      return;
    }
    if (message.type === 'height' && !this.#options.features.heightResize) {
      this.#reject('FEATURE_DISABLED', 'height refused: policy did not grant heightResize');
      return;
    }
    if (message.type === 'statePatch' && !this.#options.features.postMessage) {
      this.#reject('FEATURE_DISABLED', 'statePatch refused: the bridge is disabled');
      return;
    }

    this.#stats = { ...this.#stats, accepted: this.#stats.accepted + 1 };
    // `ready` is what flips the bridge on, and it is also dispatched below, so
    // a handler registered before `init()` still sees it exactly once.
    if (message.type === 'ready') this.#ready = true;

    const id = message.id;
    if (id !== undefined) {
      const pending = this.#pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        if (message.type === 'error') {
          pending.reject(new BridgeError(message.payload.code ?? 'APP_ERROR', message.payload.message));
        } else {
          pending.resolve(message.payload);
        }
      }
    }

    if (message.type === 'height') {
      this.#emit('height', { heightPx: this.#clampHeight(message.payload.heightPx) });
      return;
    }
    this.#emit(message.type, message.payload);
  }

  #emit<K extends AppMessageType>(type: K, payload: AppEventPayloads[K]): void {
    const set = this.#handlers.get(type);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as EventHandler<K>)(payload);
      } catch {
        /* an app-side handler that throws must not break message handling */
      }
    }
  }
}

/** The origin a postMessage target must use for a frame decision. */
export function postMessageTargetFor(frameOrigin: string): string {
  if (frameOrigin === OPAQUE_ORIGIN) return OPAQUE_ORIGIN;
  try {
    return new URL(frameOrigin).origin;
  } catch {
    throw new Error(`AppBridge: "${frameOrigin}" is not a usable postMessage target; refusing to fall back to "*"`);
  }
}
