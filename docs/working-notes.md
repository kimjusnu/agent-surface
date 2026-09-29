# agent-surface — working notes

Continuation notes for whoever picks this up next. Current state is on
`master` at tag `session/2026-09-29-1`; CI is green (490 tests).

## Where things stand

Six packages exist and are typechecked and tested. What does **not** exist yet
is the part that makes this a product: the React renderer and the demo app.
Everything below is built on a contract that is already stable, so the
remaining work is additive.

| Done | Missing |
|---|---|
| `protocol` IR + stream + JSON Patch | nothing |
| `adapter-ag-ui` | nothing |
| `adapter-a2ui` | nothing |
| `adapter-mcp-apps` (incl. sandbox policy) | nothing |
| `trace` (recorder, tree, replay, spans, diff, redact, storage) | live streaming UI, scrubbing viewport |
| `eval` (20 asserters, suites, judge, JUnit, gate, CLI) | more suites, real recorded runs |
| CI (typecheck + test + eval-gate) | renderer regression tests, deploy |

## What to build next, in order

### 1. `packages/ui-catalog` — the design system as a spec
The component catalog is the security boundary: an agent may only render
components the host declares. A component is
`{ id, schema (zod), render, capabilities }`, and the catalog compiles to the
A2UI `Catalog` shape plus a `useComponent` map for the IR renderer.

Start with ~8 components: `Text`, `Button`, `Card`, `Column`, `Row`, `List`,
`TextField`, `DataTable`. `DataTable` is the one worth the effort — virtualized
rows, sortable, and it is the component a hiring reviewer will actually open.

### 2. `packages/ui-react` — the renderer
- `<SurfaceHost>` — subscribes to a `SurfaceStream`, applies the **reducer
  from `@agent-surface/trace`**, renders surfaces declaratively.
  The IR already separates declarative nodes from `EmbeddedApp`, so the renderer
  branches once, in one place.
- `<EmbeddedAppFrame>` — renders `EmbeddedApp` through the policy decision from
  `@agent-surface/adapter-mcp-apps`. It must not take a sandbox attribute
  directly from the agent; the policy decides. This is the one component where
  getting the plumbing wrong is a security bug, not a styling bug.
- `<TraceTimeline>` — the flame/waterfall view of the execution tree.
- `<ReplayScrubber>` — bound to `createReplay`, `seek(seq)` drives a viewport.

### 3. `apps/demo` — Next.js, three tabs
One tab per protocol, driven by the **same** recorded fixtures the eval suite
already uses (`packages/eval/src/fixtures/*.json`). That is deliberate: the demo
and the gate score identical data, so a green gate means the demo renders.

Include a "replay" tab that scrubs a run and shows the surface state at each
`seq`. That single view is the most persuasive artifact in the repo.

### 4. Remaining trace/eval depth
- `diff` is implemented but has no UI; a baseline-vs-candidate view is cheap now.
- Real recorded runs. The three fixtures are synthetic. Record from an actual
  agent so the numbers are real.

## Decisions that will look wrong out of context

**`AGUI_STATE_SURFACE_ID = '__agui_state__'`.** AG-UI has a state snapshot event
and the IR has no state frame, so a snapshot is delivered as a `surface.data`
merge at that reserved id with an empty pointer (the only one that means "the
whole document"). Merge, not replace, so an optimistic user write in flight is
not discarded mid-turn. A delta has no faithful IR representation and becomes a
`warning` carrying the patch — the adapter mirrors it internally instead.

**`CHUNK` events do not imply `END`.** The AG-UI client's own `transformChunks`
only synthesises END at a run boundary. Emitting `text.done` per chunk would
announce a 500-fragment message final 500 times. Open streams are flushed before
`run.finished`, and a *new* run finding leftovers raises
`AGUI_RUN_LEFT_STREAMS_OPEN` rather than publishing them under a reset `seq`.

**Own SSE parser in `adapter-ag-ui`.** `@ag-ui/client`'s parser splits on a
literal `\n\n`. A pure-CRLF body arrives as one concatenated payload and fails
`JSON.parse`. Both behaviours are pinned by tests; ours follows the standard
(CR, LF, CRLF).

**The MCP Apps scanner never blocks.** A regex over hostile HTML both over- and
under-reports, so a false-positive denial would be a host DoS bug. CSP enforces;
the scanner feeds the audit trail. Known gaps are listed at the bottom of
`packages/adapter-mcp-apps/src/policy.ts` — worth re-reading before touching it.

**`llm-judge` is deterministic offline by default.** CI must not depend on a
network call, and a flaky judge would make a red build indistinguishable from a
real regression. Network mode falls back to deterministic on failure rather
than failing the gate.

**`eval` does not import `trace`.** It declares its own `NormalizedRun` in
`trace-input.ts` so the gate runs in a container with no tracer. When wiring the
two, check the shapes still line up rather than reaching for a shared type.

## Known rough edges

- `adapter-mcp-apps`: a remote `https:` frame gets the CSP handed to it but a
  server we do not control will not send it. Needs a same-origin fetch-and-inline
  or a host proxy.
- The srcdoc rewrite is regex-based, so `<script`/`<base` inside a comment or
  string literal is mangled. Accepted; CSP is the real boundary.
- `_meta.ui.permissions` (camera/mic/geo) are parsed and ignored, with no warning
  that the request was dropped.
- No inbound rate limit on bridge messages, only size caps.

## Commands

```bash
pnpm install
pnpm check                 # typecheck + all tests
pnpm -r test               # tests only, per-package counts
pnpm --filter @agent-surface/trace test      # one package

# The gate. Exits non-zero on violation; the two non-happy fixtures fail on
# purpose, so a red run here is the expected baseline.
node packages/eval/bin/eval.mjs \
  --suite packages/eval/suites/demo.yaml \
  --runs "packages/eval/src/fixtures/*.json"

node packages/eval/bin/eval.mjs --list-asserters
```

Conventions that are enforced, not merely stated: TypeScript strict with
`noUncheckedIndexedAccess` and `verbatimModuleSyntax`, ESM only, `.js` extensions
on relative imports, and comments that justify a decision or cite a spec — never
comments restating code.
