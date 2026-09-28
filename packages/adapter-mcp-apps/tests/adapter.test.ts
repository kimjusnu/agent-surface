import { describe, expect, it } from 'vitest';
import { McpAppsAdapter } from '../src/adapter.js';
import { MCP_APPS_EXTENSION_ID, MCP_APPS_MIME_TYPE, collectText, isUiMimeType, isUiResourceUri, parseMcpToolCallResult } from '../src/mcp-tools.js';
import type { SurfaceFrame } from '@agent-surface/protocol';

const HOST = 'https://surface.example';

/** UTF-8 base64 without a Node global, so the suite needs no ambient types. */
function base64(value: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function warningCodes(frames: SurfaceFrame[]): string[] {
  return frames.filter((f) => f.kind === 'warning').map((f) => (f.payload as { code: string }).code);
}

function warningMessages(frames: SurfaceFrame[]): string[] {
  return frames.filter((f) => f.kind === 'warning').map((f) => (f.payload as { message: string }).message);
}

function warningCodeOf(frame: SurfaceFrame): string {
  return (frame.payload as { code?: string }).code ?? '';
}

const HTML = '<!doctype html><html><head><title>Weather</title></head><body><h1 id="t">--</h1><script>listen()</script></body></html>';

function toolResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: [
      { type: 'text', text: 'Sunny, 24C' },
      {
        type: 'resource',
        resource: {
          uri: 'ui://weather/app.html',
          name: 'Weather Dashboard',
          mimeType: MCP_APPS_MIME_TYPE,
          text: HTML,
          _meta: { ui: { csp: { connectDomains: ['https://api.example'], resourceDomains: ['https://cdn.example'] } } },
        },
      },
    ],
    _meta: { ui: { resourceUri: 'ui://weather/app.html' }, toolName: 'get_weather' },
    ...overrides,
  };
}

function makeAdapter(overrides: Partial<ConstructorParameters<typeof McpAppsAdapter>[0]> = {}): McpAppsAdapter {
  return new McpAppsAdapter({
    hostOrigin: HOST,
    allowedOrigins: ['https://cdn.example', 'https://api.example'],
    toolInvokeOrigin: 'https://api.example',
    now: () => 1_700_000_000_000,
    ...overrides,
  });
}

function ingest(adapter: McpAppsAdapter, raw: unknown): SurfaceFrame[] {
  return [...adapter.ingest({ threadId: 't1', runId: 'r1', raw })];
}

describe('parseMcpToolCallResult', () => {
  it('finds the ui:// resource, its HTML, its title and the text fallback', () => {
    const parsed = parseMcpToolCallResult(toolResult());
    expect(parsed.resource).not.toBeNull();
    expect(parsed.resource?.uri).toBe('ui://weather/app.html');
    expect(parsed.resource?.html).toBe(HTML);
    expect(parsed.resource?.title).toBe('Weather Dashboard');
    expect(parsed.resource?.requestedSandbox).toBe('sandboxed-scripts');
    expect(parsed.resource?.csp).toEqual({
      connectDomains: ['https://api.example'],
      resourceDomains: ['https://cdn.example'],
    });
    expect(parsed.textFallback).toBe('Sunny, 24C');
  });

  it('decodes a base64 ui resource blob', () => {
    const b64 = base64(HTML);
    const parsed = parseMcpToolCallResult({
      content: [{ type: 'resource', resource: { uri: 'ui://a/b', mimeType: MCP_APPS_MIME_TYPE, blob: b64 } }],
    });
    expect(parsed.resource?.html).toBe(HTML);
  });

  it('accepts a plain text content block that is obviously a document', () => {
    const parsed = parseMcpToolCallResult({ content: [{ type: 'text', text: HTML }] });
    expect(parsed.resource?.html).toBe(HTML);
    expect(parsed.notes.join(' ')).toMatch(/plain text content block/);
  });

  it('honors the deprecated flat _meta["ui/resourceUri"] and says so', () => {
    const parsed = parseMcpToolCallResult({ content: [{ type: 'text', text: 'x' }], _meta: { 'ui/resourceUri': 'ui://legacy/app' } });
    expect(parsed.resource?.uri).toBe('ui://legacy/app');
    expect(parsed.notes.join(' ')).toMatch(/deprecated/);
  });

  it('honors the OpenAI _meta["openai/outputTemplate"] shape', () => {
    const parsed = parseMcpToolCallResult({
      content: [{ type: 'text', text: 'x' }],
      _meta: { 'openai/outputTemplate': 'ui://openai/app.html' },
    });
    expect(parsed.resource?.uri).toBe('ui://openai/app.html');
  });

  it('reports a referenced resource with no body so the host knows it must read it', () => {
    const parsed = parseMcpToolCallResult({ content: [{ type: 'text', text: 'x' }], _meta: { ui: { resourceUri: 'ui://a/b' } } });
    expect(parsed.resource?.html).toBeNull();
    expect(parsed.notes.join(' ')).toMatch(/must read the resource/);
  });

  it('returns no resource for a plain tool result', () => {
    const parsed = parseMcpToolCallResult({ content: [{ type: 'text', text: 'just text' }], isError: false });
    expect(parsed.resource).toBeNull();
    expect(parsed.textFallback).toBe('just text');
  });

  it('reads the declared bridge version from _meta and from a document meta', () => {
    expect(parseMcpToolCallResult({ content: [{ type: 'text', text: 'x' }], _meta: { ui: { resourceUri: 'ui://a', bridgeVersion: '0.2' } } }).resource?.bridgeVersion).toBe('0.2');
    const html = '<head><meta name="agent-surface:bridge-version" content="0.2"></head>';
    expect(parseMcpToolCallResult({ content: [{ type: 'resource', resource: { uri: 'ui://a', mimeType: MCP_APPS_MIME_TYPE, text: html } }] }).resource?.bridgeVersion).toBe('0.2');
    expect(parseMcpToolCallResult({ content: [{ type: 'text', text: 'x' }], _meta: { ui: { resourceUri: 'ui://a', bridgeVersion: '9' } } }).resource?.bridgeVersion).toBe('0.1');
  });

  it('reads declared sandbox, permissions, domain and prefersBorder', () => {
    const parsed = parseMcpToolCallResult({
      content: [{ type: 'text', text: 'x' }],
      _meta: {
        ui: {
          resourceUri: 'ui://a',
          title: 'Custom',
          sandbox: 'allow-same-origin',
          domain: 'a.claudemcpcontent.com',
          prefersBorder: true,
          permissions: { camera: {}, geolocation: {} },
        },
      },
    });
    expect(parsed.resource?.title).toBe('Custom');
    expect(parsed.resource?.requestedSandbox).toBe('allow-same-origin');
    expect(parsed.resource?.domain).toBe('a.claudemcpcontent.com');
    expect(parsed.resource?.prefersBorder).toBe(true);
    expect(parsed.resource?.permissions).toEqual({ camera: {}, geolocation: {} });
  });

  it('merges _meta.ui per field so a tool-level sandbox is not lost to a content-level csp', () => {
    const parsed = parseMcpToolCallResult({
      content: [
        { type: 'text', text: 'x' },
        {
          type: 'resource',
          resource: {
            uri: 'ui://a/b',
            mimeType: MCP_APPS_MIME_TYPE,
            text: HTML,
            _meta: { ui: { csp: { resourceDomains: ['https://cdn.example'] } } },
          },
        },
      ],
      _meta: { ui: { resourceUri: 'ui://a/b', sandbox: 'allow-all', title: 'Tool Level' } },
    });
    expect(parsed.resource?.csp.resourceDomains).toEqual(['https://cdn.example']);
    expect(parsed.resource?.requestedSandbox).toBe('allow-all');
    expect(parsed.resource?.title).toBe('Tool Level');
  });

  it('lets the content item override a field the tool result also declared', () => {
    const parsed = parseMcpToolCallResult({
      content: [
        {
          type: 'resource',
          resource: {
            uri: 'ui://a/b',
            mimeType: MCP_APPS_MIME_TYPE,
            text: HTML,
            _meta: { ui: { sandbox: 'sandboxed', title: 'Content Level' } },
          },
        },
      ],
      _meta: { ui: { resourceUri: 'ui://a/b', sandbox: 'allow-all', title: 'Tool Level' } },
    });
    expect(parsed.resource?.requestedSandbox).toBe('sandboxed');
    expect(parsed.resource?.title).toBe('Content Level');
  });

  it('is total: it never throws on nonsense input', () => {
    for (const input of [null, undefined, 42, 'text', [], { content: 7 }, { content: [null, 3] }, { _meta: 5 }]) {
      expect(() => parseMcpToolCallResult(input)).not.toThrow();
    }
    expect(parseMcpToolCallResult(undefined).resource).toBeNull();
  });

  it('exposes the small helpers it is built from', () => {
    expect(isUiMimeType('text/html;profile=mcp-app')).toBe(true);
    expect(isUiMimeType('text/html+skybridge')).toBe(true);
    expect(isUiMimeType('application/json')).toBe(false);
    expect(isUiResourceUri('UI://x')).toBe(true);
    expect(isUiResourceUri('https://x')).toBe(false);
    expect(collectText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('a\nb');
  });
});

describe('McpAppsAdapter: client capabilities', () => {
  it('advertises the MCP Apps extension, the bridge features and the security posture', () => {
    const caps = makeAdapter().getClientCapabilities();
    expect(caps['extensions']).toEqual({ [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APPS_MIME_TYPE] } });
    expect(caps['hostCapabilities']).toMatchObject({ supportsEmbeddedApps: true, maxFrameHeightPx: 2000 });
    expect(caps['hostCapabilities']).toMatchObject({
      bridge: { postMessage: true, toolInvoke: true, a2a: true, heightResize: true },
    });
    expect(caps['security']).toMatchObject({ allowUntrustedCode: false });
    expect(JSON.stringify(caps)).not.toContain('undefined');
  });

  it('reports allowUntrustedCode honestly instead of defaulting it on', () => {
    expect(makeAdapter({ allowUntrustedCode: true }).getClientCapabilities()['security']).toMatchObject({
      allowUntrustedCode: true,
    });
  });

  it('states which sandbox postures it will refuse so an agent can size its app correctly', () => {
    const policy = makeAdapter().getClientCapabilities()['security'] as { sandboxPolicy: { refuses: string[] } };
    expect(policy.sandboxPolicy.refuses).toContain('allow-scripts + allow-same-origin');
  });

  it('omits inline catalogs unless asked, and then returns an empty list', () => {
    expect(makeAdapter().getClientCapabilities()['inlineCatalogs']).toBeUndefined();
    expect(makeAdapter().getClientCapabilities({ includeInlineCatalogs: true })['inlineCatalogs']).toEqual([]);
  });

  it('refuses to be constructed without a hostOrigin', () => {
    expect(() => new McpAppsAdapter({ hostOrigin: '' })).toThrow(/hostOrigin/);
  });

  it('reports its identity and bridge versions', () => {
    const adapter = makeAdapter();
    expect(adapter.id).toBe('mcp-apps');
    expect(adapter.supportedVersions).toEqual(['0.1', '0.2']);
  });
});

describe('McpAppsAdapter: ingest', () => {
  it('emits app.attached for a tool result that carries an allowlisted ui resource', () => {
    const frames = ingest(makeAdapter(), toolResult());
    const attached = frames.find((f) => f.kind === 'app.attached');
    expect(attached).toBeDefined();
    const app = attached?.payload as unknown as { app: Record<string, unknown> };
    expect(app.app['title']).toBe('Weather Dashboard');
    expect(app.app['sandbox']).toBe('sandboxed-scripts');
    expect(app.app['untrusted']).toBe(true);
    expect(app.app['transport']).toBe('postmessage');
    expect(String(app.app['src'])).toContain('Content-Security-Policy');
    expect(attached?.raw).toMatchObject({ frame: { attribute: 'srcdoc', heightPx: 240 } });
  });

  it('downgrades a refused sandbox on the attached app instead of trusting the declaration', () => {
    const hostile = toolResult({
      content: [
        { type: 'text', text: 'x' },
        {
          type: 'resource',
          resource: {
            uri: 'ui://weather/app.html',
            name: 'Evil',
            mimeType: MCP_APPS_MIME_TYPE,
            text: HTML,
          },
        },
      ],
      _meta: { ui: { resourceUri: 'ui://weather/app.html', sandbox: 'allow-scripts-same-origin' }, toolName: 'get_weather' },
    });
    const frames = ingest(makeAdapter(), hostile);
    const attached = frames.find((f) => f.kind === 'app.attached');
    expect(attached).toBeDefined();
    // The agent asked for the escape combination; the host did not grant it.
    expect((attached?.payload as { app: { sandbox: string } }).app.sandbox).toBe('sandboxed-scripts');
    expect(warningMessages(frames).some((w) => w.includes('sandbox escape'))).toBe(true);
  });

  it('denies a javascript: frame identity outright with no app.attached at all', () => {
    const frames = ingest(
      makeAdapter(),
      toolResult({
        content: [
          { type: 'text', text: 'Sunny, 24C' },
          {
            type: 'resource',
            resource: { uri: 'javascript:alert(1)', name: 'Evil', mimeType: MCP_APPS_MIME_TYPE, text: HTML },
          },
        ],
        _meta: { toolName: 'get_weather' },
      }),
    );
    expect(frames.some((f) => f.kind === 'app.attached')).toBe(false);
    const denial = frames.find((f) => f.kind === 'warning' && warningCodeOf(f) === 'APP_POLICY_DENIED');
    expect((denial?.payload as { message: string }).message).toMatch(/javascript:/);
    // The model still gets its text fallback, so a refused app is not a lost turn.
    expect((denial?.payload as { detail: Record<string, unknown> }).detail['textFallback']).toBe('Sunny, 24C');
  });

  it('emits a warning frame carrying the scanner findings alongside the attach', () => {
    const dirty = toolResult();
    (dirty['content'] as Array<Record<string, unknown>>)[1] = {
      type: 'resource',
      resource: {
        uri: 'ui://weather/app.html',
        name: 'Weather',
        mimeType: MCP_APPS_MIME_TYPE,
        text: '<!doctype html><html><head></head><body onload="x()"><script>localStorage.clear()</script></body></html>',
      },
    };
    const frames = ingest(makeAdapter(), dirty);
    expect(frames.some((f) => f.kind === 'app.attached')).toBe(true);
    expect(warningCodes(frames)).toContain('APP_FINDING_INLINE_EVENT_HANDLER');
    expect(warningCodes(frames)).toContain('APP_FINDING_LOCAL_STORAGE');
  });

  it('emits nothing for a plain tool result with no UI, which is the normal case', () => {
    const frames = ingest(makeAdapter(), { content: [{ type: 'text', text: 'just text' }] });
    expect(frames).toHaveLength(0);
  });

  it('unwraps a JSON-RPC response envelope', () => {
    const frames = ingest(makeAdapter(), { jsonrpc: '2.0', id: 7, result: toolResult() });
    expect(frames.some((f) => f.kind === 'app.attached')).toBe(true);
  });

  it('parses a JSONL text body when no decoded value was supplied', () => {
    const frames = [...makeAdapter().ingest({ threadId: 't1', runId: 'r1', text: JSON.stringify(toolResult()) })];
    expect(frames.some((f) => f.kind === 'app.attached')).toBe(true);
  });

  it('turns an unparseable body into a warning frame instead of throwing', () => {
    const frames = [...makeAdapter().ingest({ threadId: 't1', runId: 'r1', text: '{not json' })];
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe('warning');
    expect((frames[0]?.payload as { code: string }).code).toBe('MCP_UNPARSEABLE_BODY');
  });

  it('handles a missing body without throwing', () => {
    const frames = [...makeAdapter().ingest({ threadId: 't1', runId: 'r1' })];
    expect((frames[0]?.payload as { code: string }).code).toBe('MCP_EMPTY_BODY');
  });

  it('never throws on hostile input of any shape', () => {
    const adapter = makeAdapter();
    for (const raw of [null, undefined, 0, '', [], [1, 2], { content: [{ type: 'resource', resource: 5 }] }, { _meta: { ui: 'x' } }]) {
      expect(() => [...adapter.ingest({ threadId: 't', runId: 'r', raw })]).not.toThrow();
    }
  });

  it('stamps thread, run, source and a monotonic seq on every frame it emits', () => {
    const frames = ingest(
      makeAdapter(),
      toolResult({
        content: [
          { type: 'text', text: 'x' },
          { type: 'resource', resource: { uri: 'ui://a', mimeType: MCP_APPS_MIME_TYPE, text: '<body onclick="x()">y</body>' } },
        ],
        _meta: { ui: { resourceUri: 'ui://a' }, toolName: 't' },
      }),
    );
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.source).toBe('mcp-apps');
      expect(frame.threadId).toBe('t1');
      expect(frame.runId).toBe('r1');
      expect(frame.ts).toBe(1_700_000_000_000);
    }
  });

  it('remembers the last policy decision so the host can render an audit line', () => {
    const adapter = makeAdapter();
    ingest(adapter, toolResult());
    const decision = adapter.lastDecision('get_weather');
    expect(decision?.allowed).toBe(true);
    expect(decision?.audit.sourceUri).toBe('ui://weather/app.html');
    expect(adapter.lastDecision('never-called')).toBeUndefined();
  });

  it('applies the declared CSP only where the allowlist permits', () => {
    const frames = ingest(
      makeAdapter({ allowedOrigins: ['https://cdn.example'] }),
      toolResult({
        content: [
          { type: 'text', text: 'x' },
          {
            type: 'resource',
            resource: {
              uri: 'ui://weather/app.html',
              name: 'Weather',
              mimeType: MCP_APPS_MIME_TYPE,
              text: HTML,
              _meta: { ui: { csp: { connectDomains: ['https://evil.example'], resourceDomains: ['https://cdn.example'] } } },
            },
          },
        ],
        _meta: { ui: { resourceUri: 'ui://weather/app.html' }, toolName: 'get_weather' },
      }),
    );
    const attached = frames.find((f) => f.kind === 'app.attached');
    const document = String((attached?.payload as { app: { src: string } }).app.src);
    expect(document).toContain('https://cdn.example');
    expect(document).not.toContain('evil.example');
  });

  it('sizes the initial frame with the host default; MCP servers declare no height', () => {
    const frames = ingest(makeAdapter(), toolResult());
    const attached = frames.find((f) => f.kind === 'app.attached');
    expect((attached?.payload as { app: { height: number } }).app.height).toBe(240);
    expect(attached?.raw).toMatchObject({ frame: { heightClamped: false } });
  });

  it('propagates maxFrameHeightPx to the advertised capabilities and the policy', () => {
    const adapter = makeAdapter({ maxFrameHeightPx: 320 });
    expect(adapter.getClientCapabilities()['hostCapabilities']).toMatchObject({ maxFrameHeightPx: 320 });
    ingest(adapter, toolResult());
    expect(adapter.lastDecision('get_weather')?.bounds.maxHeightPx).toBe(320);
  });
});

describe('McpAppsAdapter: actions and local state', () => {
  it('encodeAction returns a bridge marker and an empty patch, never a run input', () => {
    const encoded = makeAdapter().encodeAction({
      surfaceId: 'app-1',
      componentId: 'btn',
      name: 'onClick',
      value: 7,
      context: { tool: 'refresh' },
    });
    expect(encoded.protocol).toBe('mcp-apps');
    expect(Object.keys(encoded.input)).toEqual(['mcp-apps/bridgeAction']);
    expect(encoded.input['mcp-apps/bridgeAction']).toEqual({
      surfaceId: 'app-1',
      componentId: 'btn',
      name: 'onClick',
      value: 7,
      context: { tool: 'refresh' },
    });
    expect(encoded.patch.operations).toEqual([]);
    expect(encoded.patch.revision).toBe(0);
  });

  it('encodeAction omits value and context when the interaction carried none', () => {
    const encoded = makeAdapter().encodeAction({ surfaceId: 'a', componentId: 'b', name: 'onHover' });
    expect(encoded.input['mcp-apps/bridgeAction']).toEqual({ surfaceId: 'a', componentId: 'b', name: 'onHover' });
  });

  it('applyLocalState is a safe no-op for any patch, including a malformed one', () => {
    const adapter = makeAdapter();
    const patch = { threadId: 't', runId: 'r', operations: [{ op: 'replace', path: '/a' }], revision: 1 } as never;
    expect(() => {
      adapter.applyLocalState(patch);
      adapter.applyLocalState(patch);
      adapter.applyLocalState(undefined as never);
    }).not.toThrow();
    expect(adapter.lastDecision('get_weather')).toBeUndefined();
  });
});
