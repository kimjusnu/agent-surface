import { describe, expect, it } from 'vitest';
import {
  A2UI_PREFERRED_VERSION,
  A2UI_SUPPORTED_VERSIONS,
  A2UI_VERSIONS,
  A2UI_WARNING_CODES,
  collectMessages,
  isA2uiMessageKind,
  isA2uiVersion,
  parseA2uiMessage,
  toJsonValue,
  validateA2uiMessage,
} from '../src/messages.js';
import {
  A2UI_V0_9_JSONL,
  CREATE_SURFACE_V09,
  DELETE_SURFACE_V09,
  TEST_CATALOG_ID,
  UPDATE_COMPONENTS_V09,
  UPDATE_DATA_MODEL_V09,
} from './fixtures.js';
import { readJsonlValues } from '../src/jsonl.js';

const codes = (warnings: readonly { code: string }[]): string[] => warnings.map((w) => w.code);

describe('A2UI message parsing', () => {
  it('accepts all four v0.9 message types', () => {
    expect(parseA2uiMessage(CREATE_SURFACE_V09)).toMatchObject({ ok: true, kind: 'createSurface', version: 'v0.9' });
    expect(parseA2uiMessage(UPDATE_COMPONENTS_V09)).toMatchObject({ ok: true, kind: 'updateComponents' });
    expect(parseA2uiMessage(UPDATE_DATA_MODEL_V09)).toMatchObject({ ok: true, kind: 'updateDataModel' });
    expect(parseA2uiMessage(DELETE_SURFACE_V09)).toMatchObject({ ok: true, kind: 'deleteSurface' });
  });

  it('accepts v0.9.1 as well as v0.9, and advertises newest-first', () => {
    const parsed = parseA2uiMessage({
      version: 'v0.9.1',
      createSurface: { surfaceId: 's1', catalogId: TEST_CATALOG_ID },
    });
    expect(parsed).toMatchObject({ ok: true, version: 'v0.9.1' });
    expect([...A2UI_SUPPORTED_VERSIONS]).toEqual(['v0.9.1', 'v0.9']);
    expect(A2UI_PREFERRED_VERSION).toBe('v0.9.1');
    expect([...A2UI_VERSIONS].sort()).toEqual([...A2UI_SUPPORTED_VERSIONS].sort());
  });

  it('warns on an unknown version instead of throwing', () => {
    const parsed = parseA2uiMessage({
      version: 'v1.0',
      createSurface: { surfaceId: 's1', catalogId: TEST_CATALOG_ID },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(codes(parsed.warnings)).toContain(A2UI_WARNING_CODES.UNSUPPORTED_VERSION);
    expect(parsed.version).toBe('v1.0');
  });

  it('warns when the version field is absent', () => {
    const parsed = parseA2uiMessage({ createSurface: { surfaceId: 's1', catalogId: TEST_CATALOG_ID } });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(codes(parsed.warnings)).toEqual([A2UI_WARNING_CODES.MISSING_VERSION]);
  });

  it('refuses a message carrying two update types, matching the processor', () => {
    const parsed = parseA2uiMessage({
      version: 'v0.9',
      createSurface: { surfaceId: 'a', catalogId: TEST_CATALOG_ID },
      deleteSurface: { surfaceId: 'a' },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(codes(parsed.warnings)).toEqual([A2UI_WARNING_CODES.AMBIGUOUS_MESSAGE]);
  });

  it('warns when no envelope key is present', () => {
    const parsed = parseA2uiMessage({ version: 'v0.9', somethingElse: true });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(codes(parsed.warnings)).toEqual([A2UI_WARNING_CODES.UNKNOWN_MESSAGE]);
  });

  it('warns for a non-object payload without throwing', () => {
    for (const bad of [null, 42, 'text', []]) {
      const parsed = parseA2uiMessage(bad);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error('unreachable');
      expect(codes(parsed.warnings)).toEqual([A2UI_WARNING_CODES.NOT_AN_OBJECT]);
    }
  });

  it('reports a missing catalogId as its own semantic warning', () => {
    const parsed = parseA2uiMessage({ version: 'v0.9', createSurface: { surfaceId: 's1' } });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(codes(parsed.warnings)).toEqual([
      A2UI_WARNING_CODES.SCHEMA_INVALID,
      A2UI_WARNING_CODES.MISSING_CATALOG_ID,
    ]);
  });

  it('reports a missing surfaceId on every kind that needs one', () => {
    for (const message of [
      { version: 'v0.9', updateDataModel: { path: '/a', value: 1 } },
      { version: 'v0.9', deleteSurface: {} },
      { version: 'v0.9', updateComponents: { components: [] } },
    ]) {
      const parsed = parseA2uiMessage(message);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error('unreachable');
      expect(codes(parsed.warnings)).toContain(A2UI_WARNING_CODES.MISSING_SURFACE_ID);
    }
  });

  it('pinpoints the offending component index', () => {
    const parsed = parseA2uiMessage({
      version: 'v0.9',
      updateComponents: {
        surfaceId: 's1',
        components: [{ id: 'ok', component: 'Text' }, { component: 'Text' }],
      },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(codes(parsed.warnings)).toContain(A2UI_WARNING_CODES.COMPONENT_MISSING_ID);
    const warning = parsed.warnings.find((w) => w.code === A2UI_WARNING_CODES.COMPONENT_MISSING_ID);
    expect(warning?.detail).toMatchObject({ index: 1 });
  });

  it('rejects a data write with neither path nor value, which would blank the surface', () => {
    const parsed = parseA2uiMessage({ version: 'v0.9', updateDataModel: { surfaceId: 's1' } });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(codes(parsed.warnings)).toContain(A2UI_WARNING_CODES.EMPTY_DATA_WRITE);
  });

  it('allows a data write with only a path, which is a delete', () => {
    expect(parseA2uiMessage({ version: 'v0.9', updateDataModel: { surfaceId: 's1', path: '/a' } })).toMatchObject({
      ok: true,
    });
  });

  it('reports a non-array components field', () => {
    const parsed = parseA2uiMessage({
      version: 'v0.9',
      updateComponents: { surfaceId: 's1', components: 'nope' },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(codes(parsed.warnings)).toContain(A2UI_WARNING_CODES.MISSING_COMPONENTS);
  });

  it('preserves binding metadata that the strict component schema does not model', () => {
    const parsed = parseA2uiMessage({
      version: 'v0.9',
      updateComponents: {
        surfaceId: 's1',
        components: [{ id: 'a', component: 'Text', text: { path: '/x', relative: true } }],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    const component = (parsed.message as { updateComponents: { components: Record<string, unknown>[] } })
      .updateComponents.components[0]!;
    expect(component['text']).toEqual({ path: '/x', relative: true });
  });

  it('strict validation surfaces the reference implementation issue text', () => {
    const result = validateA2uiMessage({ version: 'v0.9', updateDataModel: { surfaceId: 's1' }, extra: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.issues.join(' ')).toContain("'extra'");

    expect(validateA2uiMessage(CREATE_SURFACE_V09).ok).toBe(true);
  });

  it('unwraps arrays, list wrappers and bare messages', () => {
    expect(collectMessages([1, 2])).toEqual([1, 2]);
    expect(collectMessages({ messages: [1] })).toEqual([1]);
    expect(collectMessages({ version: 'v0.9' })).toEqual([{ version: 'v0.9' }]);
    expect(collectMessages('solo')).toEqual(['solo']);
  });

  it('exposes narrow type guards', () => {
    expect(isA2uiVersion('v0.9.1')).toBe(true);
    expect(isA2uiVersion('v1')).toBe(false);
    expect(isA2uiMessageKind('createSurface')).toBe(true);
    expect(isA2uiMessageKind('create_surface')).toBe(false);
  });

  it('coerces arbitrary values into JSON-safe output', () => {
    expect(toJsonValue(undefined)).toBeNull();
    expect(toJsonValue(Number.NaN)).toBeNull();
    expect(toJsonValue([1, 'a', { b: true }])).toEqual([1, 'a', { b: true }]);
  });

  it('parses the whole external v0.9 JSONL fixture', () => {
    const values = readJsonlValues(A2UI_V0_9_JSONL);
    expect(values).toHaveLength(4);
    for (const value of values) expect(parseA2uiMessage(value).ok).toBe(true);
  });
});
