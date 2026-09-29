/**
 * Minimal TypeScript loader for the eval CLI.
 *
 * The workspace publishes every package as `main: ./src/index.ts` and relies on
 * a bundler to run it, which a bare `node bin/eval.mjs` cannot do. Rather than
 * require a build step in CI (and rather than depend on tsx, which the
 * workspace does not have), the CLI registers this hook: it rewrites a relative
 * `./x.js` specifier to the `./x.ts` file that actually exists and hands the
 * result to Node's own type stripping.
 *
 * It runs on Node 22.6+ with `--experimental-strip-types`, and degrades with a
 * clear message on anything older instead of a module-not-found stack trace.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * The IR imports `verbatimModuleSyntax`-compatible TypeScript only: no enums,
 * no namespaces, no parameter properties, no `experimentalDecorators`. Those
 * are all things Node's type stripper rejects, and keeping to them is a
 * deliberate constraint on the package rather than an accident.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && /\.js$/.test(specifier) && context.parentURL) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    return { format: 'module-typescript', source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
