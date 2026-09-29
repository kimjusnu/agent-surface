/**
 * Run input for the eval engine.
 *
 * ---------------------------------------------------------------------------
 * Why this type is local and not `@agent-surface/trace`
 * ---------------------------------------------------------------------------
 * The tracer package is being built in parallel and is not a dependency of the
 * eval engine on purpose. An eval gate that imports the tracer cannot run in a
 * CI container that has not installed it, and "the gate did not run" is the
 * worst possible CI outcome -- it reads as a pass. The shape below is the
 * minimal structural contract: anything that can hand over a frame array is a
 * valid input, now or after the tracer ships. If the tracer's recorded-run type
 * satisfies `EvalRunInput`, it can be passed through untouched, and anything
 * richer is recomputed here from `frames` with the protocol helpers so there is
 * exactly one implementation of "what this run did".
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import type {
  DataModel,
  FrameKind,
  FramePayloadMap,
  JsonObject,
  JsonPointer,
  JsonValue,
  ProtocolId,
  SurfaceFrame,
  SurfaceNode,
  Usage,
} from '@agent-surface/protocol';
import { flattenSurface, setAtPointer } from '@agent-surface/protocol';

import { toJsonValue, truncateJson, type JsonMeasurement, measureJson } from './json.js';

// ---------------------------------------------------------------------------
// The IR publishes these as types only, so the runtime mirror lives here.
// ---------------------------------------------------------------------------

const FRAME_KINDS: readonly FrameKind[] = [
  'run.started',
  'text.delta',
  'text.done',
  'tool.started',
  'tool.args.delta',
  'tool.args.done',
  'tool.result',
  'surface.created',
  'surface.nodes',
  'surface.data',
  'surface.deleted',
  'app.attached',
  'action.dispatched',
  'interrupt',
  'subagent',
  'warning',
  'error',
  'run.finished',
];

const PROTOCOL_IDS: readonly ProtocolId[] = ['ag-ui', 'a2ui', 'mcp-apps'];

export const UNKNOWN_TOOL_NAME = '(unknown)';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** A recorded run: the frame stream plus the identity needed to route it. */
export interface EvalRunInput {
  runId: string;
  threadId: string;
  protocol: ProtocolId;
  /**
   * Human-facing label used by suite subjects. Defaults to `runId`, which is
   * why a subject may be written against either.
   */
  scenario?: string;
  frames: SurfaceFrame[];
  /** Tracer-supplied metadata. Never asserted on; carried into reports. */
  meta?: JsonObject;
}

export interface NormalizeLimits {
  maxFrames: number;
  maxPayloadBytes: number;
  maxPayloadDepth: number;
  maxArrayItems: number;
}

export const DEFAULT_LIMITS: NormalizeLimits = {
  maxFrames: 100_000,
  maxPayloadBytes: 64 * 1024,
  maxPayloadDepth: 24,
  maxArrayItems: 500,
};

/** A frame (or the run envelope) that could not be used. Never fatal. */
export interface InputIssue {
  /** Stable machine-readable code, safe to filter on in a suite. */
  code: string;
  message: string;
  /** Position in the input `frames` array. */
  index?: number;
  seq?: number;
  kind?: string;
}

export interface TruncationReport {
  /** Frames past `maxFrames` that were dropped entirely. */
  framesDropped: number;
  /** Frames whose payload was shortened to fit `maxPayloadBytes`. */
  framesShortened: number;
  /** seq of the first dropped frame, for pointing at a trace. */
  firstDroppedSeq?: number;
  maxPayloadBytes: number;
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

export interface NormalizedFrame {
  /** Position after sorting. Stable across identical inputs. */
  index: number;
  seq: number;
  kind: FrameKind;
  ts: number;
  source: ProtocolId;
  runId: string;
  threadId: string;
  step?: number;
  subagentRunId?: string;
  payload: FramePayloadMap[FrameKind];
  /** True when the payload was shortened by the size cap. */
  truncated: boolean;
}

/** `framesOf` narrows a frame union to one kind so asserters stay type-safe. */
export interface TypedFrame<K extends FrameKind> {
  index: number;
  seq: number;
  ts: number;
  kind: K;
  truncated: boolean;
  step?: number;
  subagentRunId?: string;
  payload: FramePayloadMap[K];
}

export interface NormalizedMessage {
  messageId: string;
  /** `text.done` when present, otherwise the concatenated `text.delta`s. */
  text: string;
  deltaCount: number;
  seqStart: number;
  seqEnd: number;
}

export interface NormalizedToolCall {
  toolCallId: string;
  toolName: string;
  /** seq of `tool.started`, or of the first frame seen for this id. */
  seq: number;
  startTs: number;
  step?: number;
  /** Raw streamed argument text, when the adapter sent `tool.args.delta`. */
  argsText?: string;
  /** `tool.args.done` payload, or a salvage parse of `argsText`. */
  args?: JsonObject;
  /** True when `args` came from parsing `argsText` rather than `args.done`. */
  argsSalvaged?: boolean;
  argsParseError?: string;
  resultContent?: string;
  isError: boolean;
  /** Provider/tool reported duration, when present. */
  durationMs?: number;
  /** ts(`tool.result`) - ts(`tool.started`), clamped at 0. */
  observedDurationMs?: number;
  completed: boolean;
  /** True when a result arrived without a matching `tool.started`. */
  orphan: boolean;
  truncated: boolean;
}

export interface NormalizedSurface {
  surfaceId: string;
  catalogId: string;
  title?: string;
  nodes: SurfaceNode[];
  /** Result of `flattenSurface`: de-duplicated, cycle-safe. */
  nodeCount: number;
  maxDepth: number;
  /** Raw node count, before de-duplication. > `nodeCount` means a cycle or dup id. */
  rawNodeCount: number;
  data: DataModel;
  createdSeq: number;
  lastSeq: number;
  deleted: boolean;
  nodeUpdates: number;
  dataWrites: number;
  /** Literal was seen with a `data` ref or `{{ template }}`. */
  usesDataModel: boolean;
}

export interface NormalizedAction {
  surfaceId: string;
  componentId: string;
  name: string;
  context: JsonObject;
  seq: number;
  ts: number;
}

export interface NormalizedInterrupt {
  reason: string;
  resumable: boolean;
  resumeToken?: string;
  seq: number;
  ts: number;
  /** True when the run showed forward progress after the interrupt. */
  answered: boolean;
  /** The frame kind that counted as the answer, for a readable message. */
  answeredBy?: FrameKind;
}

export interface NormalizedSubagent {
  name: string;
  phase: 'started' | 'finished' | 'error';
  detail?: string;
  seq: number;
  ts: number;
  step?: number;
  subagentRunId?: string;
}

export interface NormalizedProblem {
  code: string;
  message: string;
  fatal: boolean;
  detail?: JsonObject;
  seq: number;
  ts: number;
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/** USD per one million tokens. */
export interface PriceEntry {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number;
  reasoningPerMTok?: number;
}

export type PriceTable = Record<ProtocolId, PriceEntry>;

/**
 * Coarse defaults keyed by protocol.
 *
 * The IR carries no model id, so the run input cannot be priced exactly. These
 * are public list prices for a representative model per protocol, chosen so
 * `max-cost` is a usable relative signal rather than a fake absolute one. The
 * table is exported so a host with real numbers overrides it per run instead of
 * forking the asserter; `Usage.costUsd` always wins when the provider reported
 * one, so this only matters for runs that predate cost reporting.
 */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  'ag-ui': { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  a2ui: { inputPerMTok: 0.8, outputPerMTok: 4, cachedInputPerMTok: 0.08 },
  'mcp-apps': { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 },
};

export interface CostBreakdown {
  costUsd: number;
  source: 'reported' | 'estimated' | 'none';
}

/**
 * Cost from token counts.
 *
 * Two conventions are baked in, both of which differ between providers, so they
 * are stated rather than hidden: `cachedInputTokens` is treated as a *subset* of
 * `inputTokens` (the only way the totals stay additive), and `reasoningTokens`
 * is treated as already included in `outputTokens` (adding it again would
 * double-charge thinking tokens on every provider that reports them).
 */
export function estimateCostUsd(usage: Usage | null | undefined, price: PriceEntry | undefined): number {
  if (!usage || !price) return 0;
  const input = finite(usage.inputTokens);
  const output = finite(usage.outputTokens);
  const cached = Math.min(input, Math.max(0, finite(usage.cachedInputTokens)));

  const freshInput = Math.max(0, input - cached);
  const cachedRate = price.cachedInputPerMTok ?? price.inputPerMTok;
  const reasoningExtra = Math.max(0, finite(usage.reasoningTokens)) * (price.reasoningPerMTok ?? 0);

  const total =
    (freshInput * price.inputPerMTok +
      cached * cachedRate +
      output * price.outputPerMTok +
      reasoningExtra) /
    1_000_000;
  return roundUsd(total);
}

export function resolveCost(usage: Usage | null | undefined, price: PriceEntry | undefined): CostBreakdown {
  if (usage && typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) {
    return { costUsd: roundUsd(usage.costUsd), source: 'reported' };
  }
  if (!usage) return { costUsd: 0, source: 'none' };
  return { costUsd: estimateCostUsd(usage, price), source: 'estimated' };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface RunMetrics {
  latencyMs: number;
  firstTs: number;
  lastTs: number;
  toolCallCount: number;
  toolErrorCount: number;
  maxToolLatencyMs: number;
  errorCount: number;
  fatalErrorCount: number;
  warningCount: number;
  interruptCount: number;
  unansweredInterruptCount: number;
  subagentCount: number;
  failedSubagentCount: number;
  surfaceCount: number;
  maxSurfaceNodes: number;
  maxSurfaceDepth: number;
  actionCount: number;
  actionNames: string[];
  textLength: number;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  costSource: 'reported' | 'estimated' | 'none';
  finished: boolean;
  outcome: 'success' | 'cancelled' | 'interrupt' | null;
  agentName: string | null;
}

// ---------------------------------------------------------------------------
// Normalized run
// ---------------------------------------------------------------------------

export interface NormalizedRun {
  runId: string;
  threadId: string;
  protocol: ProtocolId;
  scenario: string;
  agentName: string | null;
  frames: readonly NormalizedFrame[];
  limits: NormalizeLimits;
  /** Frames (or the envelope) that were unusable. Empty on a clean run. */
  inputErrors: InputIssue[];
  truncation: TruncationReport;
  /** Count of missing seq numbers between first and last, tolerated by design. */
  seqGaps: number;
  /** True when any frame's `ts` went backwards after sorting. */
  nonMonotonicTimestamps: boolean;
  messages: NormalizedMessage[];
  /** All assistant text, messages joined by a blank line. */
  text: string;
  toolCalls: NormalizedToolCall[];
  surfaces: NormalizedSurface[];
  /** Surfaces in creation order, de-duplicated by `surfaceId`. */
  surfaceIndex: ReadonlyMap<string, NormalizedSurface>;
  /** Final data models merged across every surface. */
  dataModel: DataModel;
  actions: NormalizedAction[];
  interrupts: NormalizedInterrupt[];
  subagents: NormalizedSubagent[];
  errors: NormalizedProblem[];
  warnings: NormalizedProblem[];
  usage: Usage | null;
  metrics: RunMetrics;
  meta: JsonObject;
}

export function framesOf<K extends FrameKind>(run: NormalizedRun, kind: K): TypedFrame<K>[] {
  const out: TypedFrame<K>[] = [];
  for (const frame of run.frames) {
    if (frame.kind !== kind) continue;
    out.push({
      index: frame.index,
      seq: frame.seq,
      ts: frame.ts,
      kind,
      truncated: frame.truncated,
      step: frame.step,
      subagentRunId: frame.subagentRunId,
      payload: frame.payload as FramePayloadMap[K],
    });
  }
  return out;
}

/**
 * Resolve the surface an assertion is about. `undefined` means "every live
 * surface": deleted surfaces are excluded unless a suite names one explicitly,
 * because asserting on a surface the agent already tore down measures nothing.
 */
export function selectSurfaces(run: NormalizedRun, surfaceId?: string): NormalizedSurface[] {
  if (surfaceId !== undefined) {
    const found = run.surfaceIndex.get(surfaceId);
    return found ? [found] : [];
  }
  return run.surfaces.filter((surface) => !surface.deleted);
}

export function selectDataModel(run: NormalizedRun, surfaceId?: string): DataModel {
  if (surfaceId === undefined) return run.dataModel;
  return run.surfaceIndex.get(surfaceId)?.data ?? {};
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

interface RawFrame {
  index: number;
  seq: number;
  kind: FrameKind;
  ts: number;
  source: ProtocolId;
  runId: string;
  threadId: string;
  step?: number;
  subagentRunId?: string;
  payload: FramePayloadMap[FrameKind];
  truncated: boolean;
}

function normalizeFrame(
  raw: unknown,
  index: number,
  envelope: { runId: string; threadId: string; protocol: ProtocolId },
  limits: NormalizeLimits,
  issues: InputIssue[],
): RawFrame | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ code: 'frame.not-an-object', index, message: `frame ${index} is not an object` });
    return null;
  }
  const frame = raw as Record<string, unknown>;

  const kind = frame['kind'];
  if (!isNonEmptyString(kind) || !(FRAME_KINDS as readonly string[]).includes(kind)) {
    issues.push({
      code: 'frame.unknown-kind',
      index,
      kind: typeof kind === 'string' ? kind : undefined,
      message: `frame ${index} has unknown kind ${JSON.stringify(kind)}`,
    });
    return null;
  }
  const frameKind = kind as FrameKind;

  if (typeof frame['ts'] !== 'number' || !Number.isFinite(frame['ts'])) {
    issues.push({
      code: 'frame.bad-timestamp',
      index,
      kind: frameKind,
      message: `frame ${index} (${frameKind}) has a non-finite ts`,
    });
    return null;
  }
  const ts = frame['ts'];

  let seq = index;
  if (typeof frame['seq'] === 'number' && Number.isFinite(frame['seq'])) {
    seq = frame['seq'];
  } else {
    issues.push({
      code: 'frame.missing-seq',
      index,
      kind: frameKind,
      message: `frame ${index} (${frameKind}) has no usable seq; using array position ${index}`,
    });
  }

  let source = envelope.protocol;
  if (typeof frame['source'] === 'string') {
    if ((PROTOCOL_IDS as readonly string[]).includes(frame['source'])) {
      source = frame['source'] as ProtocolId;
    } else {
      issues.push({
        code: 'frame.unknown-source',
        index,
        kind: frameKind,
        message: `frame ${index} has unknown source ${JSON.stringify(frame['source'])}; using ${envelope.protocol}`,
      });
    }
  }

  const runId = isNonEmptyString(frame['runId']) ? frame['runId'] : envelope.runId;
  const threadId = isNonEmptyString(frame['threadId']) ? frame['threadId'] : envelope.threadId;

  const payloadRaw = frame['payload'];
  let payload: FramePayloadMap[FrameKind];
  let truncated = false;
  if (payloadRaw === null || typeof payloadRaw !== 'object' || Array.isArray(payloadRaw)) {
    issues.push({
      code: 'frame.bad-payload',
      index,
      kind: frameKind,
      message: `frame ${index} (${frameKind}) has a non-object payload; treated as empty`,
    });
    payload = {} as FramePayloadMap[FrameKind];
  } else {
    const measured: JsonMeasurement = measureJson(payloadRaw);
    if (measured.bytes > limits.maxPayloadBytes) {
      const result = truncateJson(payloadRaw, {
        maxBytes: limits.maxPayloadBytes,
        maxDepth: limits.maxPayloadDepth,
        maxArrayItems: limits.maxArrayItems,
        label: frameKind,
      });
      payload = result.value as FramePayloadMap[FrameKind];
      truncated = true;
    } else {
      // No cap hit: still projected through the sanitizer so a cyclic payload
      // cannot reach an asserter, but no bytes are lost.
      const result = truncateJson(payloadRaw, {
        maxBytes: Number.POSITIVE_INFINITY,
        maxDepth: limits.maxPayloadDepth,
        maxArrayItems: Number.POSITIVE_INFINITY,
        label: frameKind,
      });
      payload = result.value as FramePayloadMap[FrameKind];
      truncated = result.truncated && !measured.capped;
      if (measured.cycles > 0) {
        issues.push({
          code: 'frame.cyclic-payload',
          index,
          kind: frameKind,
          message: `frame ${index} (${frameKind}) payload contains ${measured.cycles} cyclic reference(s)`,
        });
      }
    }
    if (measured.capped) {
      issues.push({
        code: 'frame.payload-unmeasurable',
        index,
        kind: frameKind,
        message: `frame ${index} (${frameKind}) payload exceeded the measurement node cap; size is a lower bound`,
      });
    }
  }

  const step = typeof frame['step'] === 'number' && Number.isFinite(frame['step']) ? frame['step'] : undefined;
  const subagentRunId = isNonEmptyString(frame['subagentRunId']) ? frame['subagentRunId'] : undefined;

  return {
    index,
    seq,
    kind: frameKind,
    ts,
    source,
    runId,
    threadId,
    step,
    subagentRunId,
    payload,
    truncated,
  };
}

/**
 * Turn a raw recorded run into the view every asserter reads.
 *
 * Never throws. A run that is too large, cyclic, or partly malformed produces a
 * `NormalizedRun` plus a list of `inputErrors`, because a gate that crashes on
 * a broken trace cannot report *why* the trace broke -- and the broken trace is
 * usually the interesting one.
 */
export function normalizeRun(input: EvalRunInput, options: Partial<NormalizeLimits> = {}): NormalizedRun {
  const limits: NormalizeLimits = {
    maxFrames: options.maxFrames ?? DEFAULT_LIMITS.maxFrames,
    maxPayloadBytes: options.maxPayloadBytes ?? DEFAULT_LIMITS.maxPayloadBytes,
    maxPayloadDepth: options.maxPayloadDepth ?? DEFAULT_LIMITS.maxPayloadDepth,
    maxArrayItems: options.maxArrayItems ?? DEFAULT_LIMITS.maxArrayItems,
  };
  const issues: InputIssue[] = [];

  const envelopeRaw = (input ?? {}) as unknown as Record<string, unknown>;
  const runId = isNonEmptyString(envelopeRaw['runId']) ? envelopeRaw['runId'] : '(unknown-run)';
  if (!isNonEmptyString(envelopeRaw['runId'])) {
    issues.push({ code: 'run.missing-id', message: 'run envelope has no runId; using (unknown-run)' });
  }
  const threadId = isNonEmptyString(envelopeRaw['threadId']) ? envelopeRaw['threadId'] : '(unknown-thread)';
  let protocol: ProtocolId = 'ag-ui';
  if (isNonEmptyString(envelopeRaw['protocol']) && (PROTOCOL_IDS as readonly string[]).includes(envelopeRaw['protocol'])) {
    protocol = envelopeRaw['protocol'] as ProtocolId;
  } else {
    issues.push({
      code: 'run.unknown-protocol',
      message: `run envelope has unknown protocol ${JSON.stringify(envelopeRaw['protocol'])}; assuming ag-ui`,
    });
  }
  const scenario = isNonEmptyString(envelopeRaw['scenario']) ? envelopeRaw['scenario'] : runId;
  const meta = toJsonValue(envelopeRaw['meta'] ?? {}) as JsonObject;

  const envelope = { runId, threadId, protocol };
  const rawFrames = Array.isArray(envelopeRaw['frames']) ? (envelopeRaw['frames'] as unknown[]) : null;
  if (!rawFrames) {
    issues.push({ code: 'run.frames-not-an-array', message: 'run envelope has no frames array; treating as empty' });
  }
  const source = rawFrames ?? [];

  const kept: RawFrame[] = [];
  let framesDropped = 0;
  let framesShortened = 0;
  let firstDroppedSeq: number | undefined;

  for (let i = 0; i < source.length; i++) {
    if (kept.length >= limits.maxFrames) {
      framesDropped += 1;
      if (firstDroppedSeq === undefined) {
        const candidate = (source[i] ?? {}) as Record<string, unknown>;
        firstDroppedSeq = typeof candidate['seq'] === 'number' ? candidate['seq'] : i;
      }
      continue;
    }
    const frame = normalizeFrame(source[i], i, envelope, limits, issues);
    if (!frame) continue;
    if (frame.truncated) framesShortened += 1;
    kept.push(frame);
  }

  if (framesDropped > 0) {
    issues.push({
      code: 'run.frames-truncated',
      message: `run has ${source.length} frames; kept the first ${limits.maxFrames} and dropped ${framesDropped}`,
    });
  }

  // seq is the IR's total order. Sorting by it (not by ts) is what makes a
  // replay reproducible when two transports disagree about arrival time.
  const ordered = kept
    .map((frame, order) => ({ frame, order }))
    .sort((a, b) => a.frame.seq - b.frame.seq || a.order - b.order)
    .map(({ frame }, index) => ({ ...frame, index }));

  let seqGaps = 0;
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!.seq;
    const curr = ordered[i]!.seq;
    if (curr > prev + 1) seqGaps += curr - prev - 1;
  }
  if (seqGaps > 0) {
    issues.push({
      code: 'run.seq-gaps',
      message: `run has ${seqGaps} missing seq value(s); gaps are tolerated but the trace is incomplete`,
    });
  }

  let nonMonotonicTimestamps = false;
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]!.ts < ordered[i - 1]!.ts) {
      nonMonotonicTimestamps = true;
      break;
    }
  }
  if (nonMonotonicTimestamps) {
    issues.push({
      code: 'run.non-monotonic-ts',
      message: 'frame timestamps go backwards once sorted by seq; latency figures are max(ts)-min(ts)',
    });
  }

  const frames: NormalizedFrame[] = ordered.map((frame) => ({
    index: frame.index,
    seq: frame.seq,
    kind: frame.kind,
    ts: frame.ts,
    source: frame.source,
    runId: frame.runId,
    threadId: frame.threadId,
    step: frame.step,
    subagentRunId: frame.subagentRunId,
    payload: frame.payload,
    truncated: frame.truncated,
  }));

  const derived = derive(frames, protocol, issues);

  return {
    runId,
    threadId,
    protocol,
    scenario,
    agentName: derived.agentName,
    frames,
    limits,
    inputErrors: issues,
    truncation: {
      framesDropped,
      framesShortened,
      ...(firstDroppedSeq === undefined ? {} : { firstDroppedSeq }),
      maxPayloadBytes: limits.maxPayloadBytes,
    },
    seqGaps,
    nonMonotonicTimestamps,
    messages: derived.messages,
    text: derived.messages.map((m) => m.text).join('\n\n'),
    toolCalls: derived.toolCalls,
    surfaces: derived.surfaces,
    surfaceIndex: derived.surfaceIndex,
    dataModel: derived.dataModel,
    actions: derived.actions,
    interrupts: derived.interrupts,
    subagents: derived.subagents,
    errors: derived.errors,
    warnings: derived.warnings,
    usage: derived.usage,
    metrics: derived.metrics,
    meta,
  };
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

interface Derived {
  agentName: string | null;
  messages: NormalizedMessage[];
  toolCalls: NormalizedToolCall[];
  surfaces: NormalizedSurface[];
  surfaceIndex: Map<string, NormalizedSurface>;
  dataModel: DataModel;
  actions: NormalizedAction[];
  interrupts: NormalizedInterrupt[];
  subagents: NormalizedSubagent[];
  errors: NormalizedProblem[];
  warnings: NormalizedProblem[];
  usage: Usage | null;
  metrics: RunMetrics;
}

/**
 * Frame kinds that prove an interrupt was answered. A resumed run re-announces
 * itself with `run.started`; some transports instead carry the human's reply
 * inline as `action.dispatched`; and a run that ended `success` cannot have
 * stopped at the question. A `run.finished` with outcome `interrupt` does not
 * count -- that is the transcript of an interrupt nobody ever returned to,
 * which is the exact failure `interrupt-answered` exists to catch.
 */
const RESUME_KINDS: readonly FrameKind[] = [
  'run.started',
  'action.dispatched',
  'text.delta',
  'tool.started',
];

function derive(frames: readonly NormalizedFrame[], protocol: ProtocolId, issues: InputIssue[]): Derived {
  let agentName: string | null = null;
  let usage: Usage | null = null;
  let outcome: 'success' | 'cancelled' | 'interrupt' | null = null;
  let finished = false;

  // -- messages ------------------------------------------------------------
  interface Buffer {
    order: number;
    messageId: string;
    text: string;
    deltaCount: number;
    done: boolean;
    seqStart: number;
    seqEnd: number;
  }
  const messageBuffers = new Map<string, Buffer>();

  // -- tool calls ----------------------------------------------------------
  const toolCalls = new Map<string, NormalizedToolCall>();
  const toolOrder: string[] = [];

  // -- surfaces ------------------------------------------------------------
  const surfaces = new Map<string, NormalizedSurface>();

  const actions: NormalizedAction[] = [];
  const subagents: NormalizedSubagent[] = [];
  const errors: NormalizedProblem[] = [];
  const warnings: NormalizedProblem[] = [];
  const interrupts: NormalizedInterrupt[] = [];

  for (const frame of frames) {
    switch (frame.kind) {
      case 'run.started': {
        const payload = frame.payload as FramePayloadMap['run.started'];
        if (isNonEmptyString(payload.agentName)) agentName = payload.agentName;
        break;
      }
      case 'text.delta': {
        const payload = frame.payload as FramePayloadMap['text.delta'];
        const id = isNonEmptyString(payload.messageId) ? payload.messageId : `message@${frame.seq}`;
        const existing = messageBuffers.get(id);
        if (existing) {
          // A delta after `text.done` means the adapter reordered; the final
          // text is authoritative, so the late delta is dropped rather than
          // concatenated onto a sealed message.
          if (!existing.done) {
            existing.text += typeof payload.delta === 'string' ? payload.delta : '';
            existing.deltaCount += 1;
            existing.seqEnd = frame.seq;
          }
          break;
        }
        messageBuffers.set(id, {
          order: messageBuffers.size,
          messageId: id,
          text: typeof payload.delta === 'string' ? payload.delta : '',
          deltaCount: 1,
          done: false,
          seqStart: frame.seq,
          seqEnd: frame.seq,
        });
        break;
      }
      case 'text.done': {
        const payload = frame.payload as FramePayloadMap['text.done'];
        const id = isNonEmptyString(payload.messageId) ? payload.messageId : `message@${frame.seq}`;
        const existing = messageBuffers.get(id);
        if (existing) {
          existing.done = true;
          if (typeof payload.text === 'string') existing.text = payload.text;
          existing.seqEnd = frame.seq;
        } else {
          messageBuffers.set(id, {
            order: messageBuffers.size,
            messageId: id,
            text: typeof payload.text === 'string' ? payload.text : '',
            deltaCount: 0,
            done: true,
            seqStart: frame.seq,
            seqEnd: frame.seq,
          });
        }
        break;
      }
      case 'tool.started': {
        const payload = frame.payload as FramePayloadMap['tool.started'];
        const id = isNonEmptyString(payload.toolCallId) ? payload.toolCallId : `call@${frame.seq}`;
        const existing = toolCalls.get(id);
        if (existing) {
          existing.toolName = isNonEmptyString(payload.toolName) ? payload.toolName : existing.toolName;
          break;
        }
        toolOrder.push(id);
        toolCalls.set(id, {
          toolCallId: id,
          toolName: isNonEmptyString(payload.toolName) ? payload.toolName : UNKNOWN_TOOL_NAME,
          seq: frame.seq,
          startTs: frame.ts,
          step: frame.step,
          completed: false,
          isError: false,
          orphan: false,
          truncated: false,
        });
        break;
      }
      case 'tool.args.delta': {
        const payload = frame.payload as FramePayloadMap['tool.args.delta'];
        const call = touchCall(toolCalls, toolOrder, payload, frame, issues);
        call.argsText = `${call.argsText ?? ''}${typeof payload.delta === 'string' ? payload.delta : ''}`;
        call.truncated = call.truncated || frame.truncated;
        break;
      }
      case 'tool.args.done': {
        const payload = frame.payload as FramePayloadMap['tool.args.done'];
        const call = touchCall(toolCalls, toolOrder, payload, frame, issues);
        if (isRecord(payload.args)) {
          call.args = payload.args as JsonObject;
        }
        if (isNonEmptyString(payload.parseError)) call.argsParseError = payload.parseError;
        break;
      }
      case 'tool.result': {
        const payload = frame.payload as FramePayloadMap['tool.result'];
        const call = touchCall(toolCalls, toolOrder, payload, frame, issues);
        call.resultContent = typeof payload.content === 'string' ? payload.content : '';
        call.isError = payload.isError === true;
        call.completed = true;
        if (typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs)) {
          call.durationMs = payload.durationMs;
        }
        if (call.startTs <= frame.ts) call.observedDurationMs = frame.ts - call.startTs;
        call.truncated = call.truncated || frame.truncated;
        break;
      }
      case 'surface.created': {
        const payload = frame.payload as FramePayloadMap['surface.created'];
        const id = isNonEmptyString(payload.surfaceId) ? payload.surfaceId : `surface@${frame.seq}`;
        surfaces.set(id, {
          surfaceId: id,
          catalogId: typeof payload.catalogId === 'string' ? payload.catalogId : '',
          title: payload.title,
          nodes: [],
          nodeCount: 0,
          maxDepth: 0,
          rawNodeCount: 0,
          data: isRecord(payload.data) ? (payload.data as DataModel) : {},
          createdSeq: frame.seq,
          lastSeq: frame.seq,
          deleted: false,
          nodeUpdates: 0,
          dataWrites: 0,
          usesDataModel: false,
        });
        break;
      }
      case 'surface.nodes': {
        const payload = frame.payload as FramePayloadMap['surface.nodes'];
        const surface = touchSurface(surfaces, payload, frame, issues);
        const incoming = Array.isArray(payload.nodes) ? (payload.nodes as SurfaceNode[]) : [];
        if (payload.mode === 'merge') {
          surface.nodes = mergeNodes(surface.nodes, incoming);
        } else {
          surface.nodes = incoming;
        }
        surface.nodeUpdates += 1;
        surface.lastSeq = frame.seq;
        rescoreSurface(surface);
        break;
      }
      case 'surface.data': {
        const payload = frame.payload as FramePayloadMap['surface.data'];
        const surface = touchSurface(surfaces, payload, frame, issues);
        applyDataWrite(surface.data, payload.path, payload.value, payload.mode);
        surface.dataWrites += 1;
        surface.lastSeq = frame.seq;
        break;
      }
      case 'surface.deleted': {
        const payload = frame.payload as FramePayloadMap['surface.deleted'];
        const surface = surfaces.get(payload.surfaceId);
        if (surface) {
          surface.deleted = true;
          surface.lastSeq = frame.seq;
        }
        break;
      }
      case 'action.dispatched': {
        const payload = frame.payload as FramePayloadMap['action.dispatched'];
        actions.push({
          surfaceId: typeof payload.surfaceId === 'string' ? payload.surfaceId : '',
          componentId: typeof payload.componentId === 'string' ? payload.componentId : '',
          name: typeof payload.name === 'string' ? payload.name : '',
          context: isRecord(payload.context) ? (payload.context as JsonObject) : {},
          seq: frame.seq,
          ts: frame.ts,
        });
        break;
      }
      case 'interrupt': {
        const payload = frame.payload as FramePayloadMap['interrupt'];
        interrupts.push({
          reason: typeof payload.reason === 'string' ? payload.reason : '',
          resumable: payload.resumable !== false,
          resumeToken: payload.resumeToken,
          seq: frame.seq,
          ts: frame.ts,
          answered: false,
        });
        break;
      }
      case 'subagent': {
        const payload = frame.payload as FramePayloadMap['subagent'];
        subagents.push({
          name: typeof payload.name === 'string' ? payload.name : '',
          phase: payload.phase === 'started' || payload.phase === 'finished' || payload.phase === 'error' ? payload.phase : 'started',
          detail: payload.detail,
          seq: frame.seq,
          ts: frame.ts,
          step: frame.step,
          subagentRunId: frame.subagentRunId,
        });
        break;
      }
      case 'warning': {
        const payload = frame.payload as FramePayloadMap['warning'];
        warnings.push({
          code: typeof payload.code === 'string' ? payload.code : '',
          message: typeof payload.message === 'string' ? payload.message : '',
          fatal: false,
          detail: isRecord(payload.detail) ? (payload.detail as JsonObject) : undefined,
          seq: frame.seq,
          ts: frame.ts,
        });
        break;
      }
      case 'error': {
        const payload = frame.payload as FramePayloadMap['error'];
        errors.push({
          code: typeof payload.code === 'string' ? payload.code : '',
          message: typeof payload.message === 'string' ? payload.message : '',
          fatal: payload.fatal === true,
          detail: isRecord(payload.detail) ? (payload.detail as JsonObject) : undefined,
          seq: frame.seq,
          ts: frame.ts,
        });
        break;
      }
      case 'run.finished': {
        const payload = frame.payload as FramePayloadMap['run.finished'];
        finished = true;
        if (payload.outcome === 'success' || payload.outcome === 'cancelled' || payload.outcome === 'interrupt') {
          outcome = payload.outcome;
        }
        if (isRecord(payload.usage)) {
          usage = normalizeUsage(payload.usage as Record<string, unknown>);
        }
        break;
      }
      case 'app.attached':
      default:
        break;
    }
  }

  // -- interrupt resolution -------------------------------------------------
  for (const interrupt of interrupts) {
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      if (frame.seq <= interrupt.seq) continue;
      if (frame.kind === 'run.finished') {
        const payload = frame.payload as FramePayloadMap['run.finished'];
        if (payload.outcome === 'success') {
          interrupt.answered = true;
          interrupt.answeredBy = 'run.finished';
        }
        break;
      }
      if (RESUME_KINDS.includes(frame.kind)) {
        interrupt.answered = true;
        interrupt.answeredBy = frame.kind;
        break;
      }
    }
  }

  // -- tool arg salvage ----------------------------------------------------
  for (const call of toolCalls.values()) {
    if (call.args === undefined && call.argsText) {
      try {
        const parsed: unknown = JSON.parse(call.argsText);
        if (isRecord(parsed)) {
          call.args = parsed as JsonObject;
          call.argsSalvaged = true;
        }
      } catch {
        // Unparseable streamed args stay undefined; `tool-args-match` will
        // report a miss rather than silently matching against "{}".
      }
    }
  }

  const messages: NormalizedMessage[] = [...messageBuffers.values()]
    .sort((a, b) => a.order - b.order)
    .map((buffer) => ({
      messageId: buffer.messageId,
      text: buffer.text,
      deltaCount: buffer.deltaCount,
      seqStart: buffer.seqStart,
      seqEnd: buffer.seqEnd,
    }));

  const surfaceList = [...surfaces.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  const dataModel: DataModel = {};
  for (const surface of surfaceList) {
    for (const [key, value] of Object.entries(surface.data)) {
      dataModel[key] = value;
    }
  }

  const toolCallList = toolOrder.map((id) => toolCalls.get(id)!).filter(Boolean);
  const liveSurfaces = surfaceList.filter((s) => !s.deleted);
  const toolErrors = toolCallList.filter((call) => call.isError).length;
  const toolLatencies = toolCallList.map((call) => call.durationMs ?? call.observedDurationMs ?? 0);
  const timestamps = frames.map((frame) => frame.ts);
  const firstTs = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const lastTs = timestamps.length > 0 ? Math.max(...timestamps) : 0;

  const cost = resolveCost(usage, DEFAULT_PRICE_TABLE[protocol]);
  const inputTokens = usage ? finite(usage.inputTokens) : 0;
  const outputTokens = usage ? finite(usage.outputTokens) : 0;

  const metrics: RunMetrics = {
    latencyMs: Math.max(0, lastTs - firstTs),
    firstTs,
    lastTs,
    toolCallCount: toolCallList.length,
    toolErrorCount: toolErrors,
    maxToolLatencyMs: toolLatencies.length > 0 ? Math.max(...toolLatencies) : 0,
    errorCount: errors.length,
    fatalErrorCount: errors.filter((e) => e.fatal).length,
    warningCount: warnings.length,
    interruptCount: interrupts.length,
    unansweredInterruptCount: interrupts.filter((i) => !i.answered).length,
    subagentCount: new Set(subagents.map((s) => s.name)).size,
    failedSubagentCount: subagents.filter((s) => s.phase === 'error').length,
    surfaceCount: liveSurfaces.length,
    maxSurfaceNodes: liveSurfaces.length > 0 ? Math.max(...liveSurfaces.map((s) => s.nodeCount)) : 0,
    maxSurfaceDepth: liveSurfaces.length > 0 ? Math.max(...liveSurfaces.map((s) => s.maxDepth)) : 0,
    actionCount: actions.length,
    actionNames: [...new Set(actions.map((a) => a.name))].sort(),
    textLength: messages.reduce((sum, m) => sum + m.text.length, 0),
    messageCount: messages.length,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: cost.costUsd,
    costSource: cost.source,
    finished,
    outcome,
    agentName,
  };

  return {
    agentName,
    messages,
    toolCalls: toolCallList,
    surfaces: surfaceList,
    surfaceIndex: surfaces,
    dataModel,
    actions,
    interrupts,
    subagents,
    errors,
    warnings,
    usage,
    metrics,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUsage(raw: Record<string, unknown>): Usage {
  return {
    inputTokens: finite(raw['inputTokens']),
    outputTokens: finite(raw['outputTokens']),
    ...(typeof raw['cachedInputTokens'] === 'number' ? { cachedInputTokens: finite(raw['cachedInputTokens']) } : {}),
    ...(typeof raw['reasoningTokens'] === 'number' ? { reasoningTokens: finite(raw['reasoningTokens']) } : {}),
    ...(typeof raw['costUsd'] === 'number' && Number.isFinite(raw['costUsd']) ? { costUsd: raw['costUsd'] } : {}),
  };
}

function touchCall(
  toolCalls: Map<string, NormalizedToolCall>,
  order: string[],
  payload: { toolCallId?: unknown },
  frame: NormalizedFrame,
  issues: InputIssue[],
): NormalizedToolCall {
  const id = isNonEmptyString(payload.toolCallId) ? payload.toolCallId : `call@${frame.seq}`;
  const existing = toolCalls.get(id);
  if (existing) return existing;
  // A result with no `tool.started` happens when the trace starts mid-run. The
  // call is still real, so it is synthesized and the gap is recorded -- dropping
  // it would let a failing tool disappear from `tool-no-error-result`.
  order.push(id);
  toolCalls.set(id, {
    toolCallId: id,
    toolName: UNKNOWN_TOOL_NAME,
    seq: frame.seq,
    startTs: frame.ts,
    completed: false,
    isError: false,
    orphan: true,
    truncated: false,
  });
  issues.push({
    code: 'tool.orphan-frame',
    index: frame.index,
    seq: frame.seq,
    kind: frame.kind,
    message: `tool frame for ${id} arrived without a tool.started; synthesized a call named ${UNKNOWN_TOOL_NAME}`,
  });
  return toolCalls.get(id)!;
}

function touchSurface(
  surfaces: Map<string, NormalizedSurface>,
  payload: { surfaceId?: unknown },
  frame: NormalizedFrame,
  issues: InputIssue[],
): NormalizedSurface {
  const id = isNonEmptyString(payload.surfaceId) ? payload.surfaceId : `surface@${frame.seq}`;
  const existing = surfaces.get(id);
  if (existing) return existing;
  surfaces.set(id, {
    surfaceId: id,
    catalogId: '',
    nodes: [],
    nodeCount: 0,
    maxDepth: 0,
    rawNodeCount: 0,
    data: {},
    createdSeq: frame.seq,
    lastSeq: frame.seq,
    deleted: false,
    nodeUpdates: 0,
    dataWrites: 0,
    usesDataModel: false,
  });
  issues.push({
    code: 'surface.orphan-frame',
    index: frame.index,
    seq: frame.seq,
    kind: frame.kind,
    message: `surface frame for ${id} arrived without surface.created; synthesized an empty surface`,
  });
  return surfaces.get(id)!;
}

/**
 * Merge patch semantics for `surface.nodes` with `mode: 'merge'`: a node with a
 * known id is replaced in place, an id-less node is appended. Depth is not
 * merged, because a partial subtree merge is indistinguishable from a bug in the
 * agent and a wrong tree silently passing a structural assertion is worse than
 * an obviously truncated one.
 */
export function mergeNodes(current: readonly SurfaceNode[], incoming: readonly SurfaceNode[]): SurfaceNode[] {
  const out = current.slice();
  const byId = new Map<string, number>();
  out.forEach((node, i) => {
    if (isNonEmptyString(node.id)) byId.set(node.id, i);
  });
  for (const node of incoming) {
    const id = node.id;
    if (isNonEmptyString(id) && byId.has(id)) {
      out[byId.get(id)!] = node;
    } else {
      if (isNonEmptyString(id)) byId.set(id, out.length);
      out.push(node);
    }
  }
  return out;
}

function applyDataWrite(
  data: DataModel,
  path: JsonPointer,
  value: unknown,
  mode: 'set' | 'merge',
): void {
  const pointer = typeof path === 'string' ? path : '';
  if (mode === 'merge' && (pointer === '' || pointer === '/') && isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      data[key] = child as JsonValue;
    }
    return;
  }
  try {
    setAtPointer(data, pointer, value === undefined ? null : (value as JsonValue));
  } catch {
    // An invalid pointer is the agent's bug; the `surface.data` frame is kept
    // verbatim in the transcript and the write is dropped rather than throwing
    // out of normalization.
  }
}

function rescoreSurface(surface: NormalizedSurface): void {
  const flat = flattenSurface(surface.nodes);
  surface.nodeCount = flat.length;
  surface.maxDepth = flat.reduce((max, node) => Math.max(max, node.depth), 0);
  surface.rawNodeCount = countNodes(surface.nodes);
  surface.usesDataModel = surface.nodes.some((node) => containsDataLiteral(node, new Set()));
}

/** Cycle-safe raw node count. A value above `nodeCount` means a cycle or dup id. */
export function countNodes(nodes: readonly SurfaceNode[], seen: Set<SurfaceNode> = new Set()): number {
  let count = 0;
  for (const node of nodes) {
    if (seen.has(node)) continue;
    seen.add(node);
    count += 1;
    if (Array.isArray(node.children)) {
      count += countNodes(node.children.filter((c): c is SurfaceNode => typeof c !== 'string'), seen);
    }
    if (node.slots) {
      for (const slot of Object.values(node.slots)) {
        if (typeof slot === 'string') continue;
        count += countNodes([slot], seen);
      }
    }
  }
  return count;
}

function containsDataLiteral(node: SurfaceNode, seen: Set<SurfaceNode>): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  for (const literal of Object.values(node.props ?? {})) {
    if (isRecord(literal) && (literal['kind'] === 'data' || literal['kind'] === 'template')) return true;
  }
  for (const child of (node.children ?? []).filter((c): c is SurfaceNode => typeof c !== 'string')) {
    if (containsDataLiteral(child, seen)) return true;
  }
  for (const slot of Object.values(node.slots ?? {})) {
    if (typeof slot === 'string') continue;
    if (containsDataLiteral(slot, seen)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface RunParseOptions {
  /** Source label used in error messages. */
  path?: string;
  limits?: Partial<NormalizeLimits>;
}

/** Parse a recorded run from JSON text. Throws only on invalid JSON. */
export function parseRunInput(text: string, options: RunParseOptions = {}): EvalRunInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SyntaxError(`${options.path ?? 'run fixture'} is not valid JSON: ${reason}`);
  }
  if (!isRecord(parsed)) {
    throw new TypeError(`${options.path ?? 'run fixture'} must contain a JSON object`);
  }
  return parsed as unknown as EvalRunInput;
}

export function loadRunInput(path: string, options: RunParseOptions = {}): EvalRunInput {
  const absolute = resolvePath(path);
  return parseRunInput(readFileSync(absolute, 'utf8'), { ...options, path: absolute });
}

/** A recorded run plus its derived view, which is what suites and gates consume. */
export interface PreparedRun {
  input: EvalRunInput;
  run: NormalizedRun;
}

export function prepareRun(input: EvalRunInput, options?: Partial<NormalizeLimits>): PreparedRun {
  return { input, run: normalizeRun(input, options) };
}
