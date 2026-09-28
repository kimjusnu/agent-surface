import { describe, expect, it } from 'vitest';
import {
  buildDataRef,
  extractTemplatePointers,
  isDataRef,
  stripEnvelopeFields,
  toLiteral,
  toLiteralProps,
} from '../src/bindings.js';
import { resolveProps } from '@agent-surface/protocol';

describe('toLiteral: primitives', () => {
  it('wraps JSON scalars and null as literals', () => {
    expect(toLiteral(null)).toEqual({ kind: 'literal', value: null });
    expect(toLiteral(undefined)).toEqual({ kind: 'literal', value: null });
    expect(toLiteral(42)).toEqual({ kind: 'literal', value: 42 });
    expect(toLiteral(false)).toEqual({ kind: 'literal', value: false });
    expect(toLiteral('plain')).toEqual({ kind: 'literal', value: 'plain' });
    expect(toLiteral({})).toEqual({ kind: 'literal', value: {} });
  });

  it('keeps a plain array or object of literals as one literal', () => {
    expect(toLiteral([1, 'a', { b: true }])).toEqual({ kind: 'literal', value: [1, 'a', { b: true }] });
    expect(toLiteral({ a: 1, b: { c: 2 } })).toEqual({ kind: 'literal', value: { a: 1, b: { c: 2 } } });
  });
});

describe('toLiteral: DataBinding', () => {
  it('maps the canonical v0.9 {path} binding to a data ref', () => {
    expect(toLiteral({ path: '/user/name' })).toEqual({ kind: 'data', ref: { pointer: '/user/name' } });
  });

  it('omits relative for an absolute pointer so the renderer can tell it apart', () => {
    const literal = toLiteral({ path: '/a' });
    expect(literal.kind).toBe('data');
    if (literal.kind !== 'data') throw new Error('unreachable');
    expect(literal.ref.relative).toBeUndefined();
    expect(isDataRef(literal.ref)).toBe(true);
  });

  it('honours an explicit relative flag that v0.9 zod would have stripped', () => {
    // DataBindingSchema declares only `path`, so `relative: true` is a key
    // zod drops. Reading the raw prop is the only way to keep it.
    expect(toLiteral({ path: '/user/name', relative: true })).toEqual({
      kind: 'data',
      ref: { pointer: '/user/name', relative: true },
    });
    expect(toLiteral({ path: '/x', relative: false })).toEqual({ kind: 'data', ref: { pointer: '/x' } });
  });

  it('infers relative for a pointer with no leading slash, matching resolvePath', () => {
    expect(toLiteral({ path: 'name' })).toEqual({ kind: 'data', ref: { pointer: '/name', relative: true } });
  });

  it('resolves a relative pointer against a context path', () => {
    expect(toLiteral({ path: 'name' }, { contextPath: '/rows/0' })).toEqual({
      kind: 'data',
      ref: { pointer: '/rows/0/name', relative: true },
    });
  });
});

describe('toLiteral: templates', () => {
  it('reads a string that is exactly one hole as a data ref', () => {
    expect(toLiteral('{{ /user/name }}')).toEqual({ kind: 'data', ref: { pointer: '/user/name' } });
    expect(toLiteral('{{name}}')).toEqual({ kind: 'data', ref: { pointer: '/name', relative: true } });
  });

  it('reads a string with surrounding text as a template', () => {
    expect(toLiteral('Hello {{ /user/name }}!')).toEqual({
      kind: 'template',
      template: 'Hello {{ /user/name }}!',
    });
  });

  it('handles multiple holes in one template', () => {
    const literal = toLiteral('{{ /a }} and {{ /b }}');
    expect(literal).toMatchObject({ kind: 'template' });
    if (literal.kind !== 'template') throw new Error('unreachable');
    expect(extractTemplatePointers(literal.template)).toEqual(['/a', '/b']);
  });

  it('resolves a template against a data model through the protocol helper', () => {
    const literal = toLiteral('Hi {{ /user/name }}, you have {{ /count }}');
    const resolved = resolveProps({ greeting: literal as never }, { user: { name: 'Ada' }, count: 3 });
    expect(resolved['greeting']).toBe('Hi Ada, you have 3');
  });

  it('ignores an empty hole', () => {
    expect(extractTemplatePointers('{{ }}')).toEqual([]);
  });
});

describe('toLiteral: degradation', () => {
  it('maps a client FunctionCall to a lazily rendered binding', () => {
    const literal = toLiteral({ call: 'formatNumber', args: { n: 3 }, returnType: 'string' });
    expect(literal.kind).toBe('binding');
    if (literal.kind !== 'binding') throw new Error('unreachable');
    expect(literal.fallback).toEqual({ call: 'formatNumber', args: { n: 3 }, returnType: 'string' });
  });

  it('degrades a whole value when a binding is nested inside an array', () => {
    const literal = toLiteral(['a', { path: '/b' }]);
    expect(literal.kind).toBe('binding');
    if (literal.kind !== 'binding') throw new Error('unreachable');
    expect(literal.fallback).toEqual(['a', { path: '/b' }]);
  });

  it('degrades a whole value when a binding is nested inside an object', () => {
    expect(toLiteral({ deep: { path: '/x' } }).kind).toBe('binding');
    expect(toLiteral({ deep: { list: ['{{ /y }}'] } }).kind).toBe('binding');
  });

  it('does not mistake a ChildList template for a data ref', () => {
    // `{componentId, path}` is a structural child reference the bridge
    // resolves; treating it as a data read would point the renderer at
    // nothing.
    const literal = toLiteral({ componentId: 'item', path: '/rows' });
    expect(literal.kind).not.toBe('data');
  });

  it('keeps an action declaration as a literal so the renderer can wire it', () => {
    const literal = toLiteral({ event: { name: 'submit' } });
    expect(literal).toEqual({ kind: 'literal', value: { event: { name: 'submit' } } });
    expect(toLiteral({ functionCall: { call: 'go', args: {}, returnType: 'void' } }).kind).toBe('literal');
  });

  it('never throws on an unrecognised shape', () => {
    for (const odd of [() => 1, Symbol.iterator, new Map(), 0n]) {
      expect(() => toLiteral(odd)).not.toThrow();
    }
  });
});

describe('toLiteralProps', () => {
  it('drops the envelope fields IR carries on the node itself', () => {
    const props = toLiteralProps({
      id: 'a',
      component: 'Text',
      weight: 1,
      text: { path: '/x' },
    });
    expect(Object.keys(props)).toEqual(['text']);
    expect(props['text']).toEqual({ kind: 'data', ref: { pointer: '/x' } });
  });

  it('stripEnvelopeFields returns only the payload keys', () => {
    expect(stripEnvelopeFields({ id: 'a', component: 'Text', weight: 2, label: 'hi' })).toEqual({ label: 'hi' });
  });
});

describe('buildDataRef', () => {
  it('passes an absolute pointer straight through', () => {
    expect(buildDataRef('/a/b')).toEqual({ pointer: '/a/b' });
  });

  it('joins a relative pointer to the context path', () => {
    expect(buildDataRef('b', { contextPath: '/a' })).toEqual({ pointer: '/a/b', relative: true });
    expect(buildDataRef('b', { contextPath: '/a/' })).toEqual({ pointer: '/a/b', relative: true });
  });

  it('roots a relative pointer with no context at the surface root', () => {
    expect(buildDataRef('b')).toEqual({ pointer: '/b', relative: true });
  });

  it('can force relative on an absolute pointer', () => {
    expect(buildDataRef('/a', { relative: true })).toEqual({ pointer: '/a', relative: true });
  });
});
