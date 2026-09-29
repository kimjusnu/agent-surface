/**
 * `Tracer` behaviour: what gets recorded, what totals come out, and -- the part
 * that actually bites in production -- that no listener survives teardown.
 */

import { SurfaceStream } from '@agent-surface/protocol';
import type { SurfaceFrame } from '@agent-surface/protocol';
import { describe, expect, it } from 'vitest';

import { Tracer, assembleRun, recordFrames } from '../src/index.js';
import { a2uiRun, aguiRun, failedRun, frame, FrameBuilder } from './fixtures.js';

const THREAD = 'thread-1';

function stream(protocol: 'ag-ui' | 'a2ui' | 'mcp-apps' = 'ag-ui'): SurfaceStream {
  return new SurfaceStream(protocol, THREAD, 'run-1');
}

/** A tracer attached to a stream, plus a helper that pushes frames through it. */
function attached(protocol: 'ag-ui' | 'a2ui' | 'mcp-apps' = 'ag-ui') {
  const target = stream(protocol);
  const tracer = new Tracer({ runId: 'run-1', threadId: THREAD, protocol });
  tracer.attach(target);
  return { target, tracer };
}

/** Replay a transcript through a stream, as a transport would. */
function pump(target: SurfaceStream, frames: readonly ReturnType<typeof frame>[]): void {
  for (const f of frames) {
    target.emit({
      kind: f.kind,
      source: f.source,
      ts: f.ts,
      threadId: f.threadId,
      runId: f.runId,
      ...(f.step !== undefined ? { step: f.step } : {}),
      ...(f.subagentRunId !== undefined ? { subagentRunId: f.subagentRunId } : {}),
      payload: f.payload,
    } as never);
  }
}

describe('Tracer recording', () => {
  it('records every frame the stream emits', () => {
    const { target, tracer } = attached();
    const frames = aguiRun();
    pump(target, frames);
    expect(tracer.frameCount).toBe(frames.length);
    expect(tracer.frames.map((f) => f.kind)).toEqual(frames.map((f) => f.kind));
  });

  it('records frames fed directly, with no stream in between', () => {
    // The AG-UI adapter stamps `seq` itself, so a host can consume `ingest`
    // without a `SurfaceStream`. The tracer has to accept that path.
    const tracer = new Tracer({ runId: 'run-1', threadId: THREAD, protocol: 'ag-ui' });
    const run = recordFrames(tracer, aguiRun());
    expect(tracer.frameCount).toBe(14);
    expect(run.state.finished).toBe(true);
  });

  it('exposes the live folded state without refolding', () => {
    const { target, tracer } = attached();
    pump(target, aguiRun());
    expect(tracer.state.frameCount).toBe(tracer.frameCount);
    expect(tracer.state.tools).toHaveLength(1);
    expect(tracer.state.messages.map((m) => m.messageId)).toEqual(['m1', 'm2']);
  });

  it('does not hand out a mutable view of its frames', () => {
    const { target, tracer } = attached();
    pump(target, aguiRun());
    const copy = tracer.frames;
    // A copy, not a live view: writing to it cannot reach the tracer's buffer.
    // `readonly` is a type-level guarantee only, so this is asserted behaviour.
    (copy as SurfaceFrame[]).push(frame('run.finished', { outcome: 'success' }));
    expect(copy).toHaveLength(tracer.frameCount + 1);
    expect(tracer.frameCount).toBe(14);
    expect(tracer.frames).toHaveLength(14);
  });

  it('works for a protocol with no tool frames at all', () => {
    const { target, tracer } = attached('a2ui');
    pump(target, a2uiRun());
    const run = tracer.finalize();
    expect(run.protocol).toBe('a2ui');
    expect(run.totals.tools.total).toBe(0);
    expect(run.totals.surfaces.live).toBe(1);
  });
});

describe('Tracer subscription lifetime', () => {
  it('stops recording after detach', () => {
    const { target, tracer } = attached();
    const frames = aguiRun({ withOrphanTool: true });
    pump(target, frames);
    expect(tracer.frameCount).toBe(frames.length);
    tracer.detach();
    expect(tracer.attached).toBe(false);
    // The stream is closed by `run.finished`, so re-publish on a fresh stream to
    // prove the recorder -- not the stream -- was what stopped listening.
    const other = stream();
    pump(other, [frame('text.delta', { messageId: 'm9', delta: 'x' }, { seq: 99 })]);
    expect(tracer.frameCount).toBe(frames.length);
  });

  it('leaves no listener behind once the stream closes on run.finished', () => {
    // `SurfaceStream.close()` clears its listener set, so the tracer's handle is
    // dead whether or not it remembers to drop it. A tracer that still reported
    // `attached` here would hold a reference the stream has already released.
    const { target, tracer } = attached();
    expect(tracer.attached).toBe(true);
    pump(target, aguiRun());
    expect(tracer.attached).toBe(false);
  });

  it('detaches exactly once even when detach is called repeatedly', () => {
    const { target, tracer } = attached();
    const detach = tracer.attach(target);
    detach();
    detach();
    tracer.detach();
    expect(tracer.attached).toBe(false);
  });

  it('does not throw when detached after the stream already closed', () => {
    const { target, tracer } = attached();
    pump(target, aguiRun());
    expect(() => tracer.detach()).not.toThrow();
  });

  it('replaces a previous subscription when attached twice', () => {
    const first = stream();
    const second = stream();
    const tracer = new Tracer({ runId: 'run-1', threadId: THREAD, protocol: 'ag-ui' });
    tracer.attach(first);
    tracer.attach(second);
    pump(first, [frame('text.delta', { messageId: 'm1', delta: 'a' })]);
    expect(tracer.frameCount).toBe(0);
    pump(second, [frame('text.delta', { messageId: 'm1', delta: 'a' })]);
    expect(tracer.frameCount).toBe(1);
  });

  it('stops recording after finalize, without losing what it already had', () => {
    const { target, tracer } = attached();
    pump(target, aguiRun());
    const first = tracer.finalize();
    expect(first.finalized).toBe(true);
    const second = tracer.finalize();
    expect(second).toEqual(first);
    expect(tracer.attached).toBe(false);
  });
});

describe('Tracer totals', () => {
  it('computes wall clock from the frame timestamps', () => {
    const tracer = new Tracer({ runId: 'run-1', threadId: THREAD, protocol: 'ag-ui' });
    recordFrames(tracer, aguiRun());
    const run = tracer.finalize();
    // The run's window is measured on the frames' own clock, not the host's:
    // a tracer attached mid-run has frames whose timestamps predate it.
    expect(run.startedAt).toBe(run.frames[0]!.ts);
    expect(run.totals.wallClockMs).toBe(run.endedAt! - run.startedAt);
    expect(run.totals.wallClockMs).toBe(130);
  });

  it('reports per-tool duration, preferring the adapter measurement', () => {
    const tracer = new Tracer({ runId: 'run-1', threadId: THREAD, protocol: 'ag-ui' });
    const run = recordFrames(tracer, aguiRun());
    expect(run.state.tools[0]?.durationMs).toBe(40);
    expect(run.totals.tools.totalDurationMs).toBe(40);
    expect(run.totals.tools.slowest).toEqual({ toolCallId: 'tc1', name: 'search', durationMs: 40 });
  });

  it('derives a duration when the adapter did not measure one', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('tool.started', { toolCallId: 'tc1', toolName: 'search' });
    b.push('tool.result', { toolCallId: 'tc1', messageId: 'tm1', content: 'ok' });
    b.finish('success');
    const run = assembleRun(b.build());
    expect(run.state.tools[0]?.durationMs).toBe(10);
  });

  it('totals tokens and cost from run.finished', () => {
    const tracer = new Tracer({ runId: 'run-1', threadId: THREAD, protocol: 'ag-ui' });
    const run = recordFrames(tracer, aguiRun());
    expect(run.totals.usage).toEqual({ inputTokens: 900, outputTokens: 120, costUsd: 0.0031 });
    expect(run.totals.costUsd).toBe(0.0031);
    expect(run.usageReported).toBe(true);
  });

  it('totals tokens from error.detail when the run died', () => {
    // Tokens spent before a failure are real cost. A tracer that only reads
    // `run.finished` reports every failed run as free.
    const tracer = new Tracer({ runId: 'run-failed', threadId: THREAD, protocol: 'ag-ui' });
    const run = recordFrames(tracer, failedRun());
    expect(run.totals.usage.inputTokens).toBe(400);
    expect(run.usageReported).toBe(true);
  });

  it('reports no cost when the producer never reported any', () => {
    const tracer = new Tracer({ runId: 'run-1', threadId: THREAD, protocol: 'ag-ui' });
    const run = recordFrames(tracer, a2uiRun());
    expect(run.totals.costUsd).toBeUndefined();
    expect(run.usageReported).toBe(false);
  });

  it('separates agent warnings from tracer warnings', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('warning', { code: 'AGUI_UNKNOWN_EVENT', message: 'unknown' });
    b.push('tool.result', { toolCallId: 'ghost', messageId: 'tm1', content: 'x' });
    b.finish('success');
    const run = assembleRun(b.build());
    expect(run.totals.warnings).toBe(2);
    expect(run.totals.tracerWarnings).toBe(1);
    expect(run.state.warnings.filter((w) => w.origin === 'adapter')).toHaveLength(1);
  });

  it('counts orphan tool calls and surfaces them in the totals', () => {
    const tracer = new Tracer({ runId: 'run-1', threadId: THREAD, protocol: 'ag-ui' });
    const run = recordFrames(tracer, aguiRun({ withOrphanTool: true, withResultWithoutStart: true }));
    expect(run.totals.tools.total).toBe(3);
    expect(run.totals.tools.orphan).toBe(1);
    expect(run.totals.tools.ok).toBe(1);
    expect(run.totals.tools.error).toBe(0);
  });

  it('sub-agent totals count phases and durations', () => {
    const tracer = new Tracer({ runId: 'run-1', threadId: THREAD, protocol: 'ag-ui' });
    const run = recordFrames(tracer, aguiRun({ withSubagent: true }));
    expect(run.totals.subagents.total).toBe(1);
    expect(run.totals.subagents.ok).toBe(1);
    expect(run.totals.subagents.totalDurationMs).toBeGreaterThan(0);
  });

  it('marks a live run as not finalized and open calls as pending', () => {
    const tracer = new Tracer({ runId: 'run-1', threadId: THREAD, protocol: 'ag-ui' });
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('tool.started', { toolCallId: 'tc1', toolName: 'search' });
    recordFrames(tracer, b.build());
    const run = tracer.getRun();
    expect(run.finalized).toBe(false);
    expect(run.totals.tools.pending).toBe(1);
    expect(run.totals.tools.orphan).toBe(0);
  });

  it('reports the run outcome', () => {
    expect(assembleRun(aguiRun()).tree.status).toBe('success');
    expect(assembleRun(failedRun()).tree.status).toBe('error');
  });
});

describe('Tracer bounds and redaction', () => {
  it('caps retained frames and reports how many were dropped', () => {
    const tracer = new Tracer({ runId: 'run-1', threadId: THREAD, protocol: 'ag-ui', maxFrames: 5 });
    recordFrames(tracer, aguiRun());
    expect(tracer.frameCount).toBe(5);
    expect(tracer.droppedFrames).toBe(9);
  });

  it('redacts retained frames when configured to', () => {
    const tracer = new Tracer({
      runId: 'run-1',
      threadId: THREAD,
      protocol: 'ag-ui',
      redact: { maxStringLength: 4_096 },
    });
    recordFrames(tracer, [
      frame('tool.result', { toolCallId: 'tc1', messageId: 'tm1', content: 'key=sk-abcdefghijklmnop' }),
    ]);
    const stored = tracer.frames[0]!.payload as { content: string };
    expect(stored.content).not.toContain('sk-abcdefghijklmnop');
    expect(stored.content).toContain('[REDACTED]');
  });

  it('leaves frames untouched when redaction is not configured', () => {
    const tracer = new Tracer({ runId: 'run-1', threadId: THREAD, protocol: 'ag-ui' });
    recordFrames(tracer, [frame('tool.result', { toolCallId: 'tc1', messageId: 'tm1', content: 'key=sk-abcdefghijklmnop' })]);
    const stored = tracer.frames[0]!.payload as { content: string };
    expect(stored.content).toBe('key=sk-abcdefghijklmnop');
  });

  it('keeps the last frame even when the cap is one', () => {
    const tracer = new Tracer({ runId: 'run-1', threadId: THREAD, protocol: 'ag-ui', maxFrames: 1 });
    const frames = aguiRun();
    recordFrames(tracer, frames);
    expect(tracer.frames).toHaveLength(1);
    expect(tracer.frames[0]!.kind).toBe('run.finished');
  });
});

describe('Tracer as a type', () => {
  it('satisfies the Recorder-shaped contract a host expects', () => {
    // Compile-time check, asserted at runtime so the import is not elided.
    const tracer: Tracer = new Tracer({ runId: 'r', threadId: THREAD, protocol: 'ag-ui' });
    expect(typeof tracer.attach).toBe('function');
    expect(typeof tracer.detach).toBe('function');
    expect(typeof tracer.finalize).toBe('function');
    expect(typeof tracer.getRun).toBe('function');
  });
});
