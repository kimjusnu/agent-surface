/**
 * `@agent-surface/eval` -- the regression gate.
 *
 * The dependency direction is deliberate and one-way: eval depends on
 * `@agent-surface/protocol` for the IR and the headless helpers, and on
 * nothing else in the workspace. The tracer is a *producer* of run fixtures, not
 * a dependency of the thing that judges them, so this package stays runnable in
 * a CI container that only checked out the gate.
 *
 * Reading order for a new contributor:
 *   trace-input.ts  what a run is, and how a hostile one is made safe
 *   suite.ts        the reviewable definition of "good"
 *   asserters.ts    the vocabulary of checks
 *   llm-judge.ts    soft quality, with a deterministic default
 *   runner.ts       matching, aggregation, and the skip-not-pass rule
 *   report.ts       terminal, JSON, JUnit
 *   gate.ts         thresholds, regressions, and the pass/fail decision
 */

export * from './json.js';
export * from './trace-input.js';
export * from './suite.js';
export * from './asserters.js';
export * from './llm-judge.js';
export * from './runner.js';
export * from './report.js';
export * from './gate.js';
