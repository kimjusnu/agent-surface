/**
 * `ProtocolAdapter` for MCP Apps.
 *
 * The adapter's job is narrow: notice that an MCP `tools/call` result carries a
 * UI document, ask the policy engine whether the host may render it, and emit
 * either an `app.attached` frame or a `warning` frame. It never emits
 * `app.attached` for anything the policy refused -- the host must not be told
 * to render a frame we decided is unsafe, or the decision becomes advisory.
 *
 * Spec: SEP-1865 "MCP Apps"; the frame contract is `EmbeddedApp` in
 * `@agent-surface/protocol`, which this package does not extend.
 */

import type {
  ActionEvent,
  AdapterInput,
  EmbeddedApp,
  EncodedAction,
  JsonObject,
  ProtocolAdapter,
  StatePatch,
  SurfaceFrame,
  UnstampedFrame,
} from '@agent-surface/protocol';
import { DEFAULT_MAX_FRAME_HEIGHT_PX, evaluateApp, type PolicyDecision } from './policy.js';
import { MCP_APPS_EXTENSION_ID, MCP_APPS_MIME_TYPE, parseMcpToolCallResult } from './mcp-tools.js';
import { materializeFrameSource } from './iframe-src.js';

export const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';
export const MCP_APPS_SUPPORTED_BRIDGE_VERSIONS = ['0.1', '0.2'] as const;

export interface McpAppsAdapterOptions {
  /** Absolute origin of the host page. Required: there is no `'*'` fallback. */
  hostOrigin: string;
  /** Origins an app may load sub-resources from or connect to. */
  allowedOrigins?: readonly string[];
  /** Master switch. Defaults to false: agent-authored code is never unsandboxed here. */
  allowUntrustedCode?: boolean;
  maxFrameHeightPx?: number;
  dev?: boolean;
  trustedBlobUrls?: readonly string[];
  toolInvokeOrigin?: string | null;
  hostName?: string;
  hostVersion?: string;
  /** Injectable clock so tests and the tracer get stable timestamps. */
  now?: () => number;
}

export class McpAppsAdapter implements ProtocolAdapter {
  readonly id = 'mcp-apps' as const;
  readonly supportedVersions: string[] = [...MCP_APPS_SUPPORTED_BRIDGE_VERSIONS];
  readonly #options: McpAppsAdapterOptions;
  /** Last decision per app/tool, for the host chrome and the audit trail. */
  readonly #decisions = new Map<string, PolicyDecision>();

  constructor(options: McpAppsAdapterOptions) {
    if (!options || typeof options.hostOrigin !== 'string' || options.hostOrigin.length === 0) {
      throw new Error('McpAppsAdapter requires hostOrigin: without it there is no validated postMessage target');
    }
    this.#options = options;
  }

  /** Most recent decision for a tool, or undefined when nothing was rendered. */
  lastDecision(toolName: string): PolicyDecision | undefined {
    return this.#decisions.get(toolName);
  }

  getClientCapabilities(options?: { includeInlineCatalogs?: boolean }): JsonObject {
    const maxFrameHeightPx = this.#options.maxFrameHeightPx ?? DEFAULT_MAX_FRAME_HEIGHT_PX;
    const caps: JsonObject = {
      protocol: 'mcp-apps',
      irVersion: '0.1',
      specVersion: MCP_APPS_PROTOCOL_VERSION,
      bridgeVersions: [...MCP_APPS_SUPPORTED_BRIDGE_VERSIONS],
      hostInfo: {
        name: this.#options.hostName ?? 'agent-surface',
        version: this.#options.hostVersion ?? '0.1.0',
      },
      hostCapabilities: {
        supportsEmbeddedApps: true,
        bridge: {
          postMessage: true,
          toolInvoke: true,
          a2a: true,
          heightResize: true,
        },
        maxFrameHeightPx,
        transport: 'postmessage',
      },
      security: {
        allowUntrustedCode: this.#options.allowUntrustedCode === true,
        allowedOrigins: [...(this.#options.allowedOrigins ?? [])],
        // Advertised so an agent can size its app to something the host will
        // actually honor instead of discovering the ceiling at render time.
        sandboxPolicy: {
          defaultSandbox: 'sandboxed-scripts',
          refuses: ['allow-scripts + allow-same-origin', 'allow-same-origin'],
          reason: 'the combination is a sandbox escape, not a sandbox',
        },
      },
      extensions: {
        [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APPS_MIME_TYPE] },
      },
    };
    if (options?.includeInlineCatalogs === true) {
      // MCP Apps do not use the declarative catalog; the app brings its own DOM.
      caps['inlineCatalogs'] = [];
    }
    return caps;
  }

  /**
   * `ingest` consumes one MCP JSON-RPC response body (or one `tools/call`
   * result object) and emits at most one `app.attached` plus the warnings that
   * explain it. It never throws: a hostile or broken payload is a `warning`
   * frame, which is the contract in `ProtocolAdapter`.
   */
  ingest(input: AdapterInput): Iterable<SurfaceFrame> {
    const frames: SurfaceFrame[] = [];
    const now = this.#options.now ?? Date.now;
    const push = (partial: UnstampedFrame): void => {
      frames.push({
        ...partial,
        seq: 0,
        source: 'mcp-apps',
        ts: now(),
        threadId: input.threadId,
        runId: input.runId,
      } as SurfaceFrame);
    };

    let raw = input.raw;
    if (raw === undefined && typeof input.text === 'string') {
      try {
        raw = JSON.parse(input.text);
      } catch (err) {
        push({
          kind: 'warning',
          payload: {
            code: 'MCP_UNPARSEABLE_BODY',
            message: `could not parse the MCP body as JSON: ${err instanceof Error ? err.message : String(err)}`,
          },
          ...(input.step !== undefined ? { step: input.step } : {}),
        });
        return frames;
      }
    }
    if (raw === undefined || raw === null) {
      push({
        kind: 'warning',
        payload: { code: 'MCP_EMPTY_BODY', message: 'no MCP body to ingest' },
        ...(input.step !== undefined ? { step: input.step } : {}),
      });
      return frames;
    }

    let parsed;
    try {
      parsed = parseMcpToolCallResult(unwrapToolResult(raw));
    } catch (err) {
      push({
        kind: 'warning',
        payload: {
          code: 'MCP_PARSE_FAILED',
          message: `MCP tool result could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
        },
        ...(input.step !== undefined ? { step: input.step } : {}),
      });
      return frames;
    }

    const toolName =
      readToolName(unwrapToolResult(raw)) ??
      parsed.resource?.uri ??
      'unknown-tool';

    for (const note of parsed.notes) {
      push({ kind: 'warning', payload: { code: 'MCP_UI_NOTE', message: note, detail: { toolName } } });
    }

    if (parsed.resource === null) {
      // A plain tool result. Nothing to render, and that is the normal case:
      // SEP-1865 requires every UI tool to also return a text fallback.
      return frames;
    }

    const decision = evaluateApp({
      app: buildEmbeddedApp(parsed.resource.uri ?? `ui://${toolName}`, parsed.resource.title, parsed.resource.requestedSandbox, undefined, parsed.resource.bridgeVersion),
      hostOrigin: this.#options.hostOrigin,
      allowedOrigins: this.#options.allowedOrigins ?? [],
      allowUntrustedCode: this.#options.allowUntrustedCode === true,
      maxFrameHeightPx: this.#options.maxFrameHeightPx,
      html: parsed.resource.html,
      dev: this.#options.dev === true,
      trustedBlobUrls: this.#options.trustedBlobUrls ?? [],
      toolInvokeOrigin: this.#options.toolInvokeOrigin ?? null,
      declaredCsp: parsed.resource.csp,
      toolName,
    });
    this.#decisions.set(toolName, decision);

    if (!decision.allowed) {
      // The whole point of the policy engine: this is what reaches the host
      // instead of `app.attached`.
      push({
        kind: 'warning',
        payload: {
          code: 'APP_POLICY_DENIED',
          message: decision.reason,
          detail: {
            toolName,
            policyCode: decision.code,
            warnings: decision.warnings,
            textFallback: parsed.textFallback,
          },
        },
        ...(input.step !== undefined ? { step: input.step } : {}),
      });
      return frames;
    }

    for (const finding of decision.findings) {
      if (finding.severity === 'info') continue;
      push({
        kind: 'warning',
        payload: { code: `APP_FINDING_${finding.code}`, message: finding.message, detail: { toolName } },
        ...(input.step !== undefined ? { step: input.step } : {}),
      });
    }

    const frame = decision.frame;
    if (frame === null) {
      push({
        kind: 'warning',
        payload: { code: 'APP_POLICY_NO_FRAME', message: decision.reason, detail: { toolName } },
      });
      return frames;
    }

    const materialized = materializeFrameSource(frame, { csp: decision.csp, nonce: decision.nonce });
    const app: EmbeddedApp = {
      id: `mcp-app-${toolName}`,
      title: parsed.resource.title,
      src: materialized.value,
      sandbox: decision.sandbox,
      height: decision.bounds.heightPx,
      bridgeVersion: parsed.resource.bridgeVersion,
      transport: 'postmessage',
      // Forced regardless of what the payload claimed: this package has no
      // trusted path for an agent-authored app.
      untrusted: true,
    };

    push({
      kind: 'app.attached',
      payload: { app },
      raw: {
        policy: decision,
        frame: {
          attribute: materialized.attribute,
          value: materialized.value,
          csp: decision.csp,
          sandbox: decision.sandbox,
          sandboxTokens: decision.sandboxTokens,
          heightPx: decision.bounds.heightPx,
          heightClamped: decision.bounds.heightClamped,
          nonce: decision.nonce,
          notes: materialized.notes,
        },
        tool: {
          name: toolName,
          textFallback: parsed.textFallback,
          prefersBorder: parsed.resource.prefersBorder,
          requestedPermissions: parsed.resource.permissions,
        },
      },
      ...(input.step !== undefined ? { step: input.step } : {}),
    });

    return frames;
  }

  /**
   * MCP App interactions do not travel as a `RunAgentInput`.
   *
   * An `ActionEvent` for this protocol means "a message arrived over the frame
   * bridge"; the transport for that is `AppBridge`, and the host forwards it to
   * the MCP server as a `tools/call`. There is no body to POST here, so the
   * encoded form is a marker plus an empty patch: a host that mistakenly POSTs
   * it as a run input sends a no-op, not a corrupted turn. The patch carries no
   * operations for the same reason -- the frame owns its own state.
   */
  encodeAction(action: ActionEvent): EncodedAction {
    const input: JsonObject = {
      'mcp-apps/bridgeAction': {
        surfaceId: action.surfaceId,
        componentId: action.componentId,
        name: action.name,
        ...(action.value !== undefined ? { value: action.value } : {}),
        ...(action.context !== undefined ? { context: action.context } : {}),
      },
    };
    return {
      protocol: 'mcp-apps',
      input,
      patch: {
        threadId: '',
        runId: '',
        surfaceId: action.surfaceId,
        operations: [],
        revision: 0,
      },
    };
  }

  /**
   * A no-op, and it stays one. MCP App state lives in the frame and travels as
   * `statePatch` messages over the bridge, so the host has no local data model
   * to write. It is safe to call with any patch, including a malformed one,
   * because it never reads the patch and never mutates adapter state.
   */
  applyLocalState(_patch: StatePatch): void {
    /* intentionally empty: see method doc */
  }
}

function unwrapToolResult(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const record = raw as Record<string, unknown>;
  if ('content' in record || 'structuredContent' in record || '_meta' in record) return raw;
  const result = record['result'];
  if (typeof result === 'object' && result !== null) return result;
  return raw;
}

function readToolName(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as { _meta?: unknown; meta?: unknown };
  for (const meta of [record._meta, record.meta]) {
    if (typeof meta !== 'object' || meta === null) continue;
    const name = (meta as Record<string, unknown>)['toolName'] ?? (meta as Record<string, unknown>)['name'];
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return null;
}

function buildEmbeddedApp(
  src: string,
  title: string,
  sandbox: string,
  height: number | undefined,
  bridgeVersion: '0.1' | '0.2',
): EmbeddedApp {
  return {
    id: `mcp-app-${title}`,
    title,
    src,
    sandbox: sandbox as EmbeddedApp['sandbox'],
    ...(height !== undefined ? { height } : {}),
    bridgeVersion,
    transport: 'postmessage',
    untrusted: true,
  };
}
