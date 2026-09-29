/**
 * The recorder: a subscriber that remembers everything.
 *
 * `Tracer` is the only writer of `RunTrace` objects during a live run. It keeps
 * the raw frames (the source of truth) and folds the reducer over them
 * incrementally, so `getRun()` can be called at any moment -- from a devtools
 * panel, a health check, or a crash handler -- and get a coherent snapshot
 * rather than a half-updated object.
 *
 * ## Subscription lifetime
 *
 * A leaked listener on a long-lived `SurfaceStream` is not a small leak: it keeps
 * an entire run's frames alive and re-folds them on every subsequent run of the
 * same thread. Three paths end a subscription and all three must leave nothing
 * behind:
 *
 *  1. `detach()` -- explicit.
 *  2. `finalize()` -- implies the run is over.
 *  3. `SurfaceStream.close()`, which fires on `run.finished` and clears its own
 *     listener set. The tracer cannot unsubscribe from a set that no longer
 *     exists, so it clears its handle instead and marks itself detached.
 *
 * The stream already protects itself against a throwing subscriber (it converts
 * a fault into an `error` frame), so this class never needs a try/catch around
 * its own work -- but it does need to stay cheap, because it runs on the
 * streaming hot path.
 */

import type { ProtocolId, SurfaceFrame, SurfaceStream, Unsubscribe } from '@agent-surface/protocol';

import { applyFrame, emptyRunState, type RunState } from './reducer.js';
import { redactFrame, type RedactOptions } from './redact.js';
import { assembleRun, type RunTrace } from './run.js';

export interface TracerOptions {
  runId: string;
  threadId: string;
  protocol: ProtocolId;
  /** Pre-seeded agent name, for the window before `run.started` arrives. */
  agentName?: string;
  /** Injectable clock for tests and for hosts that stamp frames themselves. */
  now?: () => number;
  /** Redact and bound frames before they are retained. */
  redact?: RedactOptions;
  /**
   * Keep at most this many frames; the oldest are dropped.
   *
   * A tracer that cannot be capped is a memory leak with extra steps: a
   * runaway agent can emit frames faster than the host drains them. Dropping
   * the oldest frames loses the beginning of the run and is reported through
   * `droppedFrames` rather than silently, because a truncated trace that looks
   * complete is how a bug survives a postmortem.
   */
  maxFrames?: number;
}

export const DEFAULT_MAX_FRAMES = 50_000;

export class Tracer {
  readonly runId: string;
  readonly threadId: string;
  readonly protocol: ProtocolId;

  readonly #options: TracerOptions;
  readonly #now: () => number;
  readonly #maxFrames: number;
  readonly #redact: RedactOptions | undefined;

  #frames: SurfaceFrame[] = [];
  #state: RunState;
  #unsubscribe: Unsubscribe | undefined;
  #finalized = false;
  #droppedFrames = 0;
  #startedAt: number;

  constructor(options: TracerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
    this.#maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
    this.#redact = options.redact;
    this.runId = options.runId;
    this.threadId = options.threadId;
    this.protocol = options.protocol;
    this.#startedAt = this.#now();
    this.#state = emptyRunState({
      runId: options.runId,
      threadId: options.threadId,
      protocol: options.protocol,
      ...(options.agentName !== undefined ? { agentName: options.agentName } : {}),
    });
  }

  /**
   * Subscribe to a stream. Returns the same function as `detach`, so a caller
   * that wants a `using`-style scope does not have to remember the method name.
   */
  attach(stream: SurfaceStream): () => void {
    this.detach();
    this.#unsubscribe = stream.subscribe((frame) => {
      this.record(frame);
      // `SurfaceStream.emit` clears its listener set when it sees `run.finished`.
      // Unsubscribing from there is a no-op on the stream's side, so the tracer
      // only has to stop holding the handle.
      if (frame.kind === 'run.finished') this.#forgetSubscription();
    });
    return () => this.detach();
  }

  get attached(): boolean {
    return this.#unsubscribe !== undefined;
  }

  get finalized(): boolean {
    return this.#finalized;
  }

  /** Frames discarded by `maxFrames`. Zero unless the cap was hit. */
  get droppedFrames(): number {
    return this.#droppedFrames;
  }

  get frameCount(): number {
    return this.#frames.length;
  }

  get frames(): readonly SurfaceFrame[] {
    return this.#frames.slice();
  }

  /** The live folded state. Cheap: the last frame's result, not a refold. */
  get state(): RunState {
    return this.#state;
  }

  /**
   * Record one frame.
   *
   * Also the entry point for a host that calls `adapter.ingest` directly with
   * no stream in between, which the AG-UI adapter's own `seq` stamping supports.
   */
  record(frame: SurfaceFrame): void {
    const stored = this.#redact === undefined ? frame : redactFrame(frame, this.#redact);
    if (this.#frames.length >= this.#maxFrames) {
      this.#frames.shift();
      this.#droppedFrames += 1;
    }
    this.#frames.push(stored);
    this.#state = applyFrame(this.#state, stored);
  }

  /** Unsubscribe. Safe after the stream already closed. */
  detach(): void {
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = undefined;
    unsubscribe?.();
  }

  /**
   * Close the run: detach, then assemble.
   *
   * Idempotent, because a host will call it from a `finally` block and from a
   * `run.finished` handler and should not have to know which came first.
   */
  finalize(): RunTrace {
    this.detach();
    this.#finalized = true;
    return this.getRun({ finalized: true });
  }

  /** An assembled snapshot. Does not detach. */
  getRun(options: { finalized?: boolean } = {}): RunTrace {
    // The run's window is measured on the frames' own clock. A tracer that
    // attached mid-run has frames older than its construction time, and mixing
    // the two clocks would report a run that starts before it existed.
    const firstTs = this.#frames[0]?.ts;
    return assembleRun(this.#frames, {
      runId: this.runId,
      threadId: this.threadId,
      protocol: this.protocol,
      ...(this.#options.agentName !== undefined ? { agentName: this.#options.agentName } : {}),
      startedAt: firstTs ?? this.#startedAt,
      finalized: options.finalized ?? this.#finalized,
      // A live view must not promote open tool calls to orphans; the tree's
      // `closed` flag exists for exactly this.
      closed: options.finalized ?? this.#finalized,
    });
  }

  #forgetSubscription(): void {
    this.#unsubscribe = undefined;
  }
}

/** Convenience: record an adapter's frames without a stream in between. */
export function recordFrames(tracer: Tracer, frames: Iterable<SurfaceFrame>): RunTrace {
  for (const frame of frames) tracer.record(frame);
  return tracer.getRun();
}
