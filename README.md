# Tape

[![ci](https://github.com/lalitheswaran11-stack/tape/actions/workflows/ci.yml/badge.svg)](https://github.com/lalitheswaran11-stack/tape/actions/workflows/ci.yml)

Tape is a real-time UI platform: versioned packages, a wire protocol, and two
independent consumer applications that prove the API surface. A framework-free
core (`tape-core` — it runs in plain Node) turns a 5 000 msg/s WebSocket
firehose into frame-budgeted record updates; a thin React binding
(`tape-react`) exposes them as hooks and a virtualized grid; a deterministic
seeded feed service with fault injection makes every resilience claim
testable. The platform is the product here, not the domain — the repo's
history includes a full major-version migration (deprecation, codemod,
removal) executed against its own consumers.

## Data flow

```
   services/feed          deterministic seeded feed, 5 000 msg/s
        |                 (WebSocket updates + REST snapshot + fault injection)
        v
  +-- packages/tape-core -----------------------------------------------------+
  |                                                                           |
  |  transport            jittered-backoff reconnect, heartbeat liveness      |
  |     |                 (a silent server is declared dead, not waited on)   |
  |     v                                                                     |
  |  sequencer            holdback reordering, seq-gap detection              |
  |     |                 (unfillable gap -> REST snapshot resync)            |
  |     v                                                                     |
  |  coalescing buffer    per-field policy: latest / accumulate / sequence    |
  |     |                 8 ms flush budget, priority-ordered shedding        |
  |     v                                                                     |
  |  store                copy-on-write records, per-record notify            |
  |                       (a tick on one record never wakes another's         |
  |                        subscribers)                                       |
  +-----|---------------------------------------------------------------------+
        |  per-visible-row subscriptions (useSyncExternalStore)
        v
   packages/tape-react    VirtualGrid / CanvasChart at 60 fps
```

## The coalescing policy contract

This is the differentiator. Tape applies **at most one write per record per
frame**; when the feed outruns the frame rate, updates merge. The consumer
declares, per field, *how* they merge — and therefore precisely what the UI
can and cannot lose under load:

```ts
client.subscribe('instruments', {
  last: 'latest',
  volume: 'accumulate',
  trades: { policy: 'sequence', capacity: 64 },
});
```

| Policy | Kept | Lost under load | Use for |
| --- | --- | --- | --- |
| `latest` | The newest value at flush time — never more than one frame behind. | Every intermediate value; intermediates are never observable, even transiently. | State: prices, statuses, labels. |
| `accumulate` | Everything — pending numeric deltas sum, and the sum applies whole. A deferred frame loses nothing. | Nothing numerically; only arrival granularity (you see totals, not each increment). | Totals: volume, counters, PnL. |
| `sequence` | Every entry, in arrival order, up to `capacity` (ring buffer). | Only the oldest entries beyond capacity — never a middle entry, never ordering. | Events: trade tapes, alerts, audit trails. |

Two wire conventions make this exact across reconnects: `accumulate` fields
are delta-encoded in updates but absolute in snapshots (totals survive a
resync to the cent), and `sequence` fields carry one entry per update with
snapshots bearing the recent history. Backpressure sheds by deferring whole
channels (priority-ordered) once the 8 ms flush budget is spent — deferred
data keeps coalescing under its policies and applies whole later, and
shedding is never silent (`deferredFrames` and `coalesceRatio` in metrics).
Full contract: [docs/POLICIES.md](docs/POLICIES.md).

## Measured

Numbers below were measured on darwin/arm64, Node 22 (the dev machine); CI
re-measures both tiers on every push. Method and baselines:
[tools/perf](tools/perf/README.md).

**Tier 1 — Node microbenchmark of tape-core hot paths** (tight gate:
calibration-normalized score within 1.25x locally, 1.5x on CI's
heterogeneous runner fleet — both bands measured, see
[tools/perf](tools/perf/README.md) — of the committed
[bench/baseline.json](tools/perf/bench/baseline.json)):

| Path | Measured | Meaning |
| --- | --- | --- |
| ingest | ~2.5 µs/msg | decode + sequencer fast path + coalescing, no flush |
| ingest + flush (e2e) | ~4.1 µs/msg | ~240k msg/s single-thread headroom vs the 5k msg/s feed |
| 10k-record snapshot sync | ~1.5 ms | socket open → `live`: two full snapshot reconciles |
| full flush drain | ~2.6 ms | ~10k staged records through `store.flushPending` |

**Tier 2 — real Chromium against the real feed** (median of 3 x 30 s runs at
4x CPU throttle, 5 000 msg/s over 10 000 rows): p95 frame interval **9.3 ms**
against a 25 ms gate, longest task **0 ms**, **0.5%** of frames over 16.7 ms.
(On GPU-less CI runners the frame-interval gate widens to a documented
200 ms backstop — the software compositor, not tape, sets frame cadence
there; the longest-task gate applies unchanged. See
[tools/perf](tools/perf/README.md).)

**Scenario highlights** (fault-injection suite, all six specs green; counts
and rates below are from a representative run — the specs gate the
invariants, not these exact figures):

- **Stall — 4 s of full server silence, pongs included:** `degraded` declared
  ~2.95 s into the stall via heartbeat timeout, before any socket error.
- **Reorder — 64 updates shuffled in windows of 8:** healed entirely by
  sequencer holdback (36 heals; holdback 16 > window 8) — zero gap
  declarations, zero resyncs, zero stale drops.
- **Burst — 10x rate for 2 s:** ingest spiked ~21k/s → ~178k/s; the
  coalescing savings rate jumped ~20x (854/s → 17.6k/s against a ≥3x gate)
  and the grid stayed scrollable mid-burst.
- **Drop — every socket hard-terminated:** `live → connecting → resyncing →
  live`, with the pre-drop sampled row ticking again after resync.

## Change management, as it actually happened

The git history *is* the demo:

1. **1.0.0** shipped the v1 subscription pair — `useStream` +
   `useCoalesced` — deliberately imperative: the coalescing policy was
   assembled from however many `useCoalesced` calls ran during render,
   scattered away from the subscription site and impossible to type as a
   unit.
2. **1.1.0** shipped `useSubscription` (policy declarative at the
   subscription site) as a non-breaking minor and deprecated the pair:
   `@deprecated` in the types plus a once-per-session runtime warning naming
   the replacement, the codemod command, and the migration guide.
3. **Both consumers migrated by codemod** —
   [packages/tape-codemod](packages/tape-codemod) rewrites v1 call sites
   mechanically and bails out with `TODO(tape-codemod)` markers where it
   cannot prove a rewrite safe. The migrations landed on branches
   `migrate/monitor-v2` and `migrate/entry-v2`, merged to `main` as
   PR-shaped merge commits. Guide: [docs/MIGRATION-v2.md](docs/MIGRATION-v2.md).
4. **2.0.0** removed the pair, plus the render-phase machinery that existed
   only to serve it. Changelog:
   [packages/tape-react/CHANGELOG.md](packages/tape-react/CHANGELOG.md).

Guarding all of it: the **API surface report**. `pnpm api-report` snapshots
the rolled-up `.d.ts` of each published library into [docs/api/](docs/api/),
and CI runs `pnpm api-report:check`. A PR that changes the public surface
necessarily shows a diff in `docs/api/` — API changes are visible at review
time, never accidental.

## Fault matrix

The feed injects faults on demand; every row is gated by a Playwright spec in
[tools/perf/scenarios](tools/perf/scenarios) (full details:
[services/feed/README.md](services/feed/README.md)).

| Fault | Simulates | Correct client behavior | Gating spec |
| --- | --- | --- | --- |
| `drop` | Network partition / server crash (no close frame) | Detect the dead socket itself (heartbeat), reconnect, resubscribe, snapshot resync | `drop.spec.ts` |
| `reorder` | Out-of-order delivery | Hold back ahead-of-seq updates, heal by seq — no data lost | `reorder.spec.ts` |
| `burst` | 10x load spike | Absorb via coalescing/backpressure; seqs stay contiguous, no resync needed | `burst.spec.ts` |
| `stall` | Upstream freeze — fully silent, pongs too | Declare `degraded` on heartbeat timeout, force-reconnect, resync | `stall.spec.ts` |
| `gap` | Lost messages (seq advances, never sent) | Detect the hole, recover via snapshot — stream replay alone cannot fill it | `gap.spec.ts` |
| empty universe | Feed with zero instruments | Reach `live`, render an explicit empty state, no crash | `empty.spec.ts` |

## Quickstart

```sh
pnpm install
pnpm -r build
pnpm test
```

Run the stack (three terminals):

```sh
pnpm feed                          # feed service         :4400
pnpm --filter @tape/monitor dev    # monitor (consumer 1) :4401
pnpm --filter @tape/entry dev      # entry (consumer 2)   :4402
```

In the monitor app, press the backquote key (`` ` ``) to toggle the perf HUD.
Then break things:

```sh
curl -X POST localhost:4400/fault/drop
curl -X POST localhost:4400/fault/stall   -d '{"ms":4000}'
curl -X POST localhost:4400/fault/reorder -d '{"window":8,"count":64}'
curl -X POST localhost:4400/fault/burst   -d '{"factor":10,"ms":2000}'
curl -X POST localhost:4400/fault/gap     -d '{"skip":200}'
```

`tape-core` needs no browser and no React — the plain-Node consumer runs
against the live feed with default seams (Node 22's built-in WebSocket and
fetch):

```sh
node examples/node-consumer/index.mjs ws://localhost:4400
```

## Packages

| Package | Version | What it is |
| --- | --- | --- |
| `@lalitheswaran11-stack/tape-core` | 1.0.0 | Framework-free core: transport, sequencer, coalescing buffer, store |
| `@lalitheswaran11-stack/tape-react` | 2.0.0 | React bindings: `useSubscription`, `VirtualGrid`, `CanvasChart`, perf HUD |
| `@lalitheswaran11-stack/tape-codemod` | 1.0.0 | jscodeshift transforms for the v1 → v2 migration |
| `@tape/feed` | private | Deterministic seeded feed: WS stream + REST snapshot + fault injection |
| `@tape/monitor` | private | Consumer 1: dense read-only monitoring view (10k instruments) |
| `@tape/entry` | private | Consumer 2: order entry, optimistic writes reconciled against the stream |
| `@tape/perf` | private | Two-tier perf harness + fault-injection scenario suite |

## CI

Pipeline order: **build → lint → typecheck → tests → bench gate → API report
check → scenarios + browser perf gate → publish / images**. Build runs first
because the workspace packages typecheck against each other's built
`dist/*.d.ts`. Publish (release tags) and images (pushes to `main`) each
require every gate before them; they never run on the same event.

Perf is two-tier by philosophy: the tight Node gate protects — low-noise
microbenchmarks against a committed baseline catch a hot-path regression in
seconds. The loose browser gate reports — real Chromium under CPU throttle
answers whether the real app holds its frame budget, with a generous gate
and a rich report as the product.

## Layout

```
packages/
  tape-core/       transport + sequencer + coalescing buffer + store. NO react.
  tape-react/      hooks + virtualized grid + canvas chart
  tape-codemod/    jscodeshift transforms for the v2 migration
apps/
  monitor/         consumer 1: dense read-only monitoring view
  entry/           consumer 2: entry view, forms + optimistic writes
services/
  feed/            deterministic seeded feed: WS + REST snapshot + faults
examples/
  node-consumer/   tape-core in plain Node — the API-boundary proof
tools/
  perf/            node microbenchmark gate + browser frame-budget harness
  api-report.mjs   public API surface snapshots -> docs/api/
docs/
  POLICIES.md      the coalescing policy contract
  MIGRATION-v2.md  the v1 -> v2 migration guide
  api/             generated API surface reports (CI-gated)
```

Docs: [POLICIES](docs/POLICIES.md) ·
[MIGRATION-v2](docs/MIGRATION-v2.md) ·
[perf harness](tools/perf/README.md) ·
[API reports](docs/api/) ·
[feed service](services/feed/README.md)

---

*Honest footnote: the Dockerfiles and the Helm chart are built and validated
in CI — the dev machine this was written on has no local docker or helm.*
