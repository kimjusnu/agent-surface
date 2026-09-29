/**
 * Time-travel replay.
 *
 * The whole point of this file is one line of contract:
 *
 * ```
 * replay.seek(n) deep-equals reduce(frames.slice(0, n + 1))
 * ```
 *
 * It holds because `seek` *is* that fold -- not an approximation of it, and not a
 * second folding implementation that happens to agree today. `replay.test.ts`
 * asserts the equality frame by frame over a full transcript, because a scrubber
 * that disagrees with the live view is worse than no scrubber: it lets an
 * engineer conclude a UI bug was an agent bug.
 *
 * `seek` is therefore O(n) in the frames replayed. That is deliberate: the
 * alternative, a persistent data structure with structural sharing, is real work
 * and the transcript is short (thousands of frames, not millions). Callers that
 * scrub continuously should hold the last state and step from it, which is what
 * `step`/`back` do.
 */

import type { FrameKind, SurfaceFrame } from '@agent-surface/protocol';

import { applyFrame, emptyRunState, type RunState, type RunStateMeta } from './reducer.js';

export interface FrameSummary {
  seq: number;
  kind: FrameKind;
  ts: number;
  /** Milliseconds since the previous frame; the scrubber's bar width. */
  deltaMs: number;
  /** Short label for a timeline tick, without the payload. */
  label: string;
  step?: number;
  subagentRunId?: string;
  /** True when the frame will add a tracer-invented warning. */
  warns?: boolean;
  isError?: boolean;
}

export interface ReplayOptions extends Partial<RunStateMeta> {}

export interface Replay {
  readonly frames: readonly SurfaceFrame[];
  /** Frames applied through the cursor, inclusive. `-1` before the first step. */
  readonly cursor: number;
  /** State with frames `0..seq` applied. */
  seek(seq: number): RunState;
  /** Advance one frame and return the new state. */
  step(): RunState;
  /** Rewind one frame. `back()` at `-1` is the empty state, not an error. */
  back(): RunState;
  /** Replay the whole transcript. */
  reset(): RunState;
  /** Advance to the end and return the final state. */
  end(): RunState;
  /** One row per frame, for a scrubber or a minimap. */
  timeline(): readonly FrameSummary[];
}

export function createReplay(frames: readonly SurfaceFrame[], options: ReplayOptions = {}): Replay {
  // The transcript is sorted once, by `seq`, so a caller that hands over frames
  // in arrival order still replays in the order the stream numbered them. Stable
  // tie-breaking on arrival index keeps duplicate seqs (a defect the reducer
  // warns about) in the order they were seen rather than at random.
  const ordered = frames
    .map((frame, index) => ({ frame, index }))
    .sort((a, b) => (a.frame.seq === b.frame.seq ? a.index - b.index : a.frame.seq - b.frame.seq))
    .map((entry) => entry.frame);

  const base = emptyRunState({
    runId: options.runId ?? ordered[0]?.runId ?? 'unknown-run',
    threadId: options.threadId ?? ordered[0]?.threadId ?? 'unknown-thread',
    protocol: options.protocol ?? ordered[0]?.source ?? 'ag-ui',
    ...(options.agentName !== undefined ? { agentName: options.agentName } : {}),
  });

  let cursor = -1;
  let state = base;

  const seek = (seq: number): RunState => {
    const target = Math.max(-1, Math.min(ordered.length - 1, Math.trunc(seq)));
    // Rewinding refolds from the empty state; stepping forward continues from
    // here. Both directions go through `applyFrame`, so there is no second path.
    let next = target < cursor ? base : state;
    for (let i = cursor + 1; i <= target; i += 1) {
      next = applyFrame(next, ordered[i]!);
    }
    cursor = target;
    state = next;
    return next;
  };

  return {
    frames: ordered,
    get cursor(): number {
      return cursor;
    },
    seek,
    step: (): RunState => seek(cursor + 1),
    back: (): RunState => seek(cursor - 1),
    reset: (): RunState => seek(-1),
    end: (): RunState => seek(ordered.length - 1),
    timeline: (): readonly FrameSummary[] => summarize(ordered),
  };
}

/** Replay built from an already-reduced trace, for a trace read off disk. */
export function replayOf(run: { frames: readonly SurfaceFrame[] }, options: ReplayOptions = {}): Replay {
  return createReplay(run.frames, {
    runId: options.runId ?? run.frames[0]?.runId,
    threadId: options.threadId ?? run.frames[0]?.threadId,
    protocol: options.protocol ?? run.frames[0]?.source,
    ...(options.agentName !== undefined ? { agentName: options.agentName } : {}),
  });
}

/**
 * A timeline row per frame.
 *
 * `label` is derived from the payload rather than left as prose so a scrubber
 * does not have to re-implement payload narrowing to label a tick, and so a
 * label is never mistaken for agent-supplied text.
 */
export function summarize(frames: readonly SurfaceFrame[]): readonly FrameSummary[] {
  let previousTs: number | undefined;
  return frames.map((frame) => {
    const deltaMs = previousTs === undefined ? 0 : Math.max(0, frame.ts - previousTs);
    previousTs = frame.ts;
    const summary: FrameSummary = {
      seq: frame.seq,
      kind: frame.kind,
      ts: frame.ts,
      deltaMs,
      label: labelOf(frame),
      ...(frame.step !== undefined ? { step: frame.step } : {}),
      ...(frame.subagentRunId !== undefined ? { subagentRunId: frame.subagentRunId } : {}),
      ...(frame.kind === 'warning' ? { warns: true } : {}),
      ...(frame.kind === 'error' ? { isError: true } : {}),
    };
    return summary;
  });
}

function labelOf(frame: SurfaceFrame): string {
  const payload = frame.payload as Record<string, unknown> | undefined;
  const pick = (key: string): string | undefined => {
    const value = payload?.[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  switch (frame.kind) {
    case 'tool.started':
      return pick('toolName') ?? 'tool call';
    case 'tool.args.done':
      return pick('toolCallId') ?? 'arguments';
    case 'tool.args.delta':
      return `${pick('toolCallId') ?? 'tool call'} args`;
    case 'tool.result':
      return pick('toolCallId') ?? 'result';
    case 'text.delta':
      return pick('messageId') ?? 'text';
    case 'text.done':
      return pick('messageId') ?? 'message';
    case 'surface.created':
    case 'surface.nodes':
    case 'surface.data':
    case 'surface.deleted':
      return pick('surfaceId') ?? frame.kind;
    case 'app.attached':
      return 'mcp app';
    case 'subagent':
      return `${pick('name') ?? 'sub-agent'} ${pick('phase') ?? ''}`.trim();
    case 'warning':
    case 'error':
      return pick('code') ?? frame.kind;
    case 'run.started':
      return pick('agentName') ?? 'run started';
    default:
      return frame.kind;
  }
}
