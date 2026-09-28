/**
 * The SSE parser is where a real stream breaks, so it is tested against the
 * awkward inputs rather than the tidy ones: chunk boundaries that land inside a
 * field name, inside a field value, and between the CR and the LF of a CRLF.
 *
 * The reference oracle for chunk-splitting equivalence is not a hand-written
 * expectation but the parser itself fed in one big chunk, so any boundary bug
 * shows up as a diff between the two.
 */

import { describe, expect, it } from 'vitest';

import { SseParser, decodeSse } from '../src/sse.js';

const AGENT_EVENT = 'data: {"type":"RUN_STARTED"}\n\n';

function feedAll(chunks: readonly string[]): string[] {
  const parser = new SseParser();
  const out: string[] = [];
  for (const chunk of chunks) for (const m of parser.feed(chunk)) out.push(`${m.event}|${m.data}`);
  for (const m of parser.flush()) out.push(`${m.event}|${m.data}`);
  return out;
}

function feedByChar(text: string): string[] {
  return feedAll([...text]);
}

describe('SseParser framing', () => {
  it('dispatches a single data-only block', () => {
    expect(decodeSse(['data: hello\n\n'])).toEqual([
      { event: 'message', data: 'hello', id: undefined, retry: undefined },
    ]);
  });

  it('joins multiple data lines with a newline', () => {
    const [message] = decodeSse(['data: {"a":\ndata:  1}\n\n']);
    expect(message?.data).toBe('{"a":\n 1}');
  });

  it('reads the event field', () => {
    const [message] = decodeSse(['event: message-delta\ndata: x\n\n']);
    expect(message?.event).toBe('message-delta');
  });

  it('defaults the event name to "message"', () => {
    expect(decodeSse(['data: x\n\n'])[0]?.event).toBe('message');
  });

  it('strips exactly one leading space and keeps the rest', () => {
    const [message] = decodeSse(['data:   padded\n\n']);
    expect(message?.data).toBe('  padded');
  });

  it('treats a line with no colon as a field with an empty value', () => {
    const [message] = decodeSse(['data\ndata: after\n\n']);
    expect(message?.data).toBe('\nafter');
  });

  it('ignores unknown fields instead of rejecting them', () => {
    const [message] = decodeSse(['weird: value\ndata: x\n\n']);
    expect(message?.data).toBe('x');
  });

  it('dispatches an empty data line as an empty-payload event', () => {
    expect(decodeSse(['data:\n\n'])[0]?.data).toBe('');
  });

  it('does not dispatch a block that has fields but no data', () => {
    expect(decodeSse(['event: ping\nid: 7\n\ndata: real\n\n'])).toHaveLength(1);
  });

  it('does not leak an event name from an undispatched block into the next one', () => {
    const messages = decodeSse(['event: ghost\n\ndata: real\n\n']);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.event).toBe('message');
  });

  it('handles several blocks in one chunk', () => {
    expect(feedAll(['data: a\n\ndata: b\n\ndata: c\n\n'])).toEqual(['message|a', 'message|b', 'message|c']);
  });
});

describe('SseParser id and retry fields', () => {
  it('attaches the id from the same block', () => {
    expect(decodeSse(['id: 42\ndata: x\n\n'])[0]?.id).toBe('42');
  });

  it('persists the last id across later blocks that carry none', () => {
    const messages = decodeSse(['id: 1\ndata: a\n\ndata: b\n\n']);
    expect(messages.map((m) => m.id)).toEqual(['1', '1']);
  });

  it('ignores an id containing NUL', () => {
    const messages = decodeSse(['id: bad\u0000id\ndata: a\n\n']);
    expect(messages[0]?.id).toBeUndefined();
  });

  it('parses a numeric retry and exposes it on the block and the parser', () => {
    const parser = new SseParser();
    const [message] = [...parser.feed('retry: 2500\ndata: x\n\n')];
    expect(message?.retry).toBe(2500);
    expect(parser.reconnectionTime).toBe(2500);
  });

  it('ignores a non-numeric retry', () => {
    const parser = new SseParser();
    const [message] = [...parser.feed('retry: soon\ndata: x\n\n')];
    expect(message?.retry).toBeUndefined();
    expect(parser.reconnectionTime).toBeUndefined();
  });

  it('reports retry only on the block that carried it', () => {
    const messages = decodeSse(['retry: 100\ndata: a\n\ndata: b\n\n']);
    expect(messages.map((m) => m.retry)).toEqual([100, undefined]);
  });
});

describe('SseParser line endings and comments', () => {
  it('accepts CRLF line endings', () => {
    expect(feedAll(['data: x\r\n\r\n'])).toEqual(['message|x']);
  });

  it('accepts bare CR line endings', () => {
    expect(feedAll(['data: x\r\r'])).toEqual(['message|x']);
  });

  it('ignores comment lines and does not let them dispatch', () => {
    expect(feedAll([': keep-alive\n', ': another\n\ndata: x\n\n'])).toEqual(['message|x']);
  });

  it('ignores a comment that arrives between the data line and the blank line', () => {
    expect(feedAll(['data: x\n:noise\n\n'])).toEqual(['message|x']);
  });

  it('handles a stream that is nothing but comments', () => {
    expect(feedAll([': a\n: b\n'])).toEqual([]);
  });
});

describe('SseParser chunk-boundary equivalence', () => {
  const bodies: readonly string[] = [
    AGENT_EVENT,
    'event: msg\r\ndata: {"type":"TEXT_MESSAGE_CONTENT","delta":"hi"}\r\nid: 3\r\n\r\n',
    'data: a\ndata: b\ndata: c\n\ndata: d\n\n',
    'data: split\r\n\r\ndata: crlf\r\n\r\n',
    'data: a\ndata: b\ndata: c\ndata: d\ndata: e\n\n',
    ': ping\n\ndata: after-comment\n\n',
    'retry: 300\nevent: x\nid: 9\ndata: y\n\n',
  ];

  for (const body of bodies) {
    it(`matches the single-chunk result for ${JSON.stringify(body.slice(0, 34))}`, () => {
      expect(feedByChar(body)).toEqual(feedAll([body]));
    });
  }

  it('produces the same messages for every possible two-way split', () => {
    const body = 'event: e\r\nid: 5\r\ndata: {"a":1}\r\ndata: 2\r\n\r\n';
    const whole = feedAll([body]);
    for (let cut = 0; cut <= body.length; cut++) {
      expect(feedAll([body.slice(0, cut), body.slice(cut)])).toEqual(whole);
    }
  });

  it('holds back a dangling CR so a split CRLF is not two terminators', () => {
    const parser = new SseParser();
    expect(parser.feed('data: x\r')).toEqual([]);
    expect(parser.pendingBytes).toBeGreaterThan(0);
    expect(parser.feed('\n\r\n')).toEqual([{ event: 'message', data: 'x', id: undefined, retry: undefined }]);
  });

  it('does not dispatch when a chunk boundary lands inside the field name', () => {
    const parser = new SseParser();
    expect(parser.feed('dat')).toEqual([]);
    expect(parser.feed('a: {"ty')).toEqual([]);
    const messages = parser.feed('pe":"RAW"}\n\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.data).toBe('{"type":"RAW"}');
  });

  it('does not dispatch when a chunk boundary lands inside the field value', () => {
    const parser = new SseParser();
    expect(parser.feed('data: {"mes')).toEqual([]);
    expect(parser.feed('sageId":"m1","del')).toEqual([]);
    expect(parser.feed('ta":"x"}\n\n')[0]?.data).toBe('{"messageId":"m1","delta":"x"}');
  });
});

describe('SseParser flush', () => {
  it('dispatches a block whose blank line never arrived', () => {
    const parser = new SseParser();
    expect(parser.feed('data: last\n')).toEqual([]);
    expect(parser.flush()).toEqual([{ event: 'message', data: 'last', id: undefined, retry: undefined }]);
  });

  it('dispatches a block that never even got a line terminator', () => {
    const parser = new SseParser();
    parser.feed('data: truncated');
    expect(parser.flush()[0]?.data).toBe('truncated');
  });

  it('dispatches a block terminated by a bare trailing CR', () => {
    const parser = new SseParser();
    parser.feed('data: x\r');
    expect(parser.flush()[0]?.data).toBe('x');
  });

  it('is idempotent', () => {
    const parser = new SseParser();
    parser.feed('data: x\n');
    expect(parser.flush()).toHaveLength(1);
    expect(parser.flush()).toEqual([]);
  });

  it('returns nothing on an empty stream', () => {
    expect(new SseParser().flush()).toEqual([]);
  });

  it('leaves the parser usable after a flush', () => {
    const parser = new SseParser();
    parser.feed('data: first\n');
    parser.flush();
    expect(parser.feed('data: second\n\n')[0]?.data).toBe('second');
  });

  it('keeps a real dispatch from being repeated by the flush', () => {
    const parser = new SseParser();
    const dispatched = parser.feed('data: x\n\n');
    expect(dispatched).toHaveLength(1);
    expect(parser.flush()).toEqual([]);
  });
});

describe('decodeSse', () => {
  it('decodes a realistic AG-UI run delivered in small chunks', () => {
    const body =
      'data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}\n\n' +
      'data: {"type":"TEXT_MESSAGE_START","messageId":"m1"}\n\n' +
      'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"Hello"}\n\n' +
      'data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}\n\n';
    const messages = decodeSse([body.slice(0, 30), body.slice(30, 97), body.slice(97)]);
    expect(messages.map((m) => JSON.parse(m.data).type)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'RUN_FINISHED',
    ]);
  });
});
