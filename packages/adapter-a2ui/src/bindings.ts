/**
 * A2UI property value -> IR `Literal`.
 *
 * The binding shapes handled here are the ones actually present in
 * `@a2ui/web_core` v0.9's `schema/common-types.js`, not the ones one might
 * assume:
 *
 *   - `DataBindingSchema`  = `z.object({ path: z.string() })`   -> `{kind:'data'}`
 *   - `FunctionCallSchema` = `z.object({ call, args, returnType })` -> `{kind:'binding'}`
 *   - `ActionSchema`       = `{event:{name,context?}} | {functionCall:{...}}` -> literal
 *   - `ChildListSchema`    = `string[] | {componentId, path}` -> child ref, not a value
 *   - `z.string()`         = `DynamicString`, which admits `{{ pointer }}` holes
 *
 * Two consequences worth stating explicitly:
 *
 * 1. v0.9's `DataBinding` has **no** `relative` flag -- `DataBindingSchema`
 *    declares only `path`, and zod strips unknown keys, so
 *    `DataBindingSchema.parse({path, relative: true})` returns `{path}`.
 *    Relative semantics are decided at *resolution* time by
 *    `MessageProcessor.resolvePath`, which treats a pointer without a leading
 *    `/` as relative to the context path. This module therefore infers
 *    `relative` from the authored pointer exactly the way `resolvePath` does,
 *    and also honours an explicit `relative: true` so a future schema revision
 *    carrying the flag is not silently dropped.
 *
 * 2. IR `props` is `Record<string, Literal>` -- one `Literal` per prop, and
 *    `JsonValue` cannot carry a nested ref. So a value that *contains* a
 *    binding inside an array or object degrades the whole value to
 *    `{kind:'binding', fallback: raw}` rather than dropping the inner refs.
 */

import type { DataRef, JsonObject, JsonValue, Literal } from '@agent-surface/protocol';

/**
 * `resolveProps` in `@agent-surface/protocol` matches holes with this shape.
 *
 * `matchAll` clones the regex internally, so these are safe to share. Plain
 * `HAS_HOLE` and `SOLE_HOLE` deliberately omit the `g` flag: a global regex
 * carries `lastIndex` across `.test()` calls, which would make binding
 * detection depend on evaluation order.
 */
const TEMPLATE_HOLE = /\{\{\s*([^}]*?)\s*\}\}/g;
const HAS_HOLE = /\{\{\s*[^}]*?\s*\}\}/;
const SOLE_HOLE = /^\{\{\s*([^}]*?)\s*\}\}$/;

export interface DataRefOptions {
  /** Force relative interpretation regardless of the authored pointer. */
  readonly relative?: boolean;
  /**
   * Path prefix to resolve against when the authored pointer is relative.
   * Mirrors `MessageProcessor.resolvePath(path, contextPath)`.
   */
  readonly contextPath?: string;
}

export function isDataRef(value: unknown): value is DataRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)['pointer'] === 'string'
  );
}

/**
 * Resolve an authored A2UI pointer into a `DataRef`.
 *
 * Mirrors `MessageProcessor.resolvePath`: an absolute pointer is returned
 * as-is, a relative one is joined to `contextPath` (or rooted at `/`).
 * Emits `relative: true` only when the pointer is genuinely relative, so the
 * renderer can tell "authored against the root" from "authored against scope".
 */
export function buildDataRef(path: string, options: DataRefOptions = {}): DataRef {
  const explicit = options.relative === true;
  const isAbsolute = path.startsWith('/');

  if (isAbsolute) {
    return explicit ? { pointer: path, relative: true } : { pointer: path };
  }

  const contextPath = options.contextPath;
  if (contextPath) {
    const base = contextPath.endsWith('/') ? contextPath : `${contextPath}/`;
    return { pointer: `${base}${path}`, relative: true };
  }
  return { pointer: `/${path}`, relative: true };
}

/** Pointers referenced by a `{{ ... }}` template, normalised to absolute. */
export function extractTemplatePointers(template: string): string[] {
  const out: string[] = [];
  for (const match of template.matchAll(TEMPLATE_HOLE)) {
    const inner = match[1]?.trim() ?? '';
    if (inner.length === 0) continue;
    out.push(inner.startsWith('/') ? inner : `/${inner}`);
  }
  return out;
}

/** True when the string is exactly one hole, e.g. `"{{ /user/name }}"`. */
function isSoleHole(value: string): boolean {
  return SOLE_HOLE.test(value);
}

/** The raw, un-normalised pointer authored inside a sole hole. */
function soleHolePointer(value: string): string {
  return SOLE_HOLE.exec(value)?.[1]?.trim() ?? '';
}

/**
 * `ActionSchema` wrapper keys. Their values declare an interaction, not a
 * dynamic datum, so a `FunctionCall` nested under one is not a binding.
 */
const ACTION_WRAPPER_KEYS: ReadonlySet<string> = new Set(['event', 'functionCall']);

/** Deep scan for a binding shape, used to decide whether to degrade a container. */
function containsBinding(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === 'string') return HAS_HOLE.test(value);
  if (Array.isArray(value)) return value.some((v) => containsBinding(v, depth + 1));
  if (isBindingShapedObject(value)) return true;
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, nested]) => !ACTION_WRAPPER_KEYS.has(key) && containsBinding(nested, depth + 1),
    );
  }
  return false;
}

/**
 * Detect the wire shapes that mean "this is a reference, not a value".
 *
 * `{componentId, path}` is a `ChildList` template -- a structural child
 * reference the bridge resolves -- so it is checked first and excluded, rather
 * than being mistaken for a data read.
 */
function isBindingShapedObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj['componentId'] === 'string' && typeof obj['path'] === 'string') return false;
  if (typeof obj['path'] === 'string') return true;
  if (typeof obj['call'] === 'string') return true;
  return false;
}

function asJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value as string | boolean;
  if (t === 'number') return Number.isFinite(value as number) ? (value as number) : null;
  if (Array.isArray(value)) return value.map(asJsonValue);
  if (t === 'object') {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = asJsonValue(v);
    return out;
  }
  return null;
}

/**
 * Convert one A2UI property value into an IR `Literal`.
 *
 * Never throws. Anything unrecognised degrades to `{kind:'binding', fallback}`
 * so a renderer can substitute a placeholder instead of losing the prop.
 */
export function toLiteral(raw: unknown, options: DataRefOptions = {}): Literal {
  if (raw === null || raw === undefined) {
    return { kind: 'literal', value: raw === undefined ? null : null };
  }

  const t = typeof raw;
  if (t === 'number' || t === 'boolean') {
    return { kind: 'literal', value: raw as number | boolean };
  }

  if (t === 'string') {
    const text = raw as string;
    if (!HAS_HOLE.test(text)) {
      return { kind: 'literal', value: text };
    }
    // A string that is one hole and nothing else is a data read with no
    // surrounding text, so `data` preserves the reference type for the
    // renderer; anything else is genuine interpolation. The raw hole is used
    // rather than `extractTemplatePointers` because that normalises to an
    // absolute pointer, which would erase the authored relative semantics.
    if (isSoleHole(text)) {
      return { kind: 'data', ref: buildDataRef(soleHolePointer(text), options) };
    }
    return { kind: 'template', template: text };
  }

  if (Array.isArray(raw)) {
    if (raw.some((item) => containsBinding(item))) {
      return { kind: 'binding', fallback: asJsonValue(raw) };
    }
    return { kind: 'literal', value: asJsonValue(raw) };
  }

  if (t === 'object') {
    const obj = raw as Record<string, unknown>;

    const path = obj['path'];
    if (typeof path === 'string' && typeof obj['componentId'] !== 'string') {
      return { kind: 'data', ref: buildDataRef(path, { ...options, relative: obj['relative'] === true }) };
    }

    const call = obj['call'];
    if (typeof call === 'string') {
      // `FunctionCall` is documented as "Invokes a named function on the
      // client". IR has no function-call variant, so it degrades to `binding`
      // with the payload kept as the fallback.
      return { kind: 'binding', fallback: asJsonValue(obj) };
    }

    if (Object.keys(obj).length === 0) {
      return { kind: 'literal', value: {} };
    }

    if (containsBinding(obj)) {
      return { kind: 'binding', fallback: asJsonValue(obj) };
    }
    return { kind: 'literal', value: asJsonValue(obj) };
  }

  return { kind: 'binding', fallback: asJsonValue(raw) };
}

/**
 * Convert a component's raw property bag. Envelope fields (`id`, `component`,
 * `weight`) are removed because IR carries them as `SurfaceNode` fields, and
 * `weight` has no IR counterpart.
 */
export function toLiteralProps(
  raw: Record<string, unknown>,
  options: DataRefOptions = {},
): Record<string, Literal> {
  const out: Record<string, Literal> = {};
  for (const [key, value] of Object.entries(stripEnvelopeFields(raw))) {
    out[key] = toLiteral(value, options);
  }
  return out;
}

/**
 * Drop the A2UI component envelope (`id`, `component`, `weight`), leaving the
 * raw property payload. Values stay `unknown` because they arrive from an
 * untrusted agent and have not been through a schema yet.
 */
export function stripEnvelopeFields(component: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(component)) {
    if (key === 'id' || key === 'component' || key === 'weight') continue;
    out[key] = value;
  }
  return out;
}
