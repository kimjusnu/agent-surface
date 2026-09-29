/**
 * Secret stripping, and the size bounds that keep one frame from breaking the
 * tracer.
 *
 * Two independent jobs, and conflating them is why tracoders leak secrets:
 *
 *  1. **Redaction** removes credentials that a hostile or merely careless agent
 *     put into a tool result, an argument object, or a message. It runs on the
 *     way *in*, before the frame is retained, so a secret is never at rest in
 *     the first place. Redacting at export time would leave it in the
 *     in-memory transcript and in any earlier export.
 *  2. **Bounding** caps depth, node count, array length and string length. A tool
 *     that returns a 40 MB page dump must not be able to make every later
 *     `applyFrame` a copy of 40 MB, which is how one agent turns an
 *     observability layer into an outage. Truncation is always explicit: a
 *     marker suffix says how much was dropped, so a trace that was cut is a
 *     trace that says so.
 *
 * ## Cycle handling
 *
 * `SurfaceNode` trees, `raw` passthrough and hand-built `args` objects can all
 * contain cycles, because the values come from arbitrary agent input and the
 * IR's `Literal` type is not enforced at runtime. A `WeakSet` of visited
 * objects breaks them, emitting a `[cycle]` marker rather than recursing.
 */

import type { JsonObject, JsonValue, SurfaceFrame } from '@agent-surface/protocol';

import { assembleRun, type RunTrace } from './run.js';

export const REDACTED = '[REDACTED]';
export const CYCLE_MARKER = '[cycle]';
export const DEPTH_MARKER = '[max depth reached]';
export const NODES_MARKER = '[max nodes reached]';
export const ARRAY_MARKER = '[array truncated]';

export interface RedactOptions {
  /**
   * Compiled or plain patterns whose *key* should have its value replaced.
   * Added to `DEFAULT_SENSITIVE_KEYS`. Strings and RegExps are accepted so a
   * caller can pass a list straight from configuration.
   */
  sensitiveKeys?: readonly (string | RegExp)[];
  /** Extra value patterns, applied to every string. */
  valuePatterns?: readonly (string | RegExp)[];
  /** Replacement text. Must not itself match a pattern. */
  placeholder?: string;
  maxDepth?: number;
  maxNodes?: number;
  maxArrayLength?: number;
  maxStringLength?: number;
}

export const DEFAULT_REDACT_LIMITS = {
  maxDepth: 12,
  maxNodes: 10_000,
  maxArrayLength: 256,
  maxStringLength: 4_096,
} as const;

/**
 * Keys whose *value* is replaced wholesale.
 *
 * A key match replaces the value rather than pattern-matching inside it: a
 * secret under `authorization` is not shaped like a secret under `password`, and
 * the only reliable signal is the key.
 */
export const DEFAULT_SENSITIVE_KEYS: readonly (string | RegExp)[] = [
  /^(?:x-)?(?:api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|auth[-_]?token|secret|client[-_]?secret|password|passwd|pwd|passphrase|authorization|cookie|set-cookie|session[-_]?id|private[-_]?key)$/i,
  /[-_](?:key|secret|token|password)$/i,
];

/**
 * Value patterns, in application order.
 *
 * Each is documented with the shape it targets rather than the service, because
 * the shapes are what generalise: a new provider's key prefix is one line.
 */
export const DEFAULT_VALUE_PATTERNS: readonly RegExp[] = [
  // OpenAI-style `sk-...`, including the `-proj-` and long-token variants.
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // Anthropic-style `sk-ant-...` is covered by the rule above.
  // GitHub classic and fine-grained personal access tokens.
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}/g,
  // Slack tokens.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // JSON Web Tokens: three base64url segments whose header is `{"alg":...}`.
  // The header check is what keeps a dotted identifier like `com.example.app`
  // from being reported as a token.
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
  // `Authorization: Bearer <token>` and the Basic form.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Query-string and JSON-ish credential assignments.
  /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?token)["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{6,})["']?/gi,
  // Email addresses.
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  // 13-19 consecutive digits, optionally grouped by spaces or dashes: a PAN.
  // Bounded at 19 so a 30-digit nanosecond epoch or a raw token of digits is not
  // mistaken for a card number.
  /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g,
];

export interface RedactionStats {
  /** Values replaced because their key was sensitive. */
  keyMatches: number;
  /** Values replaced because their content matched a pattern. */
  valueMatches: number;
  stringsTruncated: number;
  charsTruncated: number;
  arraysTruncated: number;
  nodesTruncated: number;
  depthTruncated: number;
  cycles: number;
}

export interface Redactor {
  redact(value: unknown): unknown;
  redactString(value: string): string;
  frames(frames: readonly SurfaceFrame[]): SurfaceFrame[];
  frame(frame: SurfaceFrame): SurfaceFrame;
  /** Cumulative over every call on this redactor. */
  readonly stats: RedactionStats;
}

interface KeyMatcher {
  test(key: string): boolean;
  /** Present so `matchesKey` can reset `lastIndex` on the regex form. */
  lastIndex: number;
}

interface Compiled {
  readonly sensitiveKeys: readonly KeyMatcher[];
  readonly valuePatterns: readonly RegExp[];
  readonly placeholder: string;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxArrayLength: number;
  readonly maxStringLength: number;
}

/**
 * A stateful redactor, so an audit can ask "did redaction actually fire?" --
 * a redactor that reports nothing is indistinguishable from one that was never
 * pointed at a secret.
 */
export function createRedactor(options: RedactOptions = {}): Redactor {
  const compiled: Compiled = {
    sensitiveKeys: [...DEFAULT_SENSITIVE_KEYS, ...(options.sensitiveKeys ?? [])].map(toMatcher),
    valuePatterns: [...DEFAULT_VALUE_PATTERNS, ...(options.valuePatterns ?? [])].map(toGlobal),
    placeholder: options.placeholder ?? REDACTED,
    maxDepth: options.maxDepth ?? DEFAULT_REDACT_LIMITS.maxDepth,
    maxNodes: options.maxNodes ?? DEFAULT_REDACT_LIMITS.maxNodes,
    maxArrayLength: options.maxArrayLength ?? DEFAULT_REDACT_LIMITS.maxArrayLength,
    maxStringLength: options.maxStringLength ?? DEFAULT_REDACT_LIMITS.maxStringLength,
  };
  const stats: RedactionStats = {
    keyMatches: 0,
    valueMatches: 0,
    stringsTruncated: 0,
    charsTruncated: 0,
    arraysTruncated: 0,
    nodesTruncated: 0,
    depthTruncated: 0,
    cycles: 0,
  };
  let nodes = 0;

  const walk = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (typeof value === 'string') return redactContents(value, compiled, stats);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= compiled.maxDepth) {
      stats.depthTruncated += 1;
      return DEPTH_MARKER;
    }
    nodes += 1;
    if (nodes > compiled.maxNodes) {
      stats.nodesTruncated += 1;
      return NODES_MARKER;
    }
    const object = value as object;
    if (seen.has(object)) {
      stats.cycles += 1;
      return CYCLE_MARKER;
    }
    seen.add(object);
    try {
      if (Array.isArray(value)) {
        const limit = Math.min(value.length, compiled.maxArrayLength);
        if (limit < value.length) stats.arraysTruncated += 1;
        const out: unknown[] = [];
        for (let i = 0; i < limit; i += 1) out.push(walk(value[i], depth + 1, seen));
        if (limit < value.length) out.push(ARRAY_MARKER);
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = matchesKey(compiled, key)
          ? redactWhole(entry, compiled, stats)
          : walk(entry, depth + 1, seen);
      }
      return out;
    } finally {
      // Removing on exit is what makes a DAG (the same object referenced twice)
      // work: only a true cycle, not a repeated reference, is a cycle.
      seen.delete(object);
    }
  };

  const redactWhole = (value: unknown, cfg: Compiled, acc: RedactionStats): unknown => {
    acc.keyMatches += 1;
    if (typeof value !== 'string') {
      // A structured secret (a nested credentials object) is replaced whole
      // rather than walked: once a key is known sensitive, its contents are too.
      return cfg.placeholder;
    }
    const { text, dropped } = truncate(value, cfg);
    recordTruncation(acc, dropped);
    if (dropped === 0) return cfg.placeholder;
    return `${cfg.placeholder}${text.slice(value.length)}`;
  };

  return {
    redact: (value: unknown) => walk(value, 0, new WeakSet()),
    redactString: (value: string) => redactContents(value, compiled, stats),
    frames: (frames) => frames.map((frame) => redactOneFrame(frame, walk)),
    frame: (frame) => redactOneFrame(frame, walk),
    stats,
  };
}

/** One-shot convenience for callers that do not want to keep stats. */
export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  return createRedactor(options).redact(value);
}

/** Redact a string's contents only. Keys are not consulted. */
export function redactString(value: string, options: RedactOptions = {}): string {
  return createRedactor(options).redactString(value);
}

/**
 * Redact a transcript's frames, returning new frames.
 *
 * A redactor never mutates its input: the original frames are what the live view
 * renders, and a trace that no longer matches what the user saw is useless for
 * the bug it was collected for.
 */
export function redactFrames(frames: readonly SurfaceFrame[], options: RedactOptions = {}): SurfaceFrame[] {
  return createRedactor(options).frames(frames);
}

export function redactFrame(frame: SurfaceFrame, options: RedactOptions = {}): SurfaceFrame {
  return createRedactor(options).frame(frame);
}

/**
 * Redact a whole trace.
 *
 * Only the frames are rewritten. `state`, `tree` and `totals` are derived from
 * frames, so redacting them as well would double-transform the strings inside
 * them (`[REDACTED]` matches no pattern, so it survives, but truncating a second
 * time would double the marker). The trace is reassembled instead -- which is
 * also why a redacted trace is guaranteed to be internally consistent with its
 * frames.
 */
export function redactRun(run: RunTrace, options: RedactOptions = {}): RunTrace {
  const frames = redactFrames(run.frames, options);
  return assembleRun(frames, {
    runId: run.runId,
    threadId: run.threadId,
    protocol: run.protocol,
    ...(run.agentName !== undefined ? { agentName: run.agentName } : {}),
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    finalized: run.finalized,
  });
}

// ---------------------------------------------------------------------------
// Frame-level
// ---------------------------------------------------------------------------

function redactOneFrame(
  frame: SurfaceFrame,
  walk: (value: unknown, depth: number, seen: WeakSet<object>) => unknown,
): SurfaceFrame {
  const next: Record<string, unknown> = {
    ...frame,
    payload: walk(frame.payload, 0, new WeakSet()),
  };
  if (frame.raw !== undefined) {
    // `raw` is the untouched protocol event, and the most likely place for a
    // header or token the adapter was asked to pass through.
    next['raw'] = walk(frame.raw, 0, new WeakSet());
  }
  return next as unknown as SurfaceFrame;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function redactContents(value: string, cfg: Compiled, stats: RedactionStats): string {
  let out = value;
  for (const pattern of cfg.valuePatterns) {
    pattern.lastIndex = 0;
    if (!pattern.test(out)) continue;
    pattern.lastIndex = 0;
    out = out.replace(pattern, cfg.placeholder);
    stats.valueMatches += 1;
  }
  const result = truncate(out, cfg);
  recordTruncation(stats, result.dropped);
  return result.text;
}

/**
 * Truncate with an explicit marker.
 *
 * The marker carries the dropped count on purpose: "truncated" alone leaves the
 * reader guessing whether 4 KB of a 40 MB dump or of a 5 KB answer survived.
 */
function truncate(value: string, cfg: Compiled): { text: string; dropped: number } {
  if (value.length <= cfg.maxStringLength) return { text: value, dropped: 0 };
  const dropped = value.length - cfg.maxStringLength;
  return { text: `${value.slice(0, cfg.maxStringLength)}…[truncated ${String(dropped)} chars]`, dropped };
}

function recordTruncation(stats: RedactionStats, dropped: number): void {
  if (dropped === 0) return;
  stats.stringsTruncated += 1;
  stats.charsTruncated += dropped;
}

function matchesKey(cfg: Compiled, key: string): boolean {
  for (const matcher of cfg.sensitiveKeys) {
    matcher.lastIndex = 0;
    if (matcher.test(key)) return true;
  }
  return false;
}

function toMatcher(pattern: string | RegExp): KeyMatcher {
  if (typeof pattern === 'string') {
    // A string key match is exact-or-suffix: `/token` as a string means "a key
    // called token", while `'refresh-token'` is matched case-insensitively so
    // configuration does not have to know the producer's capitalisation.
    const needle = pattern.toLowerCase();
    return {
      lastIndex: 0,
      test: (key: string) => {
        const lowered = key.toLowerCase();
        return lowered === needle || lowered.endsWith(`-${needle}`) || lowered.endsWith(`_${needle}`);
      },
    };
  }
  return toGlobal(pattern);
}

function toGlobal(pattern: string | RegExp): RegExp {
  if (typeof pattern === 'string') return new RegExp(pattern, 'g');
  return pattern.flags.includes('g') ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
}

/** Shape assertions for the helpers above, kept next to the logic. */
export function isRedactedMarker(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value === REDACTED ||
      value === CYCLE_MARKER ||
      value === DEPTH_MARKER ||
      value === NODES_MARKER ||
      value === ARRAY_MARKER ||
      /…\[truncated \d+ chars\]$/.test(value))
  );
}

/** Re-exported so callers can narrow a redacted payload without a cast. */
export type RedactedJson = JsonObject | JsonValue;
