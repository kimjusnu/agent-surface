/**
 * Surface IR (Intermediate Representation)
 * ----------------------------------------
 * Every inbound agent protocol (AG-UI, A2UI, MCP Apps) is normalized into a
 * single `SurfaceFrame` stream. The renderer never learns which protocol
 * produced a frame; the adapters never learn anything about React.
 *
 * This file is the contract for the whole monorepo. Change it only with a
 * migration plan -- every package depends on these exact shapes.
 */

export const IR_VERSION = '0.1' as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** JSON Pointer (RFC 6901) used for data-binding paths. */
export type JsonPointer = string;

/** A reference to a data-model location, possibly with a relative base. */
export interface DataRef {
  /** Absolute or relative pointer into the surface data model. */
  pointer: JsonPointer;
  /**
   * When true, the pointer resolves against the nearest ancestor that holds a
   * matching value, instead of the surface root. Corresponds to A2UI's
   * relative-path semantics.
   */
  relative?: boolean;
}

export type Literal =
  | { kind: 'literal'; value: JsonValue }
  | { kind: 'data'; ref: DataRef }
  /** Agent-authored template string containing `{{ pointer }}` holes. */
  | { kind: 'template'; template: string }
  | { kind: 'binding'; /** Rendered lazily; renderer may substitute a fallback. */ fallback?: JsonValue };

// ---------------------------------------------------------------------------
// Component tree
// ---------------------------------------------------------------------------

/**
 * A node in a declarative surface. Deliberately NOT a raw protocol payload:
 * component names are already resolved to catalog component ids, and every
 * property is a `Literal` rather than a bare JSON value.
 */
export interface SurfaceNode {
  /** Catalog component id (e.g. `Text`, `Card`). Validated against the catalog. */
  component: string;
  /** Stable id used for event wiring back to the agent. */
  id?: string;
  /** Literal-valued props after binding extraction. */
  props?: Record<string, Literal>;
  /**
   * Children. Mixed form is allowed: an id string refers to another node in the
   * same surface (A2UI's `ref` indirection), an inline node is nested directly.
   */
  children?: SurfaceNode[];
  /** Named child slots, e.g. `{ header: <node> }`. */
  slots?: Record<string, SurfaceNode | string>;
  /**
   * Marks a node as coming from an untrusted source. The sandbox layer refuses
   * to render these without a policy decision; see `@agent-surface/sandbox`.
   */
  untrusted?: boolean;
}

export type DataModel = JsonObject;

// ---------------------------------------------------------------------------
// Interactive (agent-owned) surfaces -- MCP Apps
// ---------------------------------------------------------------------------

/**
 * A self-contained UI delivered by an MCP server, rendered inside an isolated
 * frame. Kept in the same IR as declarative nodes so a transcript can mix both
 * without the renderer branching on protocol.
 */
export interface EmbeddedApp {
  /** Stable id for the app instance. */
  id: string;
  /** Display name shown in the frame chrome. */
  title: string;
  /** Document URL or data/blob URL served to the iframe. */
  src: string;
  /** Sandbox posture. Anything but `sandboxed` requires an explicit allow. */
  sandbox:
    | 'sandboxed'
    | 'sandboxed-forms'
    | 'sandboxed-scripts'
    | 'allow-scripts-same-origin'
    | 'allow-same-origin'
    | 'allow-all';
  /** Initial height in px; the frame may grow to fit content. */
  height?: number;
  /** Bridge version negotiated with the app. */
  bridgeVersion?: '0.1' | '0.2';
  /** Which channel the app uses to talk back to the host. */
  transport?: 'postmessage' | 'a2a';
  untrusted: true;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export type FrameKind =
  /** First frame of a run: capabilities, catalog, initial state. */
  | 'run.started'
  /** A partial assistant message, appended to by delta frames. */
  | 'text.delta'
  /** A message reached its final length. */
  | 'text.done'
  /** A tool invocation began. */
  | 'tool.started'
  /** Streaming JSON arguments for a tool call. */
  | 'tool.args.delta'
  /** Arguments complete; `args` holds the parsed object. */
  | 'tool.args.done'
  /** A tool produced a result. */
  | 'tool.result'
  /** A declarative surface was created. */
  | 'surface.created'
  /** Partial component tree update for a surface. */
  | 'surface.nodes'
  /** Data-model write for a surface. */
  | 'surface.data'
  /** The surface was removed. */
  | 'surface.deleted'
  /** An MCP App was attached. */
  | 'app.attached'
  /** The user acted inside a surface; must be sent back to the agent. */
  | 'action.dispatched'
  /** Agent asked for human input before continuing. */
  | 'interrupt'
  /** An agent-side sub-agent started / finished / failed. */
  | 'subagent'
  /** Non-fatal protocol or validation problem. */
  | 'warning'
  /** Fatal: the run cannot continue. */
  | 'error'
  /** The run finished successfully. */
  | 'run.finished';

/**
 * One normalized event. Discriminated on `kind`.
 *
 * `seq` is a monotonic counter assigned by the adapter, giving the transcript
 * and the time-travel replay a total order even when the transport does not
 * guarantee one.
 */
export interface SurfaceFrame {
  /** Monotonic, gap-free within a run. Starts at 0. */
  seq: number;
  kind: FrameKind;
  /** Which protocol produced this frame. */
  source: ProtocolId;
  /** Epoch millis assigned by the adapter on receipt. */
  ts: number;
  /** Thread correlation, propagated from the transport. */
  threadId: string;
  runId: string;
  /** Step index, when the source protocol exposes one. */
  step?: number;
  /** Sub-agent correlation, when the source protocol exposes one. */
  subagentRunId?: string;
  /** Payload, narrowed by `kind`. See the `FramePayload` map. */
  payload: FramePayloadMap[FrameKind];
  /** Free-form protocol passthrough. Never rendered. */
  raw?: unknown;
}

export interface FramePayloadMap {
  'run.started': { agentName: string; capabilities?: JsonObject; input?: JsonObject };
  'text.delta': { messageId: string; delta: string };
  'text.done': { messageId: string; text: string };
  'tool.started': { toolCallId: string; toolName: string; parentMessageId?: string };
  'tool.args.delta': { toolCallId: string; delta: string };
  'tool.args.done': { toolCallId: string; args: JsonObject; parseError?: string };
  'tool.result': { toolCallId: string; messageId: string; content: string; isError?: boolean; durationMs?: number };
  'surface.created': { surfaceId: string; catalogId: string; title?: string; data?: DataModel; sendDataModel?: boolean };
  'surface.nodes': { surfaceId: string; nodes: SurfaceNode[]; mode: 'replace' | 'merge' };
  'surface.data': { surfaceId: string; path: JsonPointer; value: JsonValue; mode: 'set' | 'merge' };
  'surface.deleted': { surfaceId: string };
  'app.attached': { app: EmbeddedApp };
  'action.dispatched': { surfaceId: string; componentId: string; name: string; context: JsonObject };
  interrupt: { reason: string; resumeToken?: string; resumable: boolean };
  subagent: { phase: 'started' | 'finished' | 'error'; name: string; detail?: string };
  warning: { code: string; message: string; detail?: JsonObject };
  error: { code: string; message: string; fatal: boolean; detail?: JsonObject };
  'run.finished': { outcome: 'success' | 'cancelled' | 'interrupt'; usage?: Usage };
}

// ---------------------------------------------------------------------------
// Usage / cost
// ---------------------------------------------------------------------------

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported cached-input tokens, when available. */
  cachedInputTokens?: number;
  reasoningTokens?: number;
  /** USD. Derived by `@agent-surface/cost`; absent when pricing is unknown. */
  costUsd?: number;
}

// ---------------------------------------------------------------------------
// Protocol identity
// ---------------------------------------------------------------------------

export type ProtocolId = 'ag-ui' | 'a2ui' | 'mcp-apps';

/** Discriminator for a host's support of each protocol. */
export interface ProtocolSupport {
  id: ProtocolId;
  supported: boolean;
  /** Host-advertised protocol versions, newest first. */
  versions: string[];
  /** True when the host can render agent-authored interactive apps. */
  supportsEmbeddedApps?: boolean;
  /** True when the host can round-trip surface actions back to the agent. */
  supportsBidirectionalState?: boolean;
  /** Human-readable reason when `supported` is false. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

/**
 * The single interface every protocol adapter implements.
 *
 * Adapters are push-based and may emit frames at their own cadence; the host
 * reorders by `seq`. They must not throw on malformed input -- they emit an
 * `error` or `warning` frame instead, because a hostile or buggy agent is a
 * normal operating condition, not an exception.
 */
export interface ProtocolAdapter {
  readonly id: ProtocolId;
  readonly supportedVersions: string[];

  /**
   * Capabilities the host should advertise upstream so the agent can choose
   * an interaction model. Called once per connection.
   */
  getClientCapabilities(options?: { includeInlineCatalogs?: boolean }): JsonObject;

  /**
   * Consume one raw inbound unit (SSE `data:` payload, JSONL line, or a
   * complete JSON body) and push zero or more frames.
   *
   * `raw` is the already-parsed value. Adapters that need the original text
   * (JSONL, partial SSE) should receive it via {@link AdapterInput.text}.
   */
  ingest(input: AdapterInput): Iterable<SurfaceFrame>;

  /**
   * Build the frames that carry a user action back to the agent. Returns the
   * transport-specific payload plus a suggested `RunAgentInput` state patch.
   */
  encodeAction(action: ActionEvent): EncodedAction;

  /**
   * Apply a host-owned state patch that the agent never sent (optimistic local
   * update). Must be idempotent.
   */
  applyLocalState(patch: StatePatch): void;
}

export interface AdapterInput {
  /** Transport correlation ids. The adapter may keep its own map. */
  threadId: string;
  runId: string;
  /** Raw decoded JSON value, if the transport produced one. */
  raw?: unknown;
  /** Original text, for line-oriented or partially-parsed transports. */
  text?: string;
  step?: number;
  subagentRunId?: string;
  /** Headers/metadata from the transport envelope. */
  meta?: Record<string, string | undefined>;
}

/** A user-initiated interaction inside a rendered surface. */
export interface ActionEvent {
  surfaceId: string;
  componentId: string;
  /** Action name declared by the catalog component (e.g. `onClick`). */
  name: string;
  /** Value carried by the action (e.g. the new slider position). */
  value?: JsonValue;
  /** Free-form context from the component. */
  context?: JsonObject;
}

export interface EncodedAction {
  protocol: ProtocolId;
  /** Body to POST as `RunAgentInput` (or A2UI client data model update). */
  input: JsonObject;
  /** State patch to apply optimistically before the agent acknowledges. */
  patch: StatePatch;
}

export interface StatePatch {
  threadId: string;
  runId: string;
  surfaceId?: string;
  /** JSON Patch (RFC 6902) operations against the surface data model. */
  operations: JsonPatchOperation[];
  /** Bumped on every host-side write so late agent writes can be reconciled. */
  revision: number;
}

/**
 * RFC 6902 operations.
 *
 * `value` is required for the ops that carry data (`add`, `replace`, `test`)
 * and forbidden for `remove`, which deletes a path. Making it a union rather
 * than one optional field means a bare `{op:'add', path}` -- a no-op that
 * would silently drop the user's interaction -- is a type error at the
 * adapter, not a runtime surprise.
 */
export type JsonPatchOperation =
  | { op: 'add' | 'replace'; path: JsonPointer; value: JsonValue }
  | { op: 'remove'; path: JsonPointer }
  | { op: 'move' | 'copy'; from: JsonPointer; path: JsonPointer }
  | { op: 'test'; path: JsonPointer; value: JsonValue };

/**
 * A frame before the stream has stamped it: no `seq`, and the transport-owned
 * fields are optional because the stream fills in whatever the adapter omitted.
 */
export type UnstampedFrame = Omit<SurfaceFrame, 'seq' | 'source' | 'ts' | 'threadId' | 'runId'> &
  Partial<Pick<SurfaceFrame, 'source' | 'ts' | 'threadId' | 'runId'>>;
