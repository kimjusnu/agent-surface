/**
 * Headless A2UI bridge: messages in, IR frames out, no DOM.
 *
 * ## Why the real `MessageProcessor` and not a hand-rolled state machine
 *
 * Verified against `@a2ui/web_core@0.11.0` on Node 22 with no `document`,
 * `window` or `customElements` in scope:
 *
 *  - The `@a2ui/web_core/v0_9` barrel *does* re-export
 *    `catalog/a2ui-lit-element.js`, so the DOM is one import away -- but
 *    `a2ui-lit-element` only *declares* a custom element class. Nothing
 *    dereferences `customElements` or `HTMLElement` at module scope, so the
 *    barrel loads and runs headlessly. (The `exports` map exposes no v0.9
 *    subpaths, so a deep import that would have avoided Lit entirely is
 *    impossible: it fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.)
 *  - `new MessageProcessor([...])`, `processMessages`, `getClientCapabilities`,
 *    `resolvePath` and `getClientDataModel` all work with no DOM.
 *
 * So the reference implementation is used directly rather than reimplemented.
 * That buys the catalog `.strict()` prop validation, the atomic
 * validate-then-mutate batch semantics, and the `A2uiError.code` values
 * (`STATE_ERROR`, `VALIDATION_ERROR`, `DATA_ERROR`, `EXPRESSION_ERROR`) that
 * the transcripts depend on. A local state machine would have had to
 * re-derive all three and would have drifted.
 *
 * ## What is hand-rolled, and why
 *
 * The node *tree*. `ComponentModel.componentTree` is a flat `{id, type,
 * ...props}` with no child resolution, and the class that does resolve it --
 * `NodeResolver` -- is constrained to catalogs whose functions are executable
 * (`F extends FunctionImplementation`). A schema-only catalog built by
 * `Catalog.fromSchema` is a compile-time error there, and
 * `node-resolver.d.ts` says so itself: "Hosts without implementations
 * (agent-side code) operate on `SurfaceModel` directly and never construct a
 * resolver." This adapter is exactly that host, so it walks the flat
 * `componentsModel` map itself.
 *
 * ## Error policy
 *
 * `MessageProcessor` *throws* on bad input rather than emitting, and never
 * calls `SurfaceModel.dispatchError` itself (only the DOM node layer does).
 * Both paths are therefore handled: throws become `warning` frames carrying
 * the real `A2uiError.code`, and `onError` is subscribed per surface for
 * errors raised asynchronously. `EventEmitter.emit` is async, so those frames
 * are queued and drained on the next `ingest()` or by `flushErrors()`.
 */

import {
  Catalog,
  MessageProcessor,
  type A2uiClientAction,
  type ComponentApi,
  type SurfaceModel,
} from '@a2ui/web_core/v0_9';
import type {
  DataModel,
  JsonObject,
  JsonPointer,
  JsonValue,
  SurfaceNode,
  UnstampedFrame,
} from '@agent-surface/protocol';
import { buildCatalogs, describeCatalog, type CatalogDescription, type SchemaOnlyCatalog } from './catalog.js';
import { toLiteral, toLiteralProps } from './bindings.js';
import { isJsonObject, parseA2uiMessage, type A2uiMessageKind, type A2uiVersion } from './messages.js';

/** Prop name A2UI's basic catalog uses for a component's children. */
const CHILDREN_PROP = 'children';

export interface BridgeOptions {
  /** Pre-built catalogs. Takes precedence over `rawCatalogs`. */
  readonly catalogs?: readonly SchemaOnlyCatalog[];
  /** Raw catalog payloads, converted with `Catalog.fromSchema`. */
  readonly rawCatalogs?: readonly unknown[];
  /** Version stamped on the processor; drives capability generation. */
  readonly version?: A2uiVersion;
  /** Sink for actions dispatched from a surface. */
  readonly onAction?: (action: A2uiClientAction) => void | Promise<void>;
}

export interface SurfaceSnapshot {
  readonly surfaceId: string;
  readonly catalogId: string;
  readonly sendDataModel: boolean;
  readonly data: DataModel;
  readonly nodes: SurfaceNode[];
}

export interface A2uiWarningDetail {
  readonly surfaceId?: string;
  readonly componentId?: string;
  readonly component?: string;
  readonly path?: string;
}

function warning(code: string, message: string, detail?: A2uiWarningDetail): UnstampedFrame {
  const clean: JsonObject = {};
  if (detail?.surfaceId !== undefined) clean['surfaceId'] = detail.surfaceId;
  if (detail?.componentId !== undefined) clean['componentId'] = detail.componentId;
  if (detail?.component !== undefined) clean['component'] = detail.component;
  if (detail?.path !== undefined) clean['path'] = detail.path;
  return {
    kind: 'warning',
    payload: { code, message, ...(Object.keys(clean).length > 0 ? { detail: clean } : {}) },
  };
}

/** Best-effort extraction of A2UI's machine-readable error code. */
function codeOf(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as unknown as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN_ERROR';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class A2uiBridge {
  readonly #processor: MessageProcessor<ComponentApi>;
  readonly #childRefProps = new Map<string, Set<string>>();
  readonly #errorSubscriptions = new Map<string, { unsubscribe(): void }>();
  #pendingAsync: UnstampedFrame[] = [];
  #disposed = false;

  constructor(options: BridgeOptions = {}) {
    const catalogs: SchemaOnlyCatalog[] = [];
    if (options.catalogs) {
      catalogs.push(...options.catalogs);
    } else if (options.rawCatalogs) {
      catalogs.push(...buildCatalogs(options.rawCatalogs).catalogs);
    }

    this.#childRefProps = collectChildRefProps(catalogs, options.rawCatalogs);

    // `MessageProcessor<T>` fixes its catalog parameter to
    // `Catalog<T, FunctionImplementation>`, but the processor never invokes a
    // function: it reads only `catalog.id` and `catalog.components` to validate
    // props. A schema-only catalog -- what `Catalog.fromSchema` returns, and
    // what an agent-side host has by definition -- is correct at runtime
    // (verified headlessly) but not expressible in that parameter type, so the
    // widening is asserted here, at the only place it is needed.
    this.#processor = new MessageProcessor<ComponentApi>(
      catalogs as unknown as Catalog<ComponentApi>[],
      options.onAction,
      { version: options.version ?? 'v0.9' },
    );
  }

  get processor(): MessageProcessor<ComponentApi> {
    return this.#processor;
  }

  get version(): A2uiVersion {
    return this.#processor.version;
  }

  get surfaceIds(): string[] {
    return [...this.#processor.model.surfacesMap.keys()];
  }

  /**
   * Consume one already-validated A2UI message and produce IR frames.
   * Never throws: validation, catalog lookup and state faults all become
   * `warning` frames.
   */
  ingest(message: unknown): UnstampedFrame[] {
    const frames: UnstampedFrame[] = this.drainPending();
    if (this.#disposed) return frames;

    const parsed = parseA2uiMessage(message);
    if (!parsed.ok) {
      for (const w of parsed.warnings) frames.push(warning(w.code, w.message, w.detail as A2uiWarningDetail));
      return frames;
    }

    // One message per `processMessages` call keeps the frame stream in 1:1
    // correspondence with the agent's messages, which is what the tracer's
    // time-travel replay needs. Batching would collapse them.
    try {
      this.#processor.processMessages([parsed.message]);
    } catch (err) {
      frames.push(
        warning(`A2UI_${codeOf(err)}`, messageOf(err), { surfaceId: surfaceIdOf(message) }),
      );
      return frames;
    }

    frames.push(...this.#framesForMessage(parsed.kind, parsed.message));
    return frames;
  }

  /** Frames queued by an async `SurfaceModel.dispatchError`. */
  drainPending(): UnstampedFrame[] {
    if (this.#pendingAsync.length === 0) return [];
    const out = this.#pendingAsync;
    this.#pendingAsync = [];
    return out;
  }

  /**
   * Await one turn of the microtask/macrotask queue and drain async errors.
   * `EventEmitter.emit` awaits its listeners, so the frames only exist after
   * the current task yields.
   */
  async flushErrors(): Promise<UnstampedFrame[]> {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return this.drainPending();
  }

  /** Surface state for tracers and eval harnesses; no DOM involved. */
  snapshot(surfaceId: string): SurfaceSnapshot | undefined {
    const surface = this.#processor.model.getSurface(surfaceId);
    if (!surface) return undefined;
    return {
      surfaceId,
      catalogId: surface.catalog.id,
      sendDataModel: surface.sendDataModel,
      data: this.#dataOf(surface),
      nodes: this.#nodesOf(surfaceId),
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const sub of this.#errorSubscriptions.values()) sub.unsubscribe();
    this.#errorSubscriptions.clear();
    this.#processor.model.dispose();
  }

  // -------------------------------------------------------------------------
  // Per-message frames
  // -------------------------------------------------------------------------

  #framesForMessage(kind: A2uiMessageKind, message: unknown): UnstampedFrame[] {
    switch (kind) {
      case 'createSurface':
        return this.#onCreateSurface(message);
      case 'updateComponents':
        return this.#onUpdateComponents(message);
      case 'updateDataModel':
        return this.#onUpdateDataModel(message);
      case 'deleteSurface':
        return this.#onDeleteSurface(message);
      default:
        return [];
    }
  }

  #onCreateSurface(message: unknown): UnstampedFrame[] {
    const body = bodyOf(message, 'createSurface');
    const surfaceId = str(body?.['surfaceId']);
    if (surfaceId === undefined) return [];

    const surface = this.#processor.model.getSurface(surfaceId);
    if (!surface) return [];
    this.#subscribeErrors(surface);

    const theme = surface.theme;
    // A2UI's `createSurface` has no title field, so the title is read out of
    // the free-form theme bag when the agent puts one there, and omitted
    // otherwise rather than invented.
    const title = isPlainObject(theme) ? str(theme['title']) : undefined;

    return [
      {
        kind: 'surface.created',
        payload: {
          surfaceId,
          catalogId: surface.catalog.id,
          ...(title !== undefined ? { title } : {}),
          data: this.#dataOf(surface),
          sendDataModel: surface.sendDataModel,
        },
        raw: message,
      },
    ];
  }

  #onUpdateComponents(message: unknown): UnstampedFrame[] {
    const body = bodyOf(message, 'updateComponents');
    const surfaceId = str(body?.['surfaceId']);
    if (surfaceId === undefined) return [];

    const surface = this.#processor.model.getSurface(surfaceId);
    if (!surface) return [];
    this.#subscribeErrors(surface);

    const frames: UnstampedFrame[] = [];
    const components = Array.isArray(body?.['components']) ? body['components'] : [];

    // `MessageProcessor` skips validation for component names absent from the
    // catalog, so an unknown name reaches the model unchecked. IR documents
    // `SurfaceNode.component` as validated against the catalog; the node is
    // still emitted (the renderer needs something to show) but a warning says
    // the catalog does not describe it.
    for (const component of components) {
      if (!isPlainObject(component)) continue;
      const name = str(component['component']);
      const id = str(component['id']);
      if (name === undefined || id === undefined) continue;
      if (!surface.catalog.components.has(name)) {
        frames.push(
          warning('A2UI_UNKNOWN_COMPONENT', `Component '${name}' (${id}) is not in catalog '${surface.catalog.id}'`, {
            surfaceId,
            componentId: id,
            component: name,
          }),
        );
      }
    }

    frames.push({
      kind: 'surface.nodes',
      payload: { surfaceId, nodes: this.#nodesOf(surfaceId, components), mode: 'merge' },
      raw: message,
    });
    return frames;
  }

  #onUpdateDataModel(message: unknown): UnstampedFrame[] {
    const body = bodyOf(message, 'updateDataModel');
    const surfaceId = str(body?.['surfaceId']);
    if (surfaceId === undefined) return [];

    // `processUpdateDataModelMessage` defaults an absent path to '/', so a
    // message with no path is a whole-model replace.
    const path: JsonPointer = str(body?.['path']) ?? '/';
    const hasValue = body !== undefined && 'value' in body;
    // An absent `value` means a delete in `DataModel` (it drops the key), but
    // `surface.data` has no remove variant, so it is reported as a null set.
    const value: JsonValue = hasValue ? (body['value'] as JsonValue) : null;

    return [
      {
        kind: 'surface.data',
        payload: { surfaceId, path, value, mode: 'set' },
        raw: message,
      },
    ];
  }

  #onDeleteSurface(message: unknown): UnstampedFrame[] {
    const body = bodyOf(message, 'deleteSurface');
    const surfaceId = str(body?.['surfaceId']);
    if (surfaceId === undefined) return [];
    this.#unsubscribeErrors(surfaceId);
    return [{ kind: 'surface.deleted', payload: { surfaceId }, raw: message }];
  }

  // -------------------------------------------------------------------------
  // State extraction
  // -------------------------------------------------------------------------

  #dataOf(surface: SurfaceModel<ComponentApi>): DataModel {
    let root: unknown;
    try {
      root = surface.dataModel.get('/');
    } catch (err) {
      // `DataModel.get` throws on forbidden path segments; the root is always
      // readable in practice, so this is belt-and-braces for a hostile model.
      this.#pendingAsync.push(
        warning(`A2UI_${codeOf(err)}`, `Could not read surface data: ${messageOf(err)}`, {
          surfaceId: surface.id,
        }),
      );
      return {};
    }
    return isPlainObject(root) ? (root as DataModel) : {};
  }

  /**
   * Build IR nodes for the components named by `components`, resolving child
   * references out of the processor's flat component map.
   *
   * `changed` empty means "rebuild the whole surface", which is what
   * `snapshot()` wants; otherwise only the components in the current message
   * are emitted, so a `mode: 'merge'` frame carries just the delta.
   */
  #nodesOf(surfaceId: string, changed: readonly unknown[] = []): SurfaceNode[] {
    const surface = this.#processor.model.getSurface(surfaceId);
    if (!surface) return [];

    if (changed.length === 0) {
      return [...surface.componentsModel.entries].map(([id]) =>
        this.#nodeFor(surfaceId, id, new Set<string>()),
      );
    }

    const out: SurfaceNode[] = [];
    const emitted = new Set<string>();
    for (const component of changed) {
      if (!isPlainObject(component)) continue;
      const id = str(component['id']);
      if (id === undefined || emitted.has(id)) continue;
      emitted.add(id);
      out.push(this.#nodeFor(surfaceId, id, new Set<string>()));
    }
    return out;
  }

  #nodeFor(surfaceId: string, id: string, visiting: Set<string>): SurfaceNode {
    const model = this.#processor.model.getSurface(surfaceId)?.componentsModel.get(id);
    if (!model) {
      // A child ref can name a component that has not arrived yet. IR types
      // `children` as `SurfaceNode[]`, so there is nothing type-safe to emit
      // for a placeholder; the missing id is simply not mounted.
      return { component: 'Unknown', id, props: {} };
    }

    // A hostile agent can make a component its own descendant. `visiting`
    // breaks the cycle instead of recursing until the stack dies.
    if (visiting.has(id)) return { component: model.type, id, props: {} };
    visiting.add(id);
    try {
      const raw = model.properties;
      const childPropNames = this.#childRefProps.get(model.type) ?? new Set<string>([CHILDREN_PROP]);
      const ownProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw)) {
        // Every child-ref prop is structural: `children` becomes
        // `SurfaceNode.children` and the rest become `slots`, so none of them
        // may also surface as a Literal prop.
        if (childPropNames.has(key)) continue;
        ownProps[key] = value;
      }

      const node: SurfaceNode = {
        component: model.type,
        id: model.id,
        props: toLiteralProps(ownProps),
      };

      const children = this.#resolveChildList(raw[CHILDREN_PROP], surfaceId, visiting);
      if (children.length > 0) node.children = children;

      const slots = this.#resolveSlots(raw, childPropNames, surfaceId, visiting);
      if (slots !== undefined) node.slots = slots;

      return node;
    } finally {
      visiting.delete(id);
    }
  }

  #resolveChildList(value: unknown, surfaceId: string, visiting: Set<string>): SurfaceNode[] {
    if (!Array.isArray(value)) return [];
    const out: SurfaceNode[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string') continue;
      out.push(this.#nodeFor(surfaceId, entry, visiting));
    }
    return out;
  }

  /**
   * Named child slots come from the raw catalog's `ComponentId`/`ChildList`
   * props. `children` is excluded: it maps to `SurfaceNode.children`.
   */
  #resolveSlots(
    raw: Record<string, unknown>,
    childRefProps: ReadonlySet<string>,
    surfaceId: string,
    visiting: Set<string>,
  ): Record<string, SurfaceNode> | undefined {
    let out: Record<string, SurfaceNode> | undefined;
    for (const [name, value] of Object.entries(raw)) {
      if (name === CHILDREN_PROP) continue;
      if (!childRefProps.has(name)) continue;

      if (Array.isArray(value)) {
        const nodes = this.#resolveChildList(value, surfaceId, visiting);
        if (nodes.length === 0) continue;
        out ??= {};
        out[name] = nodes.length === 1 ? nodes[0]! : mergeSlot(nodes);
        continue;
      }
      if (typeof value !== 'string') continue;
      out ??= {};
      out[name] = this.#nodeFor(surfaceId, value, visiting);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------

  #subscribeErrors(surface: SurfaceModel<ComponentApi>): void {
    if (this.#errorSubscriptions.has(surface.id)) return;
    const subscription = surface.onError.subscribe((error: unknown) => {
      const detail = isPlainObject(error) ? error : {};
      this.#pendingAsync.push(
        warning(
          str(detail['code']) ?? 'A2UI_SURFACE_ERROR',
          str(detail['message']) ?? 'A2UI surface reported an error',
          {
            surfaceId: str(detail['surfaceId']) ?? surface.id,
            ...(typeof detail['path'] === 'string' ? { path: detail['path'] } : {}),
          },
        ),
      );
    });
    this.#errorSubscriptions.set(surface.id, subscription);
  }

  #unsubscribeErrors(surfaceId: string): void {
    this.#errorSubscriptions.get(surfaceId)?.unsubscribe();
    this.#errorSubscriptions.delete(surfaceId);
  }
}

/**
 * `SurfaceNode.slots` holds a single node per name, so a multi-entry child
 * list in a named slot is folded into a synthetic `Column` parent rather than
 * being dropped.
 */
function mergeSlot(nodes: readonly SurfaceNode[]): SurfaceNode {
  return { component: 'Column', children: [...nodes] };
}

function bodyOf(message: unknown, key: A2uiMessageKind): JsonObject | undefined {
  if (!isJsonObject(message)) return undefined;
  const body = message[key];
  return isJsonObject(body) ? body : undefined;
}

function surfaceIdOf(message: unknown): string | undefined {
  for (const key of ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'] as const) {
    const body = bodyOf(message, key);
    const id = str(body?.['surfaceId']);
    if (id !== undefined) return id;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Build the child-ref map from the raw payloads where available, falling back
 * to the `children` convention. Pre-built `Catalog` instances have already
 * lost the marker (see the module comment), so the map is best-effort by
 * design and never blocks rendering.
 */
function collectChildRefProps(
  catalogs: readonly SchemaOnlyCatalog[],
  rawCatalogs: readonly unknown[] | undefined,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const catalog of catalogs) {
    for (const name of catalog.components.keys()) {
      out.set(name, new Set<string>([CHILDREN_PROP]));
    }
  }
  if (!rawCatalogs) return out;

  for (const raw of rawCatalogs) {
    const described = describeCatalog(raw);
    if (!described.ok) continue;
    for (const [name, props] of described.value.childRefProps) {
      const merged = out.get(name) ?? new Set<string>([CHILDREN_PROP]);
      for (const prop of props) merged.add(prop);
      out.set(name, merged);
    }
  }
  return out;
}
