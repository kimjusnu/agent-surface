/**
 * JSON helpers that tolerate values JSON does not.
 *
 * Recorded runs come off a wire and out of a tracer, which means they can
 * contain cyclic references, `undefined`, `BigInt`, and multi-megabyte strings
 * -- all of which are ordinary in a Node process and hostile in a report. Every
 * traversal in this file is cycle-safe and node-capped, because the eval engine
 * is a debugging tool: it has to work on the run that broke the agent.
 */

import type { JsonValue } from '@agent-surface/protocol';

const encoder = new TextEncoder();

export const CIRCULAR_MARKER = '[circular]';
export const DEPTH_MARKER = '[max depth exceeded]';
export const UNSUPPORTED_MARKER = '[unsupported value]';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

// ---------------------------------------------------------------------------
// Equality
// ---------------------------------------------------------------------------

export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b) ? false : Object.is(a, b);
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;

  if (aIsArray) {
    const left = a as unknown[];
    const right = b as unknown[];
    if (left.length !== right.length) return false;
    return left.every((item, i) => deepEqualJson(item, right[i]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(right, key) && deepEqualJson(left[key], right[key]),
  );
}

/**
 * Deep-partial match: every key present in `expected` must be present in
 * `actual` and match recursively; keys absent from `expected` are ignored.
 *
 * Arrays are compared element-wise at equal length rather than by prefix: a
 * tool that was handed three arguments and then dropped one is a different call,
 * not a partial match.
 */
export function deepPartialMatch(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false;
    return expected.every((item, i) => deepPartialMatch(item, actual[i]));
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.entries(expected).every(([key, value]) =>
      deepPartialMatch(value, actual[key]),
    );
  }
  return deepEqualJson(expected, actual);
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export interface JsonMeasurement {
  /** Approximate serialized size in UTF-8 bytes. */
  bytes: number;
  nodes: number;
  /** Back-references found. Non-zero means the value is not JSON-serializable. */
  cycles: number;
  /** True when `maxNodes` was hit and the measurement stopped early. */
  capped: boolean;
}

const KEY_COST = 6;
const NODE_COST = 4;

/**
 * Size a value without ever building a string. A hostile `raw` payload should
 * cost bounded CPU, so the walk stops after `maxNodes` visited nodes and says so
 * via `capped` rather than silently under-reporting.
 */
export function measureJson(value: unknown, options: { maxNodes?: number } = {}): JsonMeasurement {
  const maxNodes = options.maxNodes ?? 50_000;
  const path = new Set<object>();
  let nodes = 0;
  let cycles = 0;
  let capped = false;
  let bytes = 0;

  const walk = (node: unknown): void => {
    if (capped) return;
    if (nodes >= maxNodes) {
      capped = true;
      return;
    }
    nodes += 1;
    bytes += NODE_COST;

    if (node === null) return;
    switch (typeof node) {
      case 'string':
        bytes += utf8Length(node as string);
        return;
      case 'number':
      case 'boolean':
      case 'bigint':
        return;
      case 'undefined':
      case 'function':
      case 'symbol':
        bytes += KEY_COST;
        return;
      default:
        break;
    }

    const object = node as object;
    if (path.has(object)) {
      cycles += 1;
      return;
    }
    path.add(object);
    try {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node instanceof Date) {
        bytes += 24;
        return;
      }
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        bytes += utf8Length(key) + KEY_COST;
        walk(child);
      }
    } finally {
      path.delete(object);
    }
  };

  walk(value);
  return { bytes, nodes, cycles, capped };
}

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

export interface TruncateOptions {
  maxBytes: number;
  maxDepth?: number;
  maxArrayItems?: number;
  /** Marker for the whole payload. */
  label?: string;
}

export interface TruncateResult {
  value: JsonValue;
  truncated: boolean;
  originalBytes: number;
}

interface CopyState {
  remaining: number;
  depth: number;
  maxDepth: number;
  maxArrayItems: number;
  path: Set<object>;
  truncated: boolean;
  label: string;
}

function marker(label: string, detail: string): string {
  return `[${label} truncated: ${detail}]`;
}

/**
 * Copy a value into a JSON-safe shape, spending at most `maxBytes`.
 *
 * Oversized strings are cut with a byte-accounted marker rather than dropped,
 * because a half-visible tool argument is more useful to a human debugging a
 * failure than a placeholder. Cyclic references and over-deep nesting become
 * markers too -- a structuredClone would throw and a JSON.stringify would
 * silently return `undefined`.
 */
export function truncateJson(value: unknown, options: TruncateOptions): TruncateResult {
  const measurement = measureJson(value);
  const label = options.label ?? 'value';
  const state: CopyState = {
    remaining: options.maxBytes,
    depth: 0,
    maxDepth: options.maxDepth ?? 24,
    maxArrayItems: options.maxArrayItems ?? 500,
    path: new Set(),
    truncated: false,
    label,
  };
  const copied = copyValue(value, state);
  return { value: copied, truncated: state.truncated, originalBytes: measurement.bytes };
}

function copyValue(value: unknown, state: CopyState): JsonValue {
  if (state.remaining <= 0) {
    state.truncated = true;
    return marker(state.label, 'byte budget exhausted');
  }

  if (value === null) {
    state.remaining -= NODE_COST;
    return null;
  }

  switch (typeof value) {
    case 'string': {
      const text = value as string;
      const cost = utf8Length(text);
      if (cost > state.remaining) {
        state.truncated = true;
        const keep = Math.max(0, state.remaining - 48);
        return `${text.slice(0, keep)}…${marker(state.label, `${cost - keep} more bytes`)}`;
      }
      state.remaining -= cost;
      return text;
    }
    case 'number':
      state.remaining -= NODE_COST;
      return Number.isFinite(value) ? (value as number) : String(value);
    case 'boolean':
      state.remaining -= NODE_COST;
      return value as boolean;
    case 'undefined':
      state.remaining -= KEY_COST;
      return null;
    case 'bigint':
      state.remaining -= KEY_COST;
      return String(value);
    case 'function':
    case 'symbol':
      state.remaining += KEY_COST;
      return UNSUPPORTED_MARKER;
    default:
      break;
  }

  if (state.depth >= state.maxDepth) {
    state.truncated = true;
    return DEPTH_MARKER;
  }

  const object = value as object;
  if (state.path.has(object)) {
    state.truncated = true;
    return CIRCULAR_MARKER;
  }
  state.path.add(object);
  state.depth += 1;
  try {
    if (Array.isArray(value)) {
      const out: JsonValue[] = [];
      const limit = Math.min(value.length, state.maxArrayItems);
      for (let i = 0; i < limit; i++) {
        out.push(copyValue(value[i], state));
        if (state.remaining <= 0) break;
      }
      if (limit < value.length) {
        state.truncated = true;
        out.push(marker(state.label, `${value.length - limit} more array items`));
      }
      return out;
    }

    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }

    const out: { [key: string]: JsonValue } = {};
    const entries = Object.entries(value as Record<string, unknown>);
    let kept = 0;
    for (const [key, child] of entries) {
      if (state.remaining <= 0) {
        state.truncated = true;
        out[marker(state.label, 'byte budget exhausted')] = entries.length - kept;
        break;
      }
      out[key] = copyValue(child, state);
      kept += 1;
    }
    return out;
  } finally {
    state.depth -= 1;
    state.path.delete(object);
  }
}

/** JSON-safe projection without a size budget. Used for report payloads. */
export function toJsonValue(value: unknown): JsonValue {
  return truncateJson(value, { maxBytes: Number.POSITIVE_INFINITY }).value;
}

// ---------------------------------------------------------------------------
// Deterministic rendering
// ---------------------------------------------------------------------------

/**
 * Key-sorted JSON. Two runs that differ only in property insertion order must
 * produce byte-identical report output, or every CI diff is noise.
 */
export function stableStringify(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  const padInner = ' '.repeat(indent + 2);
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => `${padInner}${stableStringify(item, indent + 2)}`);
    return `[\n${items.join(',\n')}\n${pad}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (entries.length === 0) return '{}';
  const items = entries.map(
    ([key, child]) => `${padInner}${JSON.stringify(key)}: ${stableStringify(child, indent + 2)}`,
  );
  return `{\n${items.join(',\n')}\n${pad}}`;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Nearest-rank percentile. No interpolation, so p95 of [1,2] is 2 -- an
 * interpolated value would invent a latency that was never observed and make
 * the gate threshold un-auditable.
 */
export function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index] ?? 0;
}
