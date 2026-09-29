/**
 * Shared test scaffolding.
 *
 * Two ways to build a run, on purpose: the recorded fixtures (which is what the
 * package ships and what the CLI demos on) and `frame()`-assembled synthetic
 * runs (which is the only practical way to assert on one malformed frame in
 * isolation).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type {
  FrameKind,
  FramePayloadMap,
  JsonObject,
  ProtocolId,
  SurfaceFrame,
  SurfaceNode,
} from '@agent-surface/protocol';

import { normalizeRun, type EvalRunInput, type NormalizedRun, type NormalizeLimits } from '../src/trace-input.js';

export const T0 = 1_767_225_600_000;

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../src/fixtures/${name}.json`, import.meta.url));
}

export function suiteFixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

export function loadFixture(name: string): EvalRunInput {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as EvalRunInput;
}

/** All three bundled fixtures, in a stable order. */
export function allFixtures(): EvalRunInput[] {
  return [loadFixture('happy-path'), loadFixture('tool-error-and-slow'), loadFixture('interrupt-and-overflow')];
}

export interface FrameOptions {
  dt?: number;
  seq?: number;
  ts?: number;
  step?: number;
  subagentRunId?: string;
  runId?: string;
  threadId?: string;
  source?: ProtocolId;
  /** Drop `payload` entirely, to exercise the malformed-frame path. */
  omitPayload?: boolean;
}

export function frame<K extends FrameKind>(
  kind: K,
  payload: FramePayloadMap[K],
  options: FrameOptions = {},
): SurfaceFrame {
  const partial: Record<string, unknown> = {
    seq: options.seq ?? 0,
    kind,
    source: options.source ?? 'ag-ui',
    ts: options.ts ?? T0 + (options.dt ?? 0),
    threadId: options.threadId ?? 'thread_test',
    runId: options.runId ?? 'run_test',
  };
  if (options.step !== undefined) partial['step'] = options.step;
  if (options.subagentRunId !== undefined) partial['subagentRunId'] = options.subagentRunId;
  if (!options.omitPayload) partial['payload'] = payload;
  return partial as unknown as SurfaceFrame;
}

export interface RunOptions {
  runId?: string;
  threadId?: string;
  protocol?: ProtocolId;
  scenario?: string;
  startTs?: number;
  /** Defaults to 1ms apart, so a 3-frame run is 2ms of wall clock. */
  stepMs?: number;
}

export function run(frames: readonly SurfaceFrame[], options: RunOptions = {}): EvalRunInput {
  const runId = options.runId ?? 'run_test';
  const protocol = options.protocol ?? 'ag-ui';
  const step = options.stepMs ?? 1;
  const start = options.startTs ?? T0;
  const normalized = frames.map((entry, index) => {
    const clone = { ...entry } as unknown as Record<string, unknown>;
    clone['seq'] = index;
    clone['runId'] = runId;
    clone['threadId'] = options.threadId ?? 'thread_test';
    clone['source'] = protocol;
    if (typeof clone['ts'] !== 'number') clone['ts'] = start + index * step;
    return clone as unknown as SurfaceFrame;
  });
  return {
    runId,
    threadId: options.threadId ?? 'thread_test',
    protocol,
    ...(options.scenario !== undefined ? { scenario: options.scenario } : {}),
    frames: normalized,
  };
}

export function normalize(frames: readonly SurfaceFrame[], options: RunOptions & { limits?: Partial<NormalizeLimits> } = {}): NormalizedRun {
  return normalizeRun(run(frames, options), options.limits);
}

export function literal(value: JsonObject[string]): { kind: 'literal'; value: JsonObject[string] } {
  return { kind: 'literal', value };
}

export function dataRef(pointer: string): { kind: 'data'; ref: { pointer: string } } {
  return { kind: 'data', ref: { pointer } };
}

export function template(text: string): { kind: 'template'; template: string } {
  return { kind: 'template', template: text };
}

export function node(component: string, extra: Partial<SurfaceNode> = {}): SurfaceNode {
  return { component, ...extra };
}
