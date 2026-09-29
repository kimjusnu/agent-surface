/**
 * Frame fixtures.
 *
 * The sequences below are lifted from what the adapters actually emit, not from
 * what the IR documentation implies -- in particular the AG-UI quirks that the
 * tree builder and step derivation have to survive:
 *
 *  - `STEP_STARTED`/`STEP_FINISHED` arrive as `warning` frames with codes
 *    `AGUI_STEP_STARTED`/`AGUI_STEP_FINISHED` and `detail.stepName`, because the
 *    IR has no step frame kind and `event-map.ts` maps them to warnings.
 *  - `tool.started` names `parentMessageId`; `tool.result` names a *different*
 *    id, the tool message, which is what a nested call can point at.
 *  - `run.finished` carries aggregated usage; a failed run puts it in
 *    `error.detail.usage` instead.
 */

import type {
  FrameKind,
  FramePayloadMap,
  ProtocolId,
  SurfaceFrame,
  SurfaceNode,
} from '@agent-surface/protocol';

export const THREAD = 'thread-1';

export interface BuilderOptions {
  protocol?: ProtocolId;
  threadId?: string;
  runId?: string;
  startTs?: number;
  /** Default `step` stamped on frames, as the AG-UI adapter does mid-step. */
  step?: number;
  subagentRunId?: string;
}

/** Incremental frame builder with a monotonic `seq` and `ts`. */
export class FrameBuilder {
  #seq = 0;
  #ts: number;
  readonly frames: SurfaceFrame[] = [];
  readonly protocol: ProtocolId;
  readonly threadId: string;
  readonly runId: string;
  step: number | undefined;
  subagentRunId: string | undefined;

  constructor(options: BuilderOptions = {}) {
    this.protocol = options.protocol ?? 'ag-ui';
    this.threadId = options.threadId ?? THREAD;
    this.runId = options.runId ?? 'run-1';
    this.#ts = options.startTs ?? 1_000_000;
    this.step = options.step;
    this.subagentRunId = options.subagentRunId;
  }

  get nextTs(): number {
    this.#ts += 10;
    return this.#ts;
  }

  push<K extends FrameKind>(kind: K, payload: FramePayloadMap[K], extra: Partial<SurfaceFrame> = {}): SurfaceFrame {
    const frame = {
      seq: this.#seq++,
      kind,
      source: this.protocol,
      ts: this.nextTs,
      threadId: this.threadId,
      runId: this.runId,
      ...(this.step !== undefined ? { step: this.step } : {}),
      ...(this.subagentRunId !== undefined ? { subagentRunId: this.subagentRunId } : {}),
      ...extra,
      payload,
    } as SurfaceFrame;
    this.frames.push(frame);
    return frame;
  }

  stepStarted(name: string): SurfaceFrame {
    return this.push('warning', { code: 'AGUI_STEP_STARTED', message: 'step', detail: { stepName: name } });
  }

  stepFinished(name: string): SurfaceFrame {
    return this.push('warning', { code: 'AGUI_STEP_FINISHED', message: 'step', detail: { stepName: name } });
  }

  finish(outcome: 'success' | 'cancelled' | 'interrupt' = 'success', usage?: FramePayloadMap['run.finished']['usage']): SurfaceFrame {
    return this.push('run.finished', { outcome, ...(usage ? { usage } : {}) });
  }

  build(): SurfaceFrame[] {
    return this.frames.slice();
  }
}

export interface AgUiRunOptions {
  /** Include the sub-agent section. */
  withSubagent?: boolean;
  /** Include a tool call that never resolves. */
  withOrphanTool?: boolean;
  /** Include a result frame whose `tool.started` was never recorded. */
  withResultWithoutStart?: boolean;
  runId?: string;
  agentName?: string;
}

/**
 * The canonical transcript: plan, look something up with a tool, answer, done.
 */
export function aguiRun(options: AgUiRunOptions = {}): SurfaceFrame[] {
  const b = new FrameBuilder({ runId: options.runId ?? 'run-1' });
  b.push('run.started', {
    agentName: options.agentName ?? 'weather-bot',
    input: { forwardedProps: { model: 'gpt-5-mini' } },
  });
  b.push('text.delta', { messageId: 'm1', delta: 'Let me ' });
  b.push('text.delta', { messageId: 'm1', delta: 'check.' });
  b.push('text.done', { messageId: 'm1', text: 'Let me check.' });
  b.stepStarted('plan');

  if (options.withSubagent === true) {
    b.push('subagent', { phase: 'started', name: 'researcher' }, { subagentRunId: 'sub-1' });
    b.subagentRunId = 'sub-1';
    b.step = 1;
  }

  b.push('tool.started', { toolCallId: 'tc1', toolName: 'search', parentMessageId: 'm1' });
  b.push('tool.args.delta', { toolCallId: 'tc1', delta: '{"query":"Seoul ' });
  b.push('tool.args.delta', { toolCallId: 'tc1', delta: 'weather"}' });
  b.push('tool.args.done', { toolCallId: 'tc1', args: { query: 'Seoul weather' } });
  b.push('tool.result', { toolCallId: 'tc1', messageId: 'tm1', content: '18C, clear', durationMs: 40 });

  if (options.withOrphanTool === true) {
    b.push('tool.started', { toolCallId: 'tc-hung', toolName: 'fetch', parentMessageId: 'm1' });
    b.push('tool.args.done', { toolCallId: 'tc-hung', args: { url: 'https://example.test' } });
  }

  if (options.withResultWithoutStart === true) {
    b.push('tool.result', { toolCallId: 'tc-ghost', messageId: 'tm-ghost', content: 'orphan output' });
  }

  if (options.withSubagent === true) {
    b.push('subagent', { phase: 'finished', name: 'researcher', detail: 'completed' }, { subagentRunId: 'sub-1' });
    b.subagentRunId = undefined;
    b.step = 0;
  }

  b.stepFinished('plan');
  b.push('text.delta', { messageId: 'm2', delta: 'It is 18C and clear.' });
  b.push('text.done', { messageId: 'm2', text: 'It is 18C and clear.' });
  b.finish('success', { inputTokens: 900, outputTokens: 120, costUsd: 0.0031 });
  return b.build();
}

/** A2UI: surfaces, a data-model write, and a user action. No step frames at all. */
export function a2uiRun(): SurfaceFrame[] {
  const b = new FrameBuilder({ protocol: 'a2ui', runId: 'run-a2ui' });
  b.push('run.started', { agentName: 'form-agent', capabilities: { surfaces: true } });
  b.push('surface.created', { surfaceId: 's1', catalogId: 'basic', title: 'Booking', data: {}, sendDataModel: true });
  b.push('surface.nodes', {
    surfaceId: 's1',
    mode: 'merge',
    nodes: [
      { component: 'Column', id: 'root', children: [{ component: 'Text', id: 'label', props: { text: { kind: 'literal', value: 'Where to?' } } }] },
    ],
  });
  b.push('surface.data', { surfaceId: 's1', path: '/draft', value: { city: 'Seoul' }, mode: 'set' });
  b.push('text.done', { messageId: 'm1', text: 'Where should I book?' });
  b.push('surface.nodes', {
    surfaceId: 's1',
    mode: 'merge',
    nodes: [{ component: 'List', id: 'results', props: { items: { kind: 'data', ref: { pointer: '/draft' } } } }],
  });
  b.push('action.dispatched', { surfaceId: 's1', componentId: 'results', name: 'onSelect', context: { city: 'Seoul' } });
  b.push('text.done', { messageId: 'm2', text: 'Booked for Seoul.' });
  b.finish('success');
  return b.build();
}

/** MCP Apps: a tool result carrying an embedded app the policy allowed. */
export function mcpRun(): SurfaceFrame[] {
  const b = new FrameBuilder({ protocol: 'mcp-apps', runId: 'run-mcp' });
  b.push('run.started', { agentName: 'app-agent' });
  b.push('app.attached', {
    app: {
      id: 'mcp-app-weather',
      title: 'Weather',
      src: 'blob:https://host.test/abc',
      sandbox: 'sandboxed-scripts',
      height: 320,
      bridgeVersion: '0.2',
      transport: 'postmessage',
      untrusted: true,
    },
  });
  b.finish('success');
  return b.build();
}

/** A run that fails after spending tokens: usage rides in `error.detail`. */
export function failedRun(): SurfaceFrame[] {
  const b = new FrameBuilder({ runId: 'run-failed' });
  b.push('run.started', { agentName: 'flaky' });
  b.push('tool.started', { toolCallId: 'tc1', toolName: 'search' });
  b.push('tool.args.done', { toolCallId: 'tc1', args: {} });
  b.push('tool.result', { toolCallId: 'tc1', messageId: 'tm1', content: 'boom', isError: true });
  b.push('error', {
    code: 'AGUI_RUN_ERROR',
    message: 'provider timed out',
    fatal: true,
    detail: { usage: { inputTokens: 400, outputTokens: 0 } },
  });
  b.push('run.finished', { outcome: 'cancelled' });
  return b.build();
}

export function surfaceNodes(nodes: readonly SurfaceNode[]): SurfaceFrame[] {
  const b = new FrameBuilder({ protocol: 'a2ui', runId: 'run-nodes' });
  b.push('run.started', { agentName: 'x' });
  b.push('surface.created', { surfaceId: 's1', catalogId: 'basic' });
  b.push('surface.nodes', { surfaceId: 's1', nodes: [...nodes], mode: 'merge' });
  b.finish('success');
  return b.build();
}

/** A single frame of any kind, for reducer edge cases. */
export function frame<K extends FrameKind>(
  kind: K,
  payload: FramePayloadMap[K],
  overrides: Partial<SurfaceFrame> = {},
): SurfaceFrame {
  return {
    seq: 0,
    kind,
    source: 'ag-ui',
    ts: 1_000,
    threadId: THREAD,
    runId: 'run-1',
    payload,
    ...overrides,
  } as SurfaceFrame;
}

export const kinds = (frames: readonly SurfaceFrame[]): string[] => frames.map((f) => f.kind);

export const byKind = <T>(frames: readonly SurfaceFrame[], kind: FrameKind): T[] =>
  frames.filter((f) => f.kind === kind).map((f) => f.payload as unknown as T);
