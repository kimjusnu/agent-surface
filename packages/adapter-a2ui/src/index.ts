/**
 * `@agent-surface/adapter-a2ui`
 *
 * Parses A2UI JSONL message streams and normalizes them into the monorepo's
 * surface IR, plus a headless bridge. Nothing reachable from this module
 * requires a DOM: the DOM-bound A2UI renderers live behind the separate
 * `@agent-surface/adapter-a2ui/dom` entry point.
 */

export * from './jsonl.js';
export * from './messages.js';
export * from './bindings.js';
export * from './catalog.js';
export * from './bridge.js';
export * from './adapter.js';
