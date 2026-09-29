/**
 * Quality judgement for a run, with two backends and one contract.
 *
 * ---------------------------------------------------------------------------
 * Why the deterministic scorer is the default, not a fallback
 * ---------------------------------------------------------------------------
 * The LLM path cannot be allowed to decide a merge. A network call inside a
 * gate introduces three ways to get a wrong answer that has nothing to do with
 * the agent: the endpoint is down, the model drifted, or the JSON came back
 * with one extra word of prose. So the *default* backend is a heuristic scorer
 * that runs in microseconds with no credentials, and the LLM is an opt-in
 * *advisor* whose failure degrades to the heuristic with a warning rather than
 * failing the run.
 *
 * The heuristic is not a mock. It reads the same transcript an LLM would and
 * scores the properties a rubric almost always cares about -- did the run
 * finish, is there an answer, is it grounded, did it refuse, were the tool
 * calls well-formed, is the surface tree sane, did the interaction close. Each
 * signal is independently inspectable, so a 0.62 tells you *which* of those
 * broke instead of just that something did.
 */

import type { JsonValue } from '@agent-surface/protocol';

import { clamp01, round } from './json.js';
import { countNodes } from './trace-input.js';
import type { NormalizedRun, NormalizedToolCall } from './trace-input.js';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type JudgeMode = 'deterministic' | 'llm' | 'auto';

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;

export interface JudgeConfig {
  mode?: JudgeMode;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  temperature?: number;
}

export interface JudgeRequest extends JudgeConfig {
  rubric: string;
  run: NormalizedRun;
}

export interface JudgeSignal {
  name: string;
  /** Share of the final score this signal can move. Sums to 1. */
  weight: number;
  /** 0..1 for this signal alone. */
  score: number;
  note: string;
}

export interface JudgeResult {
  score: number;
  reason: string;
  /** Which backend actually produced the score. */
  mode: 'deterministic' | 'llm';
  rubric: string;
  signals: JudgeSignal[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Signal vocabulary
// ---------------------------------------------------------------------------

const REFUSAL_PATTERNS: readonly RegExp[] = [
  /I'?m sorry,? (?:but )?I can(?:'|no)t\b/i,
  /I can(?:'|no)t help with (?:that|this)\b/i,
  /I(?:'| a)re unable to (?:help|assist|comply)\b/i,
  /as an AI (?:language )?model\b/i,
  /죄송하지만.{0,20}(?:수 없|불가능)/,
  /(?:도와드|제공해 드)릴 수 없/,
  /접근할 수 없(?:습니다|어요)/,
];

const GROUNDING_PATTERNS: readonly RegExp[] = [
  /https?:\/\/\S+/,
  /`{3}[\s\S]*?`{3}/,
  /\b[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|json|md|csv|pdf)\b/,
  /\[[0-9]+\]/,
  /https?:\/\/|\bsource[sd]?\b|출처|근거|according to/i,
  /\b(?:[A-Z][a-z]+ )?[A-Z][a-z]+\.(?:com|org|io|ai|dev|gov|kr)\b/,
];

const HONESTY_PATTERNS: readonly RegExp[] = [
  /\bI (?:was not|wasn't|could not|couldn't|did not|didn't) (?:able|find|have|know)\b/i,
  /불确|정확하지 않|확인하지 못|모르겠/,
  /I don'?t have (?:access|enough information)/i,
];

const DISCLOSURE_WORDS: readonly RegExp[] = [
  /fail|error|could ?n[o']t|unable|cache|fallback|degrad|retry|timeout|503|실패|오류|캐시|대체|재시도|부분|연결/,
];

const HEDGE_WORDS: readonly RegExp[] = [
  /\bmaybe\b|\bperhaps\b|\bpossibly\b|\bI think\b|\bmight be\b/i,
  /아마|것 같|혹시|일 수 있|보입니다/i,
];

const DIGIT = /\d/;

/**
 * Rubric intents the deterministic scorer knows how to check.
 *
 * A scorer that ignores the rubric and returns the same number for "is this
 * grounded?" and "did it disclose the fallback?" is not a stand-in for a judge,
 * it is a constant. These four intents are the ones a run-quality rubric
 * actually turns on; each one is a *transcript* check, so it is reproducible,
 * and each is only applied when the rubric text asks for it. An unrecognized
 * rubric falls back to the rubric-agnostic signals plus a neutral fit score,
 * which is honest about the fact that nothing rubric-specific was verified.
 */
interface RubricIntent {
  name: string;
  pattern: RegExp;
  evaluate(run: NormalizedRun, text: string, groundingHits: number): { score: number; note: string };
}

const RUBRIC_INTENTS: readonly RubricIntent[] = [
  {
    name: 'disclosure',
    pattern: /disclos|transparent|transparency|honest|fallback|cached|degrad|name[sd]?\b|\bsays whether|공개|투명|알려|대체|캐시/i,
    evaluate(run, text) {
      const hadProblems = run.errors.length + run.warnings.length + run.metrics.toolErrorCount > 0;
      if (!hadProblems) return { score: 1, note: 'nothing went wrong, so there was nothing to disclose' };
      const disclosed = DISCLOSURE_WORDS.some((pattern) => pattern.test(text));
      return disclosed
        ? { score: 1, note: 'the run degraded and the answer says so' }
        : { score: 0.05, note: 'the run degraded and the answer never mentions it' };
    },
  },
  {
    name: 'grounding',
    pattern: /ground|cite|citation|source|evidence|근거|출처|근거자료/i,
    evaluate(_run, _text, groundingHits) {
      if (groundingHits >= 2) return { score: 1, note: `${groundingHits} grounding markers` };
      if (groundingHits === 1) return { score: 0.6, note: 'only one grounding marker' };
      return { score: 0.2, note: 'no citation, url, path, or code reference in the answer' };
    },
  },
  {
    name: 'specificity',
    pattern: /concrete|specific|value|number|quote|detail|구체|수치|상세|구체적/i,
    evaluate(run, text) {
      const hasNumbers = DIGIT.test(text);
      const hasData = run.surfaces.some((surface) => surface.usesDataModel);
      if (hasNumbers && hasData) return { score: 1, note: 'cites numbers and binds them to the data model' };
      if (hasNumbers) return { score: 0.7, note: 'cites numbers but nothing is data-bound' };
      if (hasData) return { score: 0.6, note: 'is data-bound but states no numbers' };
      return { score: 0.25, note: 'no concrete values anywhere in the answer' };
    },
  },
  {
    name: 'no-hedging',
    pattern: /confident|decisive|direct|without hedging|확실|단정|명확/i,
    evaluate(_run, text) {
      const hedges = HEDGE_WORDS.filter((pattern) => pattern.test(text)).length;
      if (hedges === 0) return { score: 1, note: 'no hedging language' };
      return { score: clamp01(1 - hedges * 0.3), note: `${hedges} hedging pattern(s) in the answer` };
    },
  },
];

function rubricFit(rubric: string, run: NormalizedRun, text: string, groundingHits: number): { score: number; note: string } {
  const matched = RUBRIC_INTENTS.filter((intent) => intent.pattern.test(rubric));
  if (matched.length === 0) {
    return { score: 0.7, note: 'no rubric intent this scorer recognises; fit was not verified' };
  }
  const evaluated = matched.map((intent) => ({ name: intent.name, ...intent.evaluate(run, text, groundingHits) }));
  const score = clamp01(evaluated.reduce((sum, entry) => sum + entry.score, 0) / evaluated.length);
  return { score, note: evaluated.map((entry) => `${entry.name} ${entry.score.toFixed(2)} (${entry.note})`).join('; ') };
}

function hasAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function band(value: number, idealMin: number, idealMax: number, hardMax: number): number {
  if (value >= idealMin && value <= idealMax) return 1;
  if (value < idealMin) return clamp01(value / idealMin);
  return clamp01(1 - (value - idealMax) / Math.max(1, hardMax - idealMax));
}

// ---------------------------------------------------------------------------
// Deterministic scorer
// ---------------------------------------------------------------------------

function toolSignal(run: NormalizedRun): { score: number; note: string } {
  const calls = run.toolCalls;
  if (calls.length === 0) {
    // A run with no tool calls is not automatically bad -- plenty of answers
    // need none -- but it cannot be grounded in retrieved evidence, so this
    // signal is neutral rather than rewarding.
    return { score: 0.6, note: 'no tool calls were made' };
  }
  const unparsed = calls.filter((call) => call.args === undefined);
  const failures = calls.filter((call) => call.isError);
  const unfinished = calls.filter((call) => !call.completed);
  const emptyArgs = calls.filter(
    (call) => call.args !== undefined && Object.keys(call.args).length === 0 && call.argsSalvaged !== true,
  );
  const repeats = countIdenticalRepeats(calls);
  const penalties =
    unparsed.length * 0.3 + failures.length * 0.25 + unfinished.length * 0.15 + emptyArgs.length * 0.1 + repeats * 0.1;
  const score = clamp01(1 - penalties / Math.max(2, calls.length));
  const parts: string[] = [`${calls.length} call(s)`];
  if (unparsed.length > 0) parts.push(`${unparsed.length} without parsed args`);
  if (failures.length > 0) parts.push(`${failures.length} errored`);
  if (unfinished.length > 0) parts.push(`${unfinished.length} never returned`);
  if (emptyArgs.length > 0) parts.push(`${emptyArgs.length} called with {}`);
  if (repeats > 0) parts.push(`${repeats} identical repeat(s)`);
  return { score, note: parts.join(', ') };
}

function countIdenticalRepeats(calls: readonly NormalizedToolCall[]): number {
  let repeats = 0;
  for (let i = 1; i < calls.length; i++) {
    const previous = calls[i - 1]!;
    const current = calls[i]!;
    if (
      previous.toolName === current.toolName &&
      previous.isError &&
      current.isError &&
      JSON.stringify(previous.args ?? null) === JSON.stringify(current.args ?? null)
    ) {
      repeats += 1;
    }
  }
  return repeats;
}

function surfaceSignal(run: NormalizedRun): { score: number; note: string } {
  const live = run.surfaces.filter((surface) => !surface.deleted);
  if (live.length === 0) return { score: 0.7, note: 'run rendered no surface' };
  const problems: string[] = [];
  let total = 0;
  for (const surface of live) {
    total += 1;
    if (surface.nodes.length === 0) problems.push(`${surface.surfaceId} has no nodes`);
    if (surface.nodeCount !== surface.rawNodeCount) {
      problems.push(`${surface.surfaceId} has a cyclic or duplicate-id node graph`);
    }
    if (surface.maxDepth > 12) problems.push(`${surface.surfaceId} nests ${surface.maxDepth} deep`);
    if (surface.nodeCount > 2_000) problems.push(`${surface.surfaceId} has ${surface.nodeCount} nodes`);
    if (countNodes(surface.nodes) === 0) problems.push(`${surface.surfaceId} flattened to nothing`);
  }
  const score = clamp01(1 - problems.length / Math.max(1, total * 2));
  return {
    score,
    note: problems.length === 0 ? `${live.length} surface(s) structurally clean` : problems.slice(0, 3).join('; '),
  };
}

function interactionSignal(run: NormalizedRun): { score: number; note: string } {
  const problems: string[] = [];
  for (const interrupt of run.interrupts) {
    if (!interrupt.answered) problems.push(`interrupt at seq ${interrupt.seq} was never resumed`);
  }
  for (const action of run.actions) {
    const responded = run.frames.some(
      (frame) =>
        frame.seq > action.seq &&
        (frame.kind === 'text.delta' || frame.kind === 'tool.started' || frame.kind === 'run.finished'),
    );
    if (!responded) problems.push(`action ${action.name} at seq ${action.seq} drew no response`);
  }
  if (run.actions.length === 0 && run.interrupts.length === 0) {
    return { score: 1, note: 'no user interaction was required' };
  }
  const obligations = run.interrupts.length + run.actions.length;
  return {
    score: clamp01(1 - problems.length / Math.max(1, obligations)),
    note: problems.length === 0 ? `${obligations} interaction(s) closed` : problems.slice(0, 3).join('; '),
  };
}

/**
 * The deterministic backend. Pure: no clock, no randomness, no environment
 * reads. The same run and rubric always produce the same score to four decimal
 * places, which is what makes it usable as a merge gate.
 */
export function scoreDeterministic(run: NormalizedRun, rubric: string): JudgeResult {
  const text = run.text;

  const completenessParts = [
    run.metrics.finished ? 1 : 0,
    run.metrics.fatalErrorCount === 0 ? 1 : 0,
    run.metrics.unansweredInterruptCount === 0 ? 1 : 0,
  ];
  const completeness = completenessParts.reduce((a, b) => a + b, 0) / completenessParts.length;

  const substance = band(run.metrics.textLength, 40, 8_000, 40_000);

  const groundingHits = GROUNDING_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const grounding = clamp01(
    0.35 * (groundingHits >= 2 ? 1 : groundingHits === 1 ? 0.6 : 0.15) +
      0.35 * (run.toolCalls.some((call) => call.completed && !call.isError) ? 1 : 0.2) +
      0.3 * (hasAny(text, HONESTY_PATTERNS) ? 1 : 0.7),
  );

  const refusal = hasAny(text, REFUSAL_PATTERNS) ? 0 : 1;

  const tool = toolSignal(run);
  const surface = surfaceSignal(run);
  const interaction = interactionSignal(run);
  const fit = rubricFit(rubric, run, text, groundingHits);

  const signals: JudgeSignal[] = [
    { name: 'completeness', weight: 0.16, score: round(completeness, 4), note: completionNote(run) },
    { name: 'answer-substance', weight: 0.14, score: round(substance, 4), note: `${run.metrics.textLength} chars in ${plural(run.metrics.messageCount, 'message')}` },
    { name: 'grounding', weight: 0.14, score: round(grounding, 4), note: `${groundingHits} grounding marker(s) in the answer` },
    { name: 'no-refusal', weight: 0.12, score: refusal, note: refusal === 1 ? 'no refusal language detected' : 'answer contains refusal language' },
    { name: 'tool-discipline', weight: 0.12, score: round(tool.score, 4), note: tool.note },
    { name: 'surface-integrity', weight: 0.1, score: round(surface.score, 4), note: surface.note },
    { name: 'interaction-closure', weight: 0.1, score: round(interaction.score, 4), note: interaction.note },
    { name: 'rubric-fit', weight: 0.12, score: round(fit.score, 4), note: fit.note },
  ];

  const score = round(clamp01(signals.reduce((sum, signal) => sum + signal.weight * signal.score, 0)), 4);
  return {
    score,
    reason: buildReason(score, signals, rubric),
    mode: 'deterministic',
    rubric,
    signals,
    warnings: [],
  };
}

function completionNote(run: NormalizedRun): string {
  const parts: string[] = [];
  parts.push(run.metrics.finished ? `finished:${run.metrics.outcome ?? 'unspecified'}` : 'never finished');
  if (run.metrics.fatalErrorCount > 0) parts.push(`${plural(run.metrics.fatalErrorCount, 'fatal error')}`);
  if (run.metrics.unansweredInterruptCount > 0) parts.push(`${plural(run.metrics.unansweredInterruptCount, 'unanswered interrupt')}`);
  if (run.inputErrors.length > 0) parts.push(`${plural(run.inputErrors.length, 'input problem')}`);
  return parts.join(', ');
}

function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : many}`;
}

function buildReason(score: number, signals: readonly JudgeSignal[], rubric: string): string {
  const weakest = [...signals].sort((a, b) => a.weight * a.score - b.weight * b.score).slice(0, 2);
  const tail = weakest.map((signal) => `${signal.name} ${signal.score.toFixed(2)} (${signal.note})`).join('; ');
  return `deterministic score ${score.toFixed(2)} against "${truncate(rubric, 80)}"; weakest signals: ${tail}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Strict output parsing
// ---------------------------------------------------------------------------

export interface ParsedVerdict {
  score: number;
  reason: string;
}

/**
 * Pull `{score, reason}` out of a model response.
 *
 * The parser is deliberately paranoid because a judge that accepts prose as a
 * verdict is a judge that can be talked into a pass. It strips code fences,
 * locates the first balanced top-level object, and rejects anything that is not
 * a finite number plus a non-empty string. The score is clamped rather than
 * rejected: an out-of-range 1.4 is a model being enthusiastic, and discarding
 * the whole verdict over it would be a worse failure than the clamp.
 */
export function parseJudgeVerdict(raw: unknown): { ok: true; value: ParsedVerdict } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'response content was not a string' };
  const text = stripFences(raw);
  const candidate = extractFirstObject(text);
  if (candidate === null) return { ok: false, error: 'no JSON object found in the response' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `response was not valid JSON: ${reason}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'response JSON was not an object' };
  }
  const record = parsed as Record<string, unknown>;
  const score = record['score'];
  const reason = record['reason'];
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return { ok: false, error: `"score" must be a finite number, got ${JSON.stringify(score ?? null)}` };
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    return { ok: false, error: '"reason" must be a non-empty string' };
  }
  return { ok: true, value: { score: clamp01(score), reason: reason.trim() } };
}

function stripFences(raw: string): string {
  let text = raw.trim();
  const fence = /```(?:json|javascript|js)?\s*([\s\S]*?)```/i.exec(text);
  if (fence && fence[1] !== undefined) return fence[1].trim();
  // An unterminated fence is a common truncation artifact; keep what came after it.
  const open = text.indexOf('```');
  if (open !== -1 && !text.includes('```', open + 3)) {
    const after = text.slice(open + 3).replace(/^(?:json|javascript|js)\s*/i, '');
    if (after.trim() !== '') text = after.trim();
  }
  return text;
}

function extractFirstObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transcript digest
// ---------------------------------------------------------------------------

export interface TranscriptOptions {
  /** Cap per message, so a 200k-token dump cannot blow the context window. */
  maxMessageChars?: number;
  maxToolCalls?: number;
}

export function buildTranscript(run: NormalizedRun, options: TranscriptOptions = {}): string {
  const maxMessage = options.maxMessageChars ?? 1_500;
  const maxTools = options.maxToolCalls ?? 40;
  const lines: string[] = [];

  lines.push(
    `# RUN ${run.runId} | scenario=${run.scenario} | protocol=${run.protocol} | agent=${run.agentName ?? 'unknown'}`,
  );
  lines.push(
    `# FRAMES ${run.frames.length} | outcome=${run.metrics.outcome ?? 'unfinished'} | tools=${run.metrics.toolCallCount} | errors=${run.metrics.errorCount} | warnings=${run.metrics.warningCount}`,
  );
  if (run.usage) {
    lines.push(
      `# TOKENS in=${run.metrics.inputTokens} out=${run.metrics.outputTokens} cost=${run.metrics.costUsd} (${run.metrics.costSource})`,
    );
  }
  if (run.inputErrors.length > 0) {
    lines.push(`# INPUT_PROBLEMS ${run.inputErrors.map((issue) => issue.code).join(',')}`);
  }

  for (const surface of run.surfaces) {
    lines.push(
      `# SURFACE ${surface.surfaceId} catalog=${surface.catalogId} nodes=${surface.nodeCount} depth=${surface.maxDepth}${surface.deleted ? ' (deleted)' : ''}`,
    );
  }

  for (const [index, message] of run.messages.entries()) {
    lines.push(`\n## ASSISTANT[${index}] (${message.messageId}, ${message.deltaCount} delta(s))`);
    lines.push(truncate(message.text, maxMessage));
  }

  if (run.toolCalls.length > 0) {
    lines.push('\n## TOOL CALLS');
    for (const call of run.toolCalls.slice(0, maxTools)) {
      const status = call.isError ? 'ERROR' : call.completed ? 'ok' : 'unfinished';
      lines.push(
        `- ${call.toolName} (${call.toolCallId}) args=${truncate(JSON.stringify(call.args ?? {}), 300)} -> ${status} ${
          call.durationMs ?? call.observedDurationMs ?? 0
        }ms ${truncate(call.resultContent ?? '', 200)}`.trimEnd(),
      );
    }
    if (run.toolCalls.length > maxTools) lines.push(`- ... and ${run.toolCalls.length - maxTools} more`);
  }

  if (run.actions.length > 0) {
    lines.push('\n## USER ACTIONS');
    for (const action of run.actions) {
      lines.push(`- ${action.surfaceId}/${action.componentId} ${action.name} ${truncate(JSON.stringify(action.context), 200)}`);
    }
  }

  if (run.interrupts.length > 0) {
    lines.push('\n## INTERRUPTS');
    for (const interrupt of run.interrupts) {
      lines.push(`- seq ${interrupt.seq}: ${interrupt.reason} (resumable=${interrupt.resumable}, answered=${interrupt.answered})`);
    }
  }

  if (run.errors.length > 0 || run.warnings.length > 0) {
    lines.push('\n## PROBLEMS');
    for (const error of run.errors) lines.push(`- error ${error.code}${error.fatal ? ' (fatal)' : ''}: ${error.message}`);
    for (const warning of run.warnings) lines.push(`- warning ${warning.code}: ${warning.message}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// LLM backend
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You grade an AI agent run against a rubric.',
  'Reply with a single JSON object and nothing else.',
  'Shape: {"score": <number between 0 and 1>, "reason": "<one sentence>"}',
  'score 1.0 means the run fully satisfies the rubric, 0.0 means it fails it entirely.',
  'Do not include markdown, code fences, or commentary.',
].join('\n');

export interface LlmTransportOptions extends Required<Pick<JudgeConfig, 'baseUrl' | 'model'>> {
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  temperature?: number;
}

export function buildChatRequest(rubric: string, run: NormalizedRun, options: LlmTransportOptions): {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
} {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.apiKey) headers['authorization'] = `Bearer ${options.apiKey}`;
  const body = JSON.stringify({
    model: options.model,
    temperature: options.temperature ?? 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `RUBRIC:\n${rubric}\n\nTRANSCRIPT:\n${buildTranscript(run)}`,
      },
    ],
  });
  return { url, init: { method: 'POST', headers, body } };
}

function resolveFetch(fetchImpl: FetchLike | undefined): FetchLike | null {
  if (fetchImpl) return fetchImpl;
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === 'function' ? (candidate as FetchLike) : null;
}

/** Call an OpenAI-compatible endpoint and parse its verdict. Never throws. */
export async function judgeWithLlm(
  rubric: string,
  run: NormalizedRun,
  options: LlmTransportOptions,
): Promise<{ ok: true; value: JudgeResult } | { ok: false; error: string; warnings: string[] }> {
  const fetchImpl = resolveFetch(options.fetchImpl);
  if (!fetchImpl) {
    return { ok: false, error: 'no fetch implementation is available in this runtime', warnings: [] };
  }

  const { url, init } = buildChatRequest(rubric, run, options);
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timeout = controller && options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;

  let responseText: string;
  let status: number;
  try {
    const response = await fetchImpl(url, { ...init, ...(controller ? { signal: controller.signal } : {}) });
    status = response.status;
    responseText = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        error: `endpoint returned ${status} ${response.statusText}`.trim(),
        warnings: [`llm-judge: HTTP ${status}`],
      };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `request failed: ${reason}`, warnings: [`llm-judge: request failed (${reason})`] };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  const content = extractContent(responseText);
  if (content === null) {
    return { ok: false, error: `response body had no message content (HTTP ${status})`, warnings: [`llm-judge: HTTP ${status} with no content`] };
  }
  const parsed = parseJudgeVerdict(content);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, warnings: [`llm-judge: unparseable verdict -- ${parsed.error}`] };
  }
  return {
    ok: true,
    value: {
      score: parsed.value.score,
      reason: `llm score ${parsed.value.score.toFixed(2)}: ${parsed.value.reason}`,
      mode: 'llm',
      rubric,
      signals: scoreDeterministic(run, rubric).signals,
      warnings: [],
    },
  };
}

function extractContent(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
  const content = first.message?.content ?? first.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part === 'object' && part !== null ? (part as { text?: unknown }).text : undefined))
      .filter((part): part is string => typeof part === 'string')
      .join('');
    return text === '' ? null : text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Score a run against a natural-language rubric.
 *
 * `auto` prefers the LLM when both a base URL and a key are configured and
 * silently degrades to the heuristic otherwise, recording why. Any failure of
 * the LLM path -- transport, HTTP status, malformed JSON, a missing field --
 * produces the heuristic score plus a warning. It never throws, because a
 * flaky third party must not be able to block a merge.
 */
export async function judge(request: JudgeRequest): Promise<JudgeResult> {
  const mode = request.mode ?? 'deterministic';
  const heuristic = () => scoreDeterministic(request.run, request.rubric);

  if (mode === 'deterministic') return heuristic();

  const baseUrl = request.baseUrl ?? readEnv('AGENT_SURFACE_JUDGE_BASE_URL');
  const apiKey = request.apiKey ?? readEnv('AGENT_SURFACE_JUDGE_API_KEY');
  const model = request.model ?? readEnv('AGENT_SURFACE_JUDGE_MODEL') ?? 'gpt-4o-mini';

  if (mode === 'auto' && (!baseUrl || !apiKey)) {
    const fallback = heuristic();
    return {
      ...fallback,
      warnings: ['llm-judge: auto mode found no judge endpoint configured; used the deterministic scorer'],
    };
  }
  if (!baseUrl) {
    const fallback = heuristic();
    return { ...fallback, warnings: ['llm-judge: no baseUrl was configured; used the deterministic scorer'] };
  }

  const attempt = await judgeWithLlm(request.rubric, request.run, {
    baseUrl,
    model,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(request.fetchImpl !== undefined ? { fetchImpl: request.fetchImpl } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  });
  if (attempt.ok) return attempt.value;

  const fallback = heuristic();
  return { ...fallback, warnings: [...attempt.warnings, `llm-judge: fell back to the deterministic scorer (${attempt.error})`] };
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const value = env?.[name];
  return isNonEmpty(value) ? value : undefined;
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
