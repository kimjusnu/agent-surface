/**
 * Threshold evaluation: the decision that blocks or allows a merge.
 *
 * Three things this file is opinionated about, because each of them is a way a
 * gate can lie:
 *
 *  1. **A suite that evaluated nothing does not pass.** Every run was skipped,
 *     or there were no runs. The report looks green -- 0 failed -- so the gate
 *     emits an explicit coverage violation instead of dividing by zero and
 *     reporting a perfect pass rate.
 *  2. **Skipped is not a pass and is not free.** Skip rate is its own
 *     threshold, and a case that regressed from `passed` to `skipped` counts
 *     against the merge: the agent did not break, the evidence disappeared, and
 *     a gate that cannot tell those apart is not a gate.
 *  3. **A missing baseline blocks `failOn: 'regression'`.** With no baseline
 *     there is no way to tell a regression from a pre-existing failure, and
 *     defaulting to "pass" would let a broken branch into main the first time
 *     someone forgot to download the last report. The conservative reading is
 *     to block and say why.
 */

import { percentile, round } from './json.js';
import { distinctRuns, type CaseResult, type SuiteReport } from './runner.js';

export type FailMode = 'any' | 'regression';

export interface GateThresholds {
  maxFailureRate?: number;
  minPassRate?: number;
  maxSkippedRate?: number;
  maxP95LatencyMs?: number;
  maxP99LatencyMs?: number;
  maxCostUsd?: number;
  minScore?: number;
  /** Cases that must not fail, regardless of rate. */
  maxFailedCases?: number;
  failOn?: FailMode;
  /** Stop at the first violation instead of reporting all of them. */
  stopOnFirstViolation?: boolean;
}

export type ViolationDirection = 'above' | 'below' | 'regression' | 'coverage' | 'missing-baseline' | 'case-failure';

export interface GateViolation {
  metric: string;
  direction: ViolationDirection;
  observed: number;
  threshold: number;
  /** Cases responsible, so a human can jump straight to the trace. */
  caseIds: string[];
  message: string;
  /** True when the failure did not exist in the baseline. */
  regression: boolean;
}

export interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  count: number;
}

export interface GateMetrics {
  totalCases: number;
  passed: number;
  failed: number;
  skipped: number;
  /** passed + failed -- the denominator for pass/fail rates. */
  evaluated: number;
  passRate: number;
  failureRate: number;
  skipRate: number;
  /** Failure rate over the failures that actually block this decision. */
  blockingFailureRate: number;
  minScore: number | null;
  latency: LatencyStats;
  totalCostUsd: number;
  maxCaseCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  passedCaseIds: string[];
  failedCaseIds: string[];
  skippedCaseIds: string[];
  regressions: string[];
  coverageLoss: string[];
  newCases: string[];
  fixed: string[];
  preExistingFailures: string[];
}

export interface GateDecision {
  passed: boolean;
  violations: GateViolation[];
  metrics: GateMetrics;
  thresholds: GateThresholds;
  failOn: FailMode;
  baseline: { identity: string; startedAt: string } | null;
  evaluatedAt: string;
}

export interface GateOptions {
  baseline?: SuiteReport;
  clock?: () => number;
}

export function computeLatencyStats(values: readonly number[]): LatencyStats {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0, count: 0 };
  }
  const total = sorted.reduce((acc, value) => acc + value, 0);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean: round(total / sorted.length, 2),
    count: sorted.length,
  };
}

function statusMap(report: SuiteReport | undefined): Map<string, CaseResult['status']> {
  const map = new Map<string, CaseResult['status']>();
  if (!report) return map;
  for (const result of report.results) map.set(result.caseId, result.status);
  return map;
}

function ids(results: readonly CaseResult[], status: CaseResult['status']): string[] {
  return results.filter((result) => result.status === status).map((result) => result.caseId);
}

export function computeGateMetrics(
  report: SuiteReport,
  thresholds: GateThresholds,
  baseline?: SuiteReport,
): GateMetrics {
  const failOn: FailMode = thresholds.failOn ?? 'any';
  const results = report.results;
  const base = statusMap(baseline);

  const passedIds = ids(results, 'passed');
  const failedIds = ids(results, 'failed');
  const skippedIds = ids(results, 'skipped');

  const regressions: string[] = [];
  const coverageLoss: string[] = [];
  const preExisting: string[] = [];
  const newCases: string[] = [];
  const fixed: string[] = [];

  for (const result of results) {
    const before = base.get(result.caseId);
    if (before === undefined) {
      newCases.push(result.caseId);
      continue;
    }
    if (before === 'passed' && result.status === 'failed') regressions.push(result.caseId);
    else if (before === 'passed' && result.status === 'skipped') coverageLoss.push(result.caseId);
    else if (before === 'failed' && result.status === 'passed') fixed.push(result.caseId);
    else if (before === 'failed' && result.status === 'failed') preExisting.push(result.caseId);
  }

  // In `regression` mode only newly-failed cases count toward the decision, so
  // a branch that inherits ten known failures is not blocked by them forever --
  // but it also gets no credit for them in the pass rate.
  const blockingFailedIds = failOn === 'any' ? failedIds : [...regressions, ...coverageLoss].sort();
  const evaluated = passedIds.length + blockingFailedIds.length;

  const scores = results
    .filter((result) => result.status !== 'skipped' && result.score !== undefined)
    .map((result) => result.score as number);

  const latencies = results.filter((result) => result.status !== 'skipped').map((result) => result.metrics.latencyMs);
  const costs = results.map((result) => result.metrics.costUsd);
  const total = results.length;

  // Cost and tokens are billed per *run*, but every case re-inspects the runs it
  // matched. Summing case metrics would multiply the bill by the number of cases
  // that happen to look at the same trace, so the money thresholds are computed
  // over distinct runs. Latency percentiles stay case-scoped, because "how slow
  // is this case" is the question a suite author is actually asking.
  const runCosts = distinctRuns(report);

  return {
    totalCases: total,
    passed: passedIds.length,
    failed: failedIds.length,
    skipped: skippedIds.length,
    evaluated,
    passRate: evaluated === 0 ? 0 : round(passedIds.length / evaluated, 4),
    failureRate: evaluated === 0 ? 0 : round(blockingFailedIds.length / evaluated, 4),
    skipRate: total === 0 ? 0 : round(skippedIds.length / total, 4),
    blockingFailureRate: evaluated === 0 ? 0 : round(blockingFailedIds.length / evaluated, 4),
    minScore: scores.length === 0 ? null : round(Math.min(...scores), 4),
    latency: computeLatencyStats(latencies),
    totalCostUsd: round(runCosts.reduce((acc, value) => acc + value.costUsd, 0), 6),
    maxCaseCostUsd: costs.length === 0 ? 0 : round(Math.max(...costs), 6),
    totalInputTokens: runCosts.reduce((acc, value) => acc + value.inputTokens, 0),
    totalOutputTokens: runCosts.reduce((acc, value) => acc + value.outputTokens, 0),
    passedCaseIds: passedIds,
    failedCaseIds: failedIds,
    skippedCaseIds: skippedIds,
    regressions: regressions.sort(),
    coverageLoss: coverageLoss.sort(),
    newCases: newCases.sort(),
    fixed: fixed.sort(),
    preExistingFailures: preExisting.sort(),
  };
}

function violation(
  metric: string,
  direction: ViolationDirection,
  observed: number,
  threshold: number,
  caseIds: readonly string[],
  message: string,
  regression = false,
): GateViolation {
  return { metric, direction, observed, threshold, caseIds: [...caseIds], message, regression };
}

export function evaluateGate(
  report: SuiteReport,
  thresholds: GateThresholds,
  options: GateOptions = {},
): GateDecision {
  const clock = options.clock ?? (() => Date.now());
  const failOn: FailMode = thresholds.failOn ?? 'any';
  const baseline = options.baseline;
  const metrics = computeGateMetrics(report, thresholds, baseline);
  const violations: GateViolation[] = [];

  // `stopOnFirstViolation` is off by default: a CI run that reports one problem
  // per push costs a full submit-and-wait cycle per problem, which on a gate
  // with eight thresholds is the difference between ten minutes and an hour.
  const STOP = Symbol('stop');
  const add = (found: GateViolation): void => {
    violations.push(found);
    if (thresholds.stopOnFirstViolation === true) throw STOP;
  };

  const resultCase = (id: string): CaseResult | undefined => report.results.find((entry) => entry.caseId === id);

  const blockingIds = failOn === 'any' ? metrics.failedCaseIds : [...metrics.regressions, ...metrics.coverageLoss];

  try {
    if (failOn === 'regression' && !baseline) {
      add(
        violation(
          'baseline',
          'missing-baseline',
          0,
          1,
          blockingIds,
          'failOn is "regression" but no baseline report was supplied, so every current failure is treated as new',
        ),
      );
    }

    if (metrics.evaluated === 0) {
      add(
        violation(
          'coverage',
          'coverage',
          0,
          1,
          report.results.map((entry) => entry.caseId),
          `no case was evaluated (${report.total} case(s), all skipped or no runs matched); a gate with no evidence cannot pass`,
        ),
      );
    }

    // A failed case is a failure on its own terms. Thresholds are for budgets and
    // rates; they are not a licence to ignore red assertions, and a suite run
    // with an empty threshold set must still exit nonzero. This check runs before
    // every rate check so `failFast`-style consumers see the specific cases.
    for (const id of blockingIds) {
      const isRegression = metrics.regressions.includes(id);
      add(
        violation(
          isRegression ? 'regression' : 'case',
          'case-failure',
          1,
          0,
          [id],
          describeFailure(resultCase(id), id, isRegression),
          isRegression,
        ),
      );
    }

    if (thresholds.maxFailureRate !== undefined && metrics.blockingFailureRate > thresholds.maxFailureRate) {
      add(
        violation(
          'failureRate',
          'above',
          metrics.blockingFailureRate,
          thresholds.maxFailureRate,
          blockingIds,
          `failure rate ${(metrics.blockingFailureRate * 100).toFixed(1)}% exceeds ${(thresholds.maxFailureRate * 100).toFixed(1)}%`,
          failOn === 'regression',
        ),
      );
    }

    if (thresholds.minPassRate !== undefined && metrics.passRate < thresholds.minPassRate) {
      add(
        violation(
          'passRate',
          'below',
          metrics.passRate,
          thresholds.minPassRate,
          report.results.filter((entry) => entry.status !== 'passed').map((entry) => entry.caseId),
          `pass rate ${(metrics.passRate * 100).toFixed(1)}% is below ${(thresholds.minPassRate * 100).toFixed(1)}%`,
        ),
      );
    }

    if (thresholds.maxSkippedRate !== undefined && metrics.skipRate > thresholds.maxSkippedRate) {
      add(
        violation(
          'skipRate',
          'above',
          metrics.skipRate,
          thresholds.maxSkippedRate,
          metrics.skippedCaseIds,
          `${metrics.skipped} of ${metrics.totalCases} case(s) were skipped, above the allowed ${(thresholds.maxSkippedRate * 100).toFixed(1)}%`,
        ),
      );
    }

    if (thresholds.maxFailedCases !== undefined && blockingIds.length > thresholds.maxFailedCases) {
      add(
        violation(
          'failedCases',
          'above',
          blockingIds.length,
          thresholds.maxFailedCases,
          blockingIds,
          `${blockingIds.length} blocking failure(s) exceeds the allowed ${thresholds.maxFailedCases}`,
        ),
      );
    }

    if (thresholds.maxP95LatencyMs !== undefined && metrics.latency.p95 > thresholds.maxP95LatencyMs) {
      add(
        violation(
          'p95LatencyMs',
          'above',
          metrics.latency.p95,
          thresholds.maxP95LatencyMs,
          report.results
            .filter((entry) => entry.status !== 'skipped' && entry.metrics.latencyMs > thresholds.maxP95LatencyMs!)
            .map((entry) => entry.caseId),
          `p95 case latency ${metrics.latency.p95}ms exceeds ${thresholds.maxP95LatencyMs}ms`,
        ),
      );
    }

    if (thresholds.maxP99LatencyMs !== undefined && metrics.latency.p99 > thresholds.maxP99LatencyMs) {
      add(
        violation(
          'p99LatencyMs',
          'above',
          metrics.latency.p99,
          thresholds.maxP99LatencyMs,
          report.results
            .filter((entry) => entry.status !== 'skipped' && entry.metrics.latencyMs > thresholds.maxP99LatencyMs!)
            .map((entry) => entry.caseId),
          `p99 case latency ${metrics.latency.p99}ms exceeds ${thresholds.maxP99LatencyMs}ms`,
        ),
      );
    }

    if (thresholds.maxCostUsd !== undefined && metrics.totalCostUsd > thresholds.maxCostUsd) {
      add(
        violation(
          'costUsd',
          'above',
          metrics.totalCostUsd,
          thresholds.maxCostUsd,
          report.results.filter((entry) => entry.metrics.costUsd > 0).map((entry) => entry.caseId),
          `total cost $${metrics.totalCostUsd.toFixed(4)} exceeds $${thresholds.maxCostUsd.toFixed(4)}`,
        ),
      );
    }

    if (thresholds.minScore !== undefined) {
      if (metrics.minScore === null) {
        add(
          violation(
            'minScore',
            'below',
            0,
            thresholds.minScore,
            [],
            `minScore ${thresholds.minScore} was requested but no assertion in the suite reported a score`,
          ),
        );
      } else if (metrics.minScore < thresholds.minScore) {
        add(
          violation(
            'minScore',
            'below',
            metrics.minScore,
            thresholds.minScore,
            report.results
              .filter((entry) => entry.status !== 'skipped' && entry.score !== undefined && entry.score < thresholds.minScore!)
              .map((entry) => entry.caseId),
            `lowest quality score ${metrics.minScore} is below ${thresholds.minScore}`,
          ),
        );
      }
    }

  } catch (error) {    if (error !== STOP) throw error;
  }

  return {
    passed: violations.length === 0,
    violations,
    metrics,
    thresholds,
    failOn,
    baseline: baseline ? { identity: baseline.identity, startedAt: baseline.startedAt } : null,
    evaluatedAt: new Date(clock()).toISOString(),
  };
}

function describeFailure(result: CaseResult | undefined, id: string, isRegression: boolean): string {
  if (!result) return `${id} failed and is missing from the report`;
  const first = result.assertions.find((assertion) => !assertion.pass);
  const reason = first ? `[${first.type}] ${first.message}` : 'no failing assertion was recorded';
  const tag = isRegression ? 'regressed (passed in the baseline)' : result.status === 'skipped' ? 'lost its run' : 'failed';
  return `${id} ${tag} — ${reason}`;
}

/** Human-readable gate summary for the terminal. */
export function renderGate(decision: GateDecision): string {
  const lines: string[] = [];
  const head = decision.passed ? 'GATE PASS' : `GATE FAIL (${decision.violations.length} violation(s))`;
  lines.push(head);
  const blocking = decision.failOn === 'any' ? decision.metrics.failed : decision.metrics.regressions.length + decision.metrics.coverageLoss.length;
  lines.push(
    `mode=${decision.failOn} · ${decision.metrics.passed}/${decision.metrics.totalCases} cases passed · ` +
      `${blocking} blocking failure(s) · ${decision.metrics.skipped} skipped · ` +
      `blockingPassRate=${(decision.metrics.passRate * 100).toFixed(1)}% · ` +
      `p95=${decision.metrics.latency.p95}ms · cost=$${decision.metrics.totalCostUsd.toFixed(4)}`,
  );
  if (decision.baseline) lines.push(`baseline=${decision.baseline.identity} @ ${decision.baseline.startedAt}`);
  for (const found of decision.violations) {
    const cases = found.caseIds.length > 0 ? ` [${found.caseIds.slice(0, 8).join(', ')}${found.caseIds.length > 8 ? ', ...' : ''}]` : '';
    lines.push(`  - ${found.metric}: ${found.message}${cases}`);
  }
  if (decision.metrics.fixed.length > 0) lines.push(`  fixed since baseline: ${decision.metrics.fixed.join(', ')}`);
  if (decision.metrics.preExistingFailures.length > 0 && decision.failOn === 'regression') {
    lines.push(`  pre-existing failures (not blocking): ${decision.metrics.preExistingFailures.join(', ')}`);
  }
  return lines.join('\n');
}
