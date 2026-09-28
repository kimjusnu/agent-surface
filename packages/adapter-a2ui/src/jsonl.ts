/**
 * Incremental JSONL reader for A2UI transports.
 *
 * A2UI streams one message per line (NDJSON). Chunk boundaries fall wherever
 * the network puts them, so the reader holds a partial line across `push`
 * calls. Splitting is single-pass over characters rather than `split('\n')`
 * per chunk, which is what makes "one char at a time" and "one big chunk"
 * produce byte-identical output -- a property the tests assert directly,
 * because a stream splitter that only works for aligned chunks silently
 * corrupts every partial multi-byte payload in production.
 */

export type JsonlRecord =
  | { readonly kind: 'json'; readonly line: number; readonly raw: string; readonly value: unknown }
  | {
      readonly kind: 'invalid';
      readonly line: number;
      readonly raw: string;
      readonly code: JsonlErrorCode;
      readonly error: string;
    };

export type JsonlErrorCode = 'JSONL_INVALID_JSON' | 'JSONL_LINE_TOO_LONG';

/** A hostile or buggy agent can stream an unbounded line; refuse to buffer it. */
export const DEFAULT_MAX_LINE_LENGTH = 1_048_576;

export interface JsonlReaderOptions {
  readonly maxLineLength?: number;
}

export class JsonlReader {
  #buffer = '';
  #line = 0;
  #discarding = false;
  #lastWasCarriageReturn = false;
  readonly #maxLineLength: number;

  constructor(options: JsonlReaderOptions = {}) {
    this.#maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  }

  /** Number of lines terminated so far, plus the line currently buffered. */
  get lineNumber(): number {
    return this.#line;
  }

  /** Bytes buffered for the line still being assembled. */
  get pending(): string {
    return this.#discarding ? '' : this.#buffer;
  }

  /**
   * Feed a chunk. Returns records for every line the chunk completed.
   * Never throws: an unparseable line becomes an `invalid` record so the
   * caller can surface a warning and keep reading the rest of the stream.
   */
  push(chunk: string): JsonlRecord[] {
    const out: JsonlRecord[] = [];
    if (chunk.length === 0) return out;

    for (const char of chunk) {
      const isNewline = char === '\n';
      // A CR was already treated as a terminator, so the LF of a CRLF pair is
      // not a second terminator; that is what keeps CRLF and LF identical.
      if (isNewline && this.#lastWasCarriageReturn) {
        this.#lastWasCarriageReturn = false;
        continue;
      }
      this.#lastWasCarriageReturn = false;

      if (isNewline || char === '\r') {
        this.#lastWasCarriageReturn = char === '\r';
        this.#drainLine(out);
        continue;
      }

      if (this.#discarding) continue;

      this.#buffer += char;
      if (this.#buffer.length > this.#maxLineLength) {
        out.push({
          kind: 'invalid',
          line: this.#line,
          raw: '',
          code: 'JSONL_LINE_TOO_LONG',
          error: `line exceeds maxLineLength (${this.#maxLineLength})`,
        });
        this.#buffer = '';
        this.#discarding = true;
      }
    }
    return out;
  }

  /**
   * Close the stream. A trailing line without its newline is still a complete
   * record, so it is emitted here; a trailing newline leaves an empty buffer
   * and produces nothing.
   */
  flush(): JsonlRecord[] {
    const out: JsonlRecord[] = [];
    this.#drainLine(out);
    this.#lastWasCarriageReturn = false;
    return out;
  }

  /** Drop all state, for a transport reconnect on the same adapter instance. */
  reset(): void {
    this.#buffer = '';
    this.#line = 0;
    this.#discarding = false;
    this.#lastWasCarriageReturn = false;
  }

  #drainLine(out: JsonlRecord[]): void {
    if (this.#discarding) {
      this.#discarding = false;
      this.#buffer = '';
      this.#line++;
      return;
    }
    const raw = this.#buffer;
    this.#buffer = '';
    const line = this.#line;
    this.#line++;

    // Blank and whitespace-only lines are stream separators, not records.
    if (raw.trim().length === 0) return;

    try {
      out.push({ kind: 'json', line, raw, value: JSON.parse(raw) });
    } catch (err) {
      out.push({
        kind: 'invalid',
        line,
        raw,
        code: 'JSONL_INVALID_JSON',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Read a whole string in one shot. Convenience for tests and non-streaming input. */
export function readJsonl(text: string, options: JsonlReaderOptions = {}): JsonlRecord[] {
  const reader = new JsonlReader(options);
  return [...reader.push(text), ...reader.flush()];
}

/** Read a whole string and keep only successfully parsed values. */
export function readJsonlValues(text: string, options: JsonlReaderOptions = {}): unknown[] {
  return readJsonl(text, options)
    .filter((r): r is Extract<JsonlRecord, { kind: 'json' }> => r.kind === 'json')
    .map((r) => r.value);
}
