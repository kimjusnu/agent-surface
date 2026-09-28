import { describe, expect, it } from 'vitest';
import { JsonlReader, readJsonl, readJsonlValues } from '../src/jsonl.js';
import { A2UI_V0_9_JSONL } from './fixtures.js';

type Record_ = ReturnType<JsonlReader['push']>[number];

function asJson(record: Record_ | undefined): unknown {
  if (record === undefined || record.kind !== 'json') throw new Error('expected a json record');
  return record.value;
}

describe('JsonlReader', () => {
  it('produces identical output for one-char chunks and one big chunk', () => {
    const text = `${A2UI_V0_9_JSONL}\n`;

    const big = readJsonl(text);

    const reader = new JsonlReader();
    const perChar: Record_[] = [];
    for (const char of text) perChar.push(...reader.push(char));
    perChar.push(...reader.flush());

    expect(perChar).toEqual(big);
    expect(big.length).toBeGreaterThan(3);
  });

  it('skips blank and whitespace-only lines', () => {
    const records = readJsonl('\n\n   \n{"a":1}\n\t\n{"b":2}\n');
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.kind === 'json')).toBe(true);
    expect(records.map((r) => (r.kind === 'json' ? r.value : null))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('treats CRLF and bare CR exactly like LF', () => {
    const lf = readJsonl('{"a":1}\n{"b":2}\n');
    const crlf = readJsonl('{"a":1}\r\n{"b":2}\r\n');
    const cr = readJsonl('{"a":1}\r{"b":2}\r');
    expect(crlf).toEqual(lf);
    expect(cr).toEqual(lf);
  });

  it('holds a partial line across chunks until it is terminated', () => {
    const reader = new JsonlReader();
    expect(reader.push('{"a":')).toEqual([]);
    expect(reader.pending).toBe('{"a":');
    expect(reader.push('1}')).toEqual([]);
    const done = reader.push('\n');
    expect(done).toHaveLength(1);
    expect(asJson(done[0])).toEqual({ a: 1 });
    expect(reader.pending).toBe('');
  });

  it('emits a trailing line that never got its newline, and nothing after a final newline', () => {
    const withNewline = new JsonlReader();
    withNewline.push('{"a":1}\n');
    expect(withNewline.flush()).toEqual([]);

    const without = new JsonlReader();
    without.push('{"a":1}');
    const flushed = without.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.kind).toBe('json');
  });

  it('turns malformed JSON into an invalid record and keeps reading', () => {
    const records = readJsonl('{"a":1}\nnot json at all\n{"b":2}\n');
    expect(records).toHaveLength(3);

    const bad = records[1]!;
    expect(bad.kind).toBe('invalid');
    if (bad.kind !== 'invalid') throw new Error('unreachable');
    expect(bad.code).toBe('JSONL_INVALID_JSON');
    expect(bad.raw).toBe('not json at all');
    expect(bad.line).toBe(1);
    expect(bad.error.length).toBeGreaterThan(0);

    // The stream keeps working after the bad line.
    expect(records[2]!.kind).toBe('json');
  });

  it('reports an over-long line once and resynchronises on the next newline', () => {
    const reader = new JsonlReader({ maxLineLength: 10 });
    const records = reader.push(`${'x'.repeat(40)}\n{"ok":1}\n`);
    expect(records).toHaveLength(2);
    expect(records[0]!.kind).toBe('invalid');
    if (records[0]!.kind !== 'invalid') throw new Error('unreachable');
    expect(records[0]!.code).toBe('JSONL_LINE_TOO_LONG');
    expect(records[0]!.line).toBe(0);
    expect(records[1]).toMatchObject({ kind: 'json', line: 1, value: { ok: 1 } });
  });

  it('counts lines including blank ones, so line numbers match the source', () => {
    const records = readJsonl('{"a":1}\n\n{"b":2}\nbroken\n');
    expect(records.map((r) => r.line)).toEqual([0, 2, 3]);

    const reader = new JsonlReader();
    reader.push('{"a":1}\n\n{"b":2}\n');
    expect(reader.lineNumber).toBe(3);
  });

  it('resets all state for a transport reconnect', () => {
    const reader = new JsonlReader();
    reader.push('{"a":1}\n{"partial"');
    expect(reader.pending).toBe('{"partial"');
    reader.reset();
    expect(reader.pending).toBe('');
    expect(reader.lineNumber).toBe(0);
    expect(reader.push('{"b":2}\n')).toEqual([{ kind: 'json', line: 0, raw: '{"b":2}', value: { b: 2 } }]);
  });

  it('readJsonlValues keeps only parsed values', () => {
    expect(readJsonlValues('{"a":1}\nbroken\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('treats a chunk boundary mid-UTF8-escape as one line, not two', () => {
    const reader = new JsonlReader();
    const first = reader.push('{"s":"\\u00e9');
    expect(first).toEqual([]);
    const second = reader.push('t"}\n');
    expect(second).toHaveLength(1);
    if (second[0]!.kind !== 'json') throw new Error('unreachable');
    expect(second[0]!.value).toEqual({ s: 'ét' });
  });
});
