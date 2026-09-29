# agent-surface

Protocol-agnostic **Generative UI host** + **agent observability & eval gate**.

One host renders surfaces from three competing agent protocols — AG-UI, A2UI
(MCP's declarative sibling) and MCP Apps — through a single normalized IR,
records every frame for time-travel replay, and gates agent quality with a
reproducible eval suite that runs in CI.

The problem it solves: an agent product that renders a chat surface can end up
locked to one protocol, with no view of what the agent actually did and no way
to tell a prompt change from a regression. This is both halves of that.

## Packages

| Package | What it is |
|---|---|
| `@agent-surface/protocol` | The contract. `SurfaceFrame` IR, ordered `SurfaceStream`, headless surface evaluation, RFC 6902 JSON Patch, protocol negotiation. |
| `@agent-surface/adapter-ag-ui` | AG-UI 1.0.0 event streams → IR. Own SSE parser, streaming tool-arg reassembly, tolerant event mapping. |
| `@agent-surface/adapter-a2ui` | A2UI v0.9 JSONL → IR. Headless bridge over the real `MessageProcessor`, semantic validation beyond the lax zod schema. |
| `@agent-surface/adapter-mcp-apps` | MCP Apps → IR, plus a deny-by-default sandbox policy engine, strict CSP injection and a `postMessage` bridge. |
| `@agent-surface/trace` | Recorder, execution tree, time-travel replay, OTel GenAI spans, run diffing, redaction, storage. |
| `@agent-surface/eval` | 20 asserters, YAML suites, LLM-as-judge with a deterministic offline scorer, JUnit/JSON reports, CI gate. |

## Quick start

```bash
pnpm install
pnpm check        # typecheck + 490 tests
```

Run the eval gate (no API key required — the judge falls back to a
deterministic scorer):

```bash
node packages/eval/bin/eval.mjs --suite packages/eval/suites/demo.yaml \
  --runs "packages/eval/src/fixtures/*.json"
```

It exits non-zero on failure. The three bundled fixtures are two recorded
failures on purpose: a demo whose gate passes teaches the wrong thing.

## Design notes

**The IR is the contract.** Adapters never see React; the renderer never learns
which protocol produced a frame. `SurfaceStream` owns `seq`, so a third-party
adapter cannot corrupt ordering, and an adapter that throws becomes an `error`
frame instead of killing the run.

**Adapters are hostile-input-tolerant by contract.** A malformed or buggy agent
is a normal operating condition, not an exception. Every unhandled event
produces a `warning` frame — nothing is dropped silently, because the tracer
needs to know it existed.

**Untrusted code is denied by default.** MCP Apps are agent-authored, so
`allow-scripts-same-origin` is refused (it would let a frame escape the sandbox
and read the host DOM). The static scanner never blocks — a regex over hostile
HTML both over- and under-reports, so a false-positive denial would be a host
DoS bug. CSP enforces; the scanner only feeds the audit trail.

**The gate is the product.** `llm-judge` runs deterministically offline by
default so CI needs no network, and falls back rather than failing when a model
call breaks. A case whose subject matches no run is `skipped`, never `passed` —
a missing run must not look like success.

## License

MIT
