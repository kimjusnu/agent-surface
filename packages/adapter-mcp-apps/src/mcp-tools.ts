/**
 * MCP `tools/call` result parsing.
 *
 * SEP-1865 links a tool to its UI through `_meta.ui.resourceUri`, and the host
 * then reads the `ui://` resource with `resources/read`. Servers are also seen
 * in the wild inlining the document directly in the tool result, so this parser
 * accepts all three shapes a host realistically receives:
 *
 *   1. `_meta.ui.resourceUri` plus an inlined `resource` content block,
 *   2. a `resource` content block whose `mimeType` is HTML (including the
 *      spec's `text/html;profile=mcp-app` and the older OpenAI
 *      `text/html+skybridge`),
 *   3. a `ui://` resource reference with no body yet, which the host must read
 *      before it can render anything.
 *
 * The parser is total: it never throws, and it never trusts a field it did not
 * read out of the response itself. Everything it returns is a *declaration* to
 * be handed to `evaluateApp`, which is where every permission is decided.
 */

import type { JsonObject, JsonValue } from '@agent-surface/protocol';
import type { DeclaredUiCsp } from './policy.js';

export const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app';
export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';

const HTML_MIME_RE = /^text\/html\b/i;

export interface McpUiPermissions {
  camera?: Record<string, never>;
  microphone?: Record<string, never>;
  geolocation?: Record<string, never>;
  clipboardWrite?: Record<string, never>;
}

export interface McpUiResource {
  /** `ui://` resource identity, when the server named one. */
  uri: string | null;
  /** The document body, when the server inlined it. */
  html: string | null;
  /** Human label for the frame chrome. */
  title: string;
  /** Bridge version the app declares. */
  bridgeVersion: '0.1' | '0.2';
  /** Sandbox posture the app *requested*. Policy decides what it gets. */
  requestedSandbox: string;
  /** CSP request from `_meta.ui.csp`. Never an input to the policy itself. */
  csp: DeclaredUiCsp;
  permissions: McpUiPermissions;
  /** Stable-origin request (`_meta.ui.domain`). Host-dependent; advisory. */
  domain: string | null;
  prefersBorder: boolean | null;
  /** The text the model sees, kept so a host can still render something if UI is refused. */
  textFallback: string;
}

export interface McpToolCallParse {
  resource: McpUiResource | null;
  textFallback: string;
  isError: boolean;
  /** Non-fatal observations for the operator, e.g. "tool declared ui://view but no body was inlined". */
  notes: string[];
}

const BRIDGE_VERSIONS = new Set(['0.1', '0.2']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function readMeta(root: Record<string, unknown>): Record<string, unknown> {
  const meta = root['_meta'] ?? root['meta'];
  return isRecord(meta) ? meta : {};
}

/**
 * Merge the `ui` objects from every `_meta` location, most specific first.
 *
 * SEP-1865 says the content item wins over the listing entry, but precedence is
 * per field, not per object: a server that puts `csp` on the content item and
 * `sandbox` on the tool result has declared both, and silently dropping the
 * second would mean rendering the app in a posture it never asked for.
 */
function readUiMeta(...sources: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const source of sources) {
    if (!source) continue;
    const ui = source['ui'];
    if (!isRecord(ui)) continue;
    for (const [key, value] of Object.entries(ui)) {
      if (!(key in merged)) merged[key] = value;
    }
  }
  return merged;
}

function decodeBase64Utf8(value: string): string | null {
  try {
    const binary = atob(value.replace(/\s+/g, ''));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}

function looksLikeHtmlDocument(value: string): boolean {
  const head = value.slice(0, 512).toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html') || head.includes('<body');
}

/** Does this MIME type identify an MCP Apps document? */
export function isUiMimeType(mimeType: unknown): boolean {
  if (typeof mimeType !== 'string') return false;
  const normalized = mimeType.split(';')[0]?.trim() ?? '';
  return HTML_MIME_RE.test(normalized);
}

export function isUiResourceUri(uri: unknown): boolean {
  return typeof uri === 'string' && uri.toLowerCase().startsWith('ui://');
}

interface HtmlCandidate {
  html: string;
  uri: string | null;
  mimeType: string | null;
  name: string | null;
  meta: Record<string, unknown> | undefined;
}

function collectHtmlCandidate(content: unknown, notes: string[]): HtmlCandidate | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = asString(block['type']);
    if (type === 'resource') {
      const resource = block['resource'];
      if (!isRecord(resource)) continue;
      const mimeType = asString(resource['mimeType']);
      const uri = asString(resource['uri']);
      const text = asString(resource['text']);
      const blob = asString(resource['blob']);
      const meta = isRecord(resource['_meta']) ? (resource['_meta'] as Record<string, unknown>) : undefined;
      if (text && isUiMimeType(mimeType)) return { html: text, uri, mimeType, name: asString(resource['name']), meta };
      if (blob && isUiMimeType(mimeType)) {
        const decoded = decodeBase64Utf8(blob);
        if (decoded !== null) return { html: decoded, uri, mimeType, name: asString(resource['name']), meta };
        notes.push('ui resource carried a base64 blob that could not be decoded');
        continue;
      }
      if (text && isUiResourceUri(uri)) return { html: text, uri, mimeType, name: asString(resource['name']), meta };
      continue;
    }
    if (type === 'text') {
      const text = asString(block['text']);
      if (text && looksLikeHtmlDocument(text)) {
        notes.push('ui document arrived as a plain text content block; treated as HTML because it starts with a document tag');
        return { html: text, uri: null, mimeType: null, name: null, meta: undefined };
      }
    }
  }
  return null;
}

function readBridgeVersion(uiMeta: Record<string, unknown>, html: string | null): '0.1' | '0.2' {
  const fromMeta = asString(uiMeta['bridgeVersion']) ?? asString(uiMeta['bridge-version']);
  if (fromMeta && BRIDGE_VERSIONS.has(fromMeta)) return fromMeta as '0.1' | '0.2';
  if (html) {
    const fromDoc =
      /<meta[^>]+name\s*=\s*["']agent-surface:bridge-version["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] ??
      /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']agent-surface:bridge-version["']/i.exec(html)?.[1];
    if (fromDoc && BRIDGE_VERSIONS.has(fromDoc.trim())) return fromDoc.trim() as '0.1' | '0.2';
  }
  return '0.1';
}

function readCsp(uiMeta: Record<string, unknown>): DeclaredUiCsp {
  const raw = uiMeta['csp'];
  if (!isRecord(raw)) return {};
  const out: DeclaredUiCsp = {};
  const connect = asStringArray(raw['connectDomains']);
  const resource = asStringArray(raw['resourceDomains']);
  const frame = asStringArray(raw['frameDomains']);
  const base = asStringArray(raw['baseUriDomains']);
  if (connect.length > 0) out.connectDomains = connect;
  if (resource.length > 0) out.resourceDomains = resource;
  if (frame.length > 0) out.frameDomains = frame;
  if (base.length > 0) out.baseUriDomains = base;
  return out;
}

function readPermissions(uiMeta: Record<string, unknown>): McpUiPermissions {
  const raw = uiMeta['permissions'];
  if (!isRecord(raw)) return {};
  const out: McpUiPermissions = {};
  if (isRecord(raw['camera'])) out.camera = {};
  if (isRecord(raw['microphone'])) out.microphone = {};
  if (isRecord(raw['geolocation'])) out.geolocation = {};
  if (isRecord(raw['clipboardWrite'])) out.clipboardWrite = {};
  return out;
}

/**
 * Split a `tools/call` result into "is there UI here?" and "what did the
 * server say the UI is?". Both halves are advisory; `evaluateApp` decides.
 */
export function parseMcpToolCallResult(raw: unknown): McpToolCallParse {
  const notes: string[] = [];
  if (!isRecord(raw)) {
    return { resource: null, textFallback: '', isError: false, notes: ['tool result was not an object'] };
  }

  const content = raw['content'];
  const rootMeta = readMeta(raw);
  const structured = isRecord(raw['structuredContent']) ? (raw['structuredContent'] as Record<string, unknown>) : undefined;

  const candidate = collectHtmlCandidate(content, notes);

  // Listing-level metadata is the fallback; content-level wins, per SEP-1865
  // "Metadata Location".
  const uiMeta = readUiMeta(candidate?.meta, structured, rootMeta);
  const deprecatedFlatUri = asString(rootMeta['ui/resourceUri']);
  const openAiTemplate = asString(rootMeta['openai/outputTemplate']);
  const resourceUri =
    (isUiResourceUri(asString(uiMeta['resourceUri'])) ? asString(uiMeta['resourceUri']) : null) ??
    candidate?.uri ??
    (isUiResourceUri(deprecatedFlatUri) ? deprecatedFlatUri : null) ??
    (isUiResourceUri(openAiTemplate) ? openAiTemplate : null);

  const textFallback = collectText(content);
  if (resourceUri && candidate === null) {
    notes.push(`${resourceUri} was referenced but no document body was inlined; the host must read the resource before rendering`);
  }
  if (deprecatedFlatUri) {
    notes.push("server used the deprecated flat _meta['ui/resourceUri']; it was honored, but _meta.ui.resourceUri is the non-deprecated form");
  }
  if (candidate && candidate.mimeType && !HTML_MIME_RE.test(candidate.mimeType.split(';')[0] ?? '')) {
    notes.push(`ui resource declared an unexpected mimeType (${candidate.mimeType})`);
  }

  if (resourceUri === null && candidate === null) {
    return { resource: null, textFallback, isError: raw['isError'] === true, notes };
  }

  const toolTitle =
    asString(uiMeta['title']) ??
    candidate?.name ??
    asString(structured?.['title']) ??
    asString(rootMeta['title']) ??
    'MCP App';

  const requestedSandbox =
    asString(uiMeta['sandbox']) ??
    asString(rootMeta['agent-surface/sandbox']) ??
    // An app that says nothing gets scripting in an opaque origin: enough to
    // run the bridge, not enough to touch anything the host owns.
    'sandboxed-scripts';

  const html = candidate?.html ?? null;
  return {
    resource: {
      uri: resourceUri ?? candidate?.uri ?? null,
      html,
      title: toolTitle,
      bridgeVersion: readBridgeVersion(uiMeta, html),
      requestedSandbox,
      csp: readCsp(uiMeta),
      permissions: readPermissions(uiMeta),
      domain: asString(uiMeta['domain']),
      prefersBorder: typeof uiMeta['prefersBorder'] === 'boolean' ? uiMeta['prefersBorder'] : null,
      textFallback,
    },
    textFallback,
    isError: raw['isError'] === true,
    notes,
  };
}

/** Concatenate the `text` blocks so a refused app still has a model-visible fallback. */
export function collectText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'text') {
      const text = asString(block['text']);
      if (text) parts.push(text);
    }
  }
  return parts.join('\n');
}

/**
 * Build the JSON-RPC `tools/call` parameters the host sends to the MCP server
 * when an app asks for a tool. Kept here so the adapter and the bridge cannot
 * drift on the method name.
 */
export function toolCallParams(name: string, args: JsonObject): JsonObject {
  const params: JsonObject = { name };
  if (Object.keys(args).length > 0) params['arguments'] = args as JsonValue;
  return { method: 'tools/call', params };
}
