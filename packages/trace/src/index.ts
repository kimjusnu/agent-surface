/**
 * `@agent-surface/trace` -- the observability half of the host.
 *
 * The pipeline is: a protocol adapter normalises an event into a `SurfaceFrame`;
 * a `Tracer` records those frames; `reduce` folds them into a `RunState`; `buildTree`
 * reconstructs what the agent actually did; `buildSpans` turns that into OTel GenAI
 * spans; `FileTraceStore` keeps the frames; `diffRuns` compares two runs; and
 * `redact` makes it safe to keep them at all.
 *
 * The reducer is the keystone and everything else agrees with it, so a live view and
 * a replayed view of the same transcript cannot disagree. `index.ts` exists to make
 * that pipeline legible from one screen rather than seven.
 */

export {
  ANONYMOUS_SUBAGENT,
  AGUI_STATE_SURFACE_ID,
  TRACER_CODES,
  TRACER_WARNING_PREFIX,
  UNKNOWN_CATALOG,
  UNNAMED_TOOL,
  addUsage,
  appendError,
  appendWarning,
  applyFrame,
  emptyRunState,
  openTools,
  reduce,
  subagentMessages,
  subagentToolCalls,
  writeData,
} from './reducer.js';
export type {
  ActionRecord,
  AppRecord,
  AssembledMessage,
  InterruptRecord,
  MessageBuffer,
  RunOutcome,
  RunState,
  RunStateMeta,
  SubAgentRecord,
  SurfaceRecord,
  ToolRecord,
  TracerError,
  TracerWarning,
  UsageReport,
} from './reducer.js';

export { collectOrphans, collectSubAgents, collectTools, hashArgs, stableStringify, walkTree, buildTree, fnv1a, isTracerCode } from './tree.js';
export type {
  BuildTreeOptions,
  ExecNode,
  MessageNode,
  RunNode,
  SubAgentNode,
  ToolCallNode,
  ToolCallStatus,
} from './tree.js';

export { RUN_TRACE_VERSION, assembleRun, computeTotals, outcomeOf, unresolvedTools } from './run.js';
export type { AssembleOptions, RunTotals, RunTrace, RunTraceMeta } from './run.js';

export { DEFAULT_MAX_FRAMES, Tracer, recordFrames } from './recorder.js';
export type { TracerOptions } from './recorder.js';

export { createReplay, replayOf, summarize } from './replay.js';
export type { FrameSummary, Replay, ReplayOptions } from './replay.js';

export {
  InMemorySpanExporter,
  STEP_FINISHED_CODE,
  STEP_STARTED_CODE,
  buildSpans,
  deriveSteps,
  exportSpans,
  modelHint,
  nanos,
  orderSpans,
  spanIdOf,
  traceIdOf,
} from './spans.js';
export type {
  BuildSpansOptions,
  ExportResult,
  RawStep,
  SpanAttributeValue,
  SpanBundle,
  SpanDescriptor,
  SpanEvent,
  SpanExporter,
  SpanKind,
  SpanLink,
  SpanStatus,
  StepSource,
  StepSpan,
} from './spans.js';

export {
  diffFrameTranscripts,
  diffRuns,
  diffSurfaces as diffRunSurfaces,
  diffUsage,
  sameScenario,
  summarizeDiffs,
} from './diff.js';
export type {
  MatchKind,
  MessageDiff,
  MetricDelta,
  RunDiff,
  SurfaceDiff,
  ToolChange,
  ToolChangeKind,
  ToolMatch,
} from './diff.js';

export {
  ARRAY_MARKER,
  CYCLE_MARKER,
  DEFAULT_REDACT_LIMITS,
  DEFAULT_SENSITIVE_KEYS,
  DEFAULT_VALUE_PATTERNS,
  DEPTH_MARKER,
  NODES_MARKER,
  REDACTED,
  createRedactor,
  isRedactedMarker,
  redactFrame,
  redactFrames,
  redactRun,
  redactString,
  redactValue,
} from './redact.js';
export type { RedactOptions, RedactionStats, Redactor } from './redact.js';

export {
  DEFAULT_MAX_FILE_BYTES,
  FileTraceStore,
  InMemoryTraceStore,
  TRACE_EXTENSION,
  applyFilter,
  decodeTrace,
  encodeTrace,
  safeFileName,
  sortSummaries,
  summarizeRun,
  toHeader,
} from './storage.js';
export type {
  FileTraceStoreOptions,
  RunSummary,
  TraceFrameRecord,
  TraceHeaderRecord,
  TraceListFilter,
  TraceRecord,
  TraceStore,
} from './storage.js';
