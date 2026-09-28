/**
 * Catalog handling.
 *
 * Two paths are offered on purpose:
 *
 *  - `buildCatalog` produces a real `Catalog` via `Catalog.fromSchema`, which
 *    converts each component's JSON Schema into a `.strict()` zod schema. That
 *    is what `MessageProcessor` needs, and it is also what makes the reference
 *    implementation reject unknown props during `updateComponents`.
 *  - `describeCatalog` is schema-only: it reports what the raw payload declares
 *    without building zod at all. The renderer uses it to learn child-slot
 *    names, and a host that only wants to validate or re-advertise the catalog
 *    never has to pay for the conversion.
 *
 * Child-slot detection reads the **raw JSON Schema** (`$ref` ending in
 * `/$defs/ComponentId` or `/$defs/ChildList`) rather than the built zod
 * schema. `web_core` tags child refs via `childRefKindOf(schema)`, but that
 * marker lives in `schema._def` and `schema_loader` wraps every optional
 * property in `.optional()`, so the tag is already gone by the time a consumer
 * can see it. The wire format is the only public place the information survives.
 */

import { Catalog, type ComponentApi, type FunctionApi } from '@a2ui/web_core/v0_9';
import type { JsonObject, JsonValue } from '@agent-surface/protocol';
import { isJsonObject } from './messages.js';

/** A schema-only `Catalog` carries signatures with no executable bodies. */
export type SchemaOnlyCatalog = Catalog<ComponentApi, FunctionApi>;

export interface CatalogDescription {
  readonly catalogId: string;
  /** Component name -> raw JSON Schema, verbatim from the payload. */
  readonly components: Readonly<Record<string, JsonObject>>;
  /** Component names typed as a child reference (ComponentId or ChildList). */
  readonly childRefProps: ReadonlyMap<string, ReadonlySet<string>>;
  readonly functions: readonly JsonObject[];
  readonly theme?: JsonObject;
}

export type CatalogResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const CHILD_REF_SUFFIXES = ['/$defs/ComponentId', '/$defs/ChildList'] as const;

function isChildRefRef(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return CHILD_REF_SUFFIXES.some((suffix) => value.endsWith(suffix));
}

/** Walk a component's raw schema, including `allOf` branches and `oneOf`/`anyOf`. */
function collectChildRefProps(schema: JsonValue, out: Set<string>, depth = 0): Set<string> {
  if (depth > 8 || !isJsonObject(schema)) return out;

  for (const branch of [schema['allOf'], schema['oneOf'], schema['anyOf']]) {
    if (!Array.isArray(branch)) continue;
    for (const item of branch) {
      if (typeof item === 'string') continue;
      collectChildRefProps(item as JsonValue, out, depth + 1);
    }
  }

  const properties = schema['properties'];
  if (isJsonObject(properties)) {
    for (const [name, propSchema] of Object.entries(properties)) {
      if (isChildRefRef(isJsonObject(propSchema) ? propSchema['$ref'] : undefined)) {
        out.add(name);
        continue;
      }
      // `oneOf` unions (e.g. an enum that also admits a DataBinding) hide the
      // ref one level down, so branch before deciding a prop is a plain value.
      if (isJsonObject(propSchema)) {
        for (const key of ['oneOf', 'anyOf'] as const) {
          const branches = propSchema[key];
          if (!Array.isArray(branches)) continue;
          if (branches.some((b) => isChildRefRef(isJsonObject(b) ? b['$ref'] : undefined))) {
            out.add(name);
          }
        }
      }
    }
  }
  return out;
}

/**
 * Describe a raw catalog payload without building zod.
 *
 * Accepts the same shapes as `Catalog.fromSchema`: a bare catalog object, or a
 * `a2uiClientCapabilities` object to pull the first inline catalog from.
 */
export function describeCatalog(raw: unknown): CatalogResult<CatalogDescription> {
  if (!isJsonObject(raw)) {
    return { ok: false, error: `catalog payload must be an object, received ${typeof raw}` };
  }

  const source = pickCatalogSource(raw);
  if (source === undefined) {
    return { ok: false, error: "catalog payload has no 'catalogId', '$id' or 'id' field" };
  }

  const catalogId = source.catalogId;
  if (typeof catalogId !== 'string' || catalogId.length === 0) {
    return { ok: false, error: "catalog payload has no 'catalogId', '$id' or 'id' field" };
  }

  const rawComponents = isJsonObject(source.components) ? source.components : {};
  const components: Record<string, JsonObject> = {};
  const childRefProps = new Map<string, Set<string>>();

  for (const [name, componentSchema] of Object.entries(rawComponents)) {
    if (!isJsonObject(componentSchema)) continue;
    components[name] = componentSchema;
    childRefProps.set(name, collectChildRefProps(componentSchema, new Set<string>()));
  }

  const rawFunctions = source.functions;
  const functions: JsonObject[] = [];
  if (Array.isArray(rawFunctions)) {
    for (const fn of rawFunctions) if (isJsonObject(fn)) functions.push(fn);
  } else if (isJsonObject(rawFunctions)) {
    for (const [name, defn] of Object.entries(rawFunctions)) {
      if (!isJsonObject(defn)) continue;
      functions.push({ name, ...defn });
    }
  }

  return {
    ok: true,
    value: {
      catalogId,
      components,
      childRefProps,
      functions,
      ...(isJsonObject(source.theme) ? { theme: source.theme } : {}),
    },
  };
}

/**
 * A `clientCapabilities` object carries catalogs under `inlineCatalogs`; take
 * the first one so a host can accept an agent-supplied catalog verbatim.
 */
function pickCatalogSource(raw: JsonObject): JsonObject | undefined {
  const inline = raw['inlineCatalogs'];
  if (Array.isArray(inline) && isJsonObject(inline[0])) return inline[0];
  return raw;
}

/** Every inline catalog found in an `a2uiClientCapabilities` payload. */
export function extractInlineCatalogs(capabilities: unknown): unknown[] {
  if (!isJsonObject(capabilities)) return [];
  for (const versionCaps of Object.values(capabilities)) {
    if (!isJsonObject(versionCaps)) continue;
    const inline = versionCaps['inlineCatalogs'];
    if (Array.isArray(inline)) return inline;
  }
  return [];
}

/**
 * Build the `Catalog` that `MessageProcessor` requires.
 *
 * Never throws: a malformed payload is a recoverable condition here, and the
 * bridge turns the failure into a `warning` frame.
 */
export function buildCatalog(raw: unknown): CatalogResult<SchemaOnlyCatalog> {
  const described = describeCatalog(raw);
  if (!described.ok) return described;
  try {
    return { ok: true, value: Catalog.fromSchema(raw as JsonObject) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Build several catalogs, reporting each failure against its index. */
export function buildCatalogs(
  raws: readonly unknown[],
): { catalogs: SchemaOnlyCatalog[]; failures: { index: number; error: string }[] } {
  const catalogs: SchemaOnlyCatalog[] = [];
  const failures: { index: number; error: string }[] = [];
  raws.forEach((raw, index) => {
    const built = buildCatalog(raw);
    if (built.ok) catalogs.push(built.value);
    else failures.push({ index, error: built.error });
  });
  return { catalogs, failures };
}
