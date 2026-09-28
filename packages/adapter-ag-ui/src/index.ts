/**
 * `@agent-surface/adapter-ag-ui` -- AG-UI event streams into the Surface IR.
 *
 * Three layers, exported separately because a host usually needs only some of
 * them: {@link AgUiAdapter} is the `ProtocolAdapter` the stream drives,
 * {@link SseParser} is the transport-level framing, and {@link EVENT_FRAME_MAP}
 * is the reviewable record of what the IR cannot express.
 */

export { AgUiAdapter, AGUI_STATE_SURFACE_ID } from './adapter.js';
export type { AgUiAdapterOptions } from './adapter.js';

export { EVENT_FRAME_MAP, UNKNOWN_EVENT_CODE, framesFor, mappingFor } from './event-map.js';
export type { AgUiMapping } from './event-map.js';

export { SseParser, decodeSse } from './sse.js';
export type { SseMessage } from './sse.js';

export { ThreadState, aggregateUsage, isJsonValue, toJsonObject, toJsonValue } from './state.js';
export type {
  DraftPatchOperation,
  OpenMessage,
  OpenToolCall,
  PatchOutcome,
  TrackedToolMessage,
} from './state.js';
