import { describe, expect, it, vi } from 'vitest';
import {
  AppBridge,
  BridgeClosedError,
  BridgeTimeoutError,
  asBridgeWindow,
  hostMessageSchema,
  postMessageTargetFor,
  type BridgeMessageEvent,
  type BridgeWindow,
} from '../src/bridge.js';
import type { BridgeFeatures } from '../src/policy.js';

const ALL: BridgeFeatures = { postMessage: true, toolInvoke: true, a2a: true, heightResize: true };

class FakeFrame implements BridgeWindow {
  readonly listenerCount = { value: 0 };
  readonly sent: Array<{ message: unknown; targetOrigin: string }> = [];
  readonly #listeners = new Set<(event: BridgeMessageEvent) => void>();

  addEventListener(_type: 'message', listener: (event: BridgeMessageEvent) => void): void {
    this.#listeners.add(listener);
    this.listenerCount.value = this.#listeners.size;
  }

  removeEventListener(_type: 'message', listener: (event: BridgeMessageEvent) => void): void {
    this.#listeners.delete(listener);
    this.listenerCount.value = this.#listeners.size;
  }

  postMessage(message: unknown, targetOrigin: string): void {
    this.sent.push({ message, targetOrigin });
  }

  /** Simulate the frame answering. */
  deliver(data: unknown, origin = 'https://frame.example', source: unknown = this): void {
    const event: BridgeMessageEvent = { data, origin, source };
    for (const listener of [...this.#listeners]) listener(event);
  }

  get lastId(): string {
    const last = this.sent[this.sent.length - 1]?.message as { id?: string } | undefined;
    return last?.id ?? '';
  }
}

function makeBridge(overrides: Partial<ConstructorParameters<typeof AppBridge>[0]> = {}) {
  const frame = new FakeFrame();
  const bridge = new AppBridge({
    targetWindow: frame,
    expectedOrigin: 'https://frame.example',
    appId: 'mcp-app-x',
    features: ALL,
    requestTimeoutMs: 40,
    ...overrides,
  });
  return { frame, bridge };
}

describe('AppBridge: target origin', () => {
  it('refuses to be constructed with a "*" target origin', () => {
    expect(() => makeBridge({ expectedOrigin: '*' })).toThrow(/"\*"/);
  });

  it('always posts to the exact expected origin, never "*"', () => {
    const { frame, bridge } = makeBridge();
    void bridge.request('theme', { theme: 'dark' }).catch(() => undefined);
    expect(frame.sent).toHaveLength(1);
    expect(frame.sent[0]?.targetOrigin).toBe('https://frame.example');
    bridge.destroy();
  });

  it('posts to the opaque origin for a srcdoc frame, which is still an exact match', () => {
    const { frame, bridge } = makeBridge({ expectedOrigin: 'null' });
    void bridge.request('theme', { theme: 'light' }).catch(() => undefined);
    expect(frame.sent[0]?.targetOrigin).toBe('null');
    bridge.destroy();
  });

  it('resolves a frame origin to a usable postMessage target and never to "*"', () => {
    expect(postMessageTargetFor('https://a.example/x?y=1')).toBe('https://a.example');
    expect(postMessageTargetFor('null')).toBe('null');
    expect(() => postMessageTargetFor('nonsense')).toThrow(/refusing to fall back/);
  });
});

describe('AppBridge: inbound validation', () => {
  it('drops a message whose origin is not the frame origin and counts it', () => {
    const { frame, bridge } = makeBridge();
    const seen: string[] = [];
    bridge.onRejected((reason) => seen.push(reason));
    frame.deliver({ v: 1, dir: 'app', type: 'ready', payload: {} }, 'https://evil.example');
    expect(bridge.stats.rejectedOrigin).toBe(1);
    expect(seen).toEqual(['ORIGIN_MISMATCH']);
    expect(bridge.stats.accepted).toBe(0);
    bridge.destroy();
  });

  it('drops a message from a window other than the frame when the host knows the reference', () => {
    const { frame, bridge } = makeBridge({ expectedSource: { win: true } });
    const seen: string[] = [];
    bridge.onRejected((reason) => seen.push(reason));
    frame.deliver({ v: 1, dir: 'app', type: 'ready', payload: {} }, 'https://frame.example', { other: true });
    expect(bridge.stats.rejectedSource).toBe(1);
    expect(seen).toEqual(['SOURCE_MISMATCH']);
    bridge.destroy();
  });

  it('drops a malformed payload instead of partially applying it', () => {
    const { frame, bridge } = makeBridge();
    let ready = 0;
    bridge.on('ready', () => {
      ready++;
    });
    frame.deliver({ v: 1, dir: 'app', type: 'ready', payload: { appName: 42 } });
    frame.deliver({ v: 2, dir: 'app', type: 'ready', payload: {} });
    frame.deliver('not an object');
    frame.deliver({ v: 1, dir: 'host', type: 'init', id: 'x', payload: {} });
    frame.deliver({ v: 1, dir: 'app', type: 'statePatch', payload: { operations: 'nope' } });
    expect(ready).toBe(0);
    expect(bridge.stats.rejectedInvalid).toBe(5);
    bridge.destroy();
  });

  it('rejects a statePatch larger than the cap rather than parsing it', () => {
    const { frame, bridge } = makeBridge();
    const operations = Array.from({ length: 300 }, (_, i) => ({ op: 'add' as const, path: `/${i}`, value: 1 }));
    frame.deliver({ v: 1, dir: 'app', type: 'statePatch', payload: { operations } });
    expect(bridge.stats.rejectedInvalid).toBe(1);
    bridge.destroy();
  });

  it('refuses a toolInvoke whose arguments are too large to forward', () => {
    const { frame, bridge } = makeBridge();
    const seen: string[] = [];
    bridge.onRejected((reason, detail) => seen.push(`${reason}:${detail}`));
    let called = false;
    bridge.on('toolInvoke', () => {
      called = true;
    });
    frame.deliver({
      v: 1,
      dir: 'app',
      type: 'toolInvoke',
      id: '1',
      payload: { toolName: 'ingest', args: { blob: 'x'.repeat(70_000) } },
    });
    expect(called).toBe(false);
    expect(seen[0]).toMatch(/INVALID_MESSAGE:toolInvoke args exceed/);
    bridge.destroy();
  });

  it('refuses an oversized a2a body', () => {
    const { frame, bridge } = makeBridge();
    let called = false;
    bridge.on('a2a', () => {
      called = true;
    });
    frame.deliver({ v: 1, dir: 'app', type: 'a2a', id: '1', payload: { to: 'peer', text: 'x'.repeat(20_000) } });
    expect(called).toBe(false);
    expect(bridge.stats.rejectedInvalid).toBe(1);
    bridge.destroy();
  });
});

describe('AppBridge: policy gating', () => {
  it('refuses toolInvoke when policy did not grant it, even from the right origin', () => {
    const { frame, bridge } = makeBridge({ features: { ...ALL, toolInvoke: false } });
    const seen: string[] = [];
    bridge.onRejected((reason, detail) => seen.push(`${reason}:${detail}`));
    let called = false;
    bridge.on('toolInvoke', () => {
      called = true;
    });
    frame.deliver({ v: 1, dir: 'app', type: 'toolInvoke', id: '1', payload: { toolName: 'delete_all', args: {} } });
    expect(called).toBe(false);
    expect(bridge.stats.rejectedFeature).toBe(1);
    expect(seen[0]).toContain('delete_all');
    bridge.destroy();
  });

  it('refuses a2a and height when those features are off', () => {
    const { frame, bridge } = makeBridge({ features: { postMessage: true, toolInvoke: true, a2a: false, heightResize: false } });
    let events = 0;
    bridge.on('a2a', () => events++);
    bridge.on('height', () => events++);
    frame.deliver({ v: 1, dir: 'app', type: 'a2a', id: '1', payload: { to: 'peer', text: 'hi' } });
    frame.deliver({ v: 1, dir: 'app', type: 'height', payload: { heightPx: 100 } });
    expect(events).toBe(0);
    expect(bridge.stats.rejectedFeature).toBe(2);
    await_bridge_destroy(bridge);
  });

  it('delivers a well-formed message the policy did grant', () => {
    const { frame, bridge } = makeBridge();
    const got: unknown[] = [];
    bridge.on('toolInvoke', (payload) => got.push(payload));
    frame.deliver({ v: 1, dir: 'app', type: 'toolInvoke', id: '1', payload: { toolName: 'refresh', args: { id: 7 } } });
    expect(got).toEqual([{ toolName: 'refresh', args: { id: 7 } }]);
    expect(bridge.stats.accepted).toBe(1);
    bridge.destroy();
  });

  it('clamps a height beyond maxFrameHeightPx and counts it', () => {
    const { frame, bridge } = makeBridge({ maxFrameHeightPx: 800 });
    const heights: number[] = [];
    bridge.on('height', (payload) => heights.push(payload.heightPx));
    frame.deliver({ v: 1, dir: 'app', type: 'height', payload: { heightPx: 99999 } });
    frame.deliver({ v: 1, dir: 'app', type: 'height', payload: { heightPx: -5 } });
    frame.deliver({ v: 1, dir: 'app', type: 'height', payload: { heightPx: 300.7 } });
    expect(heights).toEqual([800, 80, 300]);
    expect(bridge.stats.clampedHeights).toBe(2);
    bridge.destroy();
  });

  it('survives a handler that throws', () => {
    const { frame, bridge } = makeBridge();
    const after: string[] = [];
    bridge.on('statePatch', () => {
      throw new Error('host bug');
    });
    bridge.on('statePatch', () => after.push('second'));
    expect(() =>
      frame.deliver({ v: 1, dir: 'app', type: 'statePatch', payload: { operations: [{ op: 'add', path: '/a', value: 1 }] } }),
    ).not.toThrow();
    expect(after).toEqual(['second']);
    bridge.destroy();
  });
});

describe('AppBridge: request correlation and timeouts', () => {
  it('correlates a response to its request by id and ignores a stale one', async () => {
    const { frame, bridge } = makeBridge();
    const first = bridge.request('theme', { theme: 'dark' });
    const second = bridge.request('resize', { heightPx: 100 });
    expect(bridge.pendingCount).toBe(2);
    frame.deliver({ v: 1, dir: 'app', type: 'ready', id: 'host-2', payload: { appName: 'x' } });
    expect(bridge.pendingCount).toBe(1);
    frame.deliver({ v: 1, dir: 'app', type: 'ready', id: 'host-1', payload: {} });
    await expect(first).resolves.toEqual({});
    await expect(second).resolves.toEqual({ appName: 'x' });
    expect(bridge.pendingCount).toBe(0);
    bridge.destroy();
  });

  it('rejects a request with a clear timeout error and forgets it', async () => {
    const { bridge } = makeBridge({ requestTimeoutMs: 15 });
    const promise = bridge.request('theme', { theme: 'dark' });
    await expect(promise).rejects.toBeInstanceOf(BridgeTimeoutError);
    await expect(promise).rejects.toThrow(/theme did not answer within 15ms/);
    expect(bridge.stats.timeouts).toBe(1);
    expect(bridge.pendingCount).toBe(0);
    bridge.destroy();
  });

  it('honours a per-request timeout override', async () => {
    const { bridge } = makeBridge({ requestTimeoutMs: 10_000 });
    const promise = bridge.request('theme', { theme: 'dark' }, 10);
    await expect(promise).rejects.toThrow(/within 10ms/);
    bridge.destroy();
  });

  it('does not time out a request that already answered', async () => {
    vi.useFakeTimers();
    try {
      const { frame, bridge } = makeBridge({ requestTimeoutMs: 50 });
      const promise = bridge.request('theme', { theme: 'dark' });
      frame.deliver({ v: 1, dir: 'app', type: 'ready', id: 'host-1', payload: {} });
      await expect(promise).resolves.toEqual({});
      vi.advanceTimersByTime(500);
      expect(bridge.stats.timeouts).toBe(0);
      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects with the app error code when the app answers with an error', async () => {
    const { frame, bridge } = makeBridge();
    const promise = bridge.request('theme', { theme: 'dark' });
    frame.deliver({ v: 1, dir: 'app', type: 'error', id: 'host-1', payload: { code: 'DENIED', message: 'nope' } });
    await expect(promise).rejects.toThrow('nope');
    bridge.destroy();
  });

  it('reports a postMessage failure as a rejection rather than a stuck promise', async () => {
    const frame = new FakeFrame();
    frame.postMessage = () => {
      throw new Error('detached frame');
    };
    const bridge = new AppBridge({
      targetWindow: frame,
      expectedOrigin: 'https://frame.example',
      appId: 'x',
      features: ALL,
      requestTimeoutMs: 50,
    });
    await expect(bridge.request('theme', { theme: 'dark' })).rejects.toThrow('detached frame');
    expect(bridge.pendingCount).toBe(0);
    bridge.destroy();
  });
});

describe('AppBridge: init and teardown', () => {
  it('init sends host capabilities, theme and the data model, and resolves on ready', async () => {
    const { frame, bridge } = makeBridge();
    const promise = bridge.init({ theme: 'dark', locale: 'ko-KR', dataModel: { city: 'Incheon' } });
    const sent = frame.sent[0]?.message as { type: string; id: string; payload: Record<string, unknown> };
    expect(sent.type).toBe('init');
    expect(sent.payload['hostContext']).toMatchObject({ theme: 'dark', locale: 'ko-KR', dataModel: { city: 'Incheon' } });
    expect(sent.payload['hostCapabilities']).toMatchObject({ toolInvoke: true, a2a: true, heightResize: true });
    expect(hostMessageSchema.safeParse(frame.sent[0]?.message).success).toBe(true);
    frame.deliver({ v: 1, dir: 'app', type: 'ready', id: sent.id, payload: { appName: 'clock' } });
    await expect(promise).resolves.toMatchObject({ appName: 'clock' });
    expect(bridge.ready).toBe(true);
    bridge.destroy();
  });

  it('teardown removes the listener, clears the timers and rejects everything in flight', async () => {
    const { frame, bridge } = makeBridge({ requestTimeoutMs: 10_000 });
    const pending = [bridge.request('theme', { theme: 'dark' }), bridge.request('resize', { heightPx: 10 })];
    const rejection = Promise.all(pending.map((p) => p.catch((err: unknown) => err)));
    expect(frame.listenerCount.value).toBe(1);

    bridge.destroy('run ended');

    expect(frame.listenerCount.value).toBe(0);
    expect(bridge.destroyed).toBe(true);
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.ready).toBe(false);
    for (const err of await rejection) {
      expect(err).toBeInstanceOf(BridgeClosedError);
      expect((err as Error).message).toBe('run ended');
    }
  });

  it('ignores every message that arrives after teardown', () => {
    const { frame, bridge } = makeBridge();
    let events = 0;
    bridge.on('ready', () => events++);
    bridge.destroy();
    frame.deliver({ v: 1, dir: 'app', type: 'ready', payload: {} });
    expect(events).toBe(0);
    expect(bridge.stats.accepted).toBe(0);
  });

  it('refuses to send after teardown', async () => {
    const { frame, bridge } = makeBridge();
    bridge.destroy();
    await expect(bridge.request('theme', { theme: 'dark' })).rejects.toBeInstanceOf(BridgeClosedError);
    await expect(bridge.setFrameHeight(100)).rejects.toBeInstanceOf(BridgeClosedError);
    expect(frame.sent).toHaveLength(0);
  });

  it('is idempotent on teardown and stops the request timer from firing later', async () => {
    vi.useFakeTimers();
    try {
      const { frame, bridge } = makeBridge({ requestTimeoutMs: 50 });
      const promise = bridge.request('theme', { theme: 'dark' }).catch((err: unknown) => err);
      bridge.destroy();
      bridge.destroy();
      expect(frame.listenerCount.value).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(((await promise) as Error).message).toMatch(/tore down/);
      expect(bridge.stats.timeouts).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('setFrameHeight refuses to negotiate a resize when the policy withheld heightResize', async () => {
    const { bridge } = makeBridge({ features: { ...ALL, heightResize: false } });
    await expect(bridge.setFrameHeight(200)).rejects.toThrow(/not granted by policy/);
    bridge.destroy();
  });
});

describe('asBridgeWindow', () => {
  it('produces a BridgeWindow from a DOM window without touching it', () => {
    const fake = { postMessage: () => undefined } as unknown as Window;
    expect(typeof asBridgeWindow(fake).postMessage).toBe('function');
  });
});

function await_bridge_destroy(bridge: AppBridge): void {
  bridge.destroy();
}
