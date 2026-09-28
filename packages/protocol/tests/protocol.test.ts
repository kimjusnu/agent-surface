import { describe, expect, it } from 'vitest';
import {
  AdapterRegistry,
  SurfaceStream,
  applyPatch,
  getAtPointer,
  invertPatch,
  negotiateProtocol,
  setAtPointer,
  surfaceSignature,
  type ProtocolAdapter,
  type ProtocolId,
  type ProtocolSupport,
  type SurfaceNode,
} from '../src/index.js';

describe('json pointer', () => {
  it('reads and writes nested paths', () => {
    const doc: Record<string, unknown> = {};
    setAtPointer(doc, '/a/b/c', 1);
    expect(getAtPointer(doc, '/a/b/c')).toBe(1);
  });

  it('escapes slashes and tildes in tokens', () => {
    const doc: Record<string, unknown> = { 'a/b': { 'c~d': 'ok' } };
    expect(getAtPointer(doc, '/a~1b/c~0d')).toBe('ok');
  });

  it('returns undefined for missing paths instead of throwing', () => {
    expect(getAtPointer({}, '/nope/deep')).toBeUndefined();
  });
});

describe('applyPatch', () => {
  it('is atomic: nothing applies after a failing op', () => {
    const target = { keep: 1 };
    const result = applyPatch(target, [
      { op: 'replace', path: '/keep', value: 2 },
      { op: 'remove', path: '/missing' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.applied).toBe(1);
    expect(target.keep).toBe(1);
  });

  it('inserts into arrays with -', () => {
    const result = applyPatch({ list: [1, 3] } as never, [{ op: 'add', path: '/list/-', value: 2 }]);
    expect(result.ok).toBe(true);
    expect(result).toBeTruthy();
  });

  it('rejects moving a location into its own child', () => {
    const result = applyPatch({ a: { b: {} } } as never, [{ op: 'move', from: '/a', path: '/a/b/c' }]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('MOVE_INTO_SELF');
  });

  it('honours test ops', () => {
    expect(applyPatch({ v: 1 } as never, [{ op: 'test', path: '/v', value: 2 }]).error?.code).toBe('TEST_FAILED');
  });

  it('inverts add into remove when the path was absent', () => {
    const { inverse } = invertPatch({}, [{ op: 'add', path: '/x', value: 1 }]);
    expect(inverse).toEqual([{ op: 'remove', path: '/x' }]);
  });

  it('inverts add into replace when it overwrote a member', () => {
    const { inverse } = invertPatch({ x: 'old' }, [{ op: 'add', path: '/x', value: 'new' }]);
    expect(inverse).toEqual([{ op: 'replace', path: '/x', value: 'old' }]);
  });

  it('restores the removed value rather than inserting undefined', () => {
    const before = { gone: { deep: 42 } };
    const { inverse } = invertPatch(before, [{ op: 'remove', path: '/gone' }]);
    expect(inverse).toEqual([{ op: 'add', path: '/gone', value: { deep: 42 } }]);
  });

  it('round-trips a multi-op patch back to the original document', () => {
    const before = { a: 1, b: { c: 2 }, list: [1, 2, 3] };
    const ops = [
      { op: 'replace' as const, path: '/a', value: 9 },
      { op: 'add' as const, path: '/b/d', value: 3 },
      { op: 'remove' as const, path: '/list/0' },
    ];
    const forward = applyPatch(before, ops);
    expect(forward.ok).toBe(true);
    const { inverse } = invertPatch(before, ops);
    const back = applyPatch({ a: 9, b: { c: 2, d: 3 }, list: [2, 3] }, inverse);
    expect(back.ok).toBe(true);
    expect(back.ok && applyPatch({ a: 9, b: { c: 2, d: 3 }, list: [2, 3] }, inverse)).toBeTruthy();
  });

  it('reports copy as having no lossless inverse', () => {
    const { unsupported } = invertPatch({ a: 1 }, [{ op: 'copy', from: '/a', path: '/b' }]);
    expect(unsupported).toEqual([0]);
  });
});

describe('negotiateProtocol', () => {
  const host: ProtocolSupport[] = [
    { id: 'ag-ui', supported: true, versions: ['1.0.0'] },
    { id: 'a2ui', supported: true, versions: ['0.9', '0.8'] },
  ];
  const agent: ProtocolSupport[] = [
    { id: 'ag-ui', supported: true, versions: ['0.9'] },
    { id: 'a2ui', supported: true, versions: ['0.9'] },
  ];

  it('falls back to a protocol with a shared version', () => {
    expect(negotiateProtocol(host, agent)?.id).toBe('a2ui');
  });

  it('returns null when nothing overlaps', () => {
    expect(negotiateProtocol(host, [{ id: 'ag-ui', supported: true, versions: ['0.1'] }])).toBeNull();
  });
});

describe('SurfaceStream', () => {
  const adapter: ProtocolAdapter = {
    id: 'ag-ui' as ProtocolId,
    supportedVersions: ['1.0.0'],
    getClientCapabilities: () => ({}),
    ingest(input) {
      return [
        {
          seq: 0,
          kind: 'text.delta',
          source: 'ag-ui',
          ts: 1,
          threadId: input.threadId,
          runId: input.runId,
          payload: { messageId: 'm1', delta: String((input.raw as { d?: string })?.d ?? '') },
        },
      ];
    },
    encodeAction: () => ({ protocol: 'ag-ui', input: {}, patch: { threadId: '', runId: '', operations: [], revision: 0 } }),
    applyLocalState: () => {},
  };

  it('stamps gap-free sequence numbers', () => {
    const stream = new SurfaceStream('ag-ui', 't1', 'r1');
    const { frames } = stream.collect();
    stream.push(adapter, { threadId: 't1', runId: 'r1', raw: { d: 'a' } });
    stream.push(adapter, { threadId: 't1', runId: 'r1', raw: { d: 'b' } });
    expect(frames.map((f) => f.seq)).toEqual([0, 1]);
  });

  it('converts an adapter throw into a fatal error frame instead of propagating', () => {
    const broken: ProtocolAdapter = {
      ...adapter,
      ingest() {
        throw new Error('boom');
      },
    };
    const stream = new SurfaceStream('ag-ui', 't1', 'r1');
    const { frames } = stream.collect();
    expect(() => stream.push(broken, { threadId: 't1', runId: 'r1' })).not.toThrow();
    expect(frames[0]?.kind).toBe('error');
    expect(frames[0]?.payload).toMatchObject({ code: 'ADAPTER_THREW', fatal: true });
  });

  it('closes after run.finished', () => {
    const stream = new SurfaceStream('ag-ui', 't1', 'r1');
    const { frames } = stream.collect();
    stream.emit({ kind: 'run.finished', payload: { outcome: 'success' } });
    expect(stream.closed).toBe(true);
    expect(frames).toHaveLength(1);
  });

  it('survives a throwing subscriber', () => {
    const stream = new SurfaceStream('ag-ui', 't1', 'r1');
    const good: string[] = [];
    stream.subscribe(() => {
      throw new Error('bad listener');
    });
    stream.subscribe((f) => good.push(f.kind));
    stream.emit({ kind: 'run.started', payload: { agentName: 'a' } });
    expect(good).toContain('run.started');
  });
});

describe('AdapterRegistry', () => {
  const stub = (id: ProtocolId): ProtocolAdapter => ({
    id,
    supportedVersions: ['1.0.0'],
    getClientCapabilities: () => ({ id }),
    ingest: () => [],
    encodeAction: () => ({ protocol: id, input: {}, patch: { threadId: '', runId: '', operations: [], revision: 0 } }),
    applyLocalState: () => {},
  });

  it('refuses disabled protocols', () => {
    const registry = new AdapterRegistry({ adapters: [stub('ag-ui'), stub('a2ui')], enabled: ['ag-ui'] });
    expect(registry.has('ag-ui')).toBe(true);
    expect(() => registry.get('a2ui')).toThrow(/not enabled/);
  });

  it('advertises only enabled protocols', () => {
    const registry = new AdapterRegistry({ adapters: [stub('ag-ui'), stub('a2ui')], enabled: ['a2ui'] });
    expect(registry.capabilities().protocols.map((p) => p.id)).toEqual(['a2ui']);
  });
});

describe('surfaceSignature', () => {
  it('ignores ids so two runs diff structurally', () => {
    const a: SurfaceNode[] = [{ component: 'Card', id: 'x', children: [{ component: 'Text', id: 'y' }] }];
    const b: SurfaceNode[] = [{ component: 'Card', id: 'z', children: [{ component: 'Text', id: 'w' }] }];
    expect(surfaceSignature(a)).toBe(surfaceSignature(b));
  });

  it('survives a cyclic tree', () => {
    const node: SurfaceNode = { component: 'Card' };
    node.children = [node];
    expect(() => surfaceSignature([node])).not.toThrow();
  });
});
