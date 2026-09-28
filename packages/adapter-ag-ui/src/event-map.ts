/**
 * The AG-UI `EventType` -> Surface IR `FrameKind` table, kept as data so the
 * mapping is reviewable in one place and so the tracer can explain, for any
 * event it did not render, exactly why nothing was drawn.
 *
 * Every entry in {@link EVENT_FRAME_MAP} exists for one of two reasons, and the
 * `why` field records which:
 *
 *  - `frames`: the event carries something the IR models directly.
 *  - `warning`: the IR has no frame kind for it. AG-UI's `Event` union is
 *    normative and closed -- "there is no optional tier and no event a consumer
 *    may decline to implement" -- and it is wider than the IR (reasoning spans,
 *    activities, provider-native raw events, steps). Dropping them would make
 *    the transcript lie about what the agent sent, so each one becomes a
 *    `warning` frame with a stable code and the payload preserved in `raw`.
 */

import { EventType } from '@ag-ui/core';
import type { FrameKind } from '@agent-surface/protocol';

/**
 * A `surfaceId` reserved for the agent's own state document. AG-UI's state is
 * not tied to any rendered surface, but the IR's only state-bearing frame is
 * `surface.data`, so snapshots are written against this pseudo-surface. It is
 * exported so a host can exclude it from any surface list it renders.
 */
export const AGUI_STATE_SURFACE_ID = '__agui_state__';

export type AgUiMapping =
  | {
      readonly kind: 'frames';
      /** IR frames emitted, in order. */
      readonly frames: readonly FrameKind[];
      readonly why: string;
    }
  | {
      readonly kind: 'warning';
      /** Stable code, so a consumer can filter without string-matching prose. */
      readonly code: string;
      readonly why: string;
    };

/**
 * Exhaustive over `EventType`. A `Record` rather than a `Map` so a missing key
 * is a compile error the moment upstream adds an event, instead of a runtime
 * surprise in a stream that is already running.
 */
export const EVENT_FRAME_MAP: Readonly<Record<EventType, AgUiMapping>> = {
  [EventType.RUN_STARTED]: {
    kind: 'frames',
    frames: ['run.started'],
    why: 'opens the run and carries the echoed RunAgentInput',
  },
  [EventType.RUN_FINISHED]: {
    kind: 'frames',
    frames: ['interrupt', 'run.finished'],
    why: 'terminal frame; an interrupt outcome is preceded by one interrupt frame per pending Interrupt, because run.finished alone reports that the run paused without saying what it is waiting for',
  },
  [EventType.RUN_ERROR]: {
    kind: 'frames',
    frames: ['error'],
    why: 'the run cannot continue, which is exactly what a fatal error frame means',
  },

  [EventType.TEXT_MESSAGE_START]: {
    kind: 'frames',
    frames: [],
    why: 'only opens a message buffer; the IR has no "message opened" frame, and emitting a text.delta with empty text would make a consumer append nothing while still churning',
  },
  [EventType.TEXT_MESSAGE_CONTENT]: {
    kind: 'frames',
    frames: ['text.delta'],
    why: 'a partial assistant message is the IR definition of text.delta',
  },
  [EventType.TEXT_MESSAGE_END]: {
    kind: 'frames',
    frames: ['text.done'],
    why: 'the message is final, so the accumulated buffer is published verbatim',
  },
  [EventType.TEXT_MESSAGE_CHUNK]: {
    kind: 'frames',
    frames: ['text.delta'],
    why: 'the chunk shorthand stands in for start+content and holds the message open; AG-UI synthesises the matching TEXT_MESSAGE_END at the run boundary, so text.done belongs to that close rather than to a fragment that cannot know the message is final',
  },

  [EventType.TOOL_CALL_START]: {
    kind: 'frames',
    frames: ['tool.started'],
    why: 'opens a tool invocation, which the IR models exactly',
  },
  [EventType.TOOL_CALL_ARGS]: {
    kind: 'frames',
    frames: ['tool.args.delta'],
    why: 'a JSON fragment is streamed, not parsed, until the call closes',
  },
  [EventType.TOOL_CALL_END]: {
    kind: 'frames',
    frames: ['tool.args.done'],
    why: 'the argument text is complete and is now parsed into an object',
  },
  [EventType.TOOL_CALL_CHUNK]: {
    kind: 'frames',
    frames: ['tool.started', 'tool.args.delta'],
    why: 'the chunk shorthand stands in for start+args and holds the call open; started is emitted only on the chunk that names the tool, and tool.args.done belongs to the close, for the same reason as TEXT_MESSAGE_CHUNK',
  },
  [EventType.TOOL_CALL_RESULT]: {
    kind: 'frames',
    frames: ['tool.result'],
    why: 'a tool produced a result, which the IR models exactly',
  },

  [EventType.SUBAGENT_STARTED]: {
    kind: 'frames',
    frames: ['subagent'],
    why: 'the IR has one subagent frame whose phase discriminates the three events',
  },
  [EventType.SUBAGENT_FINISHED]: {
    kind: 'frames',
    frames: ['subagent'],
    why: 'as above; the subagent name is recovered from the matching start because AG-UI carries only the invocation id here',
  },
  [EventType.SUBAGENT_ERROR]: {
    kind: 'frames',
    frames: ['subagent'],
    why: 'as above; a failed subagent does not fail the run, so it is not an error frame',
  },

  [EventType.STEP_STARTED]: {
    kind: 'warning',
    code: 'AGUI_STEP_STARTED',
    why: 'the IR stamps an opaque step index on frames but has no step frame; the adapter still counts steps so the index is populated on every frame it produces',
  },
  [EventType.STEP_FINISHED]: {
    kind: 'warning',
    code: 'AGUI_STEP_FINISHED',
    why: 'as above',
  },

  [EventType.STATE_SNAPSHOT]: {
    kind: 'frames',
    frames: ['surface.data'],
    why: 'a snapshot replaces the agent state wholesale, and surface.data is the only IR frame that writes a data model',
  },
  [EventType.STATE_DELTA]: {
    kind: 'warning',
    code: 'AGUI_STATE_DELTA_PASSTHROUGH',
    why: 'the IR models no incremental patch frame, so the patch is handed to the host in warning.detail instead of being silently applied and invisible',
  },

  [EventType.REASONING_START]: {
    kind: 'warning',
    code: 'AGUI_REASONING_UNMAPPED',
    why: 'reasoning spans have no IR frame; the whole REASONING_* family shares one code and reports the exact event type in detail',
  },
  [EventType.REASONING_MESSAGE_START]: { kind: 'warning', code: 'AGUI_REASONING_UNMAPPED', why: 'see REASONING_START' },
  [EventType.REASONING_MESSAGE_CONTENT]: { kind: 'warning', code: 'AGUI_REASONING_UNMAPPED', why: 'see REASONING_START' },
  [EventType.REASONING_MESSAGE_END]: { kind: 'warning', code: 'AGUI_REASONING_UNMAPPED', why: 'see REASONING_START' },
  [EventType.REASONING_MESSAGE_CHUNK]: { kind: 'warning', code: 'AGUI_REASONING_UNMAPPED', why: 'see REASONING_START' },
  [EventType.REASONING_END]: { kind: 'warning', code: 'AGUI_REASONING_UNMAPPED', why: 'see REASONING_START' },
  [EventType.REASONING_ENCRYPTED_VALUE]: {
    kind: 'warning',
    code: 'AGUI_REASONING_ENCRYPTED_VALUE',
    why: 'reported without the value: it is an opaque provider artefact, often present precisely under a zero-data-retention policy, and copying it into a durable transcript would defeat the reason it was encrypted',
  },

  [EventType.ACTIVITY_SNAPSHOT]: {
    kind: 'warning',
    code: 'AGUI_ACTIVITY_SNAPSHOT',
    why: 'progress widgets have no IR frame; the activity is recorded so a host can render it itself',
  },
  [EventType.ACTIVITY_DELTA]: {
    kind: 'warning',
    code: 'AGUI_ACTIVITY_DELTA',
    why: 'as above, with the incremental patch preserved',
  },
  [EventType.MESSAGES_SNAPSHOT]: {
    kind: 'warning',
    code: 'AGUI_MESSAGES_SNAPSHOT',
    why: 'the IR is frame-oriented, not history-oriented; the messages are still ingested so later tool-result error flags resolve against the real conversation',
  },
  [EventType.RAW]: {
    kind: 'warning',
    code: 'AGUI_RAW_UNMAPPED',
    why: 'a provider-native event the protocol deliberately does not model; dropping it would hide the fact that the agent sent something the host could not interpret',
  },
  [EventType.CUSTOM]: {
    kind: 'warning',
    code: 'AGUI_CUSTOM',
    why: 'the application-defined extension point; pass-through with name and value so the host can route it',
  },
};

/** Warning code for an event type string that is not in {@link EVENT_FRAME_MAP}. */
export const UNKNOWN_EVENT_CODE = 'AGUI_UNKNOWN_EVENT';

const BY_NAME: ReadonlyMap<string, AgUiMapping> = new Map(
  Object.entries(EVENT_FRAME_MAP).map(([name, mapping]) => [name, mapping]),
);

/**
 * Look up a mapping by event type. Accepts a plain string because the value
 * arriving off the wire is JSON, not an enum member, and a producer on a newer
 * protocol version may send a name this build has never heard of.
 */
export function mappingFor(eventType: string): AgUiMapping | undefined {
  return BY_NAME.get(eventType);
}

/** The IR frames an event maps to, or `undefined` when it maps to a warning. */
export function framesFor(eventType: string): readonly FrameKind[] | undefined {
  const mapping = mappingFor(eventType);
  return mapping?.kind === 'frames' ? mapping.frames : undefined;
}
