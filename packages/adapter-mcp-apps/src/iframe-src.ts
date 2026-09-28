/**
 * Frame source construction.
 *
 * An MCP App document is agent-authored HTML. Everything here exists to answer
 * one question: "what exactly do we hand to the `src`/`srcdoc` attribute of the
 * iframe, and can we prove the document cannot navigate or script the host?"
 *
 * The answer is always one of two shapes:
 *   - a remote `https:` URL we did not author, in which case the strict CSP has
 *     to arrive as a response header (see `PolicyDecision.csp`), or
 *   - a `srcdoc` document we rewrite ourselves, in which case the strict CSP is
 *     injected as the first element of `<head>` and no agent-supplied CSP meta
 *     survives.
 *
 * Spec: SEP-1865 "MCP Apps" -- `McpUiResourceCsp` maps declared domains onto
 * CSP directives, and the host "MAY further restrict but MUST NOT allow
 * undeclared domains". We take the second half literally: the agent's own CSP
 * is a request, never an input to our policy.
 */

export const OPAQUE_ORIGIN = 'null';

export type FrameSourceRejectionCode =
  | 'EMPTY_SRC'
  | 'UNSAFE_SCHEME'
  | 'UNSUPPORTED_SCHEME'
  | 'INSECURE_SCHEME'
  | 'LOOPBACK_NOT_ALLOWED'
  | 'CREDENTIALS_IN_URL'
  | 'DATA_URL_NOT_HTML'
  | 'BLOB_NOT_TRUSTED'
  | 'UNRESOLVED_UI_RESOURCE'
  | 'MALFORMED_URL';

export type FrameSourceKind = 'inline' | 'remote';

export interface FrameSourceOk {
  ok: true;
  kind: FrameSourceKind;
  /**
   * The origin the frame document will run under, or {@link OPAQUE_ORIGIN} for
   * `srcdoc`/allowlisted `blob:`. `'self'` in a CSP built from an opaque frame
   * matches nothing, which is the point: the document can only load what we
   * listed.
   */
  origin: string;
  /** The `ui://`/resource identity the HTML came from, for audit logs. */
  sourceUri: string | null;
  /** Inline HTML awaiting {@link materializeFrameSource}. Absent for `remote`. */
  html: string | null;
  /** The validated URL, for `remote`. */
  url: string | null;
  notes: string[];
}

export interface FrameSourceRejected {
  ok: false;
  code: FrameSourceRejectionCode;
  reason: string;
}

export type FrameSourceClassification = FrameSourceOk | FrameSourceRejected;

export interface ClassifyFrameSourceInput {
  src: string;
  /**
   * Pre-resolved document body. MCP Apps servers hand the host a `ui://`
   * resource the host fetched with `resources/read`; when we have that HTML we
   * never navigate to `src` at all, we inline it.
   */
  html?: string | null;
  /** Development mode. Only gates loopback `http:`. */
  dev?: boolean;
  /** Exact `blob:` URLs the host itself created and is willing to load. */
  trustedBlobUrls?: readonly string[];
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const IDENTITY_REFUSED_SCHEMES = new Set(['javascript', 'vbscript', 'livescript', 'mocha', 'data']);

/**
 * Scheme sniffing that leading whitespace, control characters and case cannot
 * hide behind. `new URL()` normalizes some of these for us but not
 * `java&#9;script:`, which browsers have historically accepted.
 */
const SCHEME_RE = /^[\s\p{Cc}\p{Cf}]*([a-zA-Z][a-zA-Z0-9+.-]*):/u;

function readScheme(raw: string): string | null {
  const match = SCHEME_RE.exec(raw);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Mirror the URL parser's own preprocessing: strip every ASCII tab, LF and CR
 * from anywhere in the string, then leading C0 controls and spaces. Without
 * this, `java&#9;script:alert(1)` -- which a browser happily resolves to
 * `javascript:alert(1)` -- would sail past our scheme check.
 */
function normalizeUrlInput(raw: string): string {
  return raw.replace(/[\t\n\r]+/g, '').replace(/^[\s\p{Cc}\p{Cf}]+/u, '');
}

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * Decide what kind of frame source we are dealing with, without committing to
 * a document body. Split from {@link materializeFrameSource} so the policy
 * engine can learn the frame origin before it builds a CSP that mentions it.
 */
export function classifyFrameSource(input: ClassifyFrameSourceInput): FrameSourceClassification {
  const notes: string[] = [];
  const src = typeof input.src === 'string' ? normalizeUrlInput(input.src) : '';

  if (typeof input.html === 'string' && input.html.trim().length > 0) {
    // The resolved document wins, but the identity is still checked: an app that
    // pairs real HTML with a `javascript:` or `data:` identity is telling us it
    // expected the host to navigate somewhere, and a renderer that ever prefers
    // `src` over `srcdoc` would execute it.
    const identityScheme = src.length > 0 ? readScheme(src) : null;
    if (identityScheme !== null && IDENTITY_REFUSED_SCHEMES.has(identityScheme)) {
      return {
        ok: false,
        code: 'UNSAFE_SCHEME',
        reason: `${identityScheme}: appeared as the frame identity alongside a resolved document; an app may only identify itself with ui:/about: when the host already holds the HTML`,
      };
    }
    return {
      ok: true,
      kind: 'inline',
      origin: OPAQUE_ORIGIN,
      sourceUri: src.length > 0 && !isDocumentUri(src) ? src : null,
      html: input.html,
      url: null,
      notes,
    };
  }

  if (src.length === 0) {
    return {
      ok: false,
      code: 'EMPTY_SRC',
      reason: 'no frame source: src was empty and no resolved document was supplied',
    };
  }

  const scheme = readScheme(src);
  if (scheme === null) {
    return {
      ok: false,
      code: 'UNSUPPORTED_SCHEME',
      reason: `"${truncate(src)}" is a relative reference; an iframe src must be absolute. A relative src would resolve against the host origin and load a host page inside the frame.`,
    };
  }

  switch (scheme) {
    case 'javascript':
    case 'vbscript':
    case 'livescript':
    case 'mocha':
      return {
        ok: false,
        code: 'UNSAFE_SCHEME',
        reason: `${scheme}: executes in the frame's own context with no URL provenance; refused unconditionally, including in development.`,
      };

    case 'data': {
      const decoded = decodeDataUrl(src);
      if (decoded === null) {
        return {
          ok: false,
          code: 'DATA_URL_NOT_HTML',
          reason: 'data: URL is not text/html; only an HTML document can be given a CSP we control',
        };
      }
      notes.push('data:text/html converted to srcdoc so the strict CSP can be injected as a meta tag');
      return {
        ok: true,
        kind: 'inline',
        origin: OPAQUE_ORIGIN,
        sourceUri: null,
        html: decoded,
        url: null,
        notes,
      };
    }

    case 'blob': {
      const allow = input.trustedBlobUrls ?? [];
      if (!allow.includes(src)) {
        return {
          ok: false,
          code: 'BLOB_NOT_TRUSTED',
          reason: 'blob: URLs are only loadable when the host created them itself and passed the exact URL in trustedBlobUrls; an agent-supplied blob: could point at any document the host can reach',
        };
      }
      // A blob: URL serializes no origin, so we cannot prove what it resolves
      // to. It is allowlisted by construction, but it is still an opaque frame.
      return {
        ok: true,
        kind: 'remote',
        origin: OPAQUE_ORIGIN,
        sourceUri: null,
        html: null,
        url: src,
        notes,
      };
    }

    case 'ui':
      return {
        ok: false,
        code: 'UNRESOLVED_UI_RESOURCE',
        reason: 'ui:// resources are MCP resource identities, not fetchable URLs; the host must read the resource (resources/read) and pass the document as html',
      };

    case 'http':
    case 'https': {
      let url: URL;
      try {
        url = new URL(src);
      } catch {
        return { ok: false, code: 'MALFORMED_URL', reason: `"${truncate(src)}" is not a parseable absolute URL` };
      }
      if (url.username.length > 0 || url.password.length > 0) {
        return {
          ok: false,
          code: 'CREDENTIALS_IN_URL',
          reason: 'URL carries embedded credentials; the browser would send them to the frame origin and leak them into the frame URL bar',
        };
      }
      if (url.protocol === 'http:') {
        if (!input.dev) {
          return {
            ok: false,
            code: 'LOOPBACK_NOT_ALLOWED',
            reason: `http:// to a loopback address is a development-only affordance and dev mode is off (${url.hostname})`,
          };
        }
        if (!isLoopback(url.hostname)) {
          return {
            ok: false,
            code: 'INSECURE_SCHEME',
            reason: `http://${url.hostname} is cleartext; only loopback addresses may be loaded over http, and only in dev`,
          };
        }
        notes.push('loopback http: accepted because dev mode is on');
      }
      return { ok: true, kind: 'remote', origin: url.origin, sourceUri: null, html: null, url: url.toString(), notes };
    }

    default:
      return {
        ok: false,
        code: 'UNSUPPORTED_SCHEME',
        reason: `${scheme}: is not a loadable frame source; allowed schemes are https:, http: (loopback, dev only), data:text/html and host-created blob:`,
      };
  }
}

export interface MaterializeOptions {
  /** Exact CSP content to inject. Required for inline documents. */
  csp: string;
  /** Nonce applied to the app's own inline scripts. Required for inline documents. */
  nonce?: string | null;
}

export interface MaterializedFrame {
  attribute: 'src' | 'srcdoc';
  value: string;
  /** Present for `srcdoc`. */
  document: string | null;
  notes: string[];
}

export function materializeFrameSource(
  classified: FrameSourceOk,
  options: MaterializeOptions,
): MaterializedFrame {
  if (classified.kind === 'remote') {
    if (classified.url === null) {
      throw new Error('materializeFrameSource: remote classification without a url');
    }
    return { attribute: 'src', value: classified.url, document: null, notes: classified.notes };
  }
  if (classified.html === null) {
    throw new Error('materializeFrameSource: inline classification without a document');
  }
  const built = buildSrcdocDocument(classified.html, options);
  return {
    attribute: 'srcdoc',
    value: built.document,
    document: built.document,
    notes: [...classified.notes, ...built.notes],
  };
}

export interface SrcdocBuildResult {
  document: string;
  notes: string[];
  /** Inline scripts that received the host nonce. */
  noncedScripts: number;
}

const META_TAG_RE = /<meta\b[^>]*>/gi;
const HTTP_EQUIV_ATTR_RE = /http-equiv\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const BASE_TAG_RE = /<base\b[^>]*>/gi;
const SCRIPT_OPEN_RE = /<script\b([^>]*)>/gi;
const NONCE_ATTR_RE = /\s*nonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const SCRIPT_TYPE_ATTR_RE = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/**
 * Remove `<meta http-equiv=...>` tags the host refuses. Matching the whole tag
 * first and then reading its `http-equiv` is the only way to tell a real CSP
 * meta from a `<meta name="description" content="... CSP ...">`.
 */
function stripMetaByHttpEquiv(
  html: string,
  isTarget: (httpEquiv: string) => boolean,
  label: string,
): { html: string; count: number } {
  let count = 0;
  const out = html.replace(META_TAG_RE, (tag) => {
    const match = HTTP_EQUIV_ATTR_RE.exec(tag);
    const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').toLowerCase();
    if (!isTarget(value)) return tag;
    count++;
    return `<!-- ${label} removed by host policy -->`;
  });
  return { html: out, count };
}

const isCspHttpEquiv = (value: string): boolean =>
  value === 'content-security-policy' || value.startsWith('content-security-policy-');

/**
 * `type` values on `<script>` that a browser actually executes. Anything else
 * (`application/json`, `text/template`, ...) is a data block: a nonce on it
 * changes nothing about its trust, and adding one only muddies the document.
 */
const EXECUTABLE_SCRIPT_TYPES = new Set([
  'module',
  'importmap',
  'speculationrules',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
]);

/**
 * Rewrite an agent-authored document into one we are willing to load.
 *
 * Three agent-controlled constructs are removed outright, because each of them
 * is a way to defeat the policy we are about to apply:
 *   - an existing CSP meta, which the agent could ship a permissive one in. Two
 *     enforcing policies intersect rather than override, but a `report-only`
 *     one is still an exfiltration channel for the report URI, and an agent that
 *     ships its own policy has already told us it expects to be able to weaken
 *     ours,
 *   - `<base>`, which rewrites every relative URL in the document and would
 *     re-point the app's own resource loads,
 *   - `<meta http-equiv="refresh">`, which navigates the frame to a document we
 *     never inspected, losing the frame's origin and its bridge.
 *
 * Known limitation: this is a regex rewrite, so a `<script` or `<base` sequence
 * inside a comment or a JS string literal will be rewritten too. That is
 * acceptable only because the CSP -- not this rewrite -- is what actually
 * enforces the boundary.
 */
export function buildSrcdocDocument(
  html: string,
  options: { csp: string; nonce?: string | null },
): SrcdocBuildResult {
  const notes: string[] = [];

  let body = html;
  const cspStrip = stripMetaByHttpEquiv(body, isCspHttpEquiv, 'app-supplied csp meta');
  body = cspStrip.html;
  if (cspStrip.count > 0) {
    notes.push(`removed ${cspStrip.count} agent-supplied Content-Security-Policy meta tag(s): an app may not weaken the host policy`);
  }
  const baseTags = body.match(BASE_TAG_RE);
  if (baseTags && baseTags.length > 0) {
    body = body.replace(BASE_TAG_RE, '');
    notes.push('removed <base>: it would re-point every relative URL in the document');
  }
  const refreshStrip = stripMetaByHttpEquiv(body, (value) => value === 'refresh', 'app-supplied navigation meta');
  body = refreshStrip.html;
  if (refreshStrip.count > 0) {
    notes.push('removed <meta http-equiv="refresh">: it would navigate the frame to an unreviewed document');
  }

  let noncedScripts = 0;
  if (options.nonce) {
    const nonce = options.nonce;
    body = body.replace(SCRIPT_OPEN_RE, (whole, attrs: string) => {
      if (/\bsrc\s*=/i.test(attrs)) return whole;
      if (!isExecutableScript(attrs)) return whole;
      noncedScripts++;
      const cleaned = attrs.replace(NONCE_ATTR_RE, '');
      return `<script${cleaned} nonce="${nonce}">`;
    });
  }

  const head = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(options.csp)}"><meta charset="utf-8">`;

  let document: string;
  const headOpen = /<head\b[^>]*>/i.exec(body);
  const htmlOpen = /<html\b[^>]*>/i.exec(body);
  if (headOpen?.[0]) {
    const at = headOpen.index + headOpen[0].length;
    document = body.slice(0, at) + head + body.slice(at);
  } else if (htmlOpen?.[0]) {
    const at = htmlOpen.index + htmlOpen[0].length;
    document = body.slice(0, at) + `<head>${head}</head>` + body.slice(at);
    notes.push('document had an <html> element with no <head>; a head was created for the CSP');
  } else {
    document = `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
    notes.push('document was an HTML fragment; wrapped in a full document so the CSP meta is honored');
  }

  return { document, notes, noncedScripts };
}

/** Decode a `data:` URL, but only when the media type is HTML. */
export function decodeDataUrl(raw: string): string | null {
  const comma = raw.indexOf(',');
  if (comma < 0) return null;
  const header = raw.slice('data:'.length, comma).toLowerCase();
  const isBase64 = /;base64$/.test(header);
  const mediaType = header.replace(/;base64$/, '').split(';')[0]?.trim() ?? '';
  if (mediaType !== 'text/html') return null;
  const payload = raw.slice(comma + 1);
  if (!isBase64) {
    try {
      return decodeURIComponent(payload);
    } catch {
      return payload;
    }
  }
  try {
    const binary = atob(payload.replace(/\s+/g, ''));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}

function isExecutableScript(attrs: string): boolean {
  const match = SCRIPT_TYPE_ATTR_RE.exec(attrs);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  if (raw === undefined) return true;
  return EXECUTABLE_SCRIPT_TYPES.has(raw.toLowerCase());
}

/**
 * The CSP string is host-built, but it is still interpolated into an HTML
 * attribute. Only the attribute's own delimiter can end the tag early, so just
 * that is removed -- single quotes must survive, because `'none'`, `'self'` and
 * `'nonce-...'` are CSP source expressions and `default-src none` is not a valid
 * policy.
 */
function escapeAttribute(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/["<>]/g, '');
}

function isDocumentUri(src: string): boolean {
  const scheme = readScheme(src);
  return scheme === null || scheme === 'about';
}

function truncate(value: string, max = 80): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
