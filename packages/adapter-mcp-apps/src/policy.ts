/**
 * MCP Apps policy engine.
 *
 * This is the highest-risk decision point in the monorepo. Everything an MCP
 * server returns is agent-authored, and the host is about to execute it as code
 * inside a frame that is, by construction, allowed to talk back to the host.
 * The engine is therefore deny-by-default and every outcome is explainable in
 * one sentence.
 *
 * Threat model, from SEP-1865 "Security Implications":
 *   1. A malicious server ships hostile HTML in its `ui://` resource.
 *   2. A hostile app tries to escape the sandbox to reach the host DOM,
 *      cookies, or localStorage.
 *   3. A hostile app calls tools the host never offered it.
 *   4. A hostile app exfiltrates host data through `postMessage` or a redirect.
 *   5. A hostile app phishes the user by navigating the host tab.
 *
 * The load-bearing rule: `allow-scripts` and `allow-same-origin` together are a
 * sandbox escape, not a sandbox. MDN is explicit that a framed document with
 * both tokens can reach out of its own frame and remove the sandbox attribute
 * from its own parent, after which it is same-origin with the host and can read
 * the host's DOM, cookies, and storage. Because the document in question is
 * written by the agent, there is no "trusted server" case to carve out here --
 * that is what `allowUntrustedCode` is for, and it defaults to false.
 */

import type { EmbeddedApp } from '@agent-surface/protocol';
import {
  OPAQUE_ORIGIN,
  classifyFrameSource,
  type FrameSourceClassification,
  type FrameSourceOk,
} from './iframe-src.js';

export const DEFAULT_MAX_FRAME_HEIGHT_PX = 2000;
export const MIN_FRAME_HEIGHT_PX = 80;
export const DEFAULT_FRAME_HEIGHT_PX = 240;

// ---------------------------------------------------------------------------
// Sandbox vocabulary
// ---------------------------------------------------------------------------

export const IR_SANDBOX_VALUES: readonly EmbeddedApp['sandbox'][] = [
  'allow-all',
  'allow-scripts-same-origin',
  'allow-same-origin',
  'sandboxed-scripts',
  'sandboxed-forms',
  'sandboxed',
];

/**
 * IR value -> exact iframe `sandbox` attribute tokens, most permissive first.
 *
 * `allow-all` deliberately does not resolve to the empty string. Omitting the
 * `sandbox` attribute is the real "unsandboxed" switch, and we never emit that;
 * we emit an explicit, reviewable token list instead. It also stops short of
 * `allow-top-navigation` and `allow-top-navigation-by-user-activation`, which
 * are the tokens that would let the app replace the host page under the user.
 */
export const SANDBOX_TOKENS: Readonly<Record<EmbeddedApp['sandbox'], string>> = {
  'sandboxed': '',
  'sandboxed-forms': 'allow-forms',
  'sandboxed-scripts': 'allow-scripts',
  'allow-same-origin': 'allow-same-origin',
  'allow-scripts-same-origin': 'allow-scripts allow-same-origin',
  'allow-all':
    'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-presentation',
};

const ALL_SAFE_TOKENS = new Set(
  IR_SANDBOX_VALUES.flatMap((value) => SANDBOX_TOKENS[value].split(' ').filter(Boolean)),
);
const EXTRA_SAFE_TOKENS = new Set(['allow-pointer-lock']);
for (const tokens of Object.values(SANDBOX_TOKENS)) {
  for (const token of tokens.split(' ')) {
    if (token) ALL_SAFE_TOKENS.add(token);
  }
}

/**
 * Tokens we never emit, whatever the app asks for and whatever the master
 * switch says. Each one hands the frame a capability that is about the *host*,
 * not about the frame.
 */
const ALWAYS_STRIPPED: Readonly<Record<string, string>> = {
  'allow-top-navigation': 'lets the frame replace the host page (phishing)',
  'allow-top-navigation-by-user-activation': 'lets one click replace the host page (phishing)',
  'allow-popups-to-escape-sandbox': 'lets a spawned window run completely unsandboxed',
  'allow-storage-access-by-user-activation': 'lets a same-origin frame reach the host cookie jar',
  'allow-orientation-lock': 'locks the host UI orientation',
};

const ESCAPE_TOKENS = ['allow-scripts', 'allow-same-origin'] as const;

// ---------------------------------------------------------------------------
// Origin allowlist
// ---------------------------------------------------------------------------

export interface AllowedOriginPattern {
  /** CSP-ready source expression, e.g. `https://a.example.com` or `https://*.example.com`. */
  source: string;
  /** Null when the entry is a wildcard-host pattern. */
  origin: string | null;
  /** Host suffix for wildcard patterns, e.g. `.example.com`. */
  hostSuffix: string | null;
}

export interface AllowedOriginParse {
  patterns: AllowedOriginPattern[];
  /** Entries that could not be understood, kept for operator-facing warnings. */
  rejected: string[];
}

const WILDCARD_HOST_RE = /^\*\.(.+)$/;

/**
 * Normalize a host allowlist. Entries are origins, not URLs: a path is
 * dropped, and anything that is not an absolute http(s)/ws(s) origin is
 * discarded rather than normalized, because an allowlist entry we failed to
 * understand must never silently become a wildcard.
 */
export function parseAllowedOrigins(entries: readonly string[] | undefined): AllowedOriginParse {
  const patterns: AllowedOriginPattern[] = [];
  const rejected: string[] = [];
  for (const raw of entries ?? []) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      rejected.push(String(raw));
      continue;
    }
    const value = raw.trim();
    if (value === '*' || value.includes('*') && !WILDCARD_HOST_RE.test(hostPartOf(value))) {
      rejected.push(value);
      continue;
    }
    let url: URL;
    try {
      url = new URL(value.replace(/^(\*\.)/, 'wildcard.'));
    } catch {
      rejected.push(value);
      continue;
    }
    const protocol = url.protocol.toLowerCase();
    if (protocol !== 'https:' && protocol !== 'http:' && protocol !== 'wss:' && protocol !== 'ws:') {
      rejected.push(value);
      continue;
    }
    const wildcard = WILDCARD_HOST_RE.exec(url.hostname);
    if (wildcard) {
      const suffix = wildcard[1];
      if (!suffix || suffix.includes('/') || suffix.includes('*')) {
        rejected.push(value);
        continue;
      }
      patterns.push({
        source: `${protocol}//*.${suffix}`,
        origin: null,
        hostSuffix: `.${suffix.toLowerCase()}`,
      });
      continue;
    }
    patterns.push({ source: url.origin, origin: url.origin, hostSuffix: null });
  }
  return { patterns, rejected };
}

function hostPartOf(value: string): string {
  try {
    return new URL(value.replace(/^(\*\.)/, 'wildcard.')).hostname;
  } catch {
    return value;
  }
}

function matchesPattern(origin: string, pattern: AllowedOriginPattern): boolean {
  if (pattern.origin !== null) return origin === pattern.origin;
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    // CSP wildcard semantics: `https://*.example.com` covers subdomains, not
    // the apex, and never crosses a scheme or a port.
    return (
      url.protocol === pattern.source.split('//')[0] &&
      pattern.hostSuffix !== null &&
      hostname.endsWith(pattern.hostSuffix)
    );
  } catch {
    return false;
  }
}

/** Is `origin` covered by the parsed allowlist? */
export function isOriginAllowed(origin: string, patterns: readonly AllowedOriginPattern[]): boolean {
  return patterns.some((pattern) => matchesPattern(origin, pattern));
}

/**
 * Intersect agent-declared domains with the host allowlist. SEP-1865 requires
 * the host to enforce declared domains *and* forbids allowing undeclared ones;
 * on top of that we only allow what the operator has allowlisted, so a
 * compromised server cannot widen the policy by editing its own `_meta`.
 */
function resolveDeclaredDomains(
  declared: readonly string[] | undefined,
  patterns: readonly AllowedOriginPattern[],
): string[] {
  const out: string[] = [];
  for (const raw of declared ?? []) {
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    const value = raw.trim();
    if (value === '*') continue;
    const matching = patterns.filter((pattern) => matchesPattern(value, pattern) || pattern.source === value);
    for (const pattern of matching) {
      if (!out.includes(pattern.source)) out.push(pattern.source);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Static document scanner
// ---------------------------------------------------------------------------

export type FindingCode =
  | 'INLINE_EVENT_HANDLER'
  | 'INLINE_SCRIPT'
  | 'EXTERNAL_SCRIPT_HOST'
  | 'EXTERNAL_RESOURCE_HOST'
  | 'WINDOW_OPENER'
  | 'LOCAL_STORAGE'
  | 'FORM_THIRD_PARTY'
  | 'UNSAFE_URL'
  | 'WILDCARD_POSTMESSAGE'
  | 'DYNAMIC_CODE'
  | 'NESTED_FRAME'
  | 'PREEXISTING_CSP_META'
  | 'BASE_TAG'
  | 'META_REFRESH'
  | 'COOKIE_ACCESS'
  | 'TOP_NAVIGATION_ATTEMPT'
  | 'SANDBOX_TOKEN_DROPPED'
  | 'SANDBOX_VALUE_UNRECOGNIZED'
  | 'SANDBOX_VALUE_REMAPPED'
  | 'FRAME_DOMAIN_REFUSED'
  | 'RESOURCE_DOMAIN_REFUSED'
  | 'CONNECT_DOMAIN_REFUSED'
  | 'BASE_URI_DOMAIN_REFUSED'
  | 'ALLOWED_ORIGIN_IGNORED'
  | 'FRAME_ORIGIN_IS_HOST_ORIGIN'
  | 'TRUST_CLAIM_IGNORED'
  | 'HEIGHT_CLAMPED'
  | 'DECLARED_SANDBOX_DOWNGRADED';

export interface Finding {
  code: FindingCode;
  message: string;
  /** Operator-facing severity. Nothing here blocks; see {@link scanDocument}. */
  severity: 'info' | 'warn' | 'high';
}

export interface ScanInput {
  html: string | null | undefined;
  /** The frame document's own origin, or {@link OPAQUE_ORIGIN}. */
  frameOrigin: string;
  /** Origins the document is permitted to load sub-resources from. */
  permittedOrigins: readonly string[];
}

const TAG_RE = /<[a-zA-Z][^>]*>/g;
const INLINE_HANDLER_RE = /(?:^|\s)on[a-z]{2,24}\s*=/i;
const URL_ATTR_RE = /\b(?:src|href|action|data|poster|srcset|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const UNSAFE_URL_RE = /^\s*(?:javascript|vbscript)\s*:/i;
const DATA_HTML_URL_RE = /^\s*data:\s*text\/html/i;
const SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const LOCAL_STORAGE_RE = /\b(?:localStorage|sessionStorage|indexedDB|caches)\b/;
const WINDOW_OPENER_RE = /\b(?:window\s*\.\s*opener|parent\s*\.\s*opener|opener\s*\.\s*(?:location|document|postMessage))/;
const WILDCARD_TARGET_RE = /\.postMessage\s*\([^)]*?["']\*["']/;
const DYNAMIC_CODE_RE = /\b(?:eval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*["'`])/;
const COOKIE_RE = /\bdocument\s*\.\s*cookie\b/;
const TOP_NAVIGATION_RE = /\b(?:top|parent)\s*\.\s*location\s*(?:\.|\?=)|\bwindow\s*\.\s*top\s*\.\s*location/;
const FORM_RE = /<form\b([^>]*)>/gi;
const CSP_META_RE = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy/i;
const BASE_TAG_RE = /<base\b[^>]*>/i;
const META_REFRESH_RE = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i;

/**
 * Lightweight static scan of an agent-authored document.
 *
 * This scanner NEVER blocks. It runs over untrusted HTML with regular
 * expressions, so it both misses obfuscation (`window['local'+'Storage']`) and
 * over-reports on text that merely looks like code. A false positive that
 * refuses to render an app is a denial-of-service bug in the host, and the
 * browser -- not this function -- is what actually enforces the boundary. So
 * findings are surfaced to the operator and the CSP does the refusing. The one
 * exception is that the scanner's input is the same document the rewriter
 * strips, so `PREEXISTING_CSP_META` and `BASE_TAG` are true statements about
 * what the rewriter had to do.
 */
export function scanDocument(input: ScanInput): Finding[] {
  const findings: Finding[] = [];
  const html = input.html;
  if (typeof html !== 'string' || html.length === 0) return findings;

  const add = (code: FindingCode, message: string, severity: Finding['severity'] = 'warn'): void => {
    findings.push({ code, message, severity });
  };

  if (CSP_META_RE.test(html)) {
    add('PREEXISTING_CSP_META', 'document shipped its own CSP meta; it was stripped and replaced by the host policy', 'high');
  }
  if (BASE_TAG_RE.test(html)) {
    add('BASE_TAG', 'document contains <base>, which was stripped', 'warn');
  }
  if (META_REFRESH_RE.test(html)) {
    add('META_REFRESH', 'document contains <meta http-equiv="refresh">, which was stripped', 'high');
  }

  const permitted = parseAllowedOrigins(input.permittedOrigins);
  const isPermitted = (origin: string): boolean => isOriginAllowed(origin, permitted.patterns);

  for (const tagMatch of html.matchAll(TAG_RE)) {
    const tag = tagMatch[0];
    const name = /^<\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)?.[1]?.toLowerCase() ?? '';

    if (INLINE_HANDLER_RE.test(tag)) {
      add(
        'INLINE_EVENT_HANDLER',
        `inline event handler on <${name}>; the host CSP has no 'unsafe-inline' in script-src, so it will not run`,
      );
    }

    if (name === 'iframe' || name === 'frame' || name === 'object' || name === 'embed') {
      add('NESTED_FRAME', `<${name}> is present; frame-src is 'none' so it will not load`, 'high');
    }

    for (const attrMatch of tag.matchAll(URL_ATTR_RE)) {
      // A tag whose attribute value contains `>` is truncated by TAG_RE before
      // its closing quote, so the unquoted branch can hand back a leading or
      // trailing quote. Normalize before testing the scheme.
      const value = (attrMatch[1] ?? attrMatch[2] ?? attrMatch[3] ?? '').trim().replace(/^["']|["']$/g, '');
      if (value.length === 0) continue;
      if (UNSAFE_URL_RE.test(value)) {
        add(
          'UNSAFE_URL',
          `<${name}> references a ${value.split(':')[0]}: URL; the host CSP has no such source list, so it will not execute`,
          'high',
        );
        continue;
      }
      if (DATA_HTML_URL_RE.test(value)) {
        add(
          'UNSAFE_URL',
          `<${name}> references a data:text/html URL; the host CSP allows data: for images only, never for documents or frames`,
          'high',
        );
        continue;
      }
      if (!/^https?:\/\//i.test(value)) continue;
      let origin: string;
      try {
        origin = new URL(value).origin;
      } catch {
        continue;
      }
      if (origin === input.frameOrigin) continue;
      if (isPermitted(origin)) continue;
      const isScript = name === 'script' || name === 'link';
      add(
        isScript ? 'EXTERNAL_SCRIPT_HOST' : 'EXTERNAL_RESOURCE_HOST',
        `<${name}> loads from ${origin}, which is not in the host allowlist; the CSP will block it`,
        isScript ? 'high' : 'warn',
      );
    }
  }

  SCRIPT_BLOCK_RE.lastIndex = 0;
  for (const scriptMatch of html.matchAll(SCRIPT_BLOCK_RE)) {
    const attrs = scriptMatch[1] ?? '';
    const content = (scriptMatch[2] ?? '').trim();
    if (content.length === 0) continue;
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const isDataBlock = /type\s*=\s*["']?(?:application\/ld\+json|application\/json|text\/template)/i.test(attrs);
    if (isDataBlock) continue;
    add('INLINE_SCRIPT', 'inline <script> body; the host injects a per-render nonce so it runs without ' + "'unsafe-inline'", 'warn');
  }

  if (LOCAL_STORAGE_RE.test(html)) {
    add(
      'LOCAL_STORAGE',
      'document touches localStorage/sessionStorage/indexedDB/caches; with allow-same-origin stripped this throws instead of persisting, and with it the frame could read host storage',
      'high',
    );
  }
  if (WINDOW_OPENER_RE.test(html)) {
    add('WINDOW_OPENER', 'document references window.opener; not granted in any sandbox posture we emit', 'high');
  }
  if (COOKIE_RE.test(html)) {
    add('COOKIE_ACCESS', 'document reads document.cookie; the frame has no host cookies', 'high');
  }
  if (WILDCARD_TARGET_RE.test(html)) {
    add(
      'WILDCARD_POSTMESSAGE',
      "document calls postMessage with a '*' target origin; the host always posts to a validated exact origin",
      'high',
    );
  }
  if (DYNAMIC_CODE_RE.test(html)) {
    add('DYNAMIC_CODE', 'document uses eval/new Function/setTimeout-with-string; the host CSP omits unsafe-eval so it will throw', 'warn');
  }
  if (TOP_NAVIGATION_RE.test(html)) {
    add('TOP_NAVIGATION_ATTEMPT', 'document attempts to navigate the top window; no sandbox token we emit permits it', 'high');
  }

  for (const formMatch of html.matchAll(FORM_RE)) {
    const attrs = formMatch[1] ?? '';
    const action = /\baction\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const value = (action?.[1] ?? action?.[2] ?? action?.[3] ?? '').trim();
    if (value.length === 0) continue;
    if (UNSAFE_URL_RE.test(value)) {
      add('UNSAFE_URL', `<form action="${truncate(value)}"> uses a non-http scheme`, 'high');
      continue;
    }
    let origin: string;
    try {
      origin = new URL(value, 'https://placeholder.invalid').origin;
    } catch {
      continue;
    }
    if (origin === 'https://placeholder.invalid' || origin === input.frameOrigin) continue;
    if (isPermitted(origin)) continue;
    add('FORM_THIRD_PARTY', `<form> posts to ${origin}, outside the allowlist; form-action is 'none' so it cannot submit`, 'high');
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export interface BridgeFeatures {
  postMessage: boolean;
  toolInvoke: boolean;
  a2a: boolean;
  heightResize: boolean;
}

/** `_meta.ui.csp` from an MCP Apps resource, as a request rather than an input. */
export interface DeclaredUiCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

export interface EvaluateAppInput {
  app: EmbeddedApp;
  hostOrigin: string;
  allowedOrigins: readonly string[];
  /** Host-level master switch for running agent-authored code unsandboxed. */
  allowUntrustedCode: boolean;
  maxFrameHeightPx?: number;
  /** Pre-resolved `ui://` document, when the host has already read the resource. */
  html?: string | null;
  /** Development mode. Only gates loopback `http:`. */
  dev?: boolean;
  trustedBlobUrls?: readonly string[];
  /** Host endpoint the app may reach over `connect-src` for tool invocation. */
  toolInvokeOrigin?: string | null;
  /** The agent's declared CSP request. */
  declaredCsp?: DeclaredUiCsp;
  /** Tool name, used only to make the denial reason actionable. */
  toolName?: string;
}

export interface FrameBounds {
  heightPx: number;
  maxHeightPx: number;
  heightClamped: boolean;
}

export interface PolicyDecision {
  allowed: boolean;
  /** IR vocabulary value to place on the iframe's `sandbox` attribute. */
  sandbox: EmbeddedApp['sandbox'];
  /** Exact `sandbox` attribute token list, or `''` for maximum restriction. */
  sandboxTokens: string;
  /** Exact `csp` meta content for the frame document. */
  csp: string;
  bridge: BridgeFeatures;
  reason: string;
  /** Findings that did not block but should be surfaced to the operator. */
  warnings: string[];
  /** Machine-readable form of `warnings`, with severity. */
  findings: Finding[];
  /** Machine-readable summary of the decision. */
  code: PolicyCode;
  /** The normalized frame source; `null` when the app was refused. */
  frame: FrameSourceOk | null;
  bounds: FrameBounds;
  /** Per-render nonce for the injected document. `null` for remote frames. */
  nonce: string | null;
  /** Machine-readable provenance for the audit trail SEP-1865 asks hosts to keep. */
  audit: {
    requestedSandbox: string;
    grantedSandbox: EmbeddedApp['sandbox'];
    downgraded: boolean;
    allowUntrustedCode: boolean;
    frameOrigin: string | null;
    sourceUri: string | null;
  };
}

export type PolicyCode =
  | 'ALLOWED_AS_DECLARED'
  | 'ALLOWED_DOWNGRADED'
  | 'ALLOWED_UNRECOGNIZED_SANDBOX'
  | 'ALLOWED_UNTRUSTED_CODE_ESCALATED'
  | 'DENIED_FRAME_SOURCE'
  | 'DENIED_INVALID_HOST_ORIGIN'
  | 'DENIED_HOST_ORIGIN_REUSE';

const DISABLED_BRIDGE: BridgeFeatures = {
  postMessage: false,
  toolInvoke: false,
  a2a: false,
  heightResize: false,
};

function noBridge(): BridgeFeatures {
  return { ...DISABLED_BRIDGE };
}

function clampHeight(
  declared: number | undefined,
  maxHeightPx: number,
): { heightPx: number; heightClamped: boolean } {
  if (declared === undefined || declared === null || !Number.isFinite(declared)) {
    return { heightPx: Math.min(DEFAULT_FRAME_HEIGHT_PX, maxHeightPx), heightClamped: declared !== undefined };
  }
  if (declared > maxHeightPx) return { heightPx: maxHeightPx, heightClamped: true };
  if (declared < MIN_FRAME_HEIGHT_PX) return { heightPx: Math.min(MIN_FRAME_HEIGHT_PX, maxHeightPx), heightClamped: true };
  return { heightPx: Math.round(declared), heightClamped: false };
}

interface SandboxResolution {
  value: EmbeddedApp['sandbox'];
  tokens: Set<string>;
  downgraded: boolean;
  notes: string[];
  refused: string | null;
  /** One sentence naming the token we took away, for the decision `reason`. */
  refusalNote: string | null;
  recognized: boolean;
}

function resolveSandbox(
  declared: unknown,
  allowUntrustedCode: boolean,
  frameOrigin: string,
  hostOrigin: string,
): SandboxResolution {
  const notes: string[] = [];
  const requested = typeof declared === 'string' ? declared : '';
  const isIrValue = (IR_SANDBOX_VALUES as readonly string[]).includes(requested);
  // An IR value is a single word, not a token list: `sandboxed-scripts` means
  // exactly `allow-scripts`. Anything else is treated as a raw attribute value
  // and split into tokens.
  const rawTokens = isIrValue
    ? (SANDBOX_TOKENS[requested as EmbeddedApp['sandbox']] ?? '').split(' ').filter(Boolean)
    : requested.split(/[\s,]+/).filter(Boolean);
  const tokens = new Set<string>();

  for (const token of rawTokens) {
    if (ALWAYS_STRIPPED[token] !== undefined) {
      notes.push(`sandbox: dropped ${token} -- ${ALWAYS_STRIPPED[token]}`);
      continue;
    }
    if (token === '*') {
      notes.push('sandbox: dropped "*"; the host never emits an unconstrained sandbox attribute');
      continue;
    }
    if (ALL_SAFE_TOKENS.has(token) || EXTRA_SAFE_TOKENS.has(token)) {
      tokens.add(token);
      continue;
    }
    notes.push(`sandbox: dropped unrecognized token ${token}`);
  }

  const scripts = tokens.has('allow-scripts');
  const sameOrigin = tokens.has('allow-same-origin');
  const escape = scripts && sameOrigin;
  const sameOriginAlone = sameOrigin && !scripts;

  if (escape || sameOriginAlone) {
    if (allowUntrustedCode) {
      return {
        value: isIrValue ? (requested as EmbeddedApp['sandbox']) : nearestIrValue(tokens),
        tokens,
        downgraded: !isIrValue,
        notes: [
          ...notes,
          `sandbox: GRANTED ${escape ? 'allow-scripts together with allow-same-origin' : 'allow-same-origin'} because allowUntrustedCode is explicitly enabled. The frame can reach the host DOM, cookies, and storage. This is a deliberate operator decision, not a safe default.`,
        ],
        refused: null,
        refusalNote: null,
        recognized: isIrValue,
      };
    }
    if (sameOriginAlone && frameOrigin === hostOrigin && hostOrigin !== OPAQUE_ORIGIN) {
      return {
        value: 'sandboxed',
        tokens: new Set(),
        downgraded: true,
        notes: [
          ...notes,
          `sandbox: REFUSED allow-same-origin because the frame would be same-origin with the host (${hostOrigin}); the frame would be the host`,
        ],
        refused: `allow-same-origin would make the agent-authored document same-origin with the host (${hostOrigin}), giving it the host's DOM, cookies and storage; no sandbox token separates a same-origin frame from its host`,
        refusalNote: 'sandbox: REFUSED allow-same-origin because the frame would be same-origin with the host',
        recognized: isIrValue,
      };
    }
    // Drop `allow-same-origin` and keep `allow-scripts` when the app asked for
    // it: an opaque-origin frame can still run the app, but it can no longer
    // touch anything the host owns. When scripts were not requested there is
    // nothing left to run, so the frame drops to maximum restriction.
    const kept = escape ? new Set(['allow-scripts']) : new Set<string>();
    const refusalNote = escape
      ? 'sandbox: REFUSED allow-scripts together with allow-same-origin, because that pair is a sandbox escape rather than a sandbox (the document can reach into its own parent frame, strip the sandbox attribute, and then read the host DOM, cookies and storage)'
      : 'sandbox: REFUSED allow-same-origin, because same-origin without scripts only buys a document persistent storage on a real origin, which is exactly the host data this package must not expose';
    return {
      value: escape ? 'sandboxed-scripts' : 'sandboxed',
      tokens: kept,
      downgraded: true,
      notes: [
        ...notes,
        `${refusalNote}; downgraded to "${escape ? 'sandboxed-scripts' : 'sandboxed'}"`,
      ],
      refused: null,
      refusalNote,
      recognized: isIrValue,
    };
  }

  if (isIrValue) {
    return {
      value: requested as EmbeddedApp['sandbox'],
      tokens,
      downgraded: false,
      notes,
      refused: null,
      refusalNote: null,
      recognized: true,
    };
  }

  const nearest = nearestIrValue(tokens);
  return {
    value: nearest,
    tokens,
    downgraded: false,
    notes: [
      ...notes,
      `sandbox: "${truncate(requested)}" is not an IR sandbox value; resolved to the most capable IR value it does contain (${nearest})`,
    ],
    refused: null,
    refusalNote: null,
    recognized: false,
  };
}

/**
 * The IR vocabulary can only express one posture, so for a raw token list we
 * grant the most capable IR value whose tokens are all present. Anything the app
 * asked for beyond that is dropped, which is the only safe direction: an IR
 * value we cannot express exactly must be narrowed, never widened.
 */
function nearestIrValue(tokens: ReadonlySet<string>): EmbeddedApp['sandbox'] {
  for (const value of IR_SANDBOX_VALUES) {
    const needed = SANDBOX_TOKENS[value].split(' ').filter(Boolean);
    if (needed.every((token) => tokens.has(token))) return value;
  }
  return 'sandboxed';
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  const webcrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (webcrypto && typeof webcrypto.getRandomValues === 'function') {
    webcrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function normalizeHostOrigin(hostOrigin: string): string | null {
  if (typeof hostOrigin !== 'string') return null;
  try {
    const url = new URL(hostOrigin);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function buildCsp(input: {
  frameOrigin: string;
  sandboxTokens: string;
  nonce: string | null;
  resourceOrigins: string[];
  connectOrigins: string[];
  frameOrigins: string[];
}): string {
  const opaque = input.frameOrigin === OPAQUE_ORIGIN;
  // An opaque frame has no 'self', so a nonce is the only way its own inline
  // scripts can run without 'unsafe-inline' being available to injected markup.
  const self = opaque ? [] : ["'self'"];
  const scriptSelf = opaque ? (input.nonce ? [`'nonce-${input.nonce}'`] : []) : ["'self'"];
  const resource = input.resourceOrigins;
  const directives: Array<readonly [string, string[], 'none' | 'bare']> = [
    ['default-src', ["'none'"], 'bare'],
    ['base-uri', ["'none'"], 'bare'],
    ['object-src', ["'none'"], 'bare'],
    ['frame-ancestors', ["'none'"], 'bare'],
    ['form-action', ["'none'"], 'bare'],
    ['script-src', [...scriptSelf, ...resource], 'none'],
    ['style-src', ["'unsafe-inline'", ...self, ...resource], 'none'],
    ['img-src', [...self, 'data:', ...resource], 'none'],
    ['media-src', [...self, 'data:', ...resource], 'none'],
    ['font-src', [...self, ...resource], 'none'],
    ['connect-src', input.connectOrigins, 'none'],
    ['frame-src', input.frameOrigins, 'none'],
    ['worker-src', ["'none'"], 'bare'],
    ['manifest-src', ["'none'"], 'bare'],
    // Mirrors the iframe attribute. If the document is ever loaded outside the
    // sandboxed iframe, the CSP still confines it. This is the one directive
    // where an empty source list means maximum restriction rather than
    // "no restriction", so it is emitted bare on purpose.
    ['sandbox', input.sandboxTokens.split(' ').filter(Boolean), 'bare'],
  ];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const [name, values, empty] of directives) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (values.length > 0) parts.push(`${name} ${values.join(' ')}`);
    else if (empty === 'none') parts.push(`${name} 'none'`);
    else parts.push(name);
  }
  return `${parts.join('; ')};`;
}

function deny(
  code: PolicyCode,
  reason: string,
  partial: {
    warnings: string[];
    findings: Finding[];
    bounds: FrameBounds;
    requestedSandbox: string;
    frameOrigin: string | null;
    sourceUri: string | null;
    allowUntrustedCode: boolean;
  },
): PolicyDecision {
  return {
    allowed: false,
    sandbox: 'sandboxed',
    sandboxTokens: '',
    csp: buildCsp({
      frameOrigin: OPAQUE_ORIGIN,
      sandboxTokens: '',
      nonce: null,
      resourceOrigins: [],
      connectOrigins: [],
      frameOrigins: [],
    }),
    bridge: noBridge(),
    reason,
    warnings: partial.warnings,
    findings: partial.findings,
    code,
    frame: null,
    bounds: partial.bounds,
    nonce: null,
    audit: {
      requestedSandbox: partial.requestedSandbox,
      grantedSandbox: 'sandboxed',
      downgraded: true,
      allowUntrustedCode: partial.allowUntrustedCode,
      frameOrigin: partial.frameOrigin,
      sourceUri: partial.sourceUri,
    },
  };
}

/**
 * The one entry point. Given what the agent declared, decide whether the host
 * may render it, with which sandbox, which CSP, and which bridge features.
 *
 * It never throws: every input, including a malformed `app`, resolves to a
 * decision whose `allowed` is false.
 */
export function evaluateApp(input: EvaluateAppInput): PolicyDecision {
  const app = (input.app ?? {}) as Partial<EmbeddedApp>;
  const allowUntrustedCode = input.allowUntrustedCode === true;
  const maxHeightPx =
    typeof input.maxFrameHeightPx === 'number' && input.maxFrameHeightPx > 0
      ? Math.floor(input.maxFrameHeightPx)
      : DEFAULT_MAX_FRAME_HEIGHT_PX;
  const boundsRaw = clampHeight(app.height, maxHeightPx);
  const bounds: FrameBounds = { heightPx: boundsRaw.heightPx, maxHeightPx, heightClamped: boundsRaw.heightClamped };
  const requestedSandbox = typeof app.sandbox === 'string' ? app.sandbox : '';
  const warnings: string[] = [];
  const findings: Finding[] = [];
  const push = (finding: Finding): void => {
    findings.push(finding);
    warnings.push(finding.message);
  };

  const hostOrigin = normalizeHostOrigin(input.hostOrigin);
  if (hostOrigin === null) {
    return deny(
      'DENIED_INVALID_HOST_ORIGIN',
      `hostOrigin "${String(input.hostOrigin)}" is not an absolute http(s) origin, so there is no validated postMessage target; refusing the app rather than posting to "*"`,
      {
        warnings,
        findings,
        bounds,
        requestedSandbox,
        frameOrigin: null,
        sourceUri: null,
        allowUntrustedCode,
      },
    );
  }

  if (app.untrusted !== true) {
    push({
      code: 'TRUST_CLAIM_IGNORED',
      message:
        'app did not declare untrusted:true; MCP Apps are agent-authored and this package has no trusted path, so the flag was forced on',
      severity: 'high',
    });
  }

  const allowlist = parseAllowedOrigins(input.allowedOrigins);
  for (const bad of allowlist.rejected) {
    push({
      code: 'ALLOWED_ORIGIN_IGNORED',
      message: `allowedOrigins entry ${truncate(bad)} is not an absolute http(s)/ws(s) origin and was dropped`,
      severity: 'high',
    });
  }

  const classification: FrameSourceClassification = classifyFrameSource({
    src: typeof app.src === 'string' ? app.src : '',
    html: input.html ?? null,
    dev: input.dev === true,
    trustedBlobUrls: input.trustedBlobUrls ?? [],
  });

  const toolLabel = input.toolName ? ` for tool ${input.toolName}` : '';
  if (!classification.ok) {
    return deny(
      'DENIED_FRAME_SOURCE',
      `refused to render app${toolLabel}: ${classification.reason}`,
      {
        warnings,
        findings,
        bounds,
        requestedSandbox,
        frameOrigin: null,
        sourceUri: typeof app.src === 'string' ? app.src : null,
        allowUntrustedCode,
      },
    );
  }

  const sandbox = resolveSandbox(app.sandbox, allowUntrustedCode, classification.origin, hostOrigin);
  for (const note of sandbox.notes) {
    push({ code: sandbox.downgraded ? 'DECLARED_SANDBOX_DOWNGRADED' : 'SANDBOX_VALUE_REMAPPED', message: note, severity: 'high' });
  }
  if (!sandbox.recognized) {
    push({
      code: 'SANDBOX_VALUE_UNRECOGNIZED',
      message: `sandbox value ${truncate(requestedSandbox, 40)} is outside the IR vocabulary; resolved by deny-by-default to ${sandbox.value}`,
      severity: 'high',
    });
  }
  for (const [token, why] of Object.entries(ALWAYS_STRIPPED)) {
    if (requestedSandbox.includes(token)) {
      push({
        code: 'SANDBOX_TOKEN_DROPPED',
        message: `sandbox: dropped ${token} -- ${why}`,
        severity: 'high',
      });
    }
  }

  if (sandbox.refused !== null) {
    return deny(
      'DENIED_HOST_ORIGIN_REUSE',
      `refused to render app${toolLabel}: ${sandbox.refused}. The bridge is disabled because there is no safe frame to send it to.`,
      {
        warnings,
        findings,
        bounds,
        requestedSandbox,
        frameOrigin: classification.origin,
        sourceUri: classification.sourceUri,
        allowUntrustedCode,
      },
    );
  }

  if (sandbox.tokens.has('allow-same-origin') && classification.origin === hostOrigin) {
    return deny(
      'DENIED_HOST_ORIGIN_REUSE',
      `refused to render app${toolLabel}: the frame would run on the host origin (${hostOrigin}) with allow-same-origin, which is the host's own origin and storage`,
      {
        warnings,
        findings,
        bounds,
        requestedSandbox,
        frameOrigin: classification.origin,
        sourceUri: classification.sourceUri,
        allowUntrustedCode,
      },
    );
  }

  const resourceOrigins = resolveDeclaredDomains(input.declaredCsp?.resourceDomains, allowlist.patterns);
  for (const refused of refuseList(input.declaredCsp?.resourceDomains, allowlist.patterns)) {
    push({ code: 'RESOURCE_DOMAIN_REFUSED', message: `resourceDomains: refused ${refused} because the host allowlist does not contain it`, severity: 'warn' });
  }
  const connectOrigins = resolveDeclaredDomains(input.declaredCsp?.connectDomains, allowlist.patterns);
  for (const refused of refuseList(input.declaredCsp?.connectDomains, allowlist.patterns)) {
    push({ code: 'CONNECT_DOMAIN_REFUSED', message: `connectDomains: refused ${refused} because the host allowlist does not contain it`, severity: 'warn' });
  }
  const frameOrigins = resolveDeclaredDomains(input.declaredCsp?.frameDomains, allowlist.patterns);
  for (const refused of refuseList(input.declaredCsp?.frameDomains, allowlist.patterns)) {
    push({ code: 'FRAME_DOMAIN_REFUSED', message: `frameDomains: refused ${refused}; nested frames are off unless the operator allowlists them`, severity: 'warn' });
  }
  if ((input.declaredCsp?.baseUriDomains?.length ?? 0) > 0) {
    push({
      code: 'BASE_URI_DOMAIN_REFUSED',
      message: 'baseUriDomains: refused outright; <base> is stripped and base-uri is \'none\' so no document can re-point its own URLs',
      severity: 'high',
    });
  }

  // The host's own tool-invoke endpoint is the one connect-src entry the host
  // controls; the app reaches everything else through the bridge.
  if (typeof input.toolInvokeOrigin === 'string' && input.toolInvokeOrigin.length > 0) {
    let origin: string | null = null;
    try {
      origin = new URL(input.toolInvokeOrigin).origin;
    } catch {
      origin = null;
    }
    if (origin === null || !isOriginAllowed(origin, allowlist.patterns)) {
      push({
        code: 'CONNECT_DOMAIN_REFUSED',
        message: `toolInvokeOrigin ${truncate(input.toolInvokeOrigin)} is not in the host allowlist; connect-src stays 'none'`,
        severity: 'high',
      });
    } else if (!connectOrigins.includes(origin)) {
      connectOrigins.unshift(origin);
    }
  }

  const scriptsEnabled = sandbox.tokens.has('allow-scripts');
  const bridge: BridgeFeatures = {
    // Never '*': classification.origin is either a validated absolute origin or
    // the literal opaque origin, and both are safe postMessage targets.
    postMessage: true,
    toolInvoke: scriptsEnabled,
    a2a: scriptsEnabled && app.transport === 'a2a',
    heightResize: scriptsEnabled,
  };
  if (app.transport === 'a2a' && !scriptsEnabled) {
    push({
      code: 'DECLARED_SANDBOX_DOWNGRADED',
      message: "app declared transport 'a2a' but the frame cannot run scripts, so the a2a channel stays off",
      severity: 'warn',
    });
  }
  if (sandbox.tokens.has('allow-forms')) {
    push({
      code: 'DECLARED_SANDBOX_DOWNGRADED',
      message: "form-action is 'none' regardless of the sandbox tokens, so allow-forms grants the app nothing; form submission must go through the bridge",
      severity: 'warn',
    });
  }

  const nonce = classification.kind === 'inline' ? randomNonce() : null;
  if (scriptsEnabled && classification.origin === OPAQUE_ORIGIN && nonce === null) {
    push({
      code: 'RESOURCE_DOMAIN_REFUSED',
      message:
        "frame origin is opaque and the host cannot inject a nonce into a document it did not author, so script-src falls back to the allowlisted resource origins (or 'none'); a trusted blob: frame will not run its own inline scripts",
      severity: 'high',
    });
  }
  if (scriptsEnabled && classification.kind === 'remote' && nonce === null) {
    push({
      code: 'SANDBOX_VALUE_REMAPPED',
      message:
        "a document served over http(s) cannot be nonced by the host, so script-src is 'self' plus allowlisted origins and the app's inline scripts are blocked; the CSP only takes effect if the host serves it as a response header, and an inline srcdoc document is the preferred form",
      severity: 'warn',
    });
  }
  const csp = buildCsp({
    frameOrigin: classification.origin,
    sandboxTokens: [...sandbox.tokens].join(' '),
    nonce,
    resourceOrigins,
    connectOrigins,
    frameOrigins,
  });

  const documentFindings = scanDocument({
    html: classification.html,
    frameOrigin: classification.origin,
    permittedOrigins: [...resourceOrigins, ...connectOrigins, ...frameOrigins],
  });
  for (const finding of documentFindings) push(finding);

  if (bounds.heightClamped) {
    push({
      code: 'HEIGHT_CLAMPED',
      message: `declared height ${String(app.height)} is outside [${MIN_FRAME_HEIGHT_PX}, ${maxHeightPx}]; frame height set to ${bounds.heightPx}px`,
      severity: 'info',
    });
  }

  const escalated = sandbox.tokens.has('allow-scripts') && sandbox.tokens.has('allow-same-origin');
  const code: PolicyCode = escalated
    ? 'ALLOWED_UNTRUSTED_CODE_ESCALATED'
    : sandbox.downgraded
      ? 'ALLOWED_DOWNGRADED'
      : sandbox.recognized
        ? 'ALLOWED_AS_DECLARED'
        : 'ALLOWED_UNRECOGNIZED_SANDBOX';

  const reason = describe({
    toolLabel,
    requestedSandbox,
    sandboxValue: sandbox.value,
    downgraded: sandbox.downgraded,
    escalated,
    refusalNote: sandbox.refusalNote,
    allowUntrustedCode,
    classification,
    bridge,
    bounds,
    warnings: findings.filter((f) => f.severity === 'high').length,
  });

  return {
    allowed: true,
    sandbox: sandbox.value,
    sandboxTokens: [...sandbox.tokens].join(' '),
    csp,
    bridge,
    reason,
    warnings,
    findings,
    code,
    frame: classification,
    bounds,
    nonce,
    audit: {
      requestedSandbox,
      grantedSandbox: sandbox.value,
      downgraded: sandbox.downgraded,
      allowUntrustedCode,
      frameOrigin: classification.origin,
      sourceUri: classification.sourceUri,
    },
  };
}

function refuseList(
  declared: readonly string[] | undefined,
  patterns: readonly AllowedOriginPattern[],
): string[] {
  const out: string[] = [];
  for (const raw of declared ?? []) {
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    const value = raw.trim();
    if (value === '*') {
      out.push('*');
      continue;
    }
    if (!isOriginAllowed(value, patterns) && !patterns.some((p) => p.source === value)) out.push(value);
  }
  return out;
}

function describe(input: {
  toolLabel: string;
  requestedSandbox: string;
  sandboxValue: EmbeddedApp['sandbox'];
  downgraded: boolean;
  escalated: boolean;
  refusalNote: string | null;
  allowUntrustedCode: boolean;
  classification: FrameSourceOk;
  bridge: BridgeFeatures;
  bounds: FrameBounds;
  warnings: number;
}): string {
  const parts: string[] = [];
  const label = input.requestedSandbox.trim().length > 0 ? input.requestedSandbox : '(unspecified)';
  const bridgeOn = (Object.keys(input.bridge) as Array<keyof BridgeFeatures>).filter((k) => input.bridge[k]);
  const frame = input.classification.kind === 'inline' ? 'an inline srcdoc document' : `https document on ${input.classification.origin}`;

  if (input.escalated) {
    parts.push(
      `ALLOWED app${input.toolLabel} with sandbox "${input.sandboxValue}" on ${frame} because allowUntrustedCode is explicitly enabled: the frame can script itself and share the host origin, so it can reach the host DOM, cookies and storage. This is an operator override, not a safe default.`,
    );
  } else if (input.downgraded) {
    parts.push(
      `ALLOWED app${input.toolLabel} but downgraded the declared sandbox "${label}" to "${input.sandboxValue}" on ${frame}`,
    );
    if (input.refusalNote) parts.push(`${input.refusalNote}, so the frame runs with an opaque origin and cannot touch host storage`);
    else parts.push('so the frame runs in the most restricted posture the IR can express');
  } else {
    parts.push(`ALLOWED app${input.toolLabel} as declared: sandbox "${input.sandboxValue}" on ${frame}.`);
  }
  parts.push(`bridge: ${bridgeOn.length > 0 ? bridgeOn.join(', ') : 'no features'}.`);
  parts.push(`frame height ${input.bounds.heightPx}px (max ${input.bounds.maxHeightPx}px).`);
  if (input.warnings > 0) parts.push(`${input.warnings} high-severity finding(s) recorded for the operator.`);
  return parts.join(' ');
}

function truncate(value: string, max = 80): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
