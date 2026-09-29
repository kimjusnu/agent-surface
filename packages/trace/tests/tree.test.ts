/**
 * Tree building: what nests under what, and the two ways a tool call can be
 * broken.
 */

import { describe, expect, it } from 'vitest';

import {
  UNNAMED_TOOL,
  buildTree,
  collectOrphans,
  collectSubAgents,
  collectTools,
  hashArgs,
  stableStringify,
  walkTree,
} from '../src/index.js';
import type { SurfaceNode } from '@agent-surface/protocol';

import type { MessageNode, SubAgentNode, ToolCallNode } from '../src/index.js';
import { aguiRun, a2uiRun, frame, FrameBuilder } from './fixtures.js';

const tool = (node: { kind: string } | undefined): ToolCallNode => node as ToolCallNode;
const message = (node: { kind: string } | undefined): MessageNode => node as MessageNode;
const subagent = (node: { kind: string } | undefined): SubAgentNode => node as SubAgentNode;

describe('tree structure', () => {
  it('nests a tool call under the message that requested it', () => {
    const run = buildTree(aguiRun());
    const m1 = message(run.children.find((child) => child.kind === 'message' && child.messageId === 'm1'));
    expect(m1.text).toBe('Let me check.');
    expect(m1.children.map((child) => child.kind)).toEqual(['tool']);
    expect(tool(m1.children[0]).name).toBe('search');
  });

  it('carries arguments, results and duration onto the tool node', () => {
    const [node] = collectTools(buildTree(aguiRun()));
    expect(node?.args).toEqual({ query: 'Seoul weather' });
    expect(node?.result).toBe('18C, clear');
    expect(node?.status).toBe('ok');
    expect(node?.durationMs).toBe(40);
    expect(node?.parentMessageId).toBe('m1');
  });

  it('nests a tool call under the tool result it descends from', () => {
    // AG-UI's `tool.result` names a tool *message*; a follow-up call can point at
    // that id, and that is the only parent link a nested call has.
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('tool.started', { toolCallId: 'outer', toolName: 'plan' });
    b.push('tool.args.done', { toolCallId: 'outer', args: {} });
    b.push('tool.result', { toolCallId: 'outer', messageId: 'outer-result', content: 'step 1' });
    b.push('tool.started', { toolCallId: 'inner', toolName: 'fetch', parentMessageId: 'outer-result' });
    b.push('tool.result', { toolCallId: 'inner', messageId: 'inner-result', content: 'done' });
    b.finish('success');
    const run = buildTree(b.build());
    const outer = tool(run.children.find((child) => child.kind === 'tool'));
    expect(outer?.toolCallId).toBe('outer');
    expect(outer?.children.map((child) => (child as ToolCallNode).toolCallId)).toEqual(['inner']);
  });

  it('keeps a tool at the root when its parent message never arrives', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('tool.started', { toolCallId: 'tc1', toolName: 'search', parentMessageId: 'never-seen' });
    b.push('tool.result', { toolCallId: 'tc1', messageId: 'tm1', content: 'ok' });
    b.finish('success');
    const run = buildTree(b.build());
    expect(run.children).toHaveLength(1);
    expect(tool(run.children[0]).parentMessageId).toBe('never-seen');
  });

  it('attaches a tool to a message still buffering when the call starts', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('text.delta', { messageId: 'm1', delta: 'calling ' });
    b.push('tool.started', { toolCallId: 'tc1', toolName: 'search', parentMessageId: 'm1' });
    b.push('tool.result', { toolCallId: 'tc1', messageId: 'tm1', content: 'ok' });
    b.push('text.done', { messageId: 'm1', text: 'calling search' });
    b.finish('success');
    const run = buildTree(b.build());
    const m1 = message(run.children.find((child) => child.kind === 'message'));
    expect(m1.children).toHaveLength(1);
    expect(m1.text).toBe('calling search');
    expect(m1.synthesized).toBe(false);
  });

  it('builds a message node for text that never closed', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('text.delta', { messageId: 'm1', delta: 'half a ' });
    b.push('text.delta', { messageId: 'm1', delta: 'sentence' });
    b.finish('success');
    const run = buildTree(b.build());
    const m1 = message(run.children[0]);
    expect(m1.text).toBe('half a sentence');
    expect(m1.synthesized).toBe(true);
  });
});

describe('sub-agent containers', () => {
  it('collects a sub-agent\'s frames into a container', () => {
    const run = buildTree(aguiRun({ withSubagent: true }));
    const nodes = collectSubAgents(run);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.name).toBe('researcher');
    expect(nodes[0]?.status).toBe('ok');
    expect(collectTools(nodes[0]!)).toHaveLength(1);
  });

  it('gives the container a duration and keeps it out of the run root', () => {
    const run = buildTree(aguiRun({ withSubagent: true }));
    const [node] = collectSubAgents(run);
    expect(node?.durationMs).toBeGreaterThan(0);
    expect(run.children.filter((child) => child.kind === 'tool')).toHaveLength(0);
  });

  it('nests a sub-agent that starts while another is open', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('subagent', { phase: 'started', name: 'outer' }, { subagentRunId: 'sub-1' });
    b.push('subagent', { phase: 'started', name: 'inner' }, { subagentRunId: 'sub-2' });
    b.push('subagent', { phase: 'finished', name: 'inner' }, { subagentRunId: 'sub-2' });
    b.push('subagent', { phase: 'finished', name: 'outer' }, { subagentRunId: 'sub-1' });
    b.finish('success');
    const run = buildTree(b.build());
    const outer = subagent(run.children[0]);
    expect(outer.name).toBe('outer');
    expect(outer.children.map((child) => (child as SubAgentNode).name)).toEqual(['inner']);
  });

  it('keeps sequential sub-agents as siblings', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('subagent', { phase: 'started', name: 'first' }, { subagentRunId: 'sub-1' });
    b.push('subagent', { phase: 'finished', name: 'first' }, { subagentRunId: 'sub-1' });
    b.push('subagent', { phase: 'started', name: 'second' }, { subagentRunId: 'sub-2' });
    b.push('subagent', { phase: 'finished', name: 'second' }, { subagentRunId: 'sub-2' });
    b.finish('success');
    const run = buildTree(b.build());
    expect(run.children.filter((child) => child.kind === 'subagent')).toHaveLength(2);
  });

  it('leaves parallel root sub-agents as siblings when nesting is disabled', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('subagent', { phase: 'started', name: 'a' }, { subagentRunId: 'sub-1' });
    b.push('subagent', { phase: 'started', name: 'b' }, { subagentRunId: 'sub-2' });
    b.finish('success');
    const run = buildTree(b.build(), { nestSubagents: false });
    expect(run.children.filter((child) => child.kind === 'subagent')).toHaveLength(2);
  });

  it('records a sub-agent that finished without starting', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('subagent', { phase: 'finished', name: 'ghost', detail: 'completed' }, { subagentRunId: 'sub-9' });
    b.finish('success');
    const [node] = collectSubAgents(buildTree(b.build()));
    expect(node?.status).toBe('orphan');
    expect(node?.startedAt).toBeUndefined();
  });

  it('matches a correlation-less finish to the open sub-agent of that name', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('subagent', { phase: 'started', name: 'worker' }, { subagentRunId: 'sub-1' });
    b.push('subagent', { phase: 'finished', name: 'worker', detail: 'done' });
    b.finish('success');
    const nodes = collectSubAgents(buildTree(b.build()));
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.status).toBe('ok');
  });

  it('marks a sub-agent still open when the run ends as an orphan', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('subagent', { phase: 'started', name: 'worker' }, { subagentRunId: 'sub-1' });
    b.finish('success');
    const [node] = collectSubAgents(buildTree(b.build()));
    expect(node?.status).toBe('orphan');
  });

  it('marks a sub-agent that errored', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('subagent', { phase: 'started', name: 'worker' }, { subagentRunId: 'sub-1' });
    b.push('subagent', { phase: 'error', name: 'worker', detail: 'rate limited' }, { subagentRunId: 'sub-1' });
    b.finish('success');
    const [node] = collectSubAgents(buildTree(b.build()));
    expect(node?.status).toBe('error');
    expect(node?.detail).toBe('rate limited');
  });
});

describe('orphan tool calls', () => {
  it('marks a started call with no result as an orphan once the run is closed', () => {
    const run = buildTree(aguiRun({ withOrphanTool: true }));
    const orphans = collectOrphans(run);
    expect(orphans.map((node) => node.toolCallId)).toContain('tc-hung');
    expect(orphans[0]?.endedAt).toBeGreaterThan(orphans[0]?.startedAt ?? 0);
  });

  it('reports it as pending while the run is live', () => {
    const run = buildTree(aguiRun({ withOrphanTool: true }), { closed: false });
    const nodes = collectTools(run);
    expect(nodes.find((node) => node.toolCallId === 'tc-hung')?.status).toBe('pending');
    expect(collectOrphans(run)).toHaveLength(0);
  });

  it('keeps a result that has no start, marked as an orphan', () => {
    // Dropping it would make the transcript claim the agent never made a call it
    // demonstrably made -- and `diffRuns` could not see the difference either.
    const run = buildTree(aguiRun({ withResultWithoutStart: true }));
    const ghost = collectTools(run).find((node) => node.toolCallId === 'tc-ghost');
    expect(ghost).toBeDefined();
    expect(ghost?.status).toBe('orphan');
    expect(ghost?.result).toBe('orphan output');
    expect(ghost?.startedAt).toBeUndefined();
  });

  it('fills in the name when the late start finally arrives', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('tool.result', { toolCallId: 'tc1', messageId: 'tm1', content: 'early' });
    b.push('tool.started', { toolCallId: 'tc1', toolName: 'search' });
    b.finish('success');
    const [node] = collectTools(buildTree(b.build()));
    expect(node?.name).toBe('search');
    // The late start makes the call attributable, so it stops being an orphan
    // -- but the result already resolved it, so it does not go back to pending.
    expect(node?.status).toBe('ok');
    expect(node?.result).toBe('early');
  });

  it('keeps an orphan when no start ever arrives', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('tool.result', { toolCallId: 'tc1', messageId: 'tm1', content: 'early' });
    b.finish('success');
    const [node] = collectTools(buildTree(b.build()));
    expect(node?.name).toBe(UNNAMED_TOOL);
    expect(node?.status).toBe('orphan');
  });

  it('marks a tool result flagged as an error', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('tool.started', { toolCallId: 'tc1', toolName: 'search' });
    b.push('tool.result', { toolCallId: 'tc1', messageId: 'tm1', content: 'boom', isError: true });
    b.finish('success');
    expect(collectTools(buildTree(b.build()))[0]?.status).toBe('error');
  });

  it('derives a duration when the result frame did not carry one', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('tool.started', { toolCallId: 'tc1', toolName: 'search' });
    b.push('tool.result', { toolCallId: 'tc1', messageId: 'tm1', content: 'ok' });
    b.finish('success');
    expect(collectTools(buildTree(b.build()))[0]?.durationMs).toBe(10);
  });
});

describe('run node and hashing', () => {
  it('reports the run outcome, duration and frame count', () => {
    const run = buildTree(aguiRun());
    expect(run.status).toBe('success');
    expect(run.durationMs).toBe(130);
    expect(run.frameCount).toBe(14);
    expect(run.agentName).toBe('weather-bot');
  });

  it('reports an error outcome when a fatal error frame arrived', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('error', { code: 'X', message: 'boom', fatal: true });
    b.push('run.finished', { outcome: 'success' });
    expect(buildTree(b.build()).status).toBe('error');
  });

  it('reports a run that never finished as running', () => {
    const b = new FrameBuilder();
    b.push('run.started', { agentName: 'x' });
    b.push('text.done', { messageId: 'm1', text: 'partial' });
    expect(buildTree(b.build()).status).toBe('running');
  });

  it('walks parents before children', () => {
    const seen: string[] = [];
    walkTree(buildTree(aguiRun({ withSubagent: true })), (node) => seen.push(node.kind));
    expect(seen[0]).toBe('run');
    expect(seen.filter((kind) => kind === 'tool')).toHaveLength(1);
  });

  it('hashes arguments independently of key order', () => {
    expect(hashArgs({ a: 1, b: 2 })).toBe(hashArgs({ b: 2, a: 1 }));
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
    expect(hashArgs({})).toMatch(/^[0-9a-f]{8}$/);
  });

  it('serialises nested structures stably', () => {
    expect(stableStringify({ b: [1, { d: 2, c: 3 }], a: null })).toBe('{"a":null,"b":[1,{"c":3,"d":2}]}');
    expect(stableStringify(undefined)).toBe('null');
  });

  it('survives a payload that does not match the declared shape', () => {
    const frames = [
      frame('run.started', { agentName: 'x' }),
      frame('tool.started', null as never),
      frame('tool.args.done', undefined as never),
      frame('text.done', undefined as never),
      frame('run.finished', { outcome: 'success' }),
    ];
    expect(() => buildTree(frames)).not.toThrow();
    expect(buildTree(frames).status).toBe('success');
  });

  it('does not throw on a payload with a cycle', () => {
    const cyclic: SurfaceNode = { component: 'Column', children: [] };
    (cyclic.children as SurfaceNode[]).push(cyclic);
    const frames = [
      frame('run.started', { agentName: 'x' }),
      frame('surface.nodes', { surfaceId: 's1', nodes: [cyclic], mode: 'merge' }),
      frame('run.finished', { outcome: 'success' }),
    ];
    expect(() => buildTree(frames)).not.toThrow();
  });

  it('produces an empty tree for an empty transcript', () => {
    const run = buildTree([]);
    expect(run.children).toEqual([]);
    expect(run.status).toBe('running');
    expect(run.runId).toBe('unknown-run');
  });

  it('treats A2UI surface frames as structure, not tool calls', () => {
    const run = buildTree(a2uiRun());
    expect(collectTools(run)).toHaveLength(0);
    expect(run.frameCount).toBe(9);
  });
});
