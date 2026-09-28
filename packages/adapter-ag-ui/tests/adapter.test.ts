/**
 * The adapter's job is to be boring about hostile input. These tests therefore
 * assert two things for every case: the frames that came out, and the absence of
 * an exception. A test that only checked the happy path would not have caught
 * the empty-argument and unterminated-end cases, which is where a stream
 * actually dies in production.
 */

import { EventType } from '@ag-ui/core';
import type { RunAgentInput } from '@ag-ui/core';
import { HttpAgent, enforceOutgoingInput } from '@ag-ui/client';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  AGUI_STATE_SURFACE_ID,
  AgUiAdapter,
  EVENT_FRAME_MAP,
  SseParser,
  UNKNOWN_EVENT_CODE,
  aggregateUsage,
  decodeSse,
  framesFor,
  isJsonValue,
} from '../src/index.js';
import type { AgUiAdapterOptions, DraftPatchOperation } from '../src/index.js';
import type { AdapterInput, FrameKind, SurfaceFrame } from '@agent-surface/protocol';

const THREAD = 'thread-1';
const RUN = 'run-1';

/** A monotonic fake clock, so `ts` and `durationMs` are assertable. */
function makeClock(start = 1_000_000, step = 10): () => number {
  let value = start;
  return () => {
    const current = value;
    value += step;
    return current;
  };
}

function newAdapter(options: AgUiAdapterOptions = {}): AgUiAdapter {
  return new AgUiAdapter({ threadId: THREAD, runId: RUN, now: makeClock(), ...options });
}

function input(raw: unknown, overrides: Partial<AdapterInput> = {}): AdapterInput {
  return { threadId: THREAD, runId: RUN, raw, ...overrides };
}

function kinds(frames: readonly SurfaceFrame[]): FrameKind[] {
  return frames.map((f) => f.kind);
}

interface WarningPayload {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

/**
 * The `warning` payload, viewed as one shape. The IR narrows payloads by frame
 * kind, so a test asserting on a warning has to pick one of the seventeen
 * variants; going through `unknown` is the honest way to say which one it means.
 */
function warning(frame: SurfaceFrame | undefined): WarningPayload {
  return frame?.payload as unknown as WarningPayload;
}

/**
 * Build JSON Patch operations for a `StatePatch`. Routed through a function
 * because the IR's operation union omits `value` on `add`/`replace`, which RFC
 * 6902 requires, and TypeScript rejects the extra member on a fresh literal.
 */
function ops(...list: DraftPatchOperation[]): DraftPatchOperation[] {
  return list;
}

/** Ingest a whole array of events as one batch, the way a batching transport would. */
function ingestAll(adapter: AgUiAdapter, events: readonly unknown[]): SurfaceFrame[] {
  return [...adapter.ingest(input(events))];
}

const T = EventType;

describe('AgUiAdapter identity and capabilities', () => {
  it('identifies itself as the ag-ui protocol', () => {
    const adapter = newAdapter();
    expect(adapter.id).toBe('ag-ui');
    expect(adapter.supportedVersions).toEqual(['1.0']);
  });

  it('advertises a capability object that is a valid RunAgentInput', () => {
    const caps = newAdapter({ tools: [{ name: 't', description: 'd' }] }).getClientCapabilities();
    expect(caps['threadId']).toBe(THREAD);
    expect(caps['runId']).toBe(RUN);
    expect(caps['protocolVersion']).toBe('1.0');
    expect(caps['messages']).toEqual([]);
    expect(caps['tools']).toEqual([{ name: 't', description: 'd' }]);
    expect(caps['context']).toEqual([]);
    expect(caps['state']).toEqual({});
    // Every value has to survive a real JSON round trip to be POSTable.
    expect(JSON.parse(JSON.stringify(caps))).toEqual(caps);
  });

  it('puts capability declarations in forwardedProps, where RunAgentInput allows them', () => {
    const caps = newAdapter({ hostName: 'probe', agentName: 'assistant' }).getClientCapabilities();
    const forwarded = caps['forwardedProps'] as Record<string, unknown>;
    const capabilities = forwarded['capabilities'] as Record<string, unknown>;
    expect(forwarded['host']).toBe('probe');
    expect(forwarded['irVersion']).toBe('0.1');
    expect((capabilities['identity'] as Record<string, unknown>)['name']).toBe('assistant');
    expect(capabilities['tools']).toMatchObject({ supported: true, clientProvided: true });
    expect(capabilities['state']).toMatchObject({ snapshots: true, deltas: true, persistentState: true });
  });

  it('inlines the tool catalogue only when asked', () => {
    const adapter = newAdapter({ tools: [{ name: 'search', description: 'find' }] });
    const bare = adapter.getClientCapabilities()['forwardedProps'] as Record<string, unknown>;
    const inlined = adapter.getClientCapabilities({ includeInlineCatalogs: true })['forwardedProps'] as Record<string, unknown>;
    expect((bare['capabilities'] as Record<string, unknown>)['tools']).not.toHaveProperty('items');
    expect((inlined['capabilities'] as Record<string, unknown>)['tools']).toHaveProperty('items');
  });
});

describe('AgUiAdapter run lifecycle', () => {
  it('emits run.started and stamps gap-free sequence numbers', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.RUN_STARTED, threadId: THREAD, runId: RUN },
      { type: T.TEXT_MESSAGE_START, messageId: 'm1' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'hi' },
      { type: T.TEXT_MESSAGE_END, messageId: 'm1' },
    ]);
    expect(kinds(frames)).toEqual(['run.started', 'text.delta', 'text.done']);
    expect(frames.map((f) => f.seq)).toEqual([0, 1, 2]);
    expect(frames.every((f) => f.source === 'ag-ui')).toBe(true);
    expect(frames[0]?.threadId).toBe(THREAD);
  });

  it('echoes the RunAgentInput and the negotiated capabilities on run.started', () => {
    const [frame] = ingestAll(newAdapter({ agentName: 'planner' }), [
      { type: T.RUN_STARTED, threadId: THREAD, runId: RUN, input: { threadId: THREAD, runId: RUN, messages: [], tools: [], context: [] } },
    ]);
    const payload = frame?.payload as { agentName: string; input?: { runId: string }; capabilities?: unknown };
    expect(payload.agentName).toBe('planner');
    expect(payload.input).toMatchObject({ runId: RUN });
    expect(payload.capabilities).toMatchObject({ threadId: THREAD });
  });

  it('warns when the agent declares a protocol version this host does not speak', () => {
    const frames = ingestAll(newAdapter(), [{ type: T.RUN_STARTED, threadId: THREAD, runId: RUN, protocolVersion: '0.9' }]);
    expect(kinds(frames)).toEqual(['warning', 'run.started']);
    expect((frames[0]?.payload as { code: string }).code).toBe('AGUI_VERSION_UNSUPPORTED');
  });

  it('adopts the ids the agent declares and resets the run', () => {
    const adapter = newAdapter();
    ingestAll(adapter, [
      { type: T.RUN_STARTED, threadId: THREAD, runId: RUN },
      { type: T.TOOL_CALL_START, toolCallId: 'c1', toolCallName: 'search' },
      { type: T.TOOL_CALL_END, toolCallId: 'c1' },
    ]);
    expect(adapter.stateFor(THREAD).toolCalls.size).toBe(0);

    const second = ingestAll(adapter, [{ type: T.RUN_STARTED, threadId: THREAD, runId: 'run-2' }]);
    expect(second[0]?.seq).toBe(0);
    expect(second[0]?.runId).toBe('run-2');
    expect(adapter.stateFor(THREAD).toolCalls.size).toBe(0);
  });

  it('reads the run outcome, defaulting an absent one to success', () => {
    expect(kinds(ingestAll(newAdapter(), [{ type: T.RUN_FINISHED, threadId: THREAD, runId: RUN }]))).toEqual(['run.finished']);
    const [finished] = ingestAll(newAdapter(), [{ type: T.RUN_FINISHED, threadId: THREAD, runId: RUN, outcome: { type: 'cancelled' } }]);
    expect(finished?.payload).toMatchObject({ outcome: 'cancelled' });
  });

  it('warns before the terminal frame when the outcome is unrecognised', () => {
    const frames = ingestAll(newAdapter(), [{ type: T.RUN_FINISHED, threadId: THREAD, runId: RUN, outcome: { type: 'weird' } }]);
    expect(kinds(frames)).toEqual(['warning', 'run.finished']);
    expect((frames[0]?.payload as { code: string }).code).toBe('AGUI_RUN_OUTCOME_UNKNOWN');
    expect(frames[1]?.payload).toMatchObject({ outcome: 'success' });
  });

  it('emits one interrupt frame per pending interrupt before run.finished', () => {
    const frames = ingestAll(newAdapter(), [
      {
        type: T.RUN_FINISHED,
        threadId: THREAD,
        runId: RUN,
        outcome: {
          type: 'interrupt',
          interrupts: [
            { id: 'int-1', reason: 'needs_approval', message: 'Approve the send?' },
            { id: 'int-2', reason: 'needs_value' },
          ],
        },
      },
    ]);
    expect(kinds(frames)).toEqual(['interrupt', 'interrupt', 'run.finished']);
    expect(frames[0]?.payload).toEqual({ reason: 'needs_approval', resumeToken: 'int-1', resumable: true });
    expect(frames[1]?.payload).toEqual({ reason: 'needs_value', resumeToken: 'int-2', resumable: true });
  });

  it('marks an interrupt unresumable once its expiry has passed', () => {
    const adapter = newAdapter({ now: () => Date.parse('2026-01-02T00:00:00Z') });
    const [frame] = ingestAll(adapter, [
      {
        type: T.RUN_FINISHED,
        threadId: THREAD,
        runId: RUN,
        outcome: { type: 'interrupt', interrupts: [{ id: 'i', reason: 'r', expiresAt: '2026-01-01T00:00:00Z' }] },
      },
    ]);
    expect((frame?.payload as { resumable: boolean }).resumable).toBe(false);
  });

  it('maps RUN_ERROR to a fatal error frame and keeps the pre-failure usage', () => {
    const [frame] = ingestAll(newAdapter(), [
      { type: T.RUN_ERROR, message: 'model refused', code: 'rate_limited', usage: [{ inputTokens: 10, outputTokens: 2 }] },
    ]);
    expect(frame?.kind).toBe('error');
    expect(frame?.payload).toMatchObject({ code: 'rate_limited', message: 'model refused', fatal: true });
    expect((frame?.payload as { detail: Record<string, unknown> }).detail).toMatchObject({
      agentCode: 'rate_limited',
      usage: [{ inputTokens: 10, outputTokens: 2 }],
    });
  });

  it('falls back to a default error code when the agent sends none', () => {
    const [frame] = ingestAll(newAdapter(), [{ type: T.RUN_ERROR, message: 'boom' }]);
    expect((frame?.payload as { code: string }).code).toBe('AGUI_RUN_ERROR');
  });
});

describe('AgUiAdapter usage aggregation', () => {
  it('sums per-provider entries into one Usage record', () => {
    const [frame] = ingestAll(newAdapter(), [
      {
        type: T.RUN_FINISHED,
        threadId: THREAD,
        runId: RUN,
        usage: [
          { provider: 'openai', inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningTokens: 5 },
          { provider: 'anthropic', inputTokens: 7, outputTokens: 3, cacheWriteInputTokens: 9, totalTokens: 10 },
        ],
      },
    ]);
    expect((frame?.payload as { usage?: unknown }).usage).toEqual({
      inputTokens: 107,
      outputTokens: 23,
      cachedInputTokens: 40,
      reasoningTokens: 5,
    });
  });

  it('omits usage entirely when the agent reported none', () => {
    const [frame] = ingestAll(newAdapter(), [{ type: T.RUN_FINISHED, threadId: THREAD, runId: RUN }]);
    expect(frame?.payload).not.toHaveProperty('usage');
  });

  it('aggregateUsage keeps not-reported distinct from zero', () => {
    expect(aggregateUsage(undefined)).toBeUndefined();
    expect(aggregateUsage([])).toBeUndefined();
    expect(aggregateUsage([{ provider: 'x' }])).toBeUndefined();
    expect(aggregateUsage([{ inputTokens: 0, outputTokens: 0 }])).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('AgUiAdapter text streaming', () => {
  it('buffers fragments and publishes the assembled text on END', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'Hel' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'lo ' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'world' },
      { type: T.TEXT_MESSAGE_END, messageId: 'm1' },
    ]);
    expect(kinds(frames)).toEqual(['text.delta', 'text.delta', 'text.delta', 'text.done']);
    expect(frames[3]?.payload).toEqual({ messageId: 'm1', text: 'Hello world' });
  });

  it('publishes empty text for an empty message rather than dropping the frame', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.TEXT_MESSAGE_START, messageId: 'm1' },
      { type: T.TEXT_MESSAGE_END, messageId: 'm1' },
    ]);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload).toEqual({ messageId: 'm1', text: '' });
  });

  it('warns when END arrives for a message it never saw start', () => {
    const frames = ingestAll(newAdapter(), [{ type: T.TEXT_MESSAGE_END, messageId: 'ghost' }]);
    expect(kinds(frames)).toEqual(['warning', 'text.done']);
    expect((frames[0]?.payload as { code: string }).code).toBe('AGUI_MESSAGE_END_WITHOUT_START');
    expect(frames[1]?.payload).toEqual({ messageId: 'ghost', text: '' });
  });

  it('keeps two interleaved messages apart', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.TEXT_MESSAGE_START, messageId: 'a' },
      { type: T.TEXT_MESSAGE_START, messageId: 'b' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'a', delta: 'A' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'b', delta: 'B' },
      { type: T.TEXT_MESSAGE_END, messageId: 'a' },
      { type: T.TEXT_MESSAGE_END, messageId: 'b' },
    ]);
    expect(frames.at(-2)?.payload).toEqual({ messageId: 'a', text: 'A' });
    expect(frames.at(-1)?.payload).toEqual({ messageId: 'b', text: 'B' });
  });

  it('expands a chunk into delta and done', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.TEXT_MESSAGE_START, messageId: 'c1' },
      { type: T.TEXT_MESSAGE_CHUNK, messageId: 'c1', delta: 'chunky', role: 'assistant' },
      { type: T.TEXT_MESSAGE_END, messageId: 'c1' },
    ]);
    expect(kinds(frames)).toEqual(['text.delta', 'text.done']);
    expect(frames[1]?.payload).toEqual({ messageId: 'c1', text: 'chunky' });
  });

  it('opens a message on the first chunk and closes it at the run boundary', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.TEXT_MESSAGE_CHUNK, messageId: 'c1', delta: 'one ' },
      { type: T.TEXT_MESSAGE_CHUNK, delta: 'two' },
      { type: T.RUN_FINISHED, threadId: THREAD, runId: RUN },
    ]);
    expect(kinds(frames)).toEqual(['text.delta', 'text.delta', 'text.done', 'run.finished']);
    expect(frames[2]?.payload).toEqual({ messageId: 'c1', text: 'one two' });
  });

  it('lets a chunk with no id continue the open message', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.TEXT_MESSAGE_START, messageId: 'c1' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'c1', delta: 'one ' },
      { type: T.TEXT_MESSAGE_CHUNK, delta: 'two' },
      { type: T.TEXT_MESSAGE_END, messageId: 'c1' },
    ]);
    expect(frames.at(-1)?.payload).toEqual({ messageId: 'c1', text: 'one two' });
  });

  it('omits the delta frame for a chunk that carried no delta', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.TEXT_MESSAGE_CHUNK, messageId: 'c1' },
      { type: T.TEXT_MESSAGE_END, messageId: 'c1' },
    ]);
    expect(kinds(frames)).toEqual(['text.done']);
  });

  it('publishes the older buffer when one message id is reopened', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.TEXT_MESSAGE_START, messageId: 'm1' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'first' },
      { type: T.TEXT_MESSAGE_START, messageId: 'm1' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'second' },
      { type: T.TEXT_MESSAGE_END, messageId: 'm1' },
    ]);
    expect(kinds(frames)).toEqual(['text.delta', 'warning', 'text.done', 'text.delta', 'text.done']);
    expect((frames[1]?.payload as { code: string }).code).toBe('AGUI_MESSAGE_REOPENED');
    expect(frames[2]?.payload).toEqual({ messageId: 'm1', text: 'first' });
    expect(frames[4]?.payload).toEqual({ messageId: 'm1', text: 'second' });
  });

  it('recovers a message whose START it never saw', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'mid', delta: 'half ' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'mid', delta: 'a message' },
      { type: T.TEXT_MESSAGE_END, messageId: 'mid' },
    ]);
    expect(kinds(frames)).toEqual(['text.delta', 'text.delta', 'text.done']);
    expect(frames[2]?.payload).toEqual({ messageId: 'mid', text: 'half a message' });
  });

  it('warns instead of throwing when a chunk cannot be placed', () => {
    const frames = ingestAll(newAdapter(), [{ type: T.TEXT_MESSAGE_CHUNK, delta: 'orphan' }]);
    expect(kinds(frames)).toEqual(['warning']);
    expect((frames[0]?.payload as { code: string }).code).toBe('AGUI_CHUNK_WITHOUT_OPEN_MESSAGE');
  });
});

describe('AgUiAdapter tool call streaming', () => {
  it('reassembles arguments split across many events', () => {
    const json = '{"query":"weather in Seoul","limit":5,"nested":{"deep":[1,2,3]}}';
    const events: unknown[] = [{ type: T.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'search', parentMessageId: 'm1' }];
    for (let i = 0; i < json.length; i += 7) {
      events.push({ type: T.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: json.slice(i, i + 7) });
    }
    events.push({ type: T.TOOL_CALL_END, toolCallId: 'tc1' });

    const frames = ingestAll(newAdapter(), events);
    expect(frames[0]?.kind).toBe('tool.started');
    expect(frames[0]?.payload).toEqual({ toolCallId: 'tc1', toolName: 'search', parentMessageId: 'm1' });
    const deltas = frames.filter((f) => f.kind === 'tool.args.delta');
    expect(deltas).toHaveLength(Math.ceil(json.length / 7));
    expect(deltas.map((f) => (f.payload as { delta: string }).delta).join('')).toBe(json);
    expect(frames.at(-1)?.payload).toEqual({ toolCallId: 'tc1', args: { query: 'weather in Seoul', limit: 5, nested: { deep: [1, 2, 3] } } });
  });

  it('reports a parse failure on the frame instead of throwing', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'search' },
      { type: T.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{"query":' },
      { type: T.TOOL_CALL_END, toolCallId: 'tc1' },
    ]);
    const done = frames.at(-1);
    expect(done?.kind).toBe('tool.args.done');
    const payload = done?.payload as { args: unknown; parseError?: string };
    expect(payload.args).toEqual({});
    expect(payload.parseError).toBeTypeOf('string');
    expect(payload.parseError?.length).toBeGreaterThan(0);
  });

  it('treats a zero-argument call as empty, not as a parse error', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'now' },
      { type: T.TOOL_CALL_END, toolCallId: 'tc1' },
    ]);
    expect(frames.at(-1)?.payload).toEqual({ toolCallId: 'tc1', args: {} });
  });

  it('refuses to invent an object when the arguments parse to something else', () => {
    for (const [text, shape] of [['[1,2]', 'an array'], ['"just a string"', 'string'], ['42', 'number'], ['null', 'object']] as const) {
      const frames = ingestAll(newAdapter(), [
        { type: T.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'f' },
        { type: T.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: text },
        { type: T.TOOL_CALL_END, toolCallId: 'tc1' },
      ]);
      const payload = frames.at(-1)?.payload as { args: unknown; parseError?: string };
      expect(payload.args).toEqual({});
      expect(payload.parseError).toContain(shape);
    }
  });

  it('warns and still closes when a call ends that never started', () => {
    const frames = ingestAll(newAdapter(), [{ type: T.TOOL_CALL_END, toolCallId: 'ghost' }]);
    expect(kinds(frames)).toEqual(['warning', 'tool.args.done']);
    expect(frames[1]?.payload).toMatchObject({ toolCallId: 'ghost', args: {} });
  });

  it('opens a call on the first chunk and parses args at the close', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.TOOL_CALL_CHUNK, toolCallId: 'tc1', toolCallName: 'search', delta: '{"q":' },
      { type: T.TOOL_CALL_CHUNK, toolCallId: 'tc1', delta: '"a"}' },
      { type: T.TOOL_CALL_END, toolCallId: 'tc1' },
    ]);
    expect(kinds(frames)).toEqual(['tool.started', 'tool.args.delta', 'tool.args.delta', 'tool.args.done']);
    expect(frames.at(-1)?.payload).toEqual({ toolCallId: 'tc1', args: { q: 'a' } });
  });

  it('closes a chunked call at the run boundary when the agent sends no END', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.TOOL_CALL_CHUNK, toolCallId: 'tc1', toolCallName: 'search', delta: '{"q":"a"}' },
      { type: T.RUN_FINISHED, threadId: THREAD, runId: RUN },
    ]);
    expect(kinds(frames)).toEqual(['tool.started', 'tool.args.delta', 'tool.args.done', 'run.finished']);
    expect(frames[2]?.payload).toEqual({ toolCallId: 'tc1', args: { q: 'a' } });
  });

  it('warns instead of throwing when a tool chunk cannot be placed', () => {
    const frames = ingestAll(newAdapter(), [{ type: T.TOOL_CALL_CHUNK, delta: '{}' }]);
    expect(kinds(frames)).toEqual(['warning']);
    expect((frames[0]?.payload as { code: string }).code).toBe('AGUI_CHUNK_WITHOUT_OPEN_TOOL_CALL');
  });

  it('flushes an unfinished call on a fatal run error', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'search' },
      { type: T.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{"q":' },
      { type: T.RUN_ERROR, message: 'died mid-call' },
    ]);
    expect(kinds(frames)).toEqual(['tool.started', 'tool.args.delta', 'tool.args.done', 'error']);
    expect(frames[2]?.payload).toMatchObject({ toolCallId: 'tc1', args: {} });
    expect((frames[2]?.payload as { parseError?: string }).parseError).toBeTypeOf('string');
  });

  it('warns rather than closing when a previous run left a stream open', () => {
    const adapter = newAdapter();
    ingestAll(adapter, [
      { type: T.RUN_STARTED, threadId: THREAD, runId: RUN },
      { type: T.TEXT_MESSAGE_START, messageId: 'm1' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'unfinished' },
    ]);
    const frames = ingestAll(adapter, [{ type: T.RUN_STARTED, threadId: THREAD, runId: 'run-2' }]);
    expect(kinds(frames)).toEqual(['warning', 'run.started']);
    expect(warning(frames[0]).code).toBe('AGUI_RUN_LEFT_STREAMS_OPEN');
    expect(warning(frames[0]).detail?.['messageIds']).toEqual(['m1']);
    expect(frames[0]?.seq).toBe(0);
    expect(frames[1]?.seq).toBe(1);
  });
});

describe('AgUiAdapter tool results', () => {
  it('maps a result and measures how long the call took', () => {
    const adapter = newAdapter({ now: makeClock(1_000, 250) });
    const frames = ingestAll(adapter, [
      { type: T.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'search' },
      { type: T.TOOL_CALL_END, toolCallId: 'tc1' },
      { type: T.TOOL_CALL_RESULT, messageId: 'tm1', toolCallId: 'tc1', content: 'sunny' },
    ]);
    const result = frames.at(-1);
    expect(result?.kind).toBe('tool.result');
    expect(result?.payload).toMatchObject({ toolCallId: 'tc1', messageId: 'tm1', content: 'sunny' });
    expect((result?.payload as { durationMs: number }).durationMs).toBeGreaterThan(0);
  });

  it('does not claim isError when no tool message for the call is known', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'search' },
      { type: T.TOOL_CALL_END, toolCallId: 'tc1' },
      { type: T.TOOL_CALL_RESULT, messageId: 'tm1', toolCallId: 'tc1', content: 'ok' },
    ]);
    expect(frames.at(-1)?.payload).not.toHaveProperty('isError');
  });

  it('derives isError from the tool message echoed back in RunAgentInput', () => {
    const frames = ingestAll(newAdapter(), [
      {
        type: T.RUN_STARTED,
        threadId: THREAD,
        runId: RUN,
        input: {
          threadId: THREAD,
          runId: RUN,
          messages: [{ id: 'tm0', role: 'tool', toolCallId: 'tc0', content: 'quota exceeded', error: 'QUOTA' }],
          tools: [],
          context: [],
        },
      },
      { type: T.TOOL_CALL_START, toolCallId: 'tc0', toolCallName: 'search' },
      { type: T.TOOL_CALL_END, toolCallId: 'tc0' },
      { type: T.TOOL_CALL_RESULT, messageId: 'tm1', toolCallId: 'tc0', content: 'quota exceeded' },
    ]);
    expect(frames.at(-1)?.payload).toMatchObject({ isError: true });
  });

  it('flattens media content to text and leaves the parts on raw', () => {
    const content = [
      { type: 'text', text: 'before ' },
      { type: 'text', text: 'after' },
    ];
    const frames = ingestAll(newAdapter(), [
      { type: T.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'render' },
      { type: T.TOOL_CALL_END, toolCallId: 'tc1' },
      { type: T.TOOL_CALL_RESULT, messageId: 'tm1', toolCallId: 'tc1', content },
    ]);
    expect((frames.at(-1)?.payload as { content: string }).content).toBe('before after');
    expect((frames.at(-1)?.raw as { content: unknown }).content).toEqual(content);
  });
});

describe('AgUiAdapter state events', () => {
  it('publishes a snapshot as a merge write against the reserved pseudo-surface', () => {
    const adapter = newAdapter();
    const frames = ingestAll(adapter, [
      { type: T.RUN_STARTED, threadId: THREAD, runId: RUN },
      { type: T.STATE_SNAPSHOT, snapshot: { todos: [{ id: 1, done: false }] } },
    ]);
    const snapshot = frames.at(-1);
    expect(snapshot?.kind).toBe('surface.data');
    expect(snapshot?.payload).toEqual({
      surfaceId: AGUI_STATE_SURFACE_ID,
      path: '',
      value: { todos: [{ id: 1, done: false }] },
      mode: 'merge',
    });
    expect(adapter.stateFor(THREAD).document).toEqual({ todos: [{ id: 1, done: false }] });
  });

  it('keeps the raw snapshot alongside the frame', () => {
    const [frame] = ingestAll(newAdapter(), [{ type: T.STATE_SNAPSHOT, snapshot: { a: 1 } }]);
    expect(frame?.raw).toEqual({ type: T.STATE_SNAPSHOT, snapshot: { a: 1 } });
  });

  it('forwards a delta for the host to apply and mirrors it internally', () => {
    const adapter = newAdapter();
    const frames = ingestAll(adapter, [
      { type: T.STATE_SNAPSHOT, snapshot: { count: 1, nested: { keep: true } } },
      { type: T.STATE_DELTA, delta: [{ op: 'replace', path: '/count', value: 2 }, { op: 'add', path: '/nested/extra', value: 'x' }] },
    ]);
    const delta = frames.at(-1);
    expect(delta?.kind).toBe('warning');
    const payload = warning(delta);
    expect(payload.code).toBe('AGUI_STATE_DELTA_PASSTHROUGH');
    expect(payload.detail?.['patch']).toEqual([
      { op: 'replace', path: '/count', value: 2 },
      { op: 'add', path: '/nested/extra', value: 'x' },
    ]);
    expect(payload.detail?.['applied']).toBe(2);
    expect(adapter.stateFor(THREAD).document).toEqual({ count: 2, nested: { keep: true, extra: 'x' } });
  });

  it('asks for a resync when a delta does not apply', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.STATE_DELTA, delta: [{ op: 'replace', path: '/missing', value: 1 }] },
    ]);
    const detail = warning(frames[0]).detail as { resyncRequired?: boolean; error?: { code: string } };
    expect(detail.resyncRequired).toBe(true);
    expect(detail.error?.code).toBe('PATH_MISSING');
  });

  it('rejects a snapshot that is not representable as JSON', () => {
    const frames = ingestAll(newAdapter(), [{ type: T.STATE_SNAPSHOT, snapshot: { fn: () => 1 } }]);
    expect(kinds(frames)).toEqual(['warning']);
    expect((frames[0]?.payload as { code: string }).code).toBe('AGUI_STATE_NOT_JSON');
  });
});

describe('AgUiAdapter subagents, steps and unmapped events', () => {
  it('remembers a subagent name from its start and reuses it on finish', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.SUBAGENT_STARTED, subagentRunId: 'sa1', name: 'researcher', description: 'reads docs' },
      { type: T.SUBAGENT_STARTED, subagentRunId: 'sa2', name: 'writer' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'x', subagentRunId: 'sa1' },
      { type: T.SUBAGENT_FINISHED, subagentRunId: 'sa1' },
      { type: T.SUBAGENT_ERROR, subagentRunId: 'sa2', message: 'ran out of context' },
    ]);
    expect(kinds(frames)).toEqual(['subagent', 'subagent', 'text.delta', 'subagent', 'subagent']);
    expect(frames[0]?.payload).toEqual({ phase: 'started', name: 'researcher', detail: 'reads docs' });
    expect(frames[3]?.payload).toEqual({ phase: 'finished', name: 'researcher', detail: 'completed' });
    expect(frames[4]?.payload).toEqual({ phase: 'error', name: 'writer', detail: 'ran out of context' });
  });

  it('stamps subagent attribution onto every frame the subagent produced', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.SUBAGENT_STARTED, subagentRunId: 'sa1', name: 'researcher' },
      { type: T.TEXT_MESSAGE_START, messageId: 'm1', subagentRunId: 'sa1' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'x', subagentRunId: 'sa1' },
    ]);
    expect(frames[0]?.subagentRunId).toBe('sa1');
    expect(frames[1]?.subagentRunId).toBe('sa1');
  });

  it('falls back to the invocation id when a finish has no matching start', () => {
    const [frame] = ingestAll(newAdapter(), [{ type: T.SUBAGENT_FINISHED, subagentRunId: 'never-announced' }]);
    expect(frame?.payload).toEqual({ phase: 'finished', name: 'subagent', detail: 'completed' });
  });

  it('reports a suspended subagent distinctly from a completed one', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.SUBAGENT_STARTED, subagentRunId: 'sa1', name: 'worker' },
      { type: T.SUBAGENT_FINISHED, subagentRunId: 'sa1', outcome: { type: 'suspended', interruptIds: ['i1'] } },
    ]);
    expect(frames.at(-1)?.payload).toEqual({ phase: 'finished', name: 'worker', detail: 'suspended awaiting 1 interrupt(s)' });
  });

  it('stamps a step index on frames produced inside a step', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.STEP_STARTED, stepName: 'plan' },
      { type: T.TEXT_MESSAGE_START, messageId: 'm1' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'x' },
      { type: T.STEP_FINISHED, stepName: 'plan' },
      { type: T.TEXT_MESSAGE_START, messageId: 'm2' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'm2', delta: 'y' },
    ]);
    expect(frames[1]?.payload).toMatchObject({ messageId: 'm1' });
    expect(frames[1]?.step).toBe(0);
    expect(frames[5]?.step).toBeUndefined();
  });

  it('warns about a step pair rather than dropping it', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.STEP_STARTED, stepName: 'plan' },
      { type: T.STEP_FINISHED, stepName: 'plan' },
    ]);
    expect(kinds(frames)).toEqual(['warning', 'warning']);
    expect((frames[0]?.payload as { code: string }).code).toBe('AGUI_STEP_STARTED');
    expect((frames[1]?.payload as { code: string }).code).toBe('AGUI_STEP_FINISHED');
  });

  it('passes a custom event through as a warning with its name and value', () => {
    const [frame] = ingestAll(newAdapter(), [{ type: T.CUSTOM, name: 'render-chart', value: { series: [1, 2] } }]);
    expect(frame?.kind).toBe('warning');
    const payload = frame?.payload as { code: string; message: string; detail: Record<string, unknown> };
    expect(payload.code).toBe('AGUI_CUSTOM');
    expect(payload.message).toContain('render-chart');
    expect(payload.detail).toEqual({ name: 'render-chart', value: { series: [1, 2] } });
  });

  it('warns for every event family the IR cannot render, keeping raw', () => {
    const unmapped: readonly [EventType, unknown, string][] = [
      [T.RAW, { type: T.RAW, event: { kind: 'provider_delta' }, source: 'openai' }, 'AGUI_RAW_UNMAPPED'],
      [T.ACTIVITY_SNAPSHOT, { type: T.ACTIVITY_SNAPSHOT, messageId: 'a1', activityType: 'progress', content: { pct: 10 } }, 'AGUI_ACTIVITY_SNAPSHOT'],
      [T.ACTIVITY_DELTA, { type: T.ACTIVITY_DELTA, messageId: 'a1', activityType: 'progress', patch: [{ op: 'add', path: '/pct', value: 20 }] }, 'AGUI_ACTIVITY_DELTA'],
      [T.MESSAGES_SNAPSHOT, { type: T.MESSAGES_SNAPSHOT, messages: [] }, 'AGUI_MESSAGES_SNAPSHOT'],
      [T.REASONING_START, { type: T.REASONING_START, messageId: 'r1' }, 'AGUI_REASONING_UNMAPPED'],
      [T.REASONING_MESSAGE_CONTENT, { type: T.REASONING_MESSAGE_CONTENT, messageId: 'r1', delta: 'thinking' }, 'AGUI_REASONING_UNMAPPED'],
      [T.REASONING_END, { type: T.REASONING_END, messageId: 'r1' }, 'AGUI_REASONING_UNMAPPED'],
    ];
    for (const [type, event, code] of unmapped) {
      const [frame] = ingestAll(newAdapter(), [event]);
      expect(frame?.kind, type).toBe('warning');
      expect((frame?.payload as { code: string }).code, type).toBe(code);
      expect(frame?.raw, type).toEqual(event);
    }
  });

  it('never copies an encrypted reasoning value into the transcript', () => {
    const [frame] = ingestAll(newAdapter(), [
      { type: T.REASONING_ENCRYPTED_VALUE, subtype: 'message', entityId: 'm1', encryptedValue: 'opaque-blob' },
    ]);
    expect((frame?.payload as { code: string }).code).toBe('AGUI_REASONING_ENCRYPTED_VALUE');
    expect(JSON.stringify(frame?.payload)).not.toContain('opaque-blob');
    expect((frame?.payload as { detail: Record<string, unknown> }).detail).toEqual({
      subtype: 'message',
      entityId: 'm1',
      withheld: 'encryptedValue',
    });
  });

  it('ingests tool errors out of a messages snapshot', () => {
    const frames = ingestAll(newAdapter(), [
      {
        type: T.MESSAGES_SNAPSHOT,
        messages: [
          { id: 'tm0', role: 'tool', toolCallId: 'tc0', content: 'failed', error: 'TIMEOUT' },
          { id: 'a0', role: 'assistant', content: 'earlier answer' },
        ],
      },
      { type: T.TOOL_CALL_RESULT, messageId: 'tm1', toolCallId: 'tc0', content: 'failed' },
    ]);
    expect((frames.at(-1)?.payload as { isError: boolean }).isError).toBe(true);
  });
});

describe('AgUiAdapter resilience', () => {
  it('warns on an event type it has never heard of', () => {
    const [frame] = ingestAll(newAdapter(), [{ type: 'SOME_FUTURE_EVENT', payload: 1 }]);
    expect(frame?.kind).toBe('warning');
    expect((frame?.payload as { code: string }).code).toBe(UNKNOWN_EVENT_CODE);
    expect((frame?.payload as { detail: Record<string, unknown> }).detail).toEqual({ eventType: 'SOME_FUTURE_EVENT' });
  });

  it('warns on a unit with no type at all', () => {
    const frames = ingestAll(newAdapter(), [{ hello: 'world' }, 42, null, undefined, ['nested']]);
    expect(frames).toHaveLength(5);
    for (const frame of frames) expect((frame?.payload as { code: string }).code).toBe('AGUI_MALFORMED_EVENT');
  });

  it('warns on a string that is valid JSON but not an event', () => {
    const frames = ingestAll(newAdapter(), ['{"hello":"world"}', '[1,2,3]']);
    expect(frames).toHaveLength(2);
    for (const frame of frames) expect((frame?.payload as { code: string }).code).toBe('AGUI_MALFORMED_EVENT');
  });

  it('warns on unparseable SSE text without throwing', () => {
    const frames = [...newAdapter().ingest({ threadId: THREAD, runId: RUN, text: '{not json' })];
    expect((frames[0]?.payload as { code: string }).code).toBe('AGUI_MALFORMED_JSON');
  });

  it('reads an event delivered as raw SSE data text', () => {
    const frames = [...newAdapter().ingest({ threadId: THREAD, runId: RUN, text: '{"type":"CUSTOM","name":"ping","value":1}' })];
    expect((frames[0]?.payload as { code: string }).code).toBe('AGUI_CUSTOM');
  });

  it('produces no frames for an empty unit and does not throw', () => {
    expect([...newAdapter().ingest({ threadId: THREAD, runId: RUN })]).toEqual([]);
  });

  it('keeps going after one bad event in a batch', () => {
    const frames = ingestAll(newAdapter(), [
      { type: T.RUN_STARTED, threadId: THREAD, runId: RUN },
      { type: 'NOPE' },
      { type: T.TEXT_MESSAGE_START, messageId: 'm1' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'survived' },
    ]);
    expect(kinds(frames)).toEqual(['run.started', 'warning', 'text.delta']);
    expect((frames[2]?.payload as { delta: string }).delta).toBe('survived');
  });

  it('turns an internal fault into a warning frame rather than an exception', () => {
    const adapter = newAdapter();
    // A snapshot whose `snapshot` getter throws is the cheapest way to make a
    // handler fail from outside, which is exactly the "hostile agent" case the
    // contract forbids throwing on.
    const hostile = {
      type: T.STATE_SNAPSHOT,
      get snapshot(): unknown {
        throw new Error('evil getter');
      },
    };
    const frames = ingestAll(adapter, [hostile]);
    expect(kinds(frames)).toEqual(['warning']);
    expect((frames[0]?.payload as { code: string }).code).toBe('AGUI_ADAPTER_FAULT');
  });
});

describe('AgUiAdapter outbound actions', () => {
  let adapter: AgUiAdapter;
  beforeEach(() => {
    adapter = newAdapter({ hostName: 'probe', tools: [{ name: 't', description: 'd' }] });
    ingestAll(adapter, [{ type: T.RUN_STARTED, threadId: THREAD, runId: RUN }]);
  });

  it('encodes an action as a tool message plus a state patch', () => {
    const encoded = adapter.encodeAction({ surfaceId: 'cart', componentId: 'qty', name: 'onChange', value: 3 });
    expect(encoded.protocol).toBe('ag-ui');
    expect(encoded.input['threadId']).toBe(THREAD);
    expect(encoded.input['runId']).toBe(RUN);

    const messages = encoded.input['messages'] as { id: string; role: string; toolCallId: string; content: unknown }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('tool');
    expect(messages[0]?.id).toBe(messages[0]?.toolCallId);
    const envelope = JSON.parse((messages[0]?.content as { text: string }[])[0]?.text ?? '{}');
    expect(envelope).toMatchObject({ surfaceId: 'cart', componentId: 'qty', name: 'onChange', value: 3 });
  });

  it('writes the action value at the documented pointer', () => {
    const encoded = adapter.encodeAction({ surfaceId: 'cart', componentId: 'qty', name: 'onChange', value: 3, context: { source: 'widget' } });
    expect(encoded.patch).toMatchObject({ threadId: THREAD, runId: RUN, surfaceId: 'cart', revision: 1 });
    expect(encoded.patch.operations).toEqual([{ op: 'add', path: '/actions/cart/qty/onChange', value: 3 }]);
  });

  it('escapes pointer tokens so a slash in an id cannot forge a path', () => {
    const encoded = adapter.encodeAction({ surfaceId: 'a/b', componentId: 'c~d', name: 'onClick' });
    expect(encoded.patch.operations[0]?.path).toBe('/actions/a~1b/c~0d/onClick');
  });

  it('writes null rather than dropping the value when the action carries none', () => {
    const encoded = adapter.encodeAction({ surfaceId: 's', componentId: 'c', name: 'onReset' });
    expect(encoded.patch.operations).toEqual([{ op: 'add', path: '/actions/s/c/onReset', value: null }]);
  });

  it('produces a stable message id so a retry is deduplicable', () => {
    const a = adapter.encodeAction({ surfaceId: 's', componentId: 'c', name: 'onClick', value: 1 });
    const b = adapter.encodeAction({ surfaceId: 's', componentId: 'c', name: 'onClick', value: 1 });
    expect((a.input['messages'] as { id: string }[])[0]?.id).toBe((b.input['messages'] as { id: string }[])[0]?.id);
  });

  it('does not let a colon in a component name collide with another action', () => {
    const a = adapter.encodeAction({ surfaceId: 'a:b', componentId: 'c', name: 'n' });
    const b = adapter.encodeAction({ surfaceId: 'a', componentId: 'b:c', name: 'n' });
    expect((a.input['messages'] as { id: string }[])[0]?.id).not.toBe((b.input['messages'] as { id: string }[])[0]?.id);
  });

  it('carries the current state document and the tools in the outbound body', () => {
    ingestAll(adapter, [{ type: T.STATE_SNAPSHOT, snapshot: { step: 2 } }]);
    const encoded = adapter.encodeAction({ surfaceId: 's', componentId: 'c', name: 'onClick' });
    expect(encoded.input['state']).toEqual({ step: 2 });
    expect(encoded.input['tools']).toEqual([{ name: 't', description: 'd' }]);
    expect((encoded.input['forwardedProps'] as Record<string, unknown>)['action']).toMatchObject({ surfaceId: 's' });
  });
});

describe('AgUiAdapter local state', () => {
  it('applies a host patch to the internal document', () => {
    const adapter = newAdapter();
    ingestAll(adapter, [{ type: T.STATE_SNAPSHOT, snapshot: { count: 1 } }]);
    adapter.applyLocalState({ threadId: THREAD, runId: RUN, operations: ops({ op: 'add', path: '/count', value: 5 }), revision: 1 });
    expect(adapter.stateFor(THREAD).document).toEqual({ count: 5 });
    expect(adapter.lastPatchError).toBeUndefined();
  });

  it('is idempotent: replaying the same patch changes nothing', () => {
    const adapter = newAdapter();
    adapter.applyLocalState({ threadId: THREAD, runId: RUN, operations: ops({ op: 'add', path: '/list', value: [1] }), revision: 1 });
    const first = adapter.stateFor(THREAD).document;
    adapter.applyLocalState({ threadId: THREAD, runId: RUN, operations: ops({ op: 'add', path: '/list', value: [1] }), revision: 1 });
    expect(adapter.stateFor(THREAD).document).toEqual(first);
  });

  it('ignores a patch that is older than what it already applied', () => {
    const adapter = newAdapter();
    adapter.applyLocalState({ threadId: THREAD, runId: RUN, operations: ops({ op: 'add', path: '/v', value: 2 }), revision: 5 });
    adapter.applyLocalState({ threadId: THREAD, runId: RUN, operations: ops({ op: 'add', path: '/v', value: 99 }), revision: 3 });
    expect(adapter.stateFor(THREAD).document).toEqual({ v: 2 });
  });

  it('leaves the document untouched when any operation fails', () => {
    const adapter = newAdapter();
    adapter.applyLocalState({
      threadId: THREAD,
      runId: RUN,
      operations: ops({ op: 'add', path: '/ok', value: 1 }, { op: 'replace', path: '/missing', value: 2 }),
      revision: 1,
    });
    expect(adapter.stateFor(THREAD).document).toEqual({});
    expect(adapter.lastPatchError).toContain('PATH_MISSING');
  });

  it('refuses a patch addressed to another thread', () => {
    const adapter = newAdapter();
    adapter.applyLocalState({ threadId: 'someone-else', runId: RUN, operations: ops({ op: 'add', path: '/x', value: 1 }), revision: 1 });
    expect(adapter.stateFor(THREAD).document).toEqual({});
    expect(adapter.lastPatchError).toContain('someone-else');
  });

  it('honours a failing test operation as all-or-nothing', () => {
    const adapter = newAdapter();
    adapter.applyLocalState({
      threadId: THREAD,
      runId: RUN,
      operations: ops({ op: 'add', path: '/v', value: 1 }, { op: 'test', path: '/v', value: 999 }),
      revision: 1,
    });
    expect(adapter.stateFor(THREAD).document).toEqual({});
  });
});

describe('AgUiAdapter end to end', () => {
  it('normalises a realistic run delivered over SSE, in order', () => {
    const events: unknown[] = [
      {
        type: T.RUN_STARTED,
        threadId: THREAD,
        runId: RUN,
        protocolVersion: '1.0',
        input: {
          threadId: THREAD,
          runId: RUN,
          messages: [{ id: 'u1', role: 'user', content: 'weather in Seoul?' }],
          tools: [{ name: 'search', description: 'search the web' }],
          context: [{ description: 'locale', value: 'ko-KR' }],
        },
      },
      { type: T.TEXT_MESSAGE_START, messageId: 'm1' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'Let me ' },
      { type: T.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'check.' },
      { type: T.TEXT_MESSAGE_END, messageId: 'm1' },
      { type: T.STEP_STARTED, stepName: 'lookup' },
      { type: T.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'search', parentMessageId: 'm1' },
      { type: T.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{"query":"Seoul ' },
      { type: T.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: 'weather"}' },
      { type: T.TOOL_CALL_END, toolCallId: 'tc1' },
      { type: T.TOOL_CALL_RESULT, messageId: 'tm1', toolCallId: 'tc1', content: '18C, clear' },
      { type: T.STEP_FINISHED, stepName: 'lookup' },
      { type: T.CUSTOM, name: 'ui-hint', value: 'done' },
      { type: T.RUN_FINISHED, threadId: THREAD, runId: RUN, usage: [{ provider: 'openai', inputTokens: 900, outputTokens: 120 }] },
    ];

    const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
    const parser = new SseParser();
    const adapter = newAdapter({ agentName: 'weather-bot' });
    const frames: SurfaceFrame[] = [];
    for (const message of [...parser.feed(body.slice(0, 200)), ...parser.feed(body.slice(200, 900)), ...parser.feed(body.slice(900)), ...parser.flush()]) {
      for (const frame of adapter.ingest({ threadId: THREAD, runId: RUN, text: message.data })) frames.push(frame);
    }

    expect(kinds(frames)).toEqual([
      'run.started',
      'text.delta',
      'text.delta',
      'text.done',
      'warning',
      'tool.started',
      'tool.args.delta',
      'tool.args.delta',
      'tool.args.done',
      'tool.result',
      'warning',
      'warning',
      'run.finished',
    ]);
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i));
    expect(frames[3]?.payload).toEqual({ messageId: 'm1', text: 'Let me check.' });
    expect(frames[8]?.payload).toEqual({ toolCallId: 'tc1', args: { query: 'Seoul weather' } });
    expect(frames[9]?.payload).toMatchObject({ toolCallId: 'tc1', content: '18C, clear' });
    expect(frames[6]?.step).toBe(0);
    expect(frames[9]?.step).toBe(0);
    expect(frames[12]?.payload).toEqual({ outcome: 'success', usage: { inputTokens: 900, outputTokens: 120 } });
    for (const frame of frames) expect(frame.source).toBe('ag-ui');
  });

  it('keeps the event table and the adapter in agreement', () => {
    const adapter = newAdapter();
    const expectations: [EventType, FrameKind[]][] = [
      [T.RUN_STARTED, ['run.started']],
      [T.RUN_FINISHED, ['interrupt', 'run.finished']],
      [T.RUN_ERROR, ['error']],
      [T.TEXT_MESSAGE_START, []],
      [T.TEXT_MESSAGE_CONTENT, ['text.delta']],
      [T.TEXT_MESSAGE_END, ['text.done']],
      [T.TEXT_MESSAGE_CHUNK, ['text.delta']],
      [T.TOOL_CALL_START, ['tool.started']],
      [T.TOOL_CALL_ARGS, ['tool.args.delta']],
      [T.TOOL_CALL_END, ['tool.args.done']],
      [T.TOOL_CALL_CHUNK, ['tool.started', 'tool.args.delta']],
      [T.TOOL_CALL_RESULT, ['tool.result']],
      [T.STATE_SNAPSHOT, ['surface.data']],
      [T.SUBAGENT_STARTED, ['subagent']],
      [T.SUBAGENT_FINISHED, ['subagent']],
      [T.SUBAGENT_ERROR, ['subagent']],
    ];
    for (const [type, frames] of expectations) {
      expect([...(framesFor(type) ?? [])], type).toEqual(frames);
    }
    // Every entry in the table is either rendered or explicitly a warning; none
    // is silently dropped.
    for (const [type, mapping] of Object.entries(EVENT_FRAME_MAP)) {
      expect(['frames', 'warning'], type).toContain(mapping.kind);
      expect(adapter, type).toBeInstanceOf(AgUiAdapter);
    }
  });
});

describe('isJsonValue', () => {
  let adapter: AgUiAdapter;
  beforeEach(() => {
    adapter = newAdapter();
  });

  it('accepts plain JSON and rejects everything the IR cannot hold', () => {
    expect(isJsonValue({ a: [1, 'two', true, null] })).toBe(true);
    expect(isJsonValue({ a: () => 1 })).toBe(false);
    expect(isJsonValue({ a: new Date() })).toBe(false);
    expect(isJsonValue({ a: Number.NaN })).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(isJsonValue(cycle)).toBe(false);
  });

  it('rejects a prototype-polluting key', () => {
    expect(isJsonValue(JSON.parse('{"__proto__":{"polluted":true}}'))).toBe(false);
  });

  it('keeps the adapter working after a rejected state value', () => {
    const frames = ingestAll(adapter, [
      { type: T.STATE_SNAPSHOT, snapshot: { bad: () => 1 } },
      { type: T.STATE_SNAPSHOT, snapshot: { good: true } },
    ]);
    expect(kinds(frames)).toEqual(['warning', 'surface.data']);
    expect(adapter.stateFor(THREAD).document).toEqual({ good: true });
  });
});

/**
 * The contract test that matters most: run a real `@ag-ui/client` `HttpAgent`
 * over a stubbed `fetch` and push the events it actually delivers through this
 * adapter. Everything between the socket and the IR -- SSE framing, the client's
 * own chunk expansion, the outbound validator -- is upstream code, so a
 * disagreement about the protocol shows up here rather than in a browser.
 */
describe('AgUiAdapter against the real @ag-ui/client', () => {
  it('handles the events HttpAgent delivers over a stubbed SSE response', async () => {
    const sseBody = [
      { type: T.RUN_STARTED, threadId: THREAD, runId: RUN },
      // Sent as chunks: the client expands these into start/content/end itself,
      // which is the behaviour this adapter's deferred lane close has to match.
      { type: T.TEXT_MESSAGE_CHUNK, messageId: 'm1', role: 'assistant', delta: 'Hello ' },
      { type: T.TEXT_MESSAGE_CHUNK, delta: 'there' },
      { type: T.TOOL_CALL_CHUNK, toolCallId: 'tc1', toolCallName: 'now', delta: '{"tz":"UTC"}' },
      { type: T.TOOL_CALL_RESULT, messageId: 'tm1', toolCallId: 'tc1', content: '12:00' },
      { type: T.RUN_FINISHED, threadId: THREAD, runId: RUN, usage: [{ provider: 'openai', inputTokens: 5, outputTokens: 2 }] },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join('');

    const delivered: unknown[] = [];
    let posted: unknown;
    const agent = new HttpAgent({
      agentId: 'probe',
      threadId: THREAD,
      url: 'https://agent.invalid/run',
      fetch: async (_url, init) => {
        posted = JSON.parse(String(init?.body));
        return new Response(sseBody, { headers: { 'Content-Type': 'text/event-stream' } });
      },
    });
    await agent.runAgent({}, { onEvent: ({ event }) => { delivered.push(event); } });

    const adapter = newAdapter({ agentName: 'probe' });
    const frames: SurfaceFrame[] = [];
    for (const event of delivered) {
      for (const frame of adapter.ingest({ threadId: THREAD, runId: RUN, raw: event })) frames.push(frame);
    }

    expect(kinds(frames)).toEqual([
      'run.started',
      'text.delta',
      'text.delta',
      'text.done',
      'tool.started',
      'tool.args.delta',
      'tool.args.done',
      'tool.result',
      'run.finished',
    ]);
    expect(frames[3]?.payload).toEqual({ messageId: 'm1', text: 'Hello there' });
    expect(frames[6]?.payload).toEqual({ toolCallId: 'tc1', args: { tz: 'UTC' } });
    expect(frames[7]?.payload).toMatchObject({ content: '12:00' });
    expect(frames[8]?.payload).toEqual({ outcome: 'success', usage: { inputTokens: 5, outputTokens: 2 } });

    // Whatever the client actually POSTed has to be a RunAgentInput this host
    // can produce, or the two halves of the round trip do not meet.
    expect(posted).toMatchObject({ threadId: THREAD, protocolVersion: '1.0', tools: [], context: [] });
  });

  it('produces outbound bodies the real agent-side validator leaves untouched', () => {
    const adapter = newAdapter({ hostName: 'probe', tools: [{ name: 'search', description: 'find' }] });
    ingestAll(adapter, [{ type: T.RUN_STARTED, threadId: THREAD, runId: RUN, state: { step: 1 } }]);

    const action = adapter.encodeAction({ surfaceId: 'cart', componentId: 'qty', name: 'onChange', value: 3, context: { source: 'widget' } });
    // `enforceOutgoingInput` is the stage that strips anything the protocol does
    // not define. Nothing it removes is material this adapter invented.
    expect(enforceOutgoingInput(action.input as unknown as RunAgentInput)).toEqual(action.input);
    expect(enforceOutgoingInput(adapter.getClientCapabilities() as unknown as RunAgentInput)).toEqual(
      adapter.getClientCapabilities(),
    );
  });

  it('reads a stream the real client frames with comments, extra fields and split data lines', async () => {
    const LF = String.fromCharCode(10);
    const delivered: unknown[] = [];
    // No trailing blank line on the last event, on purpose: the client flushes
    // at end-of-stream, and so must any host that reads the same bytes.
    const body = [
      ': keep-alive',
      '',
      'event: message',
      'id: 7',
      'retry: 2500',
      'data: {"type":"RUN_STARTED",',
      'data:  "threadId":"t1","runId":"r1"}',
      '',
      ': another keep-alive',
      'data: {"type":"RAW","event":{"partial":true}}',
      '',
    ].join(LF);
    const agent = new HttpAgent({
      agentId: 'probe',
      threadId: 't1',
      url: 'https://agent.invalid/run',
      fetch: async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    });
    await agent.runAgent({}, { onEvent: ({ event }) => { delivered.push(event); } });

    const frames = ingestAll(newAdapter(), delivered);
    expect(kinds(frames)).toEqual(['run.started', 'warning']);
    expect(frames[0]?.runId).toBe('r1');
    expect((frames[1]?.payload as { code: string }).code).toBe('AGUI_RAW_UNMAPPED');
  });

  it('frames a pure-CRLF body that @ag-ui/client cannot split', () => {
    // `@ag-ui/client`'s parseSSEStream splits events on a literal double LF, so a
    // server that terminates every line with CRLF hands it one concatenated
    // payload. This parser follows the SSE standard, which makes CR, LF and
    // CRLF all line terminators, and so reads the same bytes correctly. The
    // divergence is why this package ships its own parser rather than delegating.
    const CRLF = String.fromCharCode(13, 10);
    const body = ['data: {"a":1}', '', 'data: {"b":2}', '', ''].join(CRLF);
    expect(decodeSse([body]).map((m) => m.data)).toEqual(['{"a":1}', '{"b":2}']);
  });
});
