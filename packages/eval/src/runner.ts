/**
 * Suite execution.
 *
 * The runner owns exactly two decisions that the asserters must not:
 *
 *  1. **Which run a case is about.** Matching is by subject, and a case that
 *     matches nothing is `skipped` with the list of runs it could have matched.
 *     It is never `passed`. A suite that silently reports 20/20 green because
 *     the tracer stopped recording is worse than no gate at all -- it converts
 *     an observability outage into a false all-clear.
 *  2. **When a case fails.** A case is a conjunction over every run that matched
 *     it, so one bad fixture fails the case. Passing on "at least one run was
 *     fine" would make adding a fixture weaken the gate.
 *
 * Concurrency defaults to 1. Determinism is worth more than wall clock here:
 * gate output is diffed, and a suite whose failure order changes between runs
 * produces gate diffs that mean nothing.
 */

import type { JsonObject, JsonValue } from '@agent-surface/protocol';

import { round } from './json.js';
import { caseTags, subjectMatches, suiteIdentity, type Assertion, type EvalCase, type EvalSuite } from './suite.js';
import {
  DEFAULT_ASSERTER_CONTEXT,
  createRegistry,
  type AsserterContext,
  type AsserterRegistry,
  type AssertionOutcome,
} from './asserters.js';
import { normalizeRun, type EvalRunInput, type NormalizeLimits, type NormalizedRun } from './trace-input.js';

export type CaseStatus = 'passed' | 'failed' | 'skipped';

export interface CaseMetrics {
  latencyMs: number;
  costUsd: number;
  costSource: 'reported' | 'estimated' | 'none';
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  toolErrors: number;
  errors: number;
  warnings: number;
  surfaces: number;
  actions: number;
  runCount: number;
}

export interface CaseResult {
  caseId: string;
  description?: string;
  tags: string[];
  subject: string;
  status: CaseStatus;
  /** Runs the subject matched, in input order. */
  runIds: string[];
  /** The run whose numbers are the worst, for pointing a human at a trace. */
  worstRunId?: string;
  /** Why the case was skipped. Present only for skipped cases. */
  reason?: string;
  /** Lowest score reported by any scored assertion. */
  score?: number;
  durationMs: number;
  assertions: AssertionOutcome[];
  metrics: CaseMetrics;
}

export interface RunSummary {
  runId: string;
  scenario: string;
  protocol: string;
  frames: number;
  inputErrors: number;
  truncated: boolean;
  latencyMs: number;
  costUsd: number;
  costSource: 'reported' | 'estimated' | 'none';
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  outcome: string | null;
}

export interface SuiteReport {
  suite: { name: string; version?: string | number; description?: string };
  identity: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  results: CaseResult[];
  runs: RunSummary[];
  /** Anything advisory that should not change the exit code. */
  warnings: string[];
}

export interface RunnerOptions {
  /** 1 keeps execution strictly sequential. */
  concurrency?: number;
  failFast?: boolean;
  registry?: AsserterRegistry;
  context?: Partial<AsserterContext>;
  limits?: Partial<NormalizeLimits>;
  /** Injected for reproducible durations in tests. */
  clock?: () => number;
}

interface PreparedCase {
  testCase: EvalCase;
  runs: { input: EvalRunInput; run: NormalizedRun }[];
}

function summarize(run: NormalizedRun): RunSummary {
  return {
    runId: run.runId,
    scenario: run.scenario,
    protocol: run.protocol,
    frames: run.frames.length,
    inputErrors: run.inputErrors.length,
    truncated: run.truncation.framesDropped > 0 || run.truncation.framesShortened > 0,
    latencyMs: run.metrics.latencyMs,
    costUsd: run.metrics.costUsd,
    costSource: run.metrics.costSource,
    inputTokens: run.metrics.inputTokens,
    outputTokens: run.metrics.outputTokens,
    toolCalls: run.metrics.toolCallCount,
    outcome: run.metrics.outcome,
  };
}

function aggregateMetrics(prepared: readonly { run: NormalizedRun }[]): CaseMetrics {
  if (prepared.length === 0) {
    return {
      latencyMs: 0,
      costUsd: 0,
      costSource: 'none',
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      toolErrors: 0,
      errors: 0,
      warnings: 0,
      surfaces: 0,
      actions: 0,
      runCount: 0,
    };
  }
  // Weakest source wins: a case that inspects one run with a reported cost and
  // one run we had to price ourselves is an *estimated* case, and a gate
  // threshold reading "reported" would be told a lie.
  const costSource = prepared.some((entry) => entry.run.metrics.costSource === 'estimated')
    ? 'estimated'
    : prepared.some((entry) => entry.run.metrics.costSource === 'reported')
      ? 'reported'
      : 'none';
  const sum = (pick: (run: NormalizedRun) => number): number => prepared.reduce((acc, entry) => acc + pick(entry.run), 0);
  return {
    latencyMs: Math.max(...prepared.map((entry) => entry.run.metrics.latencyMs)),
    costUsd: round(sum((run) => run.metrics.costUsd), 6),
    costSource,
    inputTokens: sum((run) => run.metrics.inputTokens),
    outputTokens: sum((run) => run.metrics.outputTokens),
    toolCalls: sum((run) => run.metrics.toolCallCount),
    toolErrors: sum((run) => run.metrics.toolErrorCount),
    errors: sum((run) => run.metrics.errorCount),
    warnings: sum((run) => run.metrics.warningCount),
    surfaces: sum((run) => run.metrics.surfaceCount),
    actions: sum((run) => run.metrics.actionCount),
    runCount: prepared.length,
  };
}

function collectWarnings(assertions: readonly AssertionOutcome[]): string[] {
  const warnings: string[] = [];
  for (const outcome of assertions) {
    const detail = outcome.detail as { warnings?: unknown } | undefined;
    const values = detail?.['warnings'];
    if (Array.isArray(values)) {
      for (const value of values) {
        if (typeof value === 'string') warnings.push(value);
      }
    }
  }
  return [...new Set(warnings)].sort();
}

async function runCase(
  prepared: PreparedCase,
  registry: AsserterRegistry,
  context: AsserterContext,
  clock: () => number,
): Promise<CaseResult> {
  const { testCase, runs } = prepared;
  const startedAt = clock();
  const assertions: AssertionOutcome[] = [];

  for (const entry of runs) {
    for (const assertion of testCase.assertions) {
      const outcome = await registry.runAssertion(entry.run, assertion, context);
      assertions.push({ ...outcome, message: `${entry.run.runId}: ${outcome.message}` });
    }
  }

  const failed = assertions.filter((assertion) => !assertion.pass);
  const scores = assertions.map((assertion) => assertion.score).filter((score): score is number => score !== undefined);

  const result: CaseResult = {
    caseId: testCase.id,
    tags: caseTags(testCase),
    subject: testCase.subject,
    status: failed.length > 0 ? 'failed' : 'passed',
    runIds: runs.map((entry) => entry.run.runId),
    durationMs: clock() - startedAt,
    assertions,
    metrics: aggregateMetrics(runs),
  };
  if (testCase.description !== undefined) result.description = testCase.description;
  if (scores.length > 0) result.score = Math.min(...scores);

  const worst = runs
    .slice()
    .sort((a, b) => b.run.metrics.fatalErrorCount + b.run.metrics.errorCount - (a.run.metrics.fatalErrorCount + a.run.metrics.errorCount) || b.run.metrics.latencyMs - a.run.metrics.latencyMs)[0];
  if (worst) result.worstRunId = worst.run.runId;

  return result;
}

function skipCase(testCase: EvalCase, available: readonly RunSummary[]): CaseResult {
  const seen = available.length === 0 ? '(no runs were loaded)' : available.map((run) => run.runId).join(', ');
  const result: CaseResult = {
    caseId: testCase.id,
    tags: caseTags(testCase),
    subject: testCase.subject,
    status: 'skipped',
    runIds: [],
    reason: `no run matched subject ${JSON.stringify(testCase.subject)}; available runs: ${seen}`,
    durationMs: 0,
    assertions: [],
    metrics: aggregateMetrics([]),
  };
  if (testCase.description !== undefined) result.description = testCase.description;
  return result;
}

/** Match a case to runs, preserving input order. */
export function matchRuns(testCase: EvalCase, runs: readonly NormalizedRun[]): NormalizedRun[] {
  return runs.filter((run) => subjectMatches(testCase.subject, run));
}

export async function runSuite(
  suite: EvalSuite,
  runs: readonly EvalRunInput[],
  options: RunnerOptions = {},
): Promise<SuiteReport> {
  const clock = options.clock ?? (() => Date.now());
  const registry = options.registry ?? createRegistry();
  const context = registry.context({ ...DEFAULT_ASSERTER_CONTEXT, ...options.context });
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 1));
  const failFast = options.failFast ?? false;

  const startedAtMs = clock();
  const preparedRuns = runs.map((input) => ({ input, run: normalizeRun(input, options.limits) }));
  const summaries = preparedRuns.map((entry) => summarize(entry.run));

  const preparedCases: PreparedCase[] = suite.cases.map((testCase) => ({
    testCase,
    runs: preparedRuns.filter((entry) => subjectMatches(testCase.subject, entry.run)),
  }));

  const results = new Array<CaseResult>(suite.cases.length);
  let failedSeen = false;
  let cursor = 0;

  const takeNext = (): number | null => {
    if (cursor >= suite.cases.length) return null;
    // Fail-fast only stops *unstarted* cases. With concurrency > 1 the in-flight
    // ones still report, because a partially executed suite that hides which
    // cases were considered is harder to debug than one that reports them.
    if (failFast && failedSeen) return null;
    const index = cursor;
    cursor += 1;
    return index;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = takeNext();
      if (index === null) return;
      const prepared = preparedCases[index]!;
      if (prepared.runs.length === 0) {
        results[index] = skipCase(prepared.testCase, summaries);
        continue;
      }
      const result = await runCase(prepared, registry, context, clock);
      if (result.status === 'failed') failedSeen = true;
      results[index] = result;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, suite.cases.length)) }, worker));

  const finishedResults = results.filter((result): result is CaseResult => result !== undefined);
  const finishedAtMs = clock();

  const report: SuiteReport = {
    suite: { name: suite.name },
    identity: suiteIdentity(suite),
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    total: finishedResults.length,
    passed: finishedResults.filter((result) => result.status === 'passed').length,
    failed: finishedResults.filter((result) => result.status === 'failed').length,
    skipped: finishedResults.filter((result) => result.status === 'skipped').length,
    results: finishedResults,
    runs: summaries,
    warnings: [...new Set(finishedResults.flatMap((result) => collectWarnings(result.assertions)))].sort(),
  };
  if (suite.version !== undefined) report.suite.version = suite.version;
  if (suite.description !== undefined) report.suite.description = suite.description;
  return report;
}

/** JSON-safe projection of a report, for the `--json` output of the CLI. */
export function reportToJsonObject(report: SuiteReport): JsonObject {
  return {
    suite: report.suite as unknown as JsonValue,
    identity: report.identity,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    durationMs: report.durationMs,
    total: report.total,
    passed: report.passed,
    failed: report.failed,
    skipped: report.skipped,
    runs: report.runs as unknown as JsonValue,
    warnings: report.warnings as unknown as JsonValue,
    results: report.results.map((result) => ({
      caseId: result.caseId,
      ...(result.description !== undefined ? { description: result.description } : {}),
      tags: result.tags as unknown as JsonValue,
      subject: result.subject,
      status: result.status,
      runIds: result.runIds as unknown as JsonValue,
      ...(result.worstRunId !== undefined ? { worstRunId: result.worstRunId } : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.score !== undefined ? { score: result.score } : {}),
      durationMs: result.durationMs,
      metrics: result.metrics as unknown as JsonValue,
      assertions: result.assertions.map((assertion) => ({
        type: assertion.type,
        status: assertion.status,
        pass: assertion.pass,
        ...(assertion.score !== undefined ? { score: assertion.score } : {}),
        message: assertion.message,
        durationMs: assertion.durationMs,
        ...(assertion.detail !== undefined ? { detail: assertion.detail as unknown as JsonValue } : {}),
        ...(assertion.samples !== undefined ? { samples: assertion.samples as unknown as JsonValue } : {}),
      })),
    })),
  };
}

/** One entry per distinct runId, in report order. Runs are the billing unit. */
export function distinctRuns(report: SuiteReport): RunSummary[] {
  const seen = new Set<string>();
  const out: RunSummary[] = [];
  for (const run of report.runs) {
    if (seen.has(run.runId)) continue;
    seen.add(run.runId);
    out.push(run);
  }
  return out;
}

export type { Assertion, EvalCase, EvalSuite };

// ---------------------------------------------------------------------------
// Report round-trip
// ---------------------------------------------------------------------------

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function emptyMetrics(): CaseMetrics {
  return {
    latencyMs: 0,
    costUsd: 0,
    costSource: 'none',
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    toolErrors: 0,
    errors: 0,
    warnings: 0,
    surfaces: 0,
    actions: 0,
    runCount: 0,
  };
}

/**
 * Rebuild a `SuiteReport` from the JSON emitted by `reportToJsonObject`.
 *
 * This is what makes regression gating usable in CI: the job stores last
 * night's report as an artifact, downloads it, and hands it back as the
 * baseline. Only the fields the gate actually reads are reconstructed -- the
 * rest is left at defaults rather than guessed at, so a truncated or
 * hand-edited baseline degrades to "no information" instead of to a wrong
 * number that blocks or passes a merge.
 */
export function reportFromJson(value: unknown): SuiteReport {
  const source = (value ?? {}) as Record<string, unknown>;
  const rawResults = Array.isArray(source['results']) ? (source['results'] as Record<string, unknown>[]) : [];
  const rawRuns = Array.isArray(source['runs']) ? (source['runs'] as Record<string, unknown>[]) : [];

  const results: CaseResult[] = rawResults.map((raw) => {
    const metricsRaw = (raw['metrics'] ?? {}) as Record<string, unknown>;
    const metrics: CaseMetrics = {
      ...emptyMetrics(),
      latencyMs: num(metricsRaw['latencyMs']),
      costUsd: num(metricsRaw['costUsd']),
      costSource: (['reported', 'estimated', 'none'] as const).includes(metricsRaw['costSource'] as never)
        ? (metricsRaw['costSource'] as CaseMetrics['costSource'])
        : 'none',
      inputTokens: num(metricsRaw['inputTokens']),
      outputTokens: num(metricsRaw['outputTokens']),
      toolCalls: num(metricsRaw['toolCalls']),
      toolErrors: num(metricsRaw['toolErrors']),
      errors: num(metricsRaw['errors']),
      warnings: num(metricsRaw['warnings']),
      surfaces: num(metricsRaw['surfaces']),
      actions: num(metricsRaw['actions']),
      runCount: num(metricsRaw['runCount']),
    };
    const status = raw['status'];
    const result: CaseResult = {
      caseId: str(raw['caseId'], '(unnamed)'),
      tags: strArray(raw['tags']),
      subject: str(raw['subject']),
      status: status === 'passed' || status === 'failed' || status === 'skipped' ? status : 'skipped',
      runIds: strArray(raw['runIds']),
      durationMs: num(raw['durationMs']),
      assertions: [],
      metrics,
    };
    if (typeof raw['description'] === 'string') result.description = raw['description'];
    if (typeof raw['reason'] === 'string') result.reason = raw['reason'];
    if (typeof raw['score'] === 'number') result.score = raw['score'];
    if (typeof raw['worstRunId'] === 'string') result.worstRunId = raw['worstRunId'];
    return result;
  });

  const report: SuiteReport = {
    suite: (source['suite'] ?? {}) as SuiteReport['suite'],
    identity: str(source['identity'], 'baseline'),
    startedAt: str(source['startedAt'], new Date(0).toISOString()),
    finishedAt: str(source['finishedAt'], new Date(0).toISOString()),
    durationMs: num(source['durationMs']),
    total: num(source['total'], results.length),
    passed: num(source['passed'], results.filter((r) => r.status === 'passed').length),
    failed: num(source['failed'], results.filter((r) => r.status === 'failed').length),
    skipped: num(source['skipped'], results.filter((r) => r.status === 'skipped').length),
    results,
    runs: rawRuns.map((raw) => ({
      runId: str(raw['runId']),
      scenario: str(raw['scenario']),
      protocol: str(raw['protocol']),
      frames: num(raw['frames']),
      inputErrors: num(raw['inputErrors']),
      truncated: raw['truncated'] === true,
      latencyMs: num(raw['latencyMs']),
      costUsd: num(raw['costUsd']),
      costSource: (['reported', 'estimated', 'none'] as const).includes(raw['costSource'] as never)
        ? (raw['costSource'] as RunSummary['costSource'])
        : 'none',
      inputTokens: num(raw['inputTokens']),
      outputTokens: num(raw['outputTokens']),
      toolCalls: num(raw['toolCalls']),
      outcome: typeof raw['outcome'] === 'string' ? raw['outcome'] : null,
    })),
    warnings: strArray(source['warnings']),
  };
  if (typeof report.suite.name !== 'string') report.suite = { name: report.identity };
  return report;
}
