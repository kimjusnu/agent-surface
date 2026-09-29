/**
 * OpenTelemetry GenAI spans from a recorded run.
 *
 * ## Conventions followed
 *
 * Attributes are the GenAI semantic conventions (`gen_ai.*`), as published:
 *
 *  - `gen_ai.operation.name` -- `invoke_agent` for the run and each sub-agent,
 *    `chat` for an LLM step, `execute_tool` for a tool call.
 *  - `gen_ai.system` -- the model provider.
 *  - `gen_ai.request.model`, `gen_ai.agent.name`, `gen_ai.tool.name`,
 *    `gen_ai.tool.call.id`, `gen_ai.conversation.id`.
 *  - `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` on the run span,
 *    where the IR carries usage.
 *
 * Everything that is not a convention attribute is namespaced `agent_surface.*`
 * rather than being dropped or smuggled into a `gen_ai.*` name the convention
 * does not define -- a dashboard that queries `gen_ai.usage.cache_read_tokens`
 * has to mean something, and inventing it would mean something else to the next
 * exporter.
 *
 * ## Why plain objects
 *
 * No `@opentelemetry/api` dependency. The span shape here is structurally what
 * the SDK's `ReadableSpan` exposes, so a real exporter can be adapted with a
 * five-line `toSpan()` and the tests need no SDK, no global tracer provider, and
 * no `AsyncHooks`. The cost is that a semantic-convention rename upstream will
 * not be caught by the compiler; the mitigation is the `assertConventionNames`
 * test, which fails if any expected `gen_ai.*` attribute disappears.
 *
 * Timestamps are decimal strings, not numbers: nanoseconds since the epoch
 * exceed `Number.MAX_SAFE_INTEGER`, and JSON cannot carry a `bigint`, so a
 * numeric field would silently lose precision on the way to a file.
 */

import type { JsonObject, SurfaceFrame, Usage } from '@agent-surface/protocol';

import { fnv1a } from './tree.js';
import type { RunTrace } from './run.js';

// ---------------------------------------------------------------------------
// Span shape
// ---------------------------------------------------------------------------

export type SpanAttributeValue = string | number | boolean | readonly (string | number | boolean)[];

export interface SpanEvent {
  name: string;
  timeUnixNano: string;
  attributes: Record<string, SpanAttributeValue>;
}

export interface SpanLink {
  traceId: string;
  spanId: string;
  attributes: Record<string, SpanAttributeValue>;
}

export interface SpanStatus {
  code: 'unset' | 'ok' | 'error';
  message?: string;
}

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

export interface SpanDescriptor {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: SpanKind;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, SpanAttributeValue>;
  status: SpanStatus;
  events: readonly SpanEvent[];
  links: readonly SpanLink[];
}

/**
 * The exporter seam.
 *
 * Shaped after the OTel SDK's `SpanExporter` (including the callback argument and
 * the `ExportResult` codes) so wiring a real exporter is an adapter, not a
 * rewrite.
 */
export interface SpanExporter {
  export(
    spans: readonly SpanDescriptor[],
    resultCallback?: (result: ExportResult) => void,
  ): Promise<void>;
  shutdown(): Promise<void>;
  forceFlush?(): Promise<void>;
}

export type ExportResult = { code: 'success' | 'failed'; error?: Error };

/** Collects spans in memory, for tests and for a devtools panel. */
export class InMemorySpanExporter implements SpanExporter {
  readonly spans: SpanDescriptor[] = [];
  #shutdown = false;

  get shutdownCalled(): boolean {
    return this.#shutdown;
  }

  async export(
    spans: readonly SpanDescriptor[],
    resultCallback?: (result: ExportResult) => void,
  ): Promise<void> {
    if (this.#shutdown) {
      // Mirrors the SDK: exporting after shutdown is a failed export, not a
      // silent success and not a throw.
      resultCallback?.({ code: 'failed', error: new Error('exporter is shut down') });
      return;
    }
    this.spans.push(...spans);
    resultCallback?.({ code: 'success' });
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true;
  }

  reset(): void {
    this.spans.length = 0;
    this.#shutdown = false;
  }
}

// ---------------------------------------------------------------------------
// Step derivation
// ---------------------------------------------------------------------------

/**
 * Where a step boundary came from.
 *
 * Reported rather than assumed, because the three sources have different
 * authority and a reader comparing two runs needs to know which one produced
 * them: a step count that changed shape between runs is not a regression.
 */
export type StepSource =
  /** `AGUI_STEP_STARTED` / `AGUI_STEP_FINISHED` frames, which carry `stepName`. */
  | 'step-frames'
  /** `frame.step`, the opaque index the AG-UI adapter stamps. */
  | 'frame-step-index'
  /** Derived from the frame stream; see `deriveSteps`. */
  | 'derived';

export interface StepSpan {
  index: number;
  name?: string;
  source: StepSource;
  spanId: string;
  /** First and last `seq` inside the step, inclusive. */
  firstSeq: number;
  lastSeq: number;
  startTs: number;
  endTs: number;
  frameCount: number;
  messageIds: readonly string[];
  toolCallIds: readonly string[];
  subagentRunIds: readonly string[];
}

/** AG-UI's step events become `warning` frames: the IR has no step frame kind. */
export const STEP_STARTED_CODE = 'AGUI_STEP_STARTED';
export const STEP_FINISHED_CODE = 'AGUI_STEP_FINISHED';

export interface RawStep {
  index: number;
  name?: string;
  source: StepSource;
  startTs: number;
  endTs: number;
  firstSeq: number;
  lastSeq: number;
  frames: number;
  messageIds: string[];
  toolCallIds: string[];
  subagentRunIds: string[];
}

/**
 * Group a transcript into LLM steps.
 *
 * Three sources, in order of authority:
 *
 *  1. **step frames.** The AG-UI adapter counts `STEP_STARTED`/`STEP_FINISHED`
 *     and, because the IR has no frame kind for a step, emits each as a
 *     `warning` whose code names the event. These carry `stepName`, so a step
 *     can be labelled ("plan", "lookup") rather than numbered. Frames outside a
 *     boundary window -- `run.started`, `run.finished` -- belong to no step,
 *     because a span that claimed them would report the run's whole wall clock
 *     as one model call.
 *  2. **frame step index.** When the boundary frames are missing but frames carry
 *     `step`, consecutive frames sharing an index form a step.
 *  3. **derived.** A2UI and MCP Apps have neither, so a step is the span between
 *     assistant turns: it opens at the first frame after `run.started` and closes
 *     at each `text.done`, on the reasoning that a completed assistant message is
 *     what the model was working towards. A run with no `text.done` at all --
 *     a pure tool-calling loop -- yields a single step covering everything,
 *     because inventing turns there would be fiction.
 *
 * `text.done` only *closes* a step in the derived mode. In the explicit modes the
 * agent's own boundaries win even if a message crosses them.
 *
 * An unterminated step is kept rather than dropped: a transcript truncated
 * mid-step still shows what the model was doing when it stopped.
 */
export function deriveSteps(frames: readonly SurfaceFrame[]): readonly RawStep[] {
  return fromStepFrames(frames) ?? fromStepIndex(frames) ?? fromTurns(frames);
}

function fromStepFrames(frames: readonly SurfaceFrame[]): RawStep[] | undefined {
  const steps: RawStep[] = [];
  let current: RawStep | undefined;
  let sawBoundary = false;

  const close = (): void => {
    if (current === undefined) return;
    steps.push(current);
    current = undefined;
  };

  for (const frame of frames) {
    const code = codeOf(frame);
    if (code === STEP_STARTED_CODE) {
      sawBoundary = true;
      // A start inside an open step means the producer never closed the previous
      // one; closing it here keeps the steps non-overlapping instead of nesting
      // one step's frames inside another.
      close();
      current = openStep(steps.length, 'step-frames', frame);
      current.name = stepNameOf(frame);
      continue;
    }
    if (code === STEP_FINISHED_CODE) {
      sawBoundary = true;
      if (current === undefined) {
        // A finish with no start: still a step, so a partial transcript keeps
        // its boundary rather than merging into the previous step.
        current = openStep(steps.length, 'step-frames', frame);
      }
      current.name ??= stepNameOf(frame);
      current.frames += 1;
      current.lastSeq = frame.seq;
      current.endTs = frame.ts;
      close();
      continue;
    }
    if (current === undefined) continue;
    current.frames += 1;
    current.lastSeq = frame.seq;
    current.endTs = frame.ts;
    accumulate(current, frame);
  }
  close();
  return sawBoundary ? steps : undefined;
}

function fromStepIndex(frames: readonly SurfaceFrame[]): RawStep[] | undefined {
  const byIndex = new Map<number, RawStep>();
  const order: number[] = [];
  for (const frame of frames) {
    if (frame.step === undefined) continue;
    let step = byIndex.get(frame.step);
    if (!step) {
      step = openStep(order.length, 'frame-step-index', frame);
      byIndex.set(frame.step, step);
      order.push(frame.step);
    }
    step.endTs = frame.ts;
    step.lastSeq = frame.seq;
    step.frames += 1;
    accumulate(step, frame);
  }
  return order.length === 0 ? undefined : order.map((index) => byIndex.get(index)!);
}

function fromTurns(frames: readonly SurfaceFrame[]): RawStep[] {
  const steps: RawStep[] = [];
  let current: RawStep | undefined;
  for (const frame of frames) {
    if (frame.kind === 'run.started' || frame.kind === 'run.finished') continue;
    current ??= openStep(steps.length, 'derived', frame);
    current.endTs = frame.ts;
    current.lastSeq = frame.seq;
    current.frames += 1;
    accumulate(current, frame);
    if (frame.kind === 'text.done') {
      steps.push(current);
      current = undefined;
    }
  }
  if (current) steps.push(current);
  return steps;
}

function openStep(index: number, source: StepSource, frame: SurfaceFrame): RawStep {
  return {
    index,
    source,
    startTs: frame.ts,
    endTs: frame.ts,
    firstSeq: frame.seq,
    lastSeq: frame.seq,
    frames: 0,
    messageIds: [],
    toolCallIds: [],
    subagentRunIds: [],
  };
}

function accumulate(step: RawStep, frame: SurfaceFrame): void {
  if (frame.subagentRunId !== undefined && !step.subagentRunIds.includes(frame.subagentRunId)) {
    step.subagentRunIds.push(frame.subagentRunId);
  }
  const payload = frame.payload as Record<string, unknown> | undefined;
  const id = payload?.['toolCallId'];
  if (typeof id === 'string' && !step.toolCallIds.includes(id)) step.toolCallIds.push(id);
  const messageId = payload?.['messageId'];
  if (frame.kind === 'text.done' && typeof messageId === 'string' && !step.messageIds.includes(messageId)) {
    step.messageIds.push(messageId);
  }
}

function codeOf(frame: SurfaceFrame): string | undefined {
  if (frame.kind !== 'warning') return undefined;
  const code = (frame.payload as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function stepNameOf(frame: SurfaceFrame): string | undefined {
  const detail = (frame.payload as { detail?: unknown }).detail;
  const name = detail !== null && typeof detail === 'object' ? (detail as JsonObject)['stepName'] : undefined;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

// ---------------------------------------------------------------------------
// Span construction
// ---------------------------------------------------------------------------

export interface BuildSpansOptions {
  /**
   * `gen_ai.system`. The IR has no provider field, so this is the host's to
   * supply; `modelHint` below is tried first and this is the fallback.
   */
  system?: string;
  /** `gen_ai.request.model`. Tried from `run.started` before this fallback. */
  model?: string;
  /** Include serialised tool arguments as an attribute. */
  includeToolArguments?: boolean;
  /** Cap for that serialisation, so a 4 KB argument object does not become a span attribute. */
  maxArgumentChars?: number;
}

export interface SpanBundle {
  traceId: string;
  rootSpanId: string;
  spans: readonly SpanDescriptor[];
  steps: readonly StepSpan[];
  bySpanId: ReadonlyMap<string, SpanDescriptor>;
}

export function buildSpans(run: RunTrace, options: BuildSpansOptions = {}): SpanBundle {
  const model = options.model ?? modelHint(run) ?? 'unknown';
  const system = options.system ?? 'unknown';
  const traceId = traceIdOf(run);
  const rootSpanId = spanIdOf(traceId, 'run');
  const frames = run.frames;
  const steps = deriveSteps(frames);

  const startTs = frames[0]?.ts ?? run.startedAt;
  const endTs = run.endedAt ?? run.totals.wallClockMs + startTs;
  const spans: SpanDescriptor[] = [];

  const common: Record<string, SpanAttributeValue> = {
    'gen_ai.system': system,
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.conversation.id': run.threadId,
    'gen_ai.response.id': run.runId,
    'gen_ai.agent.name': run.agentName ?? 'unknown',
    'gen_ai.request.model': model,
    'agent_surface.protocol': run.protocol,
    'agent_surface.frame_count': run.totals.frameCount,
    'agent_surface.warning_count': run.totals.warnings,
    'agent_surface.error_count': run.totals.errors,
    'agent_surface.step_count': steps.length,
    'agent_surface.tracer_warning_count': run.totals.tracerWarnings,
  };
  addUsageAttributes(common, run.totals.usage);

  const runStatus: SpanStatus = run.tree.status === 'success' ? { code: 'ok' } : { code: 'error', message: `run ${run.tree.status}` };
  const rootEvents: SpanEvent[] = run.state.errors.map((error) => ({
    name: 'exception',
    timeUnixNano: nanos(error.ts),
    attributes: {
      'exception.type': error.code,
      'exception.message': error.message,
      ...(error.fatal ? { 'exception.escaped': true } : {}),
    },
  }));
  if (run.totals.tools.orphan > 0) {
    rootEvents.push({
      name: 'agent_surface.orphan_tool_calls',
      timeUnixNano: nanos(endTs),
      attributes: { count: run.totals.tools.orphan },
    });
  }

  spans.push({
    name: `invoke_agent ${run.agentName ?? run.runId}`,
    traceId,
    spanId: rootSpanId,
    kind: 'internal',
    startTimeUnixNano: nanos(startTs),
    endTimeUnixNano: nanos(endTs),
    attributes: common,
    status: runStatus,
    events: rootEvents,
    links: [],
  });

  const stepSpans: StepSpan[] = [];
  for (const step of steps) {
    const stepSpanId = spanIdOf(traceId, `step:${String(step.index)}`);
    stepSpans.push({
      index: step.index,
      ...(step.name !== undefined ? { name: step.name } : {}),
      source: step.source,
      spanId: stepSpanId,
      firstSeq: step.firstSeq,
      lastSeq: step.lastSeq,
      startTs: step.startTs,
      endTs: step.endTs,
      frameCount: step.frames,
      messageIds: [...step.messageIds],
      toolCallIds: [...step.toolCallIds],
      subagentRunIds: [...step.subagentRunIds],
    });
    spans.push({
      name: `chat ${model}`,
      traceId,
      spanId: stepSpanId,
      parentSpanId: rootSpanId,
      kind: 'client',
      startTimeUnixNano: nanos(step.startTs),
      endTimeUnixNano: nanos(step.endTs),
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.system': system,
        'gen_ai.request.model': model,
        'gen_ai.conversation.id': run.threadId,
        'agent_surface.step_index': step.index,
        'agent_surface.step_source': step.source,
        'agent_surface.message_count': step.messageIds.length,
        'agent_surface.tool_call_count': step.toolCallIds.length,
      },
      status: { code: 'unset' },
      events: [],
      links: [],
    });
  }

  const subagentSpanIds = new Map<string, string>();
  for (const subagent of run.state.subagents) {
    const spanId = spanIdOf(traceId, `subagent:${subagent.subagentRunId}`);
    subagentSpanIds.set(subagent.subagentRunId, spanId);
  }
  for (const subagent of run.state.subagents) {
    const spanId = subagentSpanIds.get(subagent.subagentRunId)!;
    const parent = subagent.parentSubagentRunId
      ? subagentSpanIds.get(subagent.parentSubagentRunId) ?? rootSpanId
      : rootSpanId;
    const attributes: Record<string, SpanAttributeValue> = {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.system': system,
      'gen_ai.agent.name': subagent.name,
      'agent_surface.subagent_run_id': subagent.subagentRunId,
      'agent_surface.subagent_status': subagent.status,
    };
    if (subagent.durationMs !== undefined) attributes['agent_surface.duration_ms'] = subagent.durationMs;
    spans.push({
      name: `invoke_agent ${subagent.name}`,
      traceId,
      spanId,
      ...(parent !== undefined ? { parentSpanId: parent } : {}),
      kind: 'internal',
      startTimeUnixNano: nanos(subagent.startedAt ?? startTs),
      endTimeUnixNano: nanos(subagent.endedAt ?? endTs),
      attributes,
      status:
        subagent.status === 'error'
          ? { code: 'error', message: subagent.detail ?? 'sub-agent failed' }
          : subagent.status === 'orphan'
            ? { code: 'error', message: 'sub-agent finished with no start' }
            : { code: 'unset' },
      events: [],
      links: [],
    });
  }

  for (const tool of run.state.tools) {
    const stepIndex = stepSpans.findIndex(
      (step) => tool.firstSeq >= step.firstSeq && tool.lastSeq <= step.lastSeq,
    );
    const step = stepIndex === -1 ? undefined : stepSpans[stepIndex];
    const subagentId = tool.subagentRunId;
    const parent = subagentId
      ? subagentSpanIds.get(subagentId) ?? rootSpanId
      : (step?.spanId ?? rootSpanId);
    const attributes: Record<string, SpanAttributeValue> = {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.system': system,
      'gen_ai.tool.name': tool.name,
      'gen_ai.tool.call.id': tool.toolCallId,
      'gen_ai.conversation.id': run.threadId,
      'agent_surface.tool_status': tool.status,
    };
    if (tool.durationMs !== undefined) attributes['agent_surface.duration_ms'] = tool.durationMs;
    if (tool.parentMessageId !== undefined) {
      attributes['agent_surface.parent_message_id'] = tool.parentMessageId;
    }
    if (options.includeToolArguments !== false) {
      const serialised = safeStringify(tool.args);
      if (serialised !== undefined) {
        attributes['agent_surface.tool.args'] = serialised.length > (options.maxArgumentChars ?? 1_024)
          ? `${serialised.slice(0, options.maxArgumentChars ?? 1_024)}…[truncated]`
          : serialised;
      }
    }
    const events: SpanEvent[] = [];
    if (tool.parseError !== undefined) {
      events.push({
        name: 'exception',
        timeUnixNano: nanos(tool.argsDoneAt ?? tool.startedAt ?? startTs),
        attributes: { 'exception.type': 'ToolArgumentParseError', 'exception.message': tool.parseError },
      });
    }
    spans.push({
      name: `execute_tool ${tool.name}`,
      traceId,
      spanId: spanIdOf(traceId, `tool:${tool.toolCallId}`),
      ...(parent !== undefined ? { parentSpanId: parent } : {}),
      kind: 'client',
      // A result with no start has no opening timestamp; falling back to the
      // run's start would overstate its duration, so the span opens at the run's
      // first frame and the `agent_surface.tool_status` attribute says why.
      startTimeUnixNano: nanos(tool.startedAt ?? startTs),
      endTimeUnixNano: nanos(tool.endedAt ?? endTs),
      attributes,
      status: toolStatus(tool.status, tool.isError === true),
      events,
      links: [],
    });
  }

  const bySpanId = new Map(spans.map((span) => [span.spanId, span]));
  return { traceId, rootSpanId, spans, steps: stepSpans, bySpanId };
}

/** Build and hand off to an exporter in one call. */
export async function exportSpans(
  exporter: SpanExporter,
  run: RunTrace,
  options: BuildSpansOptions = {},
): Promise<SpanBundle> {
  const bundle = buildSpans(run, options);
  await exporter.export(bundle.spans);
  return bundle;
}

/** Spans as a flat list ordered parents-first, which is what a trace UI wants. */
export function orderSpans(bundle: SpanBundle): readonly SpanDescriptor[] {
  const depth = (span: SpanDescriptor): number => {
    let level = 0;
    let current = span;
    while (current.parentSpanId !== undefined) {
      const parent = bundle.bySpanId.get(current.parentSpanId);
      if (!parent) break;
      level += 1;
      current = parent;
    }
    return level;
  };
  return bundle.spans
    .map((span, index) => ({ span, index }))
    .sort((a, b) => {
      const delta = depth(a.span) - depth(b.span);
      return delta !== 0 ? delta : a.index - b.index;
    })
    .map((entry) => entry.span);
}

// ---------------------------------------------------------------------------
// Attributes and identity
// ---------------------------------------------------------------------------

function addUsageAttributes(attributes: Record<string, SpanAttributeValue>, usage: Usage): void {
  attributes['gen_ai.usage.input_tokens'] = usage.inputTokens;
  attributes['gen_ai.usage.output_tokens'] = usage.outputTokens;
  if (usage.cachedInputTokens !== undefined) {
    // Provider extensions: the convention defines input/output only, so these
    // stay in `gen_ai.usage.*` for discoverability but are documented as
    // non-standard rather than passed off as convention.
    attributes['gen_ai.usage.cached_input_tokens'] = usage.cachedInputTokens;
  }
  if (usage.reasoningTokens !== undefined) {
    attributes['gen_ai.usage.reasoning_tokens'] = usage.reasoningTokens;
  }
  if (usage.costUsd !== undefined) attributes['agent_surface.cost_usd'] = usage.costUsd;
}

function toolStatus(status: string, isError: boolean): SpanStatus {
  if (status === 'error') return { code: 'error', message: 'tool reported an error result' };
  if (status === 'orphan') {
    // An unresolved or unattributable call is a protocol fault, and an OTel
    // span that quietly reported `ok` would hide it from every error dashboard.
    return { code: 'error', message: 'tool call never resolved or has no matching start' };
  }
  if (status === 'open') return { code: 'unset', message: 'tool call still open' };
  return isError ? { code: 'error' } : { code: 'ok' };
}

/**
 * A 32-hex trace id derived from the run's identity.
 *
 * Deterministic rather than random so that re-exporting the same trace
 * produces the same ids: a trace viewer that linked two exports of one run by
 * span id would otherwise show them as unrelated.
 */
export function traceIdOf(run: { threadId: string; runId: string }): string {
  return `${fnv1a(run.threadId)}${fnv1a(run.runId)}${fnv1a(`${run.threadId}#${run.runId}`)}${fnv1a(run.runId)}`
    .padEnd(32, '0')
    .slice(0, 32);
}

/** 16-hex span id, also derived rather than random (see `traceIdOf`). */
export function spanIdOf(traceId: string, path: string): string {
  const hash = `${fnv1a(`${traceId}|${path}`)}${fnv1a(path)}${fnv1a(`${path}|${traceId}`)}${fnv1a(`${traceId}${path}`)}`;
  // A zero id is invalid in the trace context; FNV-1a can produce it.
  return (hash.padEnd(16, '0').slice(0, 16) === '0000000000000000' ? '0000000000000001' : hash.padEnd(16, '0').slice(0, 16));
}

/** Epoch millis -> nanoseconds as a decimal string (see the module comment). */
export function nanos(ms: number | undefined): string {
  const millis = typeof ms === 'number' && Number.isFinite(ms) ? Math.round(ms) : 0;
  return (BigInt(millis) * 1_000_000n).toString(10);
}

/**
 * A model hint lifted from `run.started`.
 *
 * AG-UI forwards agent-specific values in `forwardedProps` (its own documented
 * extension point), and an adapter may also advertise a model in capabilities.
 * Both are guesses -- a host that knows the model should pass it explicitly.
 */
export function modelHint(run: RunTrace): string | undefined {
  const started = run.frames.find((frame) => frame.kind === 'run.started');
  if (!started) return undefined;
  const payload = started.payload as { input?: unknown; capabilities?: unknown };
  const candidates: unknown[] = [
    dig(payload.capabilities, 'model'),
    dig(payload.capabilities, 'gen_ai.request.model'),
    dig(payload.input, 'model'),
    dig(payload.input, 'forwardedProps.model'),
    dig(payload.input, 'forwardedProps.gen_ai.request.model'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return undefined;
}

function dig(value: unknown, path: string): unknown {
  let cursor = value;
  for (const token of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[token];
  }
  return cursor;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    // A cyclic args object would otherwise take the whole export down.
    return undefined;
  }
}
