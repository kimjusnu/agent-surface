/**
 * Trace persistence.
 *
 * ## What is stored
 *
 * The frames, and only the frames. `state`, `tree` and `totals` are re-derived on
 * read by the same reducer and tree builder that the live view used, which is
 * what guarantees a trace read off disk in six months renders exactly what the
 * screen showed when the bug happened. Persisting the derived views instead
 * would let a schema change in the reducer produce a stored trace that no longer
 * matches its own transcript, and nothing would catch it.
 *
 * The run's identity and its totals go in a header line so that listing runs does
 * not have to read (or parse) a whole transcript -- a night of evals is thousands
 * of files, and `list()` is on the path of a page render.
 *
 * ## File format
 *
 * One JSONL file per run: a header record, then one record per frame. Chosen over
 * a single JSON blob for three reasons that all show up in production:
 * `grep '"kind":"tool.result"' run.jsonl` works; a truncated write loses the tail
 * instead of the whole file; and appending is O(1). The cost is that a reader
 * must stream, which is why `get()` reads the header and frames together but
 * `list()` reads only the first line.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ProtocolId, SurfaceFrame } from '@agent-surface/protocol';

import { assembleRun, RUN_TRACE_VERSION, type RunTotals, type RunTrace } from './run.js';

export interface TraceListFilter {
  /** Most recent first; the default cap is deliberately low. */
  limit?: number;
  protocol?: ProtocolId;
  /** Epoch millis; only runs that ended at or after this are returned. */
  since?: number;
}

export interface RunSummary {
  runId: string;
  threadId: string;
  protocol: ProtocolId;
  agentName?: string;
  startedAt: number;
  endedAt?: number;
  wallClockMs: number;
  frameCount: number;
  finalized: boolean;
  toolCalls: number;
  orphanTools: number;
  warnings: number;
  errors: number;
  costUsd?: number;
}

export interface TraceStore {
  /**
   * Store a run, replacing any previous record for the same `runId`.
   *
   * Replacing rather than appending: a run id identifies one run, and a retried
   * `finalize()` must not produce two records that a diff then reads as two
   * executions.
   */
  append(run: RunTrace): Promise<void>;
  get(runId: string): Promise<RunTrace | undefined>;
  /** Summaries, newest first. */
  list(filter?: TraceListFilter): Promise<RunSummary[]>;
  /** Delete runs that ended before `before` (epoch millis). Returns the count. */
  prune(before: number): Promise<number>;
}

/** Header record; the frame records that follow carry the transcript. */
export interface TraceHeaderRecord {
  type: 'header';
  version: typeof RUN_TRACE_VERSION;
  runId: string;
  threadId: string;
  protocol: ProtocolId;
  agentName?: string;
  startedAt: number;
  endedAt?: number;
  finalized: boolean;
  totals: RunTotals;
}

export interface TraceFrameRecord {
  type: 'frame';
  frame: SurfaceFrame;
}

export type TraceRecord = TraceHeaderRecord | TraceFrameRecord;

export const TRACE_EXTENSION = '.trace.jsonl';

export function summarizeRun(run: RunTrace): RunSummary {
  const summary: RunSummary = {
    runId: run.runId,
    threadId: run.threadId,
    protocol: run.protocol,
    ...(run.agentName !== undefined ? { agentName: run.agentName } : {}),
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    wallClockMs: run.totals.wallClockMs,
    frameCount: run.totals.frameCount,
    finalized: run.finalized,
    toolCalls: run.totals.tools.total,
    orphanTools: run.totals.tools.orphan,
    warnings: run.totals.warnings,
    errors: run.totals.errors,
    ...(run.totals.costUsd !== undefined ? { costUsd: run.totals.costUsd } : {}),
  };
  return summary;
}

export function toHeader(run: RunTrace): TraceHeaderRecord {
  return {
    type: 'header',
    version: RUN_TRACE_VERSION,
    runId: run.runId,
    threadId: run.threadId,
    protocol: run.protocol,
    ...(run.agentName !== undefined ? { agentName: run.agentName } : {}),
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    finalized: run.finalized,
    totals: run.totals,
  };
}

/** Serialise a run as JSONL text. Exposed so tests can assert the wire format. */
export function encodeTrace(run: RunTrace): string {
  const lines = [JSON.stringify(toHeader(run))];
  for (const frame of run.frames) {
    lines.push(JSON.stringify({ type: 'frame', frame } satisfies TraceFrameRecord));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Parse JSONL back into a trace.
 *
 * Tolerates a truncated final line: a process killed mid-write leaves a partial
 * JSON document, and the frames before it are still the interesting ones. A
 * corrupt line in the *middle* is a real fault and throws, because silently
 * skipping it would produce a transcript with a hole in the middle that nothing
 * downstream could detect.
 */
export function decodeTrace(text: string): RunTrace {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new Error('Trace file is empty');
  const header = parseHeader(lines[0]!);
  const frames: SurfaceFrame[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (i === lines.length - 1) break;
      throw new Error(`Trace line ${String(i + 1)} is not valid JSON`);
    }
    const record = parsed as TraceFrameRecord;
    if (record?.type !== 'frame') {
      throw new Error(`Trace line ${String(i + 1)} is not a frame record`);
    }
    frames.push(record.frame);
  }
  return assembleRun(frames, {
    runId: header.runId,
    threadId: header.threadId,
    protocol: header.protocol,
    ...(header.agentName !== undefined ? { agentName: header.agentName } : {}),
    startedAt: header.startedAt,
    ...(header.endedAt !== undefined ? { endedAt: header.endedAt } : {}),
    finalized: header.finalized,
  });
}

function parseHeader(line: string): TraceHeaderRecord {
  const parsed = JSON.parse(line) as TraceHeaderRecord;
  if (parsed?.type !== 'header') throw new Error('Trace file does not start with a header record');
  if (parsed.version !== RUN_TRACE_VERSION) {
    throw new Error(
      `Trace was written by ${String(parsed.version)}; this build reads ${RUN_TRACE_VERSION}`,
    );
  }
  return parsed;
}

/** Newest-first ordering, shared by both stores so `list` behaves identically. */
export function sortSummaries(summaries: readonly RunSummary[]): RunSummary[] {
  return summaries
    .slice()
    .sort((a, b) => orderKey(b) - orderKey(a) || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
}

function orderKey(summary: RunSummary): number {
  return summary.endedAt ?? summary.startedAt;
}

export function applyFilter(summaries: readonly RunSummary[], filter: TraceListFilter = {}): RunSummary[] {
  const filtered = summaries.filter((summary) => {
    if (filter.protocol !== undefined && summary.protocol !== filter.protocol) return false;
    if (filter.since !== undefined && orderKey(summary) < filter.since) return false;
    return true;
  });
  const sorted = sortSummaries(filtered);
  return filter.limit === undefined ? sorted : sorted.slice(0, Math.max(0, filter.limit));
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

export class InMemoryTraceStore implements TraceStore {
  readonly #runs = new Map<string, RunTrace>();
  /** Insertion order, so `list` is stable for runs sharing a timestamp. */
  readonly #order: string[] = [];

  async append(run: RunTrace): Promise<void> {
    if (!this.#runs.has(run.runId)) this.#order.push(run.runId);
    this.#runs.set(run.runId, run);
  }

  async get(runId: string): Promise<RunTrace | undefined> {
    return this.#runs.get(runId);
  }

  async list(filter: TraceListFilter = {}): Promise<RunSummary[]> {
    return applyFilter(this.#order.map((id) => this.#runs.get(id)!).map(summarizeRun), filter);
  }

  async prune(before: number): Promise<number> {
    let removed = 0;
    for (const id of [...this.#order]) {
      const run = this.#runs.get(id);
      // A run that never finished has no end; pruning it on the strength of its
      // start would delete the transcript of a run that is still in flight.
      if (!run || run.endedAt === undefined || run.endedAt >= before) continue;
      this.#runs.delete(id);
      this.#order.splice(this.#order.indexOf(id), 1);
      removed += 1;
    }
    return removed;
  }

  get size(): number {
    return this.#runs.size;
  }

  runIds(): string[] {
    return this.#order.slice();
  }

  clear(): void {
    this.#runs.clear();
    this.#order.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface FileTraceStoreOptions {
  /** Directory the run files live in. Created on first write. */
  dir: string;
  /**
   * Run ids come from an agent, so they cannot be used as filenames unchecked.
   * Anything outside `[A-Za-z0-9._-]` is escaped, which keeps the store inside its
   * own directory instead of following `../`.
   */
  maxFileBytes?: number;
}

/** Hard ceiling on a re-serialised run, to refuse writing a runaway transcript. */
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;

export class FileTraceStore implements TraceStore {
  readonly #dir: string;
  readonly #maxFileBytes: number;

  constructor(options: FileTraceStoreOptions) {
    this.#dir = options.dir;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  get dir(): string {
    return this.#dir;
  }

  pathFor(runId: string): string {
    return join(this.#dir, `${safeFileName(runId)}${TRACE_EXTENSION}`);
  }

  async append(run: RunTrace): Promise<void> {
    const text = encodeTrace(run);
    // `TextEncoder` rather than `Buffer.byteLength`: the same encoder runs in a
    // worker or a browser test, and a Node-only global here would be the first
    // thing to break when this package is exercised outside Node.
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > this.#maxFileBytes) {
      throw new Error(
        `Trace ${run.runId} is ${String(bytes)} bytes, over the ${String(this.#maxFileBytes)}-byte store limit; redact or cap it before persisting`,
      );
    }
    await mkdir(this.#dir, { recursive: true });
    await writeFile(this.pathFor(run.runId), text, 'utf8');
  }

  async get(runId: string): Promise<RunTrace | undefined> {
    let text: string;
    try {
      text = await readFile(this.pathFor(runId), 'utf8');
    } catch {
      // A missing file is the normal answer to "do you have this run", not an
      // error worth propagating to a caller that asked a yes/no question.
      return undefined;
    }
    return decodeTrace(text);
  }

  /**
   * List runs newest first, reading only each file's header line.
   *
   * The whole file is never parsed, which is what keeps a listing page cheap
   * after a night of evals wrote thousands of runs.
   */
  async list(filter: TraceListFilter = {}): Promise<RunSummary[]> {
    const names = await readdir(this.#dir).catch(() => [] as string[]);
    const summaries: RunSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(TRACE_EXTENSION)) continue;
      const summary = await this.#readSummary(join(this.#dir, name));
      if (summary) summaries.push(summary);
    }
    return applyFilter(summaries, filter);
  }

  async prune(before: number): Promise<number> {
    const names = await readdir(this.#dir).catch(() => [] as string[]);
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith(TRACE_EXTENSION)) continue;
      const summary = await this.#readSummary(join(this.#dir, name));
      if (!summary || summary.endedAt === undefined) continue;
      if (summary.endedAt >= before) continue;
      await rm(join(this.#dir, name), { force: true });
      removed += 1;
    }
    return removed;
  }

  async #readSummary(path: string): Promise<RunSummary | undefined> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return undefined;
    }
    const firstLine = text.split('\n', 1)[0];
    if (firstLine === undefined || firstLine.trim() === '') return undefined;
    try {
      const header = parseHeader(firstLine);
      return {
        runId: header.runId,
        threadId: header.threadId,
        protocol: header.protocol,
        ...(header.agentName !== undefined ? { agentName: header.agentName } : {}),
        startedAt: header.startedAt,
        ...(header.endedAt !== undefined ? { endedAt: header.endedAt } : {}),
        wallClockMs: header.totals.wallClockMs,
        frameCount: header.totals.frameCount,
        finalized: header.finalized,
        toolCalls: header.totals.tools.total,
        orphanTools: header.totals.tools.orphan,
        warnings: header.totals.warnings,
        errors: header.totals.errors,
        ...(header.totals.costUsd !== undefined ? { costUsd: header.totals.costUsd } : {}),
      };
    } catch {
      // A file this build cannot read is skipped rather than fatal: one
      // incompatible trace must not hide every other run in the directory.
      return undefined;
    }
  }
}

/**
 * Make a run id safe as a filename.
 *
 * Run ids arrive from the transport and can contain a path separator; writing
 * them unescaped would let an agent choose where the store writes. Percent-style
 * escaping keeps the mapping reversible and injective, so two ids never collide.
 */
export function safeFileName(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `_${code.toString(16).padStart(4, '0')}_`;
  });
}
