# Tape

A real-time UI platform: a framework-free core that turns a WebSocket firehose
into frame-budgeted record updates, a thin React binding, and two independent
consumer applications that prove the API surface.

The platform is the product here, not the domain. `tape-core` never imports
React — it can be consumed from a plain Node script — and the thing that makes
it a platform rather than a rendering trick is the **per-field coalescing
policy**: consumers declare, per field, what happens when data outruns frames
(`latest`, `accumulate`, `sequence`). See `docs/POLICIES.md`.

## Layout

```
packages/
  tape-core/     transport + sequencer + coalescing buffer + store. NO react.
  tape-react/    hooks + virtualized grid + canvas chart
  tape-codemod/  jscodeshift transforms for the v2 migration
apps/
  monitor/       consumer 1: dense read-only monitoring view
  entry/         consumer 2: entry view, forms + optimistic writes
services/
  feed/          deterministic seeded feed: WS stream + REST snapshot + fault injection
tools/
  perf/          node microbenchmark + browser frame-budget harness
```

## Quickstart

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm feed        # feed service on :4400
```

Status: under construction — milestones land as commits on `main`.
