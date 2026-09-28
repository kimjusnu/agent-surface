/**
 * Tolerant validation for the four A2UI v0.9 server-to-client messages.
 *
 * The strict zod schemas are taken from `@a2ui/web_core` rather than
 * re-declared, so this adapter cannot drift from the reference implementation.
 * What this module adds is the failure *policy*: `ProtocolAdapter.ingest` must
 * not throw, because a hostile or buggy agent is a normal operating condition
 * (see `ir.ts`). Every problem therefore becomes a warning with a stable code
 * and the message is dropped -- dropping rather than partially applying
 * matches `MessageProcessor`, which validates a whole `updateComponents` batch
 * before mutating any of it.
 *
 * Version handling: `server-to-client.d.ts` states v0.9 renderers accept
 * v0.9.1 messages because the catalog structure is identical, so both are
 * accepted and anything else is rejected with a warning rather than a throw.
 */

import { z } from 'zod';
import {
  A2uiMessageSchema,
  A2uiMessageListWrapperSchema,
  CreateSurfaceMessageSchema,
  DeleteSurfaceMessageSchema,
  UpdateComponentsMessageSchema,
  UpdateDataModelMessageSchema,
  formatZodIssue,
  type A2uiMessage,
} from '@a2ui/web_core/v0_9';
import type { JsonObject, JsonValue } from '@agent-surface/protocol';

// Re-exported so consumers validate against exactly the schemas the reference
// implementation validates against, rather than a local copy that can rot.
export {
  A2uiMessageSchema,
  A2uiMessageListWrapperSchema,
  CreateSurfaceMessageSchema,
  DeleteSurfaceMessageSchema,
  UpdateComponentsMessageSchema,
  UpdateDataModelMessageSchema,
  formatZodIssue,
};
export type { A2uiMessage };

export const A2UI_VERSIONS = ['v0.9', 'v0.9.1'] as const;
export type A2uiVersion = (typeof A2UI_VERSIONS)[number];

/** Newest first, matching the `ProtocolSupport.versions` ordering rule. */
export const A2UI_SUPPORTED_VERSIONS: readonly A2uiVersion[] = ['v0.9.1', 'v0.9'];

/** What a caller should negotiate when the agent supports either. */
export const A2UI_PREFERRED_VERSION: A2uiVersion = 'v0.9.1';

export const MESSAGE_ENVELOPE_KEYS = [
  'createSurface',
  'updateComponents',
  'updateDataModel',
  'deleteSurface',
] as const;
export type A2uiMessageKind = (typeof MESSAGE_ENVELOPE_KEYS)[number];

export const A2UI_WARNING_CODES = {
  NOT_AN_OBJECT: 'A2UI_NOT_AN_OBJECT',
  MISSING_VERSION: 'A2UI_MISSING_VERSION',
  UNSUPPORTED_VERSION: 'A2UI_UNSUPPORTED_VERSION',
  UNKNOWN_MESSAGE: 'A2UI_UNKNOWN_MESSAGE',
  AMBIGUOUS_MESSAGE: 'A2UI_AMBIGUOUS_MESSAGE',
  SCHEMA_INVALID: 'A2UI_SCHEMA_INVALID',
  MISSING_SURFACE_ID: 'A2UI_MISSING_SURFACE_ID',
  MISSING_CATALOG_ID: 'A2UI_MISSING_CATALOG_ID',
  MISSING_COMPONENTS: 'A2UI_MISSING_COMPONENTS',
  COMPONENT_MISSING_ID: 'A2UI_COMPONENT_MISSING_ID',
  COMPONENT_MISSING_NAME: 'A2UI_COMPONENT_MISSING_NAME',
  EMPTY_DATA_WRITE: 'A2UI_EMPTY_DATA_WRITE',
} as const;

export interface A2uiWarning {
  readonly code: string;
  readonly message: string;
  readonly detail?: JsonObject;
}

export interface ParsedMessageOk {
  readonly ok: true;
  readonly kind: A2uiMessageKind;
  readonly version: A2uiVersion;
  readonly message: A2uiMessage;
}

export interface ParsedMessageFail {
  readonly ok: false;
  /** Best-effort discriminator, present when an envelope key was recognisable. */
  readonly kind?: A2uiMessageKind;
  /** Echoed even when unsupported, so the transcript records what the agent sent. */
  readonly version?: string;
  readonly warnings: readonly A2uiWarning[];
}

export type ParsedMessage = ParsedMessageOk | ParsedMessageFail;

const STRICT_SCHEMA_BY_KIND = {
  createSurface: CreateSurfaceMessageSchema,
  updateComponents: UpdateComponentsMessageSchema,
  updateDataModel: UpdateDataModelMessageSchema,
  deleteSurface: DeleteSurfaceMessageSchema,
} as const satisfies Record<A2uiMessageKind, z.ZodType>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isA2uiVersion(value: unknown): value is A2uiVersion {
  return typeof value === 'string' && (A2UI_VERSIONS as readonly string[]).includes(value);
}

export function isA2uiMessageKind(value: unknown): value is A2uiMessageKind {
  return typeof value === 'string' && (MESSAGE_ENVELOPE_KEYS as readonly string[]).includes(value);
}

function presentKeys(obj: JsonObject): A2uiMessageKind[] {
  return MESSAGE_ENVELOPE_KEYS.filter((key) => key in obj);
}

/** Coerce anything into something assignable to `JsonValue`, never throwing. */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null) return null;
  if (value === undefined) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value as string | boolean;
  if (t === 'number') return Number.isFinite(value as number) ? (value as number) : null;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (t === 'object') {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJsonValue(v);
    return out;
  }
  return String(value);
}

/**
 * Validate one message strictly. Returns the reference implementation's
 * parse result plus its human-readable issues.
 */
export function validateA2uiMessage(
  raw: unknown,
): { ok: true; message: A2uiMessage } | { ok: false; issues: string[] } {
  const result = A2uiMessageSchema.safeParse(raw);
  if (result.success) return { ok: true, message: result.data as A2uiMessage };
  return { ok: false, issues: result.error.issues.map(formatZodIssue) };
}

/**
 * Tolerant parse. Never throws and never returns a message it could not
 * validate against the reference schema; every other outcome is a warning.
 */
export function parseA2uiMessage(raw: unknown): ParsedMessage {
  if (!isJsonObject(raw)) {
    return {
      ok: false,
      warnings: [
        {
          code: A2UI_WARNING_CODES.NOT_AN_OBJECT,
          message: `A2UI message must be a JSON object, received ${describe(raw)}`,
        },
      ],
    };
  }

  const rawVersion = raw['version'];
  if (rawVersion === undefined) {
    return {
      ok: false,
      warnings: [
        {
          code: A2UI_WARNING_CODES.MISSING_VERSION,
          message: 'A2UI message has no `version` field',
        },
      ],
    };
  }
  if (!isA2uiVersion(rawVersion)) {
    return {
      ok: false,
      version: String(rawVersion),
      warnings: [
        {
          code: A2UI_WARNING_CODES.UNSUPPORTED_VERSION,
          message: `Unsupported A2UI version '${String(rawVersion)}'; supported: ${A2UI_VERSIONS.join(', ')}`,
          detail: { version: String(rawVersion), supported: A2UI_VERSIONS.join(',') },
        },
      ],
    };
  }

  const kinds = presentKeys(raw);
  if (kinds.length === 0) {
    return {
      ok: false,
      version: rawVersion,
      warnings: [
        {
          code: A2UI_WARNING_CODES.UNKNOWN_MESSAGE,
          message: `No A2UI envelope key present; expected one of ${MESSAGE_ENVELOPE_KEYS.join(', ')}`,
        },
      ],
    };
  }
  if (kinds.length > 1) {
    // `MessageProcessor.processMessage` throws on this; we refuse earlier so
    // the transcript gets a warning instead of an exception.
    return {
      ok: false,
      version: rawVersion,
      warnings: [
        {
          code: A2UI_WARNING_CODES.AMBIGUOUS_MESSAGE,
          message: `Message carries multiple update types: ${kinds.join(', ')}`,
          detail: { kinds: kinds.join(',') },
        },
      ],
    };
  }

  const kind = kinds[0]!;
  const strict = STRICT_SCHEMA_BY_KIND[kind].safeParse(raw);
  const envelope = raw[kind];
  const body = isJsonObject(envelope) ? envelope : {};

  // The reference schema is deliberately lax where the processor is strict:
  // `updateComponents[].id` is optional and `updateDataModel.path`/`value` are
  // both optional, so `{surfaceId, no id}` and `{surfaceId}` pass zod and are
  // only rejected deeper in `MessageProcessor`. These checks therefore run on
  // every message, not just on schema failures -- catching them here is what
  // turns a thrown `A2uiValidationError` into a `warning` frame.
  const semantic = semanticWarnings(kind, body);
  const strictIssues = strict.success
    ? []
    : strict.error.issues.map(formatZodIssue);

  if (strict.success && semantic.length === 0) {
    return { ok: true, kind, version: rawVersion, message: strict.data as A2uiMessage };
  }

  const warnings: A2uiWarning[] = [
    ...(strict.success
      ? []
      : [
          {
            code: A2UI_WARNING_CODES.SCHEMA_INVALID,
            message: `${kind} failed A2UI ${rawVersion} validation: ${strictIssues.join('; ')}`,
            detail: { kind, version: rawVersion, issues: toJsonValue(strict.error.issues) },
          } satisfies A2uiWarning,
        ]),
    ...semantic,
  ];

  return { ok: false, kind, version: rawVersion, warnings };
}

/**
 * Semantic rules the reference schema leaves to `MessageProcessor`.
 *
 * These run on every message, including ones that pass zod, because the schema
 * marks `updateComponents[].id` and `updateDataModel.path`/`value` optional.
 * Each rule corresponds to a specific downstream hazard rather than a
 * stylistic preference.
 */
function semanticWarnings(kind: A2uiMessageKind, body: JsonObject): A2uiWarning[] {
  const out: A2uiWarning[] = [];
  const surfaceId = body['surfaceId'];

  if (typeof surfaceId !== 'string' || surfaceId.length === 0) {
    out.push({
      code: A2UI_WARNING_CODES.MISSING_SURFACE_ID,
      message: `${kind} is missing a non-empty 'surfaceId'`,
    });
  }

  switch (kind) {
    case 'createSurface': {
      if (typeof body['catalogId'] !== 'string' || body['catalogId'].length === 0) {
        out.push({
          code: A2UI_WARNING_CODES.MISSING_CATALOG_ID,
          message: 'createSurface is missing a non-empty \'catalogId\'',
        });
      }
      break;
    }
    case 'updateComponents': {
      const components = body['components'];
      if (!Array.isArray(components)) {
        out.push({
          code: A2UI_WARNING_CODES.MISSING_COMPONENTS,
          message: 'updateComponents is missing a \'components\' array',
        });
        break;
      }
      components.forEach((component, index) => {
        if (!isJsonObject(component)) return;
        if (typeof component['id'] !== 'string' || component['id'].length === 0) {
          out.push({
            code: A2UI_WARNING_CODES.COMPONENT_MISSING_ID,
            message: `updateComponents[${index}] has no non-empty 'id'`,
            detail: { index },
          });
        }
        if (typeof component['component'] !== 'string' || component['component'].length === 0) {
          out.push({
            code: A2UI_WARNING_CODES.COMPONENT_MISSING_NAME,
            message: `updateComponents[${index}] has no non-empty 'component'`,
            detail: { index },
          });
        }
      });
      break;
    }
    case 'updateDataModel': {
      const hasPath = 'path' in body;
      const hasValue = 'value' in body;
      if (!hasPath && !hasValue) {
        // `processUpdateDataModelMessage` defaults `path` to '/', so this shape
        // would call `dataModel.set('/', undefined)` and blank the whole
        // surface. Refusing it is the difference between a warning and data loss.
        out.push({
          code: A2UI_WARNING_CODES.EMPTY_DATA_WRITE,
          message:
            "updateDataModel has neither 'path' nor 'value'; it would replace the surface root with undefined",
        });
      }
      break;
    }
    case 'deleteSurface':
      break;
  }

  return out;
}

/**
 * Flatten any transport envelope into a message list.
 *
 * Handles the `A2uiMessageListWrapper` (`{messages: [...]}`) the spec defines
 * and a bare array. A non-envelope value is returned as a single-element list
 * so the caller can report it through the same warning path.
 */
export function collectMessages(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isJsonObject(raw) && Array.isArray(raw['messages'])) return raw['messages'];
  return [raw];
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
