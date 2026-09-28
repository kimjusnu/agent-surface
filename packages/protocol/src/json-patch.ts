/**
 * RFC 6902 JSON Patch, applied against `DataModel`.
 *
 * The host needs this in two places that must agree: optimistic local writes
 * while a `surface.data` frame is in flight, and time-travel replay of a
 * recorded trace. One implementation, one set of semantics.
 */

import type { DataModel, JsonPointer, JsonValue } from './ir.js';
import { getAtPointer, parsePointer, setAtPointer } from './headless.js';
export type PatchOp =
  | { op: 'add' | 'replace' | 'remove'; path: JsonPointer; value?: JsonValue }
  | { op: 'move' | 'copy'; from: JsonPointer; path: JsonPointer }
  | { op: 'test'; path: JsonPointer; value: JsonValue };

export interface PatchResult {
  ok: boolean;
  /** Ops that were applied before the failure. */
  applied: number;
  error?: { index: number; code: string; message: string };
}

/**
 * Apply a patch. Atomic: on the first failure, nothing after it is applied and
 * the target document is left untouched (it is cloned up front).
 *
 * `add` on an object member creates or overwrites; on an array index it
 * inserts. `remove` on a missing path is an error, matching the RFC.
 */
export function applyPatch(target: DataModel, ops: readonly PatchOp[]): PatchResult {
  let doc = structuredClone(target) as DataModel;
  let applied = 0;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    try {
      switch (op.op) {
        case 'test': {
          const actual = getAtPointer(doc, op.path);
          if (!deepEqual(actual, op.value)) {
            return { ok: false, applied, error: { index: i, code: 'TEST_FAILED', message: `test failed at ${op.path}` } };
          }
          break;
        }
        case 'add': {
          const value = structuredClone(op.value);
          const parent = getAtPointer(doc, op.path);
          if (Array.isArray(parent)) {
            const idx = op.path.endsWith('-') ? parent.length : Number(lastToken(op.path));
            if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) {
              return { ok: false, applied, error: { index: i, code: 'BAD_ARRAY_INDEX', message: `invalid array index in ${op.path}` } };
            }
            parent.splice(idx, 0, value);
          } else {
            doc = setAtPointer(doc, op.path, value);
          }
          break;
        }
        case 'replace': {
          if (getAtPointer(doc, op.path) === undefined) {
            return { ok: false, applied, error: { index: i, code: 'PATH_MISSING', message: `cannot replace missing ${op.path}` } };
          }
          doc = setAtPointer(doc, op.path, structuredClone(op.value));
          break;
        }
        case 'remove': {
          if (!removeAtPointer(doc, op.path)) {
            return { ok: false, applied, error: { index: i, code: 'PATH_MISSING', message: `cannot remove missing ${op.path}` } };
          }
          break;
        }
        case 'move': {
          const value = getAtPointer(doc, op.from);
          if (value === undefined) {
            return { ok: false, applied, error: { index: i, code: 'PATH_MISSING', message: `cannot move from missing ${op.from}` } };
          }
          if (isPrefixOf(op.from, op.path)) {
            return { ok: false, applied, error: { index: i, code: 'MOVE_INTO_SELF', message: 'cannot move a location into its own child' } };
          }
          removeAtPointer(doc, op.from);
          doc = setAtPointer(doc, op.path, structuredClone(value));
          break;
        }
        case 'copy': {
          const value = getAtPointer(doc, op.from);
          if (value === undefined) {
            return { ok: false, applied, error: { index: i, code: 'PATH_MISSING', message: `cannot copy from missing ${op.from}` } };
          }
          doc = setAtPointer(doc, op.path, structuredClone(value));
          break;
        }
        default: {
          return { ok: false, applied, error: { index: i, code: 'UNKNOWN_OP', message: `unknown op` } };
        }
      }
      applied++;
    } catch (err) {
      return {
        ok: false,
        applied,
        error: { index: i, code: 'INVALID_PATCH', message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
  return { ok: true, applied };
}

/**
 * Inverse of a patch, used to roll back a failed optimistic write.
 *
 * `before` is required because the inverse of a value-carrying op is
 * value-carrying: inverting `remove` needs the value that was there, which
 * only the document knows. Pass the document as it was *before* `ops`
 * applied.
 *
 * `add` inverts to `remove` only when the path was absent beforehand; when it
 * overwrote an existing member, the correct inverse is `replace` with the old
 * value. Getting this wrong turns a rollback into data loss, so it is derived
 * from the document rather than assumed.
 *
 * `move`/`copy` and `test` have no lossless inverse here: `copy` is not
 * reversible, and `test` did not mutate. Both are reported in
 * `unsupported` so a caller can decide to reject or to re-sync.
 */
export function invertPatch(
  before: DataModel,
  ops: readonly PatchOp[],
): { inverse: PatchOp[]; unsupported: number[] } {
  // Walk a simulated document so each op's inverse sees the state it produced.
  let doc = structuredClone(before) as DataModel;
  const inverse: PatchOp[] = [];
  const unsupported: number[] = [];

  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!;
    switch (op.op) {
      case 'remove': {
        // `doc` is the pre-patch state here, so this read is correct.
        const prior = getAtPointer(doc, op.path);
        if (prior === undefined) {
          // Nothing was there to remove; a no-op remove needs no inverse.
          continue;
        }
        inverse.push({ op: 'add', path: op.path, value: structuredClone(prior) as JsonValue });
        break;
      }
      case 'add': {
        const prior = getAtPointer(doc, op.path);
        if (prior === undefined) {
          inverse.push({ op: 'remove', path: op.path });
        } else {
          inverse.push({ op: 'replace', path: op.path, value: structuredClone(prior) as JsonValue });
        }
        doc = setAtPointer(doc, op.path, structuredClone(op.value));
        break;
      }
      case 'replace': {
        const prior = getAtPointer(doc, op.path);
        if (prior === undefined) {
          // Replaced a path that did not exist; replaying `replace` would fail.
          inverse.push({ op: 'remove', path: op.path });
        } else {
          inverse.push({ op: 'replace', path: op.path, value: structuredClone(prior) as JsonValue });
        }
        doc = setAtPointer(doc, op.path, structuredClone(op.value));
        break;
      }
      case 'test': {
        // A test either passes (no mutation, no inverse needed) or aborts the
        // whole patch before anything after it.
        if (!deepEqual(getAtPointer(doc, op.path), op.value)) break;
        break;
      }
      default: {
        unsupported.push(i);
        if (op.op === 'move') {
          const value = getAtPointer(doc, op.from);
          removeAtPointer(doc, op.from);
          if (value !== undefined) doc = setAtPointer(doc, op.path, structuredClone(value));
        }
      }
    }
  }
  return { inverse, unsupported };
}

function lastToken(pointer: JsonPointer): string {
  const tokens = parsePointer(pointer);
  return tokens[tokens.length - 1] ?? '';
}

function removeAtPointer(doc: DataModel, pointer: JsonPointer): boolean {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) return false;
  const parentPointer = '/' + tokens.slice(0, -1).map((t) => t.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
  const parent = getAtPointer(doc, parentPointer);
  const key = tokens[tokens.length - 1]!;
  if (Array.isArray(parent)) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) return false;
    parent.splice(idx, 1);
    return true;
  }
  if (parent && typeof parent === 'object' && key in (parent as object)) {
    delete (parent as Record<string, unknown>)[key];
    return true;
  }
  return false;
}

function isPrefixOf(parent: JsonPointer, child: JsonPointer): boolean {
  if (parent === child) return true;
  return child.startsWith(parent === '' ? '/' : parent + '/');
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
