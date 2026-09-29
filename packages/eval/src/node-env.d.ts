/**
 * Minimal ambient declarations for the handful of Node builtins this package
 * touches.
 *
 * `@types/node` is deliberately not a dependency: adding it re-resolves the
 * peer-dependency graph of every sibling package in the workspace, and the
 * eval engine needs three functions, not a type universe. Delete this file the
 * day the workspace adopts `@types/node`.
 */

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function existsSync(path: string): boolean;
}

declare module 'node:path' {
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function resolve(...segments: string[]): string;
  export function relative(from: string, to: string): string;
  export function extname(path: string): string;
  export function basename(path: string, ext?: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}
