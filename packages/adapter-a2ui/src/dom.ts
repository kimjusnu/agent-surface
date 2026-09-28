/**
 * DOM entry point.
 *
 * Kept separate from `index.ts` on purpose. `@a2ui/web_core`'s barrel
 * re-exports `catalog/a2ui-lit-element.js`, which declares a `LitElement`
 * subclass. Importing that class is harmless off-DOM (nothing dereferences
 * `customElements` at module scope, which is what makes the isomorphic path in
 * `index.ts` work), but *instantiating* or *defining* it is not. Server code,
 * the tracer, the eval harness and unit tests should import the default entry
 * and only pull this one in from a browser bundle.
 *
 * The `exports` map in `@a2ui/web_core` exposes no v0.9 subpaths -- a deep
 * import such as `@a2ui/web_core/v0_9/catalog/a2ui-lit-element.js` fails with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` -- so the Lit layer is reachable only through
 * the barrel, and splitting here is the only way to keep it out of a headless
 * graph.
 *
 * `lib` in this package's tsconfig includes `DOM` so these types resolve; the
 * isomorphic modules never reference them.
 */

export {
  A2uiController,
  A2uiLitElement,
  injectBasicCatalogStyles,
} from '@a2ui/web_core/v0_9';

/** The basic catalog, for a browser bundle that wants A2UI's standard components. */
export { basicCatalog, BASIC_COMPONENTS, BASIC_FUNCTIONS } from '@a2ui/web_core/v0_9/basic_catalog';
