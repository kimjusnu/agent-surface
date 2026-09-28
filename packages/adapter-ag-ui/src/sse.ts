/**
 * Incremental Server-Sent Events parser (WHATWG "server-sent events" line
 * format), written as a pure chunk-in/messages-out state machine so the adapter
 * can be driven from a `fetch` body reader, a Node stream, or a test that feeds
 * one character at a time and gets identical results.
 *
 * Two decisions that the spec does not make but that every real server needs:
 *
 *  1. A trailing `\r` at the end of a chunk is held back rather than treated as
 *     a line terminator. A `CRLF` pair split across two chunks must not become
 *     two terminators, which would inject a phantom blank line and dispatch a
 *     half-built event.
 *  2. {@link SseParser.flush} dispatches a block whose terminating blank line
 *     never arrived. The spec discards an unterminated trailing line, but the
 *     host only calls `flush()` once the response body has ended, where
 *     "truncated" and "complete but unterminated" are indistinguishable -- and a
 *     dropped final event is a far worse failure than a lenient last event.
 */

/** One dispatched SSE event. `data` has already had its trailing newline removed. */
export interface SseMessage {
  /** The `event:` field, defaulting to `message` per the spec. */
  event: string;
  /** All `data:` lines of the block, joined with `\n`. */
  data: string;
  /**
   * The last event id seen on the stream, not just this block. The spec's
   * "last event ID buffer" persists across dispatches so a consumer reconnecting
   * with `Last-Event-ID` resumes where the stream left off.
   */
  id: string | undefined;
  /** The `retry:` value carried by *this* block, when it was well-formed. */
  retry: number | undefined;
}

const DEFAULT_EVENT_NAME = 'message';
/** A `retry:` value is honoured only when it is ASCII digits and nothing else. */
const DIGITS_ONLY = /^[0-9]+$/;
/**
 * The spec says an `id:` value containing U+0000 must be ignored entirely.
 * Built at runtime because a literal NUL in source is invisible in review and
 * makes every grep treat the file as binary.
 */
const NUL = String.fromCharCode(0);

export class SseParser {
  /** Bytes received but not yet consumed, i.e. a partial trailing line. */
  #buffer = '';
  #data: string[] = [];
  #event: string | undefined;
  #blockRetry: number | undefined;
  #lastEventId: string | undefined;
  #reconnectionTime: number | undefined;

  /** The most recent valid `retry:` value, which persists across events. */
  get reconnectionTime(): number | undefined {
    return this.#reconnectionTime;
  }

  /** The persistent last-event-id buffer. */
  get lastEventId(): string | undefined {
    return this.#lastEventId;
  }

  /** Bytes currently held as an incomplete line. Exposed for diagnostics. */
  get pendingBytes(): number {
    return this.#buffer.length;
  }

  /** Feed an arbitrary chunk; returns the events it completed. */
  feed(chunk: string): SseMessage[] {
    if (chunk === '') return [];
    this.#buffer += chunk;
    return this.#scan();
  }

  /**
   * End of stream: consume an unterminated trailing line, then dispatch the
   * block that never got its blank line. Idempotent -- a second `flush()` with
   * no intervening `feed()` returns nothing, and the parser stays usable.
   */
  flush(): SseMessage[] {
    const out: SseMessage[] = [];
    if (this.#buffer !== '') {
      // Appending a terminator lets the ordinary scanner cope with a bare CR, a
      // bare CR/LF, and a line that simply never got closed, without a special
      // case per flavour.
      this.#buffer += '\n';
      out.push(...this.#scan());
      this.#buffer = '';
    }
    out.push(...this.#dispatch());
    return out;
  }

  #scan(): SseMessage[] {
    const out: SseMessage[] = [];
    let lineStart = 0;
    let i = 0;
    while (i < this.#buffer.length) {
      const ch = this.#buffer[i];
      if (ch === '\n') {
        out.push(...this.#line(this.#buffer.slice(lineStart, i)));
        i += 1;
        lineStart = i;
        continue;
      }
      if (ch === '\r') {
        if (i === this.#buffer.length - 1) break;
        out.push(...this.#line(this.#buffer.slice(lineStart, i)));
        i += this.#buffer[i + 1] === '\n' ? 2 : 1;
        lineStart = i;
        continue;
      }
      i += 1;
    }
    this.#buffer = this.#buffer.slice(lineStart);
    return out;
  }

  #line(line: string): SseMessage[] {
    if (line === '') return this.#dispatch();
    // A leading colon is a comment. AG-UI servers use it as a keep-alive, and
    // per the spec it must not influence the event in any way.
    if (line.startsWith(':')) return [];
    return this.#field(line);
  }

  #field(line: string): SseMessage[] {
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    // Exactly one leading space is framing, not value. Further spaces are data,
    // so `data:  x` carries the two-character string " x".
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        this.#event = value;
        break;
      case 'data':
        this.#data.push(value);
        break;
      case 'id':
        if (!value.includes(NUL)) this.#lastEventId = value;
        break;
      case 'retry':
        if (DIGITS_ONLY.test(value)) {
          this.#reconnectionTime = Number(value);
          this.#blockRetry = this.#reconnectionTime;
        }
        break;
      default:
        // Unknown fields are ignored rather than rejected: the format is
        // explicitly extensible and a client must not die on a future field.
        break;
    }
    return [];
  }

  #dispatch(): SseMessage[] {
    if (this.#data.length === 0) {
      // No `data:` line means nothing to deliver, but the event type and the
      // block's retry still have to be cleared or they would leak into the next
      // block and mislabel it.
      this.#event = undefined;
      this.#blockRetry = undefined;
      return [];
    }
    const message: SseMessage = {
      event: this.#event ?? DEFAULT_EVENT_NAME,
      data: this.#data.join('\n'),
      id: this.#lastEventId,
      retry: this.#blockRetry,
    };
    this.#data = [];
    this.#event = undefined;
    this.#blockRetry = undefined;
    return [message];
  }
}

/**
 * Decode a whole SSE body supplied as chunks. Convenience for tests and for
 * buffering transports; a streaming host should drive {@link SseParser} directly
 * so events can be forwarded the moment they complete.
 */
export function decodeSse(chunks: Iterable<string>): SseMessage[] {
  const parser = new SseParser();
  const out: SseMessage[] = [];
  for (const chunk of chunks) out.push(...parser.feed(chunk));
  out.push(...parser.flush());
  return out;
}
