import { describe, expect, it } from 'vitest';
import { flattenSurface, surfaceSignature, type StatePatch, type SurfaceFrame, type SurfaceNode } from '@agent-surface/protocol';
import { A2uiAdapter } from '../src/adapter.js';
import { A2uiBridge } from '../src/bridge.js';
import { preferredA2uiVersion } from '../src/adapter.js';
import {
  A2UI_V0_9_JSONL,
  A2UI_V0_9_JSONL_WITH_BAD_LINE,
  CREATE_SURFACE_V09,
  DELETE_SURFACE_V09,
  FLAT_CATALOG,
  TEST_CATALOG,
  TEST_CATALOG_ID,
  UPDATE_COMPONENTS_V09,
  UPDATE_DATA_MODEL_V09,
} from './fixtures.js';

const newBridge = (rawCatalogs: unknown[] = [TEST_CATALOG]): A2uiBridge =>
  new A2uiBridge({ rawCatalogs });

const kinds = (frames: readonly { kind: string }[]): string[] => frames.map((f) => f.kind);
const only = <T>(frames: readonly { kind: string; payload: unknown }[], kind: string): T =>
  frames.find((f) => f.kind === kind)?.payload as T;

/**
 * Build a `StatePatch` carrying value-bearing operations.
 *
 * `ir.ts` declares `JsonPatchOperation` as `{op:'add'|'replace'|'remove', path}`
 * with no `value`, so a value-carrying host write is not expressible in the
 * declared type even though `applyPatch` -- the consumer -- requires it. The
 * cast is made once here, mirroring what `A2uiAdapter` does internally.
 */
function statePatch(revision: number, surfaceId: string, operations: unknown[]): StatePatch {
  return { threadId: 'th', runId: 'r', surfaceId, revision, operations } as unknown as StatePatch;
}

describe('headless constraint', () => {
  it('runs with no DOM globals in scope', () => {
    // The protocol path needs none of these. `customElements` is the one
    // exception and is asserted as *present* on purpose: Lit's node build
    // (`@lit/reactive-element/node`) does `global.customElements ??= shim`
    // from `@lit-labs/ssr-dom-shim`, so it is the SSR DOM shim, not a browser.
    // If a browser build of Lit ever leaked in, this assertion is what catches
    // it, because a real customElements registry needs `document`.
    expect(typeof globalThis.document).toBe('undefined');
    expect(typeof globalThis.window).toBe('undefined');
    expect(typeof globalThis.HTMLElement).toBe('undefined');
    expect(typeof globalThis.customElements).toBe('object');
  });

  it('drives the real MessageProcessor with no DOM, and says so', () => {
    const bridge = newBridge();
    // The processor under test is the reference implementation, not a
    // reimplementation: this is the assertion that the isomorphic path works.
    expect(bridge.processor).toBeDefined();
    expect(typeof bridge.processor.processMessages).toBe('function');
    expect(bridge.version).toBe('v0.9');

    const created = bridge.ingest(CREATE_SURFACE_V09);
    expect(kinds(created)).toEqual(['surface.created']);
    bridge.dispose();
  });

  it('builds a whole surface with no DOM and exposes it headlessly', () => {
    const bridge = newBridge();
    bridge.ingest(CREATE_SURFACE_V09);
    bridge.ingest(UPDATE_COMPONENTS_V09);
    bridge.ingest(UPDATE_DATA_MODEL_V09);

    const snapshot = bridge.snapshot('s1');
    expect(snapshot).toBeDefined();
    expect(snapshot?.data).toEqual({ user: { name: 'Ada' } });
    expect(surfaceSignature(snapshot?.nodes ?? [])).toBe(['Column', '  Text', '  Button'].join('\n'));
    bridge.dispose();
  });
});

describe('frame mapping', () => {
  it('createSurface -> surface.created with catalog, data and sendDataModel', () => {
    const bridge = newBridge();
    const payload = only<Record<string, unknown>>(bridge.ingest(CREATE_SURFACE_V09), 'surface.created');
    expect(payload).toEqual({
      surfaceId: 's1',
      catalogId: TEST_CATALOG_ID,
      data: {},
      sendDataModel: true,
    });
    bridge.dispose();
  });

  it('reads a title out of the free-form theme bag when the agent supplies one', () => {
    const bridge = newBridge();
    const payload = only<Record<string, unknown>>(
      bridge.ingest({
        version: 'v0.9',
        createSurface: { surfaceId: 's1', catalogId: TEST_CATALOG_ID, theme: { title: 'Checkout' } },
      }),
      'surface.created',
    );
    expect(payload['title']).toBe('Checkout');
    bridge.dispose();
  });

  it('updateComponents -> surface.nodes in merge mode with nested children', () => {
    const bridge = newBridge();
    bridge.ingest(CREATE_SURFACE_V09);
    const frames = bridge.ingest(UPDATE_COMPONENTS_V09);

    const nodes = only<{ surfaceId: string; nodes: SurfaceNode[]; mode: string }>(frames, 'surface.nodes');
    expect(nodes.mode).toBe('merge');
    expect(nodes.surfaceId).toBe('s1');
    expect(nodes.nodes).toHaveLength(3);

    const root = nodes.nodes[0]!;
    expect(root).toMatchObject({ component: 'Column', id: 'root' });
    expect(root.children?.map((c) => c.id)).toEqual(['greeting', 'cta']);
    expect(root.children?.[0]).toMatchObject({ component: 'Text', id: 'greeting' });
    bridge.dispose();
  });

  it('converts component props to IR Literals and keeps actions as literals', () => {
    const bridge = newBridge();
    bridge.ingest(CREATE_SURFACE_V09);
    const nodes = only<{ nodes: SurfaceNode[] }>(bridge.ingest(UPDATE_COMPONENTS_V09), 'surface.nodes').nodes;

    const greeting = nodes.find((n) => n.id === 'greeting')!;
    expect(greeting.props?.['text']).toEqual({ kind: 'data', ref: { pointer: '/user/name' } });

    const cta = nodes.find((n) => n.id === 'cta')!;
    expect(cta.props?.['label']).toEqual({ kind: 'literal', value: 'Continue' });
    expect(cta.props?.['onClick']).toEqual({ kind: 'literal', value: { event: { name: 'continue' } } });
    // `children` is structural, never a prop.
    expect(nodes[0]!.props).not.toHaveProperty('children');
    bridge.dispose();
  });

  it('updateDataModel -> surface.data in set mode carrying the pointer', () => {
    const bridge = newBridge();
    bridge.ingest(CREATE_SURFACE_V09);
    const payload = only<{ path: string; value: unknown; mode: string }>(
      bridge.ingest(UPDATE_DATA_MODEL_V09),
      'surface.data',
    );
    expect(payload).toEqual({ surfaceId: 's1', path: '/user/name', value: 'Ada', mode: 'set' });
    expect(bridge.snapshot('s1')?.data).toEqual({ user: { name: 'Ada' } });
    bridge.dispose();
  });

  it('defaults an absent path to the surface root', () => {
    const bridge = newBridge();
    bridge.ingest(CREATE_SURFACE_V09);
    const payload = only<{ path: string }>(
      bridge.ingest({ version: 'v0.9', updateDataModel: { surfaceId: 's1', value: { a: 1 } } }),
      'surface.data',
    );
    expect(payload.path).toBe('/');
    bridge.dispose();
  });

  it('deleteSurface -> surface.deleted and drops the surface', () => {
    const bridge = newBridge();
    bridge.ingest(CREATE_SURFACE_V09);
    const frames = bridge.ingest(DELETE_SURFACE_V09);
    expect(only(frames, 'surface.deleted')).toEqual({ surfaceId: 's1' });
    expect(bridge.surfaceIds).toEqual([]);
    bridge.dispose();
  });

  it('re-sending updateComponents merges rather than replaces', () => {
    const bridge = newBridge();
    bridge.ingest(CREATE_SURFACE_V09);
    bridge.ingest(UPDATE_COMPONENTS_V09);
    const second = bridge.ingest({
      version: 'v0.9',
      updateComponents: { surfaceId: 's1', components: [{ id: 'greeting', component: 'Text', text: 'Bye' }] },
    });
    // The delta frame carries only the changed node...
    const delta = only<{ nodes: SurfaceNode[] }>(second, 'surface.nodes').nodes;
    expect(delta.map((n) => n.id)).toEqual(['greeting']);
    // ...while the full state still has all three.
    expect(bridge.snapshot('s1')?.nodes.map((n) => n.id)).toEqual(['root', 'greeting', 'cta']);
    bridge.dispose();
  });
});

describe('version handling', () => {
  it('accepts a v0.9.1 message through a v0.9 processor', () => {
    const bridge = newBridge();
    bridge.ingest(CREATE_SURFACE_V09);
    const frames = bridge.ingest({ ...UPDATE_DATA_MODEL_V09, version: 'v0.9.1' });
    expect(kinds(frames)).toEqual(['surface.data']);
    bridge.dispose();
  });

  it('rejects an unknown version with a warning frame, never a throw', () => {
    const bridge = newBridge();
    const frames = bridge.ingest({ ...CREATE_SURFACE_V09, version: 'v2.0' });
    expect(kinds(frames)).toEqual(['warning']);
    expect(only<{ code: string }>(frames, 'warning').code).toBe('A2UI_UNSUPPORTED_VERSION');
    expect(bridge.surfaceIds).toEqual([]);
    bridge.dispose();
  });

  it('advertises both versions from the processor', () => {
    const adapter = new A2uiAdapter({ rawCatalogs: [TEST_CATALOG] });
    const caps = adapter.getClientCapabilities({ includeInlineCatalogs: true });
    expect(Object.keys(caps).sort()).toEqual(['v0.9', 'v0.9.1']);
    const v091 = caps['v0.9.1'] as { supportedCatalogIds: string[]; inlineCatalogs: unknown[] };
    expect(v091.supportedCatalogIds).toEqual([TEST_CATALOG_ID]);
    expect(v091.inlineCatalogs).toHaveLength(1);
    expect(preferredA2uiVersion()).toBe('v0.9.1');
    adapter.dispose();
  });
});

describe('error tolerance', () => {
  it('turns a duplicate createSurface into a warning carrying the real A2UI code', () => {
    const bridge = newBridge();
    bridge.ingest(CREATE_SURFACE_V09);
    const frames = bridge.ingest(CREATE_SURFACE_V09);
    expect(kinds(frames)).toEqual(['warning']);
    const warning = only<{ code: string; message: string }>(frames, 'warning');
    expect(warning.code).toBe('A2UI_STATE_ERROR');
    expect(warning.message).toContain('already exists');
    bridge.dispose();
  });

  it('warns when a message targets a surface that does not exist', () => {
    const bridge = newBridge();
    const frames = bridge.ingest({ ...UPDATE_DATA_MODEL_V09, updateDataModel: { ...UPDATE_DATA_MODEL_V09.updateDataModel, surfaceId: 'ghost' } });
    expect(only<{ code: string }>(frames, 'warning').code).toBe('A2UI_STATE_ERROR');
    bridge.dispose();
  });

  it('surfaces the catalog strict-prop failure as a validation warning', () => {
    const bridge = newBridge();
    bridge.ingest(CREATE_SURFACE_V09);
    const frames = bridge.ingest({
      version: 'v0.9',
      updateComponents: { surfaceId: 's1', components: [{ id: 'x', component: 'Text', nope: 1 }] },
    });
    const warning = only<{ code: string }>(frames, 'warning');
    expect(warning.code).toBe('A2UI_VALIDATION_ERROR');
    bridge.dispose();
  });

  it('warns about a component the catalog does not describe, but still emits it', () => {
    const bridge = newBridge();
    bridge.ingest(CREATE_SURFACE_V09);
    const frames = bridge.ingest({
      version: 'v0.9',
      updateComponents: { surfaceId: 's1', components: [{ id: 'g', component: 'NotInCatalog' }] },
    });
    expect(kinds(frames)).toEqual(['warning', 'surface.nodes']);
    expect(only<{ code: string }>(frames, 'warning').code).toBe('A2UI_UNKNOWN_COMPONENT');
    expect(only<{ nodes: SurfaceNode[] }>(frames, 'surface.nodes').nodes[0]).toMatchObject({
      component: 'NotInCatalog',
    });
    bridge.dispose();
  });

  it('converts a forbidden data path into a data-error warning', () => {
    const bridge = newBridge();
    bridge.ingest(CREATE_SURFACE_V09);
    const frames = bridge.ingest({
      version: 'v0.9',
      updateDataModel: { surfaceId: 's1', path: '/__proto__/polluted', value: 1 },
    });
    expect(only<{ code: string }>(frames, 'warning').code).toBe('A2UI_DATA_ERROR');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    bridge.dispose();
  });

  it('never throws for a malformed message', () => {
    const bridge = newBridge();
    for (const bad of [null, 42, 'text', [], {}, { version: 'v0.9' }]) {
      expect(() => bridge.ingest(bad)).not.toThrow();
    }
    bridge.dispose();
  });

  it('reports a surface error raised asynchronously through onError', async () => {
    const bridge = newBridge();
    bridge.ingest(CREATE_SURFACE_V09);
    const surface = bridge.processor.model.getSurface('s1')!;

    // `MessageProcessor` never calls dispatchError itself; the DOM node layer
    // does. Subscribing is what catches those, and the frames are queued
    // because `EventEmitter.emit` is async.
    await surface.dispatchError({ code: 'VALIDATION_FAILED', message: 'field required', path: '/a' });
    const frames = await bridge.flushErrors();
    expect(frames).toHaveLength(1);
    const warning = only<{ code: string; detail?: Record<string, unknown> }>(frames, 'warning');
    expect(warning.code).toBe('VALIDATION_FAILED');
    expect(warning.detail).toMatchObject({ surfaceId: 's1', path: '/a' });
    bridge.dispose();
  });
});

describe('tree extraction', () => {
  it('resolves a named child slot from a raw ComponentId catalog ref', () => {
    const bridge = newBridge();
    bridge.ingest(CREATE_SURFACE_V09);
    bridge.ingest({
      version: 'v0.9',
      updateComponents: {
        surfaceId: 's1',
        components: [
          { id: 'card', component: 'Card', header: 'title', body: 'greeting' },
          { id: 'title', component: 'Text', text: 'Title' },
          { id: 'greeting', component: 'Text', text: { path: '/user/name' } },
        ],
      },
    });
    const nodes = bridge.snapshot('s1')?.nodes ?? [];
    const card = nodes.find((n) => n.id === 'card')!;
    expect(card.slots?.['header']).toMatchObject({ component: 'Text', id: 'title' });
    expect(card.slots?.['body']).toMatchObject({ component: 'Text', id: 'greeting' });
    // Child refs are structural, so they never appear as props.
    expect(card.props).not.toHaveProperty('header');
    bridge.dispose();
  });

  it('survives a self-referencing child cycle instead of recursing forever', () => {
    const bridge = newBridge();
    bridge.ingest(CREATE_SURFACE_V09);
    expect(() =>
      bridge.ingest({
        version: 'v0.9',
        updateComponents: { surfaceId: 's1', components: [{ id: 'root', component: 'Column', children: ['root'] }] },
      }),
    ).not.toThrow();

    const flat = flattenSurface(bridge.snapshot('s1')?.nodes ?? []);
    expect(flat.map((n) => n.id)).toEqual(['root']);
    bridge.dispose();
  });

  it('mounts a placeholder for a child that has not arrived yet', () => {
    const bridge = newBridge();
    bridge.ingest(CREATE_SURFACE_V09);
    bridge.ingest({
      version: 'v0.9',
      updateComponents: { surfaceId: 's1', components: [{ id: 'root', component: 'Column', children: ['later'] }] },
    });
    const root = bridge.snapshot('s1')?.nodes[0]!;
    expect(root.children).toEqual([{ component: 'Unknown', id: 'later', props: {} }]);
    bridge.dispose();
  });

  it('handles a catalog that declares no children at all', () => {
    const bridge = new A2uiBridge({ rawCatalogs: [FLAT_CATALOG] });
    bridge.ingest({ version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: 'flat' } });
    bridge.ingest({
      version: 'v0.9',
      updateComponents: { surfaceId: 's1', components: [{ id: 't', component: 'Text', text: 'hi' }] },
    });
    expect(bridge.snapshot('s1')?.nodes[0]).toMatchObject({ component: 'Text', id: 't' });
    bridge.dispose();
  });
});

describe('A2uiAdapter', () => {
  it('stamps every frame with a gap-free sequence and correlation ids', () => {
    const adapter = new A2uiAdapter({ rawCatalogs: [TEST_CATALOG] });
    const frames = [
      ...adapter.ingest({ threadId: 'th', runId: 'run', raw: CREATE_SURFACE_V09 }),
      ...adapter.ingest({ threadId: 'th', runId: 'run', raw: UPDATE_COMPONENTS_V09 }),
      ...adapter.ingest({ threadId: 'th', runId: 'run', raw: UPDATE_DATA_MODEL_V09 }),
    ] as SurfaceFrame[];

    expect(frames.map((f) => f.seq)).toEqual([0, 1, 2]);
    for (const frame of frames) {
      expect(frame.source).toBe('a2ui');
      expect(frame.threadId).toBe('th');
      expect(frame.runId).toBe('run');
      expect(typeof frame.ts).toBe('number');
    }
    adapter.dispose();
  });

  it('reads a JSONL text stream across chunk boundaries', () => {
    const adapter = new A2uiAdapter({ rawCatalogs: [TEST_CATALOG] });
    const text = `${A2UI_V0_9_JSONL}\n`;
    const frames: SurfaceFrame[] = [];
    for (const char of text) {
      frames.push(...adapter.ingest({ threadId: 'th', runId: 'r', text: char }));
    }
    expect(kinds(frames)).toEqual(['surface.created', 'surface.nodes', 'surface.data', 'surface.deleted']);
    adapter.dispose();
  });

  it('warns on a malformed JSONL line and keeps consuming the stream', () => {
    const adapter = new A2uiAdapter({ rawCatalogs: [TEST_CATALOG] });
    const frames = [...adapter.ingest({ threadId: 'th', runId: 'r', text: A2UI_V0_9_JSONL_WITH_BAD_LINE })];
    expect(kinds(frames)).toContain('warning');
    const warning = only<{ code: string }>(frames, 'warning');
    expect(warning.code).toBe('JSONL_INVALID_JSON');
    // The messages after the bad line still landed.
    expect(adapter.bridge.snapshot('s1')?.data).toEqual({ user: { name: 'Ada' } });
    adapter.dispose();
  });

  it('buffers a trailing line until the transport is flushed', () => {
    const adapter = new A2uiAdapter({ rawCatalogs: [TEST_CATALOG] });
    const withoutNewline = JSON.stringify(CREATE_SURFACE_V09);

    // Split mid-message: nothing is emitted until the line is terminated.
    const half = Math.floor(withoutNewline.length / 2);
    expect([...adapter.ingest({ threadId: 'th', runId: 'r', text: withoutNewline.slice(0, half) })]).toEqual([]);
    expect([...adapter.ingest({ threadId: 'th', runId: 'r', text: withoutNewline.slice(half) })]).toEqual([]);

    // The stream ended without a newline, which is still a complete record.
    const flushed = adapter.flushTransport({ threadId: 'th', runId: 'r' });
    expect(kinds(flushed)).toEqual(['surface.created']);
    expect(adapter.bridge.surfaceIds).toEqual(['s1']);
    adapter.dispose();
  });

  it('accepts a message array and an A2uiMessageListWrapper', () => {
    const adapter = new A2uiAdapter({ rawCatalogs: [TEST_CATALOG] });
    const arrayFrames = [
      ...adapter.ingest({
        threadId: 'a',
        runId: 'r',
        raw: [{ ...CREATE_SURFACE_V09, createSurface: { ...CREATE_SURFACE_V09.createSurface, surfaceId: 'fromArray' } }],
      }),
    ];
    expect(kinds(arrayFrames)).toEqual(['surface.created']);

    const wrapperFrames = [
      ...adapter.ingest({
        threadId: 'b',
        runId: 'r',
        raw: {
          messages: [
            { ...CREATE_SURFACE_V09, createSurface: { ...CREATE_SURFACE_V09.createSurface, surfaceId: 'fromWrapper' } },
          ],
        },
      }),
    ];
    expect(kinds(wrapperFrames)).toEqual(['surface.created']);
    expect(adapter.bridge.surfaceIds.sort()).toEqual(['fromArray', 'fromWrapper']);
    adapter.dispose();
  });

  it('registers an inline catalog the agent shipped in its capabilities', () => {
    const adapter = new A2uiAdapter({
      agentCapabilities: {
        agentName: 'tester',
        'v0.9': { supportedCatalogIds: ['agent-supplied'], inlineCatalogs: [TEST_CATALOG] },
      },
    });
    expect(adapter.agentName).toBe('tester');
    const caps = adapter.getClientCapabilities();
    expect(caps['v0.9']).toMatchObject({ supportedCatalogIds: [TEST_CATALOG_ID] });
    adapter.dispose();
  });

  it('encodes a user action as an A2UI client action plus an optimistic patch', () => {
    const adapter = new A2uiAdapter({ rawCatalogs: [TEST_CATALOG] });
    adapter.ingest({ threadId: 'th', runId: 'r', raw: CREATE_SURFACE_V09 });

    const encoded = adapter.encodeAction({
      surfaceId: 's1',
      componentId: 'cta',
      name: 'click',
      value: 'submitted',
    });
    expect(encoded.protocol).toBe('a2ui');
    const action = (encoded.input as { action: Record<string, unknown> }).action;
    expect(action).toMatchObject({
      name: 'click',
      surfaceId: 's1',
      sourceComponentId: 'cta',
      context: { value: 'submitted' },
    });
    expect(typeof action['timestamp']).toBe('string');
    expect(encoded.patch.operations).toEqual([
      { op: 'add', path: '/_action/cta/click', value: 'submitted' },
    ]);
    adapter.dispose();
  });

  it('uses an agent-supplied action path and appends the data-model sync', () => {
    const adapter = new A2uiAdapter({ rawCatalogs: [TEST_CATALOG] });
    adapter.ingest({ threadId: 'th', runId: 'r', raw: CREATE_SURFACE_V09 });

    const encoded = adapter.encodeAction({
      surfaceId: 's1',
      componentId: 'cta',
      name: 'click',
      value: 7,
      context: { path: '/user/name' },
    });
    expect(encoded.patch.operations).toEqual([{ op: 'add', path: '/user/name', value: 7 }]);
    // s1 opted into sendDataModel, so the sync block rides along.
    expect(encoded.input['dataModel']).toEqual({ version: 'v0.9', surfaces: { s1: {} } });
    adapter.dispose();
  });

  it('omits the patch entirely for a valueless action', () => {
    const adapter = new A2uiAdapter({ rawCatalogs: [TEST_CATALOG] });
    expect(adapter.encodeAction({ surfaceId: 's1', componentId: 'c', name: 'focus' }).patch.operations).toEqual([]);
    adapter.dispose();
  });

  it('applies local state idempotently and suppresses a replayed revision', () => {
    const adapter = new A2uiAdapter({ rawCatalogs: [TEST_CATALOG] });
    adapter.ingest({ threadId: 'th', runId: 'r', raw: CREATE_SURFACE_V09 });

    const first = statePatch(1, 's1', [{ op: 'add', path: '/local/count', value: 1 }]);
    adapter.applyLocalState(first);
    expect(adapter.localData('s1')).toEqual({ local: { count: 1 } });
    expect(adapter.localRevision('s1')).toBe(1);

    // Replaying the same patch is a no-op, not a double-apply.
    adapter.applyLocalState(first);
    expect(adapter.localData('s1')).toEqual({ local: { count: 1 } });
    expect(adapter.localRevision('s1')).toBe(1);

    // A newer revision does apply.
    adapter.applyLocalState(statePatch(2, 's1', [{ op: 'add', path: '/local/count', value: 2 }]));
    expect(adapter.localData('s1')).toEqual({ local: { count: 2 } });
    expect(adapter.localRevision('s1')).toBe(2);

    // A stale revision arriving late is ignored.
    adapter.applyLocalState(statePatch(1, 's1', [{ op: 'add', path: '/local/count', value: 99 }]));
    expect(adapter.localData('s1')).toEqual({ local: { count: 2 } });
    adapter.dispose();
  });

  it('rejects a patch the shared applyPatch implementation refuses', () => {
    const adapter = new A2uiAdapter({ rawCatalogs: [TEST_CATALOG] });
    adapter.applyLocalState(statePatch(1, 's9', [{ op: 'remove', path: '/missing' }]));
    expect(adapter.localData('s9')).toBeUndefined();
    expect(adapter.localRevision('s9')).toBeUndefined();
    adapter.dispose();
  });

  it('seeds local state from the surface the bridge already holds', () => {
    const adapter = new A2uiAdapter({ rawCatalogs: [TEST_CATALOG] });
    adapter.ingest({ threadId: 'th', runId: 'r', raw: CREATE_SURFACE_V09 });
    adapter.ingest({ threadId: 'th', runId: 'r', raw: UPDATE_DATA_MODEL_V09 });
    expect(adapter.localData('s1')).toBeUndefined();
    // With no local doc yet, a host write is validated against the surface data.
    adapter.applyLocalState(statePatch(1, 's1', [{ op: 'add', path: '/user/seen', value: true }]));
    expect(adapter.localData('s1')).toMatchObject({ user: { name: 'Ada', seen: true } });
    adapter.dispose();
  });
});
