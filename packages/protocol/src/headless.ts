/**
 * SSR-side helpers.
 *
 * The client uses `@a2ui/web_core`'s `MessageProcessor` directly. This module
 * is the isomorphic subset: the same capability negotiation, and a headless
 * tree walk that works without a DOM, so the tracer and the eval harness can
 * inspect what a surface *would* render.
 */

import type {
  DataModel,
  JsonObject,
  JsonPointer,
  ProtocolId,
  ProtocolSupport,
  SurfaceNode,
} from './ir.js';

// ---------------------------------------------------------------------------
// JSON Pointer
// ---------------------------------------------------------------------------

/** Escape a single reference token per RFC 6901. */
export function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function parsePointer(pointer: JsonPointer): string[] {
  if (pointer === '' || pointer === '/') return pointer === '/' ? [''] : [];
  if (!pointer.startsWith('/')) throw new Error(`Invalid JSON Pointer: ${pointer}`);
  return pointer.slice(1).split('/').map(unescapeToken);
}

export function buildPointer(tokens: readonly string[]): JsonPointer {
  if (tokens.length === 0) return '';
  return '/' + tokens.map(escapeToken).join('/');
}

/** Read a pointer, returning undefined for any missing or invalid path. */
export function getAtPointer(doc: unknown, pointer: JsonPointer): unknown {
  let cur: unknown = doc;
  for (const token of parsePointer(pointer)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[token];
  }
  return cur;
}

/**
 * Write a pointer, creating intermediate objects as needed. Array indices in
 * the path are honoured when the target exists.
 */
export function setAtPointer<T>(doc: T, pointer: JsonPointer, value: unknown): T {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) return value as T;
  const root: Record<string, unknown> = (doc ?? {}) as Record<string, unknown>;
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const key = tokens[i]!;
    const next = cur[key];
    if (next === null || typeof next !== 'object') cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[tokens[tokens.length - 1]!] = value;
  return doc;
}

// ---------------------------------------------------------------------------
// Capability negotiation
// ---------------------------------------------------------------------------

/**
 * Pick the best protocol from what both ends support.
 *
 * Preference order encodes the control/freedom tradeoff: a controlled surface
 * (AG-UI) is the safest default, a declarative one (A2UI) is richer, and
 * agent-authored apps (MCP Apps) are last because they run untrusted code.
 * `hostPreference` overrides, so a product can pin the order.
 */
export function negotiateProtocol(
  host: ProtocolSupport[],
  agent: ProtocolSupport[],
  hostPreference: readonly ProtocolId[] = ['ag-ui', 'a2ui', 'mcp-apps'],
): ProtocolSupport | null {
  const agentById = new Map(agent.map((p) => [p.id, p]));
  for (const id of hostPreference) {
    const hostSupport = host.find((p) => p.id === id);
    const agentSupport = agentById.get(id);
    if (!hostSupport?.supported || !agentSupport?.supported) continue;
    const shared = hostSupport.versions.filter((v) => agentSupport.versions.includes(v));
    if (shared.length === 0) continue;
    return { ...hostSupport, versions: [shared[0]!, ...shared.slice(1)] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Headless surface evaluation
// ---------------------------------------------------------------------------

export interface FlatNode {
  id: string;
  component: string;
  depth: number;
  parentId?: string;
  props: Record<string, unknown>;
}

export interface FlattenOptions {
  /** Injects ids for inline nodes that lack one. Deterministic per tree. */
  generateId?: (component: string, path: string) => string;
  /** Root of the id namespace. */
  prefix?: string;
}

/**
 * Depth-first flatten of a surface tree into a list.
 *
 * The tracer uses this to diff two runs without constructing React elements,
 * and the eval harness uses it to score structural correctness (did the agent
 * reference a component that does not exist, did it nest past the limit).
 */
export function flattenSurface(
  nodes: readonly SurfaceNode[],
  options: FlattenOptions = {},
): FlatNode[] {
  const prefix = options.prefix ?? 'n';
  const out: FlatNode[] = [];
  const seenIds = new Set<string>();
  // Guards against object-identity cycles, which a hostile agent can produce
  // even when every id is distinct or absent.
  const seenNodes = new Set<SurfaceNode>();
  let counter = 0;

  const gen = (component: string, path: string): string => {
    if (options.generateId) return options.generateId(component, path);
    return `${prefix}-${counter++}`;
  };

  const visit = (node: SurfaceNode, depth: number, parentId: string | undefined, path: string): void => {
    if (seenNodes.has(node)) return; // Cycles must not hang the flattener.
    seenNodes.add(node);
    const id = node.id ?? gen(node.component, path);
    if (seenIds.has(id)) return; // Duplicate ids would break action wiring.
    seenIds.add(id);
    out.push({
      id,
      component: node.component,
      depth,
      ...(parentId !== undefined ? { parentId } : {}),
      props: resolveProps(node.props ?? {}, {}),
    });
    const children = node.children ?? [];
    children.forEach((child, i) => {
      if (typeof child === 'string') return; // Ref indirection, resolved by the adapter.
      visit(child, depth + 1, id, `${path}/${node.component}[${i}]`);
    });
    if (node.slots) {
      for (const [slotName, slotValue] of Object.entries(node.slots)) {
        if (typeof slotValue === 'string') continue;
        visit(slotValue, depth + 1, id, `${path}/${node.component}#${slotName}`);
      }
    }
  };

  nodes.forEach((node, i) => visit(node, 0, undefined, `[${i}]`));
  return out;
}

/** Structural signature for diffing: component + depth, ids excluded. */
export function surfaceSignature(nodes: readonly SurfaceNode[]): string {
  return flattenSurface(nodes)
    .map((n) => `${'  '.repeat(n.depth)}${n.component}`)
    .join('\n');
}

/** Resolve literals against a data model. Only used for diffing/telemetry. */
export function resolveProps(
  props: Record<string, unknown>,
  data: DataModel,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    out[key] = resolveLiteral(value, data);
  }
  return out;
}

function resolveLiteral(value: unknown, data: DataModel): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveLiteral(v, data));
  if (value === null || typeof value !== 'object') return value;
  const node = value as JsonObject;
  if ('kind' in node && typeof node.kind === 'string') {
    switch (node.kind) {
      case 'literal':
        return node.value;
      case 'data': {
        const ref = node.ref as { pointer: string; relative?: boolean } | undefined;
        if (!ref) return undefined;
        return getAtPointer(data, ref.pointer);
      }
      case 'template': {
        const template = String(node.template ?? '');
        return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, pointer: string) => {
          const found = getAtPointer(data, pointer.startsWith('/') ? pointer : `/${pointer}`);
          return found === undefined || found === null ? '' : String(found);
        });
      }
      case 'binding':
        return node.fallback;
      default:
        return value;
    }
  }
  return resolveProps(value as Record<string, unknown>, data);
}
