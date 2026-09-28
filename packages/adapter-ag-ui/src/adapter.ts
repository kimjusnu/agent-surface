/**
 * AG-UI -> Surface IR adapter.
 *
 * The adapter is a pure projection: it holds enough state to correlate events
 * that reference each other (a `TEXT_MESSAGE_END` that only names a message,
 * a `TOOL_CALL_END` that only closes an argument stream), and emits IR frames.
 * It performs no I/O, opens no sockets, and validates no schemas -- upstream
 * `@ag-ui/client` owns both, and duplicating them would mean two places to fix
 * when the protocol moves.
 *
 * Two invariants drive most of the decisions here:
 *
 *  1. `ingest` never throws. A hostile or merely buggy agent is a normal
 *     operating condition, so a fault becomes a `warning` frame and the run
 *     continues.
 *  2. Nothing is silently dropped. Every event the IR cannot render still
 *     produces a frame, and `raw` always carries the original. A transcript that
 *     omits what the agent sent is worse than a noisy one.
 */

import { EventType, PROTOCOL_VERSION, contentToText } from '@ag-ui/core';
import type {
  AgentCapabilities,
  Context,
  Event as AgUiEvent,
  Interrupt,
  Message,
  RunAgentInput,
  Tool,
  ToolMessage,
} from '@ag-ui/core';
import { IR_VERSION, buildPointer } from '@agent-surface/protocol';
import type {
  ActionEvent,
  AdapterInput,
  EncodedAction,
  FrameKind,
  FramePayloadMap,
  JsonObject,
  ProtocolAdapter,
  StatePatch,
  SurfaceFrame,
} from '@agent-surface/protocol';

import { AGUI_STATE_SURFACE_ID, UNKNOWN_EVENT_CODE, mappingFor } from './event-map.js';
import { ThreadState, aggregateUsage, isPlainObject, toJsonObject, toJsonValue } from './state.js';
import type { DraftPatchOperation } from './state.js';

export interface AgUiAdapterOptions {
  /** Protocol version this host speaks, advertised to the agent. */
  protocolVersion?: string;
  /** Fallback agent name when a RUN_STARTED carries no better hint. */
  agentName?: string;
  /** Host identity, forwarded to the agent for its own logging. */
  hostName?: string;
  /** Seed correlation ids used before the first event arrives. */
  threadId?: string;
  runId?: string;
  /** Tools the host offers the agent. */
  tools?: Tool[];
  /** Ambient context forwarded with every run. */
  context?: Context[];
  /** Extra capability declarations merged into the advertised object. */
  capabilities?: AgentCapabilities;
  /** Injectable clock. The IR defines `ts` as adapter-assigned, not producer-supplied. */
  now?: () => number;
}

/** Everything the frame builder needs about the event currently being handled. */
interface EventContext {
  ts: number;
  threadId: string;
  runId: string;
  step: number | undefined;
  subagentRunId: string | undefined;
  raw: unknown;
}

/** Stands in for a tool name a chunk omitted, so the frame still has a name. */
const UNNAMED_TOOL = 'unknown_tool';
/** Stands in for a subagent name that cannot be recovered, for the same reason. */
const ANONYMOUS_SUBAGENT = 'subagent';

export class AgUiAdapter implements ProtocolAdapter {
  readonly id = 'ag-ui' as const;
  readonly supportedVersions: string[] = [PROTOCOL_VERSION];

  readonly #options: AgUiAdapterOptions;
  readonly #now: () => number;
  readonly #tools: Tool[];
  readonly #context: Context[];
  readonly #threads = new Map<string, ThreadState>();

  #seq = 0;
  #threadId: string;
  #runId: string;
  #step: number | undefined;
  /** Last error from `applyLocalState`, surfaced instead of thrown. */
  #lastPatchError: string | undefined;

  constructor(options: AgUiAdapterOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
    this.#tools = options.tools ?? [];
    this.#context = options.context ?? [];
    this.#threadId = options.threadId ?? 'unknown-thread';
    this.#runId = options.runId ?? 'unknown-run';
  }

  /** Correlation ids as last observed, for the tracer and for `encodeAction`. */
  get threadId(): string {
    return this.#threadId;
  }

  get runId(): string {
    return this.#runId;
  }

  /** The message from the most recent failed `applyLocalState`, if any. */
  get lastPatchError(): string | undefined {
    return this.#lastPatchError;
  }

  /** Per-thread state, for the tracer and for assertions. */
  stateFor(threadId: string): ThreadState {
    return this.#thread(threadId);
  }

  #thread(threadId: string): ThreadState {
    let thread = this.#threads.get(threadId);
    if (!thread) {
      thread = new ThreadState();
      this.#threads.set(threadId, thread);
    }
    return thread;
  }

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  /**
   * A real `RunAgentInput` the host can POST, not a free-form description of
   * one: the object the host sends to start a run and the object that declares
   * what the host supports are the same thing in AG-UI, so returning anything
   * else would force the caller to translate.
   *
   * The capability declarations ride in `forwardedProps` because that is the
   * field the protocol reserves for application-specific values; adding a
   * top-level `capabilities` key would not type-check as a `RunAgentInput` and
   * would be stripped by a strict agent-side validator.
   */
  getClientCapabilities(options?: { includeInlineCatalogs?: boolean }): JsonObject {
    const thread = this.#thread(this.#threadId);
    const capabilities: AgentCapabilities = {
      ...this.#options.capabilities,
      identity: { name: this.#agentName(), ...this.#options.capabilities?.identity },
      transport: { streaming: true, ...this.#options.capabilities?.transport },
      tools: {
        supported: true,
        clientProvided: true,
        parallelCalls: true,
        ...(options?.includeInlineCatalogs ? { items: this.#tools } : {}),
        ...this.#options.capabilities?.tools,
      },
      state: { snapshots: true, deltas: true, persistentState: true, ...this.#options.capabilities?.state },
      humanInTheLoop: { supported: true, interrupts: true, ...this.#options.capabilities?.humanInTheLoop },
    };

    const input: RunAgentInput = {
      threadId: this.#threadId,
      runId: this.#runId,
      protocolVersion: this.#protocolVersion(),
      state: thread.document,
      messages: [],
      tools: this.#tools,
      context: this.#context,
      forwardedProps: {
        irVersion: IR_VERSION,
        host: this.#options.hostName ?? 'agent-surface',
        capabilities,
      },
    };
    // `RunAgentInput` is a set of interfaces with open `any` payloads, so it is
    // not assignable to the IR's closed `JsonObject`. Converting here is the one
    // place where a non-JSON value would be caught, at the boundary.
    return toJsonObject(input);
  }

  // -------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------

  ingest(input: AdapterInput): Iterable<SurfaceFrame> {
    const frames: SurfaceFrame[] = [];
    try {
      for (const unit of this.#units(input)) {
        try {
          this.#ingestUnit(unit, input, frames);
        } catch (err) {
          frames.push(this.#fault(unit, input, err));
        }
      }
    } catch (err) {
      // Reached only if even unit splitting failed, which means `input` itself
      // is unusable. Still a frame, never an exception.
      frames.push(this.#fault(input.raw, input, err));
    }
    return frames;
  }

  /**
   * Normalise one `AdapterInput` into the events it carries.
   *
   * A transport may hand over a single parsed event, a batch array of them, or
   * the raw SSE `data:` text of exactly one. A top-level array is unambiguous:
   * no AG-UI event is itself an array, so it can only be a batch.
   */
  #units(input: AdapterInput): unknown[] {
    if (Array.isArray(input.raw)) return input.raw;
    if (input.raw !== undefined) return [input.raw];
    if (input.text === undefined) return [];
    return [input.text];
  }

  #ingestUnit(unit: unknown, input: AdapterInput, frames: SurfaceFrame[]): void {
    const event = this.#coerce(unit, input, frames);
    if (!event) return;

    const thread = this.#thread(input.threadId);
    const ctx: EventContext = {
      ts: this.#now(),
      threadId: input.threadId,
      runId: input.runId,
      step: this.#step,
      subagentRunId: (event as { subagentRunId?: string }).subagentRunId ?? input.subagentRunId,
      raw: unit,
    };

    switch (event.type) {
      case EventType.RUN_STARTED:
        this.#onRunStarted(event, thread, ctx, frames);
        break;
      case EventType.RUN_FINISHED:
        this.#onRunFinished(event, ctx, frames);
        break;
      case EventType.RUN_ERROR:
        this.#onRunError(event, ctx, frames);
        break;

      case EventType.TEXT_MESSAGE_START:
        this.#onTextStart(event.messageId, event.role ?? 'assistant', thread, ctx, frames);
        break;
      case EventType.TEXT_MESSAGE_CONTENT:
        this.#onTextContent(event.messageId, event.delta, thread, ctx, frames);
        break;
      case EventType.TEXT_MESSAGE_END:
        this.#onTextEnd(event.messageId, thread, ctx, frames);
        break;
      case EventType.TEXT_MESSAGE_CHUNK:
        this.#onTextChunk(event, thread, ctx, frames);
        break;

      case EventType.TOOL_CALL_START:
        thread.openToolCall(event.toolCallId, event.toolCallName, event.parentMessageId, ctx.ts);
        this.#push(frames, 'tool.started', {
          toolCallId: event.toolCallId,
          toolName: event.toolCallName,
          ...(event.parentMessageId !== undefined ? { parentMessageId: event.parentMessageId } : {}),
        }, ctx);
        break;
      case EventType.TOOL_CALL_ARGS:
        this.#onToolArgs(event.toolCallId, event.delta, thread, ctx, frames);
        break;
      case EventType.TOOL_CALL_END:
        this.#onToolEnd(event.toolCallId, thread, ctx, frames);
        break;
      case EventType.TOOL_CALL_CHUNK:
        this.#onToolChunk(event, thread, ctx, frames);
        break;
      case EventType.TOOL_CALL_RESULT:
        this.#onToolResult(event, thread, ctx, frames);
        break;

      case EventType.SUBAGENT_STARTED:
        thread.subagentNames.set(event.subagentRunId, event.name);
        this.#push(frames, 'subagent', {
          phase: 'started',
          name: event.name,
          ...(event.description !== undefined ? { detail: event.description } : {}),
        }, ctx);
        break;
      case EventType.SUBAGENT_FINISHED: {
        const finished = event.outcome;
        const suspended = finished?.type === 'suspended';
        const interruptCount = suspended && finished.type === 'suspended' ? (finished.interruptIds?.length ?? 0) : 0;
        this.#push(frames, 'subagent', {
          phase: 'finished',
          name: this.#subagentName(thread, event.subagentRunId),
          detail: suspended ? `suspended awaiting ${interruptCount} interrupt(s)` : 'completed',
        }, ctx);
        break;
      }
      case EventType.SUBAGENT_ERROR:
        this.#push(frames, 'subagent', {
          phase: 'error',
          name: this.#subagentName(thread, event.subagentRunId),
          detail: event.message,
        }, ctx);
        break;

      case EventType.STEP_STARTED:
        this.#step = thread.stepCount;
        thread.stepCount += 1;
        frames.push(
          this.#passthrough(event.type, { stepName: event.stepName }, ctx),
        );
        break;
      case EventType.STEP_FINISHED:
        frames.push(this.#passthrough(event.type, { stepName: event.stepName }, ctx));
        this.#step = undefined;
        break;

      case EventType.STATE_SNAPSHOT:
        this.#onStateSnapshot(event, thread, ctx, frames);
        break;
      case EventType.STATE_DELTA:
        this.#onStateDelta(event, thread, ctx, frames);
        break;

      case EventType.REASONING_ENCRYPTED_VALUE:
        frames.push(
          this.#passthrough(
            event.type,
            { subtype: event.subtype, entityId: event.entityId, withheld: 'encryptedValue' },
            ctx,
          ),
        );
        break;
      case EventType.REASONING_START:
      case EventType.REASONING_MESSAGE_START:
      case EventType.REASONING_MESSAGE_CONTENT:
      case EventType.REASONING_MESSAGE_END:
      case EventType.REASONING_MESSAGE_CHUNK:
      case EventType.REASONING_END:
        frames.push(this.#passthrough(event.type, { messageId: 'messageId' in event ? event.messageId : undefined }, ctx));
        break;

      case EventType.ACTIVITY_SNAPSHOT:
        frames.push(
          this.#passthrough(event.type, {
            messageId: event.messageId,
            activityType: event.activityType,
            replace: event.replace ?? true,
            content: toJsonValue(event.content),
          }, ctx),
        );
        break;
      case EventType.ACTIVITY_DELTA:
        frames.push(
          this.#passthrough(event.type, {
            messageId: event.messageId,
            activityType: event.activityType,
            patch: toJsonValue(event.patch),
          }, ctx),
        );
        break;

      case EventType.MESSAGES_SNAPSHOT:
        this.#ingestMessages(event.messages, thread);
        frames.push(
          this.#passthrough(event.type, { messageCount: event.messages.length }, ctx),
        );
        break;

      case EventType.RAW:
        frames.push(
          this.#passthrough(event.type, { source: event.source, event: toJsonValue(event.event) }, ctx),
        );
        break;

      case EventType.CUSTOM:
        frames.push(
          this.#passthrough(
            event.type,
            { name: event.name, value: toJsonValue(event.value) },
            ctx,
            { eventName: event.name },
          ),
        );
        break;

      default:
        frames.push(
          this.#warning(
            UNKNOWN_EVENT_CODE,
            `AG-UI event type not recognised by this adapter: ${String((event as { type: string }).type)}`,
            { eventType: String((event as { type: string }).type) },
            ctx,
          ),
        );
        break;
    }
  }

  /**
   * Parse and narrow one unit into an AG-UI event.
   *
   * No schema validation: the shape is checked only far enough to read `type`
   * and to survive a malformed body. Re-validating every field would cost a
   * walk of arbitrary application JSON on the streaming hot path, which is
   * exactly what `@ag-ui/core` documents it declines to do.
   */
  #coerce(unit: unknown, input: AdapterInput, frames: SurfaceFrame[]): AgUiEvent | undefined {
    const ctx = this.#bareContext(input, unit);

    if (typeof unit === 'string') {
      try {
        const parsed: unknown = JSON.parse(unit);
        if (isPlainObject(parsed) && typeof parsed.type === 'string') {
          return parsed as unknown as AgUiEvent;
        }
        frames.push(this.#warning('AGUI_MALFORMED_EVENT', 'SSE data payload is not an AG-UI event object', { body: unit.slice(0, 200) }, ctx));
        return undefined;
      } catch (err) {
        frames.push(this.#warning('AGUI_MALFORMED_JSON', err instanceof Error ? err.message : String(err), { body: unit.slice(0, 200) }, ctx));
        return undefined;
      }
    }

    if (!isPlainObject(unit) || typeof unit.type !== 'string') {
      frames.push(
        this.#warning(
          'AGUI_MALFORMED_EVENT',
          'Inbound unit has no string `type`, so it is not an AG-UI event',
          { received: isPlainObject(unit) ? Object.keys(unit) : typeof unit },
          ctx,
        ),
      );
      return undefined;
    }
    return unit as unknown as AgUiEvent;
  }

  #bareContext(input: AdapterInput, raw: unknown): EventContext {
    return {
      ts: this.#now(),
      threadId: input.threadId,
      runId: input.runId,
      step: this.#step,
      subagentRunId: input.subagentRunId,
      raw,
    };
  }

  // -------------------------------------------------------------------------
  // Run lifecycle
  // -------------------------------------------------------------------------

  #onRunStarted(
    event: Extract<AgUiEvent, { type: EventType.RUN_STARTED }>,
    thread: ThreadState,
    ctx: EventContext,
    frames: SurfaceFrame[],
  ): void {
    // A RUN_STARTED opens a new run on the same thread: the transcript's
    // sequence and every run-scoped accumulator restart, but the thread's state
    // document survives, because the IR keys `StatePatch` by thread and an agent
    // that wants a fresh document sends a STATE_SNAPSHOT.
    this.#seq = 0;
    this.#step = undefined;
    this.#reportAbandonedStreams(thread, ctx, frames);
    thread.beginRun();

    this.#threadId = event.threadId || ctx.threadId;
    this.#runId = event.runId || ctx.runId;
    ctx.threadId = this.#threadId;
    ctx.runId = this.#runId;

    this.#ingestMessages(event.input?.messages, thread);
    if (isPlainObject(event.input?.state)) {
      thread.setDocument(toJsonObject(event.input.state));
    }
    this.#checkNegotiatedVersion(event, ctx, frames);

    const runCtx: EventContext = { ...ctx, threadId: this.#threadId, runId: this.#runId };
    this.#push(
      frames,
      'run.started',
      {
        agentName: this.#agentName(event),
        capabilities: this.getClientCapabilities(),
        ...(event.input !== undefined ? { input: toJsonObject(event.input) } : {}),
      },
      runCtx,
    );
  }

  /**
   * Warn when the producer's declared protocol version is not one this host
   * supports. The two sides declare independently, so the mismatch is only
   * observable at RUN_STARTED -- and it is the one moment a tracer needs it,
   * because everything after it may be shaped by rules this build never saw.
   */
  #checkNegotiatedVersion(
    event: Extract<AgUiEvent, { type: EventType.RUN_STARTED }>,
    ctx: EventContext,
    frames: SurfaceFrame[],
  ): void {
    const declared = event.protocolVersion;
    if (typeof declared !== 'string') return;
    if (this.supportedVersions.includes(declared)) return;
    frames.push(
      this.#warning(
        'AGUI_VERSION_UNSUPPORTED',
        `Agent declared AG-UI protocol version ${declared}; this host speaks ${this.supportedVersions.join(', ')}`,
        { declared, supported: this.supportedVersions },
        ctx,
      ),
    );
  }

  #onRunFinished(
    event: Extract<AgUiEvent, { type: EventType.RUN_FINISHED }>,
    ctx: EventContext,
    frames: SurfaceFrame[],
  ): void {
    const declared = event.outcome?.type;
    // AG-UI is explicit that an outcome a consumer does not recognise is read as
    // success, and the host has no better information. Warn before the terminal
    // frame: `SurfaceStream` ignores everything emitted after `run.finished`.
    if (declared !== undefined && declared !== 'success' && declared !== 'interrupt' && declared !== 'cancelled') {
      frames.push(
        this.#warning(
          'AGUI_RUN_OUTCOME_UNKNOWN',
          `Unrecognised run outcome ${String(declared)}; read as success per the AG-UI compatibility rule`,
          { outcome: toJsonValue(event.outcome) },          ctx,
        ),
      );
    }

    const outcome: 'success' | 'cancelled' | 'interrupt' =
      declared === 'cancelled' || declared === 'interrupt' ? declared : 'success';

    // Publish anything still buffered before the terminal frame. `SurfaceStream`
    // discards anything emitted after `run.finished`, so a flush placed after it
    // would be lost exactly when it matters.
    this.#flushOpenStreams(this.#thread(ctx.threadId), ctx, frames);

    if (outcome === 'interrupt') {
      for (const interrupt of outcomeInterrupts(event)) {
        frames.push(this.#interruptFrame(interrupt, ctx));
      }
    }

    const usage = aggregateUsage(event.usage);
    this.#push(
      frames,
      'run.finished',
      { outcome, ...(usage ? { usage } : {}) },
      ctx,
    );
    this.#step = undefined;
  }

  /**
   * One `interrupt` frame per pending AG-UI Interrupt.
   *
   * `run.finished` with `outcome: 'interrupt'` alone tells a host that the run
   * paused and nothing about what it is waiting for, so the reasons have to
   * travel on their own frames. `resumeToken` is the `Interrupt.id`, because
   * that is the id a `ResumeEntry` must answer for the run to continue.
   */
  #interruptFrame(interrupt: Interrupt, ctx: EventContext): SurfaceFrame {
    const expiresAt = typeof interrupt.expiresAt === 'string' ? Date.parse(interrupt.expiresAt) : Number.NaN;
    // An unparseable date must not silently kill an interrupt, so only an
    // expiry that is definitely in the past makes one unresumable.
    const expired = Number.isFinite(expiresAt) && expiresAt <= ctx.ts;
    return this.#frame(
      'interrupt',
      {
        reason: String(interrupt.reason ?? 'interrupted'),
        resumeToken: interrupt.id,
        resumable: !expired,
      },
      { ...ctx, subagentRunId: interrupt.subagentRunId ?? ctx.subagentRunId },
    );
  }

  #onRunError(
    event: Extract<AgUiEvent, { type: EventType.RUN_ERROR }>,
    ctx: EventContext,
    frames: SurfaceFrame[],
  ): void {
    // Tokens spent before the failure are real cost, and the IR's `error`
    // payload has no usage field, so they ride in `detail` where the cost layer
    // can still find them. Anything still buffered is published first: a fatal
    // error does not close the stream, but a consumer that stops reading on
    // `error` would otherwise never see the partial answer the agent produced
    // before it failed.
    this.#flushOpenStreams(this.#thread(ctx.threadId), ctx, frames);
    const detail: JsonObject = {};
    const usage = toJsonValue(event.usage);
    if (usage !== undefined) detail.usage = usage;
    if (event.code !== undefined) detail.agentCode = event.code;

    this.#push(
      frames,
      'error',
      {
        code: event.code ?? 'AGUI_RUN_ERROR',
        message: String(event.message ?? 'AG-UI run failed'),
        fatal: true,
        ...(Object.keys(detail).length > 0 ? { detail } : {}),
      },
      ctx,
    );
    this.#step = undefined;
  }

  // -------------------------------------------------------------------------
  // Text
  // -------------------------------------------------------------------------

  /**
   * Publish and close every message and tool call still buffering.
   *
   * This is the counterpart to AG-UI's deferred lane close: a producer that
   * streams in chunks and then stops without a terminal event must not leave the
   * host rendering an append-only string that will never be declared final.
   */
  #flushOpenStreams(thread: ThreadState, ctx: EventContext, frames: SurfaceFrame[]): void {
    const { messages, toolCalls } = thread.takeOpenStreams();
    for (const message of messages) {
      this.#push(frames, 'text.done', { messageId: message.messageId, text: message.text }, ctx);
    }
    for (const call of toolCalls) {
      this.#push(frames, 'tool.args.done', parseArgs(call.toolCallId, call.argsText), ctx);
    }
  }

  /**
   * Report, rather than close, whatever the *previous* run left buffering.
   *
   * Publishing a `text.done` here would place the previous run's tail after the
   * new run's `seq` has restarted at 0, so a transcript read by sequence number
   * would meet a finished message before the run that contains it. The fragments
   * were already delivered as deltas, so nothing is lost -- what is missing is
   * the closing marker, and saying so is more useful than inventing one.
   */
  #reportAbandonedStreams(thread: ThreadState, ctx: EventContext, frames: SurfaceFrame[]): void {
    const messageIds = [...thread.messages.keys()];
    const toolCallIds = [...thread.toolCalls.keys()];
    if (messageIds.length === 0 && toolCallIds.length === 0) return;
    frames.push(
      this.#warning(
        'AGUI_RUN_LEFT_STREAMS_OPEN',
        `The previous run on this thread ended without closing ${messageIds.length} message(s) and ${toolCallIds.length} tool call(s); their fragments were delivered but never marked final`,
        { messageIds, toolCallIds },
        ctx,
      ),
    );
  }

  #onTextStart(messageId: string, role: string, thread: ThreadState, ctx: EventContext, frames: SurfaceFrame[]): void {
    const { replaced } = thread.openMessage(messageId, role);
    if (!replaced) return;
    // A second START for a live message means two subagents reused one id. Close
    // the old buffer first so neither one's text is silently merged into the
    // other, then say so.
    frames.push(
      this.#warning(
        'AGUI_MESSAGE_REOPENED',
        `TEXT_MESSAGE_START for ${messageId} while a message with that id is still open; the earlier buffer is published first`,
        { messageId },
        ctx,
      ),
    );
    frames.push(this.#frame('text.done', { messageId, text: replaced.text }, ctx));
  }

  #onTextContent(
    messageId: string,
    delta: string,
    thread: ThreadState,
    ctx: EventContext,
    frames: SurfaceFrame[],
  ): void {
    const message = thread.resolveMessage(messageId);
    if (!message) {
      // A host that attached mid-stream sees CONTENT without START. The message
      // is still recoverable, so synthesise the buffer rather than dropping text.
      thread.openMessage(messageId);
    }
    const target = thread.resolveMessage(messageId);
    if (!target) return;
    target.text += delta;
    this.#push(frames, 'text.delta', { messageId: target.messageId, delta }, ctx);
  }

  #onTextEnd(
    messageId: string,
    thread: ThreadState,
    ctx: EventContext,
    frames: SurfaceFrame[],
  ): void {
    if (!thread.messages.has(messageId)) {
      // A host that attached mid-stream legitimately sees END without START, and
      // the role it missed matters, so say so rather than publishing an empty
      // message that looks complete.
      frames.push(
        this.#warning(
          'AGUI_MESSAGE_END_WITHOUT_START',
          `TEXT_MESSAGE_END for ${messageId} with no buffered start; its role is unknown`,
          { messageId },
          ctx,
        ),
      );
    }
    const message = thread.closeMessage(messageId) ?? { messageId, role: 'assistant', text: '' };
    this.#push(frames, 'text.done', { messageId: message.messageId, text: message.text }, ctx);
  }

  /**
   * A `TEXT_MESSAGE_CHUNK` is the shorthand for start+content, not for
   * start+content+end.
   *
   * AG-UI's own `transformChunks` middleware opens the message on the first chunk,
   * appends on every later one, and synthesises `TEXT_MESSAGE_END` only when the
   * lane closes at a run boundary. Closing per chunk would make a 500-fragment
   * message announce itself finished 500 times, and the IR's `text.done` means
   * "this message reached its final length" -- a claim a chunk cannot make.
   */
  #onTextChunk(
    event: Extract<AgUiEvent, { type: EventType.TEXT_MESSAGE_CHUNK }>,
    thread: ThreadState,
    ctx: EventContext,
    frames: SurfaceFrame[],
  ): void {
    let message = thread.resolveMessage(event.messageId);
    if (!message) {
      if (event.messageId === undefined) {
        frames.push(
          this.#warning(
            'AGUI_CHUNK_WITHOUT_OPEN_MESSAGE',
            'TEXT_MESSAGE_CHUNK named no message and none is open, so it cannot be placed',
            {},
            ctx,
          ),
        );
        return;
      }
      message = thread.openMessage(event.messageId, event.role ?? 'assistant').message;
    } else if (event.role !== undefined) {
      message.role = event.role;
    }
    // An absent `delta` means the chunk opened a message without adding text.
    // Emitting an empty `text.delta` would make every consumer re-render for
    // nothing, so only a real fragment produces one.
    if (typeof event.delta !== 'string') return;
    message.text += event.delta;
    this.#push(frames, 'text.delta', { messageId: message.messageId, delta: event.delta }, ctx);
  }

  // -------------------------------------------------------------------------
  // Tool calls
  // -------------------------------------------------------------------------

  #onToolArgs(
    toolCallId: string,
    delta: string,
    thread: ThreadState,
    ctx: EventContext,
    frames: SurfaceFrame[],
  ): void {
    const call = thread.resolveToolCall(toolCallId);
    if (!call) {
      frames.push(
        this.#warning(
          'AGUI_TOOL_ARGS_WITHOUT_START',
          `TOOL_CALL_ARGS for ${toolCallId} with no open call; the fragment is dropped`,
          { toolCallId },
          ctx,
        ),
      );
      return;
    }
    call.argsText += delta;
    this.#push(frames, 'tool.args.delta', { toolCallId: call.toolCallId, delta }, ctx);
  }

  #onToolEnd(
    toolCallId: string,
    thread: ThreadState,
    ctx: EventContext,
    frames: SurfaceFrame[],
  ): void {
    const call = thread.closeToolCall(toolCallId);
    if (!call) {
      frames.push(
        this.#warning(
          'AGUI_TOOL_END_WITHOUT_START',
          `TOOL_CALL_END for ${toolCallId} with no buffered arguments; nothing can be parsed`,
          { toolCallId },
          ctx,
        ),
      );
      this.#push(frames, 'tool.args.done', { toolCallId, args: {}, parseError: 'no TOOL_CALL_START was seen for this call' }, ctx);
      return;
    }
    this.#push(frames, 'tool.args.done', parseArgs(call.toolCallId, call.argsText), ctx);
  }

  /**
   * A `TOOL_CALL_CHUNK` is the shorthand for start+args, not for start+args+end,
   * for the same reason as {@link #onTextChunk} and for the same authority:
   * AG-UI's `transformChunks` middleware closes the lane at the run boundary
   * rather than per chunk, and `tool.args.done` means "these arguments are
   * complete" -- a claim a fragment cannot make.
   *
   * `tool.started` is emitted on the chunk that carries a `toolCallName`, which
   * the protocol documents as present on the chunk that opens a call and absent
   * on one that continues it.
   */
  #onToolChunk(
    event: Extract<AgUiEvent, { type: EventType.TOOL_CALL_CHUNK }>,
    thread: ThreadState,
    ctx: EventContext,
    frames: SurfaceFrame[],
  ): void {
    let call = thread.resolveToolCall(event.toolCallId);
    if (!call) {
      if (event.toolCallId === undefined) {
        frames.push(
          this.#warning(
            'AGUI_CHUNK_WITHOUT_OPEN_TOOL_CALL',
            'TOOL_CALL_CHUNK named no tool call and none is open, so it cannot be placed',
            {},
            ctx,
          ),
        );
        return;
      }
      call = thread.openToolCall(event.toolCallId, event.toolCallName ?? UNNAMED_TOOL, event.parentMessageId, ctx.ts);
      this.#push(
        frames,
        'tool.started',
        {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          ...(call.parentMessageId !== undefined ? { parentMessageId: call.parentMessageId } : {}),
        },
        ctx,
      );
    } else if (event.toolCallName !== undefined) {
      call.toolName = event.toolCallName;
    }
    if (typeof event.delta === 'string') {
      call.argsText += event.delta;
      this.#push(frames, 'tool.args.delta', { toolCallId: call.toolCallId, delta: event.delta }, ctx);
    }
  }

  #onToolResult(
    event: Extract<AgUiEvent, { type: EventType.TOOL_CALL_RESULT }>,
    thread: ThreadState,
    ctx: EventContext,
    frames: SurfaceFrame[],
  ): void {
    const call = thread.toolCallStartedAt(event.toolCallId);
    // The IR's `tool.result.content` is a string, so a parts array is a
    // downgrade the contract mandates. `contentToText` concatenates the text
    // parts in order and drops the rest; the untouched parts stay on `raw` so
    // the tracer can still see that media was lost.
    const content = contentToText(event.content);
    const tracked = thread.toolMessages.get(event.toolCallId);
    const startedAt = call;
    const durationMs = startedAt === undefined ? undefined : Math.max(0, ctx.ts - startedAt);

    this.#push(
      frames,
      'tool.result',
      {
        toolCallId: event.toolCallId,
        messageId: event.messageId,
        content,
        // `isError` is only claimed when a tool message for this call is known:
        // absence of evidence is not evidence of success, and asserting
        // `false` would make a lost error look like a clean run.
        ...(tracked ? { isError: tracked.error !== undefined && tracked.error !== '' } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
      ctx,
    );
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /**
   * A STATE_SNAPSHOT becomes a `surface.data` write against the reserved
   * pseudo-surface {@link AGUI_STATE_SURFACE_ID}.
   *
   * Two choices are forced by the IR rather than by AG-UI. `path: ''` is the
   * whole-document JSON Pointer, which is the only pointer that can express a
   * wholesale state replacement. `mode: 'merge'` rather than `'set'` because
   * the host's copy of the document also holds writes the agent has not seen --
   * optimistic `action.dispatched` values in particular -- and a wholesale
   * replace would silently discard the user's own interaction while the agent
   * was still thinking about it.
   */
  #onStateSnapshot(
    event: Extract<AgUiEvent, { type: EventType.STATE_SNAPSHOT }>,
    thread: ThreadState,
    ctx: EventContext,
    frames: SurfaceFrame[],
  ): void {
    const value = toJsonValue(event.snapshot);
    if (value === undefined) {
      frames.push(
        this.#warning(
          'AGUI_STATE_NOT_JSON',
          'STATE_SNAPSHOT carried a value that is not representable as JSON; the document is left unchanged',
          undefined,
          ctx,
        ),
      );
      return;
    }
    if (isPlainObject(value)) thread.setDocument(toJsonObject(value));
    this.#push(
      frames,
      'surface.data',
      { surfaceId: AGUI_STATE_SURFACE_ID, path: '', value, mode: 'merge' },
      ctx,
    );
  }

  /**
   * A STATE_DELTA is handed to the host instead of being applied invisibly.
   *
   * The IR models no incremental state frame, so the patch cannot be expressed
   * as a `surface.data` write without pretending it is a whole-document set. So
   * it travels as a `warning` whose `detail` carries the operations, the host
   * applies it with its own patch applier, and the adapter mirrors it into its
   * own copy so the document it sends back on the next action stays correct.
   *
   * The `resyncRequired` flag matters: AG-UI says a producer sends a snapshot
   * "when a delta cannot express the change", so a patch that does not apply is
   * a desynchronisation the host must be told about rather than a value to retry.
   */
  #onStateDelta(
    event: Extract<AgUiEvent, { type: EventType.STATE_DELTA }>,
    thread: ThreadState,
    ctx: EventContext,
    frames: SurfaceFrame[],
  ): void {
    const ops = Array.isArray(event.delta) ? event.delta : [];
    const outcome = thread.applyOperations(ops);
    const mapping = mappingFor(event.type);
    frames.push(
      this.#warning(
        mapping?.kind === 'warning' ? mapping.code : UNKNOWN_EVENT_CODE,
        outcome.ok
          ? 'STATE_DELTA forwarded for the host to apply; the IR has no incremental state frame'
          : 'STATE_DELTA does not apply to the current document; the agent should resend a STATE_SNAPSHOT',
        {
          patch: toJsonValue(ops) ?? [],
          applied: outcome.applied,
          ...(outcome.ok ? {} : { resyncRequired: true, ...(outcome.error ? { error: toJsonObject(outcome.error) } : {}) }),
        },
        ctx,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  /**
   * Encode a user action inside a rendered surface.
   *
   * The action becomes a `ToolMessage` rather than a `UserMessage` because that
   * is how AG-UI answers the host: the protocol's own `pendingToolCallIds` says
   * a call the agent left open is answered "in the next input's messages", and a
   * click on an agent-authored surface is the same situation -- the agent asked,
   * the application answers, and the answer arrives as a tool message. Sending
   * it as user text would put the interaction in the conversation as if the
   * person had typed it.
   *
   * The message id is derived from the action rather than randomised so a
   * retried POST produces the same id and the agent can deduplicate it.
   */
  encodeAction(action: ActionEvent): EncodedAction {
    const thread = this.#thread(this.#threadId);
    const messageId = actionMessageId(action);
    const pointer = buildPointer(['actions', action.surfaceId, action.componentId, action.name]);
    // `add` rather than `replace`: RFC 6902 requires the target of a replace to
    // exist, and the first click on a surface must not fail because the path is
    // new.
    const operation: DraftPatchOperation = {
      op: 'add',
      path: pointer,
      value: action.value === undefined ? null : action.value,
    };
    const envelope: JsonObject = {
      surfaceId: action.surfaceId,
      componentId: action.componentId,
      name: action.name,
      value: action.value === undefined ? null : action.value,
      context: action.context ?? {},
    };
    const message: ToolMessage = {
      id: messageId,
      role: 'tool',
      toolCallId: messageId,
      // A content part rather than a bare string keeps the action's structure
      // visible to an agent that inspects parts; `contentToText` flattens it for
      // an agent that does not.
      content: [{ type: 'text', text: JSON.stringify(envelope) }],
    };
    const input: RunAgentInput = {
      threadId: this.#threadId,
      runId: this.#runId,
      protocolVersion: this.#protocolVersion(),
      state: thread.document,
      messages: [message],
      tools: this.#tools,
      context: this.#context,
      forwardedProps: {
        irVersion: IR_VERSION,
        host: this.#options.hostName ?? 'agent-surface',
        action: envelope,
      },
    };

    return {
      protocol: 'ag-ui',
      input: toJsonObject(input),
      patch: {
        threadId: this.#threadId,
        runId: this.#runId,
        surfaceId: action.surfaceId,
        operations: [operation],
        revision: thread.nextRevision(),
      },
    };
  }

  /**
   * Apply a host-owned patch the agent never sent.
   *
   * Idempotent by revision: a patch at or below the highest revision already
   * applied is ignored, so a retried optimistic write cannot double-apply and a
   * late-arriving stale write cannot undo a newer one. `applyPatch` inside
   * `ThreadState` gives the all-or-nothing semantics, so a rejected patch leaves
   * the document untouched.
   */
  applyLocalState(patch: StatePatch): void {
    try {
      if (patch.threadId !== this.#threadId) {
        this.#lastPatchError = `patch targets thread ${patch.threadId}, not ${this.#threadId}`;
        return;
      }
      const thread = this.#thread(patch.threadId);
      if (patch.revision <= thread.revision) return;
      const outcome = thread.applyOperations(patch.operations);
      if (!outcome.ok) {
        this.#lastPatchError = `patch rejected: ${outcome.error?.code ?? 'UNKNOWN'} ${outcome.error?.message ?? ''}`.trim();
        return;
      }
      thread.adoptRevision(patch.revision);
      this.#lastPatchError = undefined;
    } catch (err) {
      this.#lastPatchError = err instanceof Error ? err.message : String(err);
    }
  }

  // -------------------------------------------------------------------------
  // Frame plumbing
  // -------------------------------------------------------------------------

  #push<K extends FrameKind>(
    frames: SurfaceFrame[],
    kind: K,
    payload: FramePayloadMap[K],
    ctx: EventContext,
  ): void {
    frames.push(this.#frame(kind, payload, ctx));
  }

  #frame<K extends FrameKind>(
    kind: K,
    payload: FramePayloadMap[K],
    ctx: EventContext,
  ): SurfaceFrame {
    return {
      // The IR's `seq` is gap-free per run and the stream overwrites whatever an
      // adapter supplies; stamping it here anyway means `ingest` can be consumed
      // directly by the tracer without a stream in between.
      seq: this.#seq++,
      kind,
      source: this.id,
      // The IR defines `ts` as adapter-assigned on receipt, not the producer's
      // timestamp, so an agent that reports a wrong clock cannot reorder the
      // host's own transcript. The producer value stays on `raw`.
      ts: ctx.ts,
      threadId: ctx.threadId,
      runId: ctx.runId,
      ...(ctx.step !== undefined ? { step: ctx.step } : {}),
      ...(ctx.subagentRunId !== undefined ? { subagentRunId: ctx.subagentRunId } : {}),
      payload,
      raw: ctx.raw,
    } as SurfaceFrame;
  }

  #warning(
    code: string,
    message: string,
    detail: Record<string, unknown> | undefined,
    ctx: EventContext,
  ): SurfaceFrame {
    return this.#frame(
      'warning',
      { code, message, ...(detail ? { detail: jsonDetail(detail) } : {}) },
      ctx,
    );
  }

  /**
   * A frame for an event the IR cannot render. The code comes from
   * {@link EVENT_FRAME_MAP} so a consumer filters on one stable string rather
   * than on prose, and `detail` carries whatever the event said minus anything
   * that must not be recorded.
   */
  #passthrough(
    eventType: string,
    detail: Record<string, unknown>,
    ctx: EventContext,
    options: { eventName?: string } = {},
  ): SurfaceFrame {
    const mapping = mappingFor(eventType);
    const code = mapping?.kind === 'warning' ? mapping.code : UNKNOWN_EVENT_CODE;
    return this.#warning(
      code,
      options.eventName
        ? `AG-UI custom event "${options.eventName}" has no Surface IR representation`
        : `AG-UI ${eventType} has no Surface IR representation`,
      detail,
      ctx,
    );
  }

  /**
   * The frame for a handler that threw. It reports the *shape* of the offending
   * unit and never its contents: the reason a handler threw is frequently a
   * throwing getter or a proxy on the value itself, and reading it again here
   * would throw out of the one method that is allowed to run when everything
   * else has already failed.
   */
  #fault(unit: unknown, input: AdapterInput, err: unknown): SurfaceFrame {
    const message = err instanceof Error ? err.message : String(err);
    return this.#warning(
      'AGUI_ADAPTER_FAULT',
      `Adapter failed while handling an AG-UI event: ${message}`,
      { threadId: input.threadId, runId: input.runId, unit: describeUnit(unit) },
      this.#bareContext(input, unit),
    );
  }

  #subagentName(thread: ThreadState, subagentRunId: string): string {
    return thread.subagentNames.get(subagentRunId) ?? ANONYMOUS_SUBAGENT;
  }

  #protocolVersion(): string {
    return this.#options.protocolVersion ?? PROTOCOL_VERSION;
  }

  #agentName(event?: Extract<AgUiEvent, { type: EventType.RUN_STARTED }>): string {
    const fromMetadata = event?.metadata?.['agentName'];
    if (typeof fromMetadata === 'string' && fromMetadata !== '') return fromMetadata;
    const forwarded = event?.input?.forwardedProps;
    if (isPlainObject(forwarded) && typeof forwarded.name === 'string' && forwarded.name !== '') {
      return forwarded.name;
    }
    return this.#options.agentName ?? ANONYMOUS_SUBAGENT;
  }

  /**
   * Absorb the messages a snapshot echoes, for the two things the frame stream
   * cannot recover later: assistant text already on the thread, and the
   * `error` flag on a tool message that tells a later result it failed.
   */
  #ingestMessages(messages: Message[] | undefined, thread: ThreadState): void {
    if (!Array.isArray(messages)) return;
    for (const message of messages) {
      if (!isPlainObject(message)) continue;
      if (message.role === 'tool' && typeof message.toolCallId === 'string') {
        const error = typeof message.error === 'string' ? message.error : undefined;
        thread.trackToolMessage({ toolCallId: message.toolCallId, error });
        continue;
      }
      if (message.role === 'assistant' && typeof message.id === 'string' && typeof message.content === 'string') {
        const buffered = thread.messages.get(message.id);
        if (buffered) buffered.text = message.content;
      }
    }
  }
}

function outcomeInterrupts(event: Extract<AgUiEvent, { type: EventType.RUN_FINISHED }>): Interrupt[] {
  const outcome = event.outcome;
  if (!isPlainObject(outcome) || outcome.type !== 'interrupt') return [];
  return Array.isArray(outcome.interrupts) ? outcome.interrupts : [];
}

/**
 * Build a `warning.detail` from loosely-typed values.
 *
 * The IR's detail is a closed `JsonObject` while the events it describes are full
 * of optional and `any`-typed members. Dropping what is not representable is the
 * only honest option: a detail that claimed to carry a value the frame could not
 * actually hold would be a lie a consumer would act on.
 */
function jsonDetail(entries: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    const json = toJsonValue(value);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

/** A description of a unit that reads only its shape, never its values. */
function describeUnit(unit: unknown): string {
  if (Array.isArray(unit)) return `array(${unit.length})`;
  if (typeof unit === 'string') return `string(${unit.length})`;
  if (isPlainObject(unit)) return `object{${Object.keys(unit).join(',')}}`;
  return typeof unit;
}

/**
 * Parse a tool call's accumulated argument text.
 *
 * Never throws, and never reports success it does not have:
 *  - Empty or whitespace-only text is a zero-argument call, not a syntax error.
 *    AG-UI makes `TOOL_CALL_ARGS` optional in practice, and a tool that takes no
 *    arguments emits no fragments at all; calling that a parse failure would
 *    put a red parse error in the transcript of a perfectly valid call.
 *  - A well-formed JSON value that is not an object is reported as an error
 *    rather than coerced, because `tool.args.done.args` is typed as a JSON
 *    object and inventing a wrapper would misrepresent what the model emitted.
 */
function parseArgs(toolCallId: string, argsText: string): FramePayloadMap['tool.args.done'] {
  if (argsText.trim() === '') return { toolCallId, args: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsText);
  } catch (err) {
    return {
      toolCallId,
      args: {},
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      toolCallId,
      args: {},
      parseError: `tool arguments parsed to ${Array.isArray(parsed) ? 'an array' : typeof parsed} rather than a JSON object`,
    };
  }
  return { toolCallId, args: parsed as JsonObject };
}

/**
 * A deterministic id for the tool message that answers a surface action.
 *
 * `:` is escaped because a component name is author-supplied: without escaping,
 * `('a:b', 'c')` and `('a', 'b:c')` would collide and one action's answer would
 * be attributed to another's call.
 */
function actionMessageId(action: ActionEvent): string {
  const token = (value: string): string => value.replace(/~/g, '~0').replace(/:/g, '~1');
  return `surface-action:${token(action.surfaceId)}:${token(action.componentId)}:${token(action.name)}`;
}

export { AGUI_STATE_SURFACE_ID };
