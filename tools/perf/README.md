# @tape/perf — two-tier performance harness

Performance regression detection for the tape platform, split by what each
environment is good at:

| Tier | Where | Gate | Command |
| --- | --- | --- | --- |
| 1 | plain Node, fake seams | **tight** — normalized scores vs a committed baseline | `pnpm --filter @tape/perf bench` |
| 2 | real Chromium + real feed | **loose** — median p95 frame ≤ 25ms (local; 200ms backstop on GPU-less CI), longest task ≤ 100ms; the report is the product | `pnpm --filter @tape/perf perf:browser` |
| — | scenarios (Tier 2 infra) | **hard** — fault-injection correctness, every assert gates | `pnpm --filter @tape/perf scenarios` |

Tier 1 is low-noise and answers "did a tape-core hot path get slower?" in
seconds. Tier 2 is high-signal and answers "does the real app hold its frame
budget under the real feed?" in minutes. Scenarios reuse the Tier 2
infrastructure to prove correctness under faults, not speed.

## Tier 1

Node microbenchmark of tape-core's hot paths: **low noise, tight gate.**

```sh
pnpm --filter @tape/perf bench            # gate against bench/baseline.json
pnpm --filter @tape/perf bench:update     # re-measure and rewrite the baseline
```

Method: every environment seam is a manual fake (`bench/fakes.ts`, modeled
on tape-core's test helpers but consuming only the **built** package) — the
socket delivers only when pushed, timers never fire, frames fire only when
told, snapshots resolve from canned responses. The workload
(`bench/fixture.ts`) is a seeded, byte-identical-across-runs stream shaped
like the ci feed: 10 000-instrument universe, 1–8 record updates per
instruments message, every 10th message a tape trade, contiguous seqs. All
frames are pre-encoded before timing starts, and the client subscribes
exactly like the monitor app (same channels, policies, priorities).

Four benchmarks, each the **minimum** of 15 samples after 3 warmups (noise
is one-sided — GC and preemption only ever add time — so the min is the
stable estimate of intrinsic cost; measured spread notes live in
`bench/run.ts`):

| Benchmark | Measures | Unit |
| --- | --- | --- |
| `snapshot-sync` | socket open → `live`: two full snapshot reconciles (10k + 1k records) | ms/sync |
| `ingest` | decode + sequencer fast path + per-field coalescing, no flush | ns/msg |
| `flush-drain` | one full drain of ~10k staged records through `store.flushPending` | ms/drain |
| `e2e-frame` | steady state: 84-msg chunks (≈5 000 msg/s at 60fps), ingest + flush | ns/msg |

**Gate:** scores are wall time **normalized by a per-run calibration**
(JSON.parse + field walk of a fixed frame — the hot path's primitive mix),
so machine speed cancels and `bench/baseline.json` transfers across runner
classes. Each score must stay within **baseline × 1.25**; the tolerance is
justified by the measured run-to-run distribution documented at
`TOLERANCE` in `bench/run.ts`. `--update` runs three full passes and
commits the per-benchmark median, centering the reference.

Correctness tripwires fail the run regardless of speed: exact message and
update counts, zero gaps/reorders/stale drops, exactly two snapshots per
client, `live` before timing, `coalesceRatio >= 1`. A fast run that dropped
work is a broken run.

## Tier 2

Browser frame-budget run: **high signal, loose gate — the report is the
product.**

```sh
pnpm --filter @tape/perf exec playwright install chromium   # once
pnpm --filter @tape/perf perf:browser
```

Method: 3 measurement runs, each a fresh page load of the monitor app
(vite preview, `:4401`) against the feed's ci profile (`seed=42 rate=5000
instruments=10000`, `:4400`). Per run: install probes (rAF inter-frame
deltas, PerformanceObserver longtasks) → goto → wait for `live` + rendered
rows → **CDP `Emulation.setCPUThrottlingRate(4)`** → measure 30s. The 4x
throttle makes results far less runner-class-dependent and comparable over
time; boot/snapshot cost is deliberately excluded (throttle starts after
the app is live, probes are zeroed at window start).

Per run: p50/p95/p99 frame interval, count and share of frames over
16.7ms, longest frame, longest task, coalesceRatio, deferredFrames delta,
p95FlushMs, JS heap delta (CDP `Runtime.getHeapUsage` — precise, unlike
Chromium's quantized `performance.memory`, which is only the fallback).
The **median run** is the one with the median p95 frame interval.

**Gate (median run ONLY): p95 frame interval ≤ 25ms (locally) AND
longest task ≤ 100ms.** Everything else is report, not gate. On CI the
p95-frame gate widens to a 200ms catastrophic-regression backstop:
GPU-less shared runners render through Chromium's software compositor,
which vsync-quantizes frames at ~133ms (measured: p50 116.7 / p95
133.4ms — exact 16.7ms multiples — with longest JS task 0.0ms across
all runs), so frame cadence there measures the rasterizer, not tape.
The longest-task gate is the one that watches our code, and it applies
unchanged everywhere; the measured rationale lives as a comment on the
gate constants in `browser/frame-budget.spec.ts`. The full 3-run report
+ median + environment goes to `tools/perf/report/frame-budget.json`
(directory is gitignored); a compact table prints to stdout.

## Scenarios

Fault-injection correctness under stress — every spec **gates hard**, fails
on any `pageerror`/`console.error`, and runs with `retries: 0, workers: 1`
(the feed's fault state is global; flake is designed out, not retried away).

```sh
pnpm --filter @tape/perf scenarios
```

| Spec | Fault | Asserts |
| --- | --- | --- |
| `drop` | sockets hard-terminated | Banner sequence leaves `live`, passes through `resyncing`, returns to `live` ≤ 15s (`connecting`/`degraded` allowed between); `reconnects` and `snapshotsLoaded` increment; the pre-drop sampled row ticks again. |
| `reorder` | 64 updates shuffled in windows of 8 | `reordersHealed` increased OR (`gapsDetected` AND `snapshotsLoaded` increased). Healing is expected (holdback 16 > window 8); a declared-and-resynced gap is also correct; **silence is the only failure**. Rows still tick. |
| `burst` | 10x rate for 2s | Ingest actually spiked (>2x); backpressure engaged: `deferredFrames` rose OR the coalescing **savings rate** (ΔupdatesIn − ΔupdatesApplied per second) grew ≥ 3x — the plain ratio barely moves with 10k distinct instruments even while coalescing eliminates tens of thousands of writes. No frame interval over **150ms hard bound** (design intent is 100ms; breaches of 100 are logged loudly — the extra 50ms absorbs runner scheduler noise). Mid-burst programmatic scroll must move the rendered row window. |
| `stall` | server fully silent 4s (updates AND pongs freeze) | Client-level state log shows `degraded` **during** the stall (asserted by timestamp), then back to `live`; `staleTransitions`, `reconnects`, `snapshotsLoaded` increment. |
| `gap` | 200 updates applied server-side, never sent | `gapsDetected` and `snapshotsLoaded` increment ≤ 10s (snapshot resync is the only recovery). One symbol's `volume`, sampled from the client store, **never decreases** across the resync (accumulate deltas + absolute snapshot must be monotone). Rows still tick. |
| `empty` | second feed, `TAPE_INSTRUMENTS=0`, `:4406` | Page pointed via `?feed=ws://localhost:4406` reaches `live`, renders the explicit empty message with **zero** data rows, `snapshotsLoaded > 0` (resynced-to-empty, not never-loaded), still empty 1s later. Child feed killed (whole process group) in `finally`. |

### Design notes / deviations from the sketch

- **Stall is 4000ms, not 3000ms.** Heartbeat = 1000ms cadence, 2500ms
  timeout: a 3000ms stall leaves a ~500ms window for a check to land in the
  stale zone — a literal coin flip. 4000ms guarantees detection while it is
  still mid-stall (asserted by timestamp: observed ~2.9–3.5s in).
- **`degraded` is asserted on the client state log, not the banner DOM.**
  The transport declares `degraded` and starts reconnecting in the same
  synchronous task, so React can only paint the later state — the banner
  physically cannot show `degraded`. The state recorder therefore keeps two
  logs: banner MutationObserver transitions (what the user saw) and
  `client.onStateChange` transitions (every transition).
- **Feed changes this suite required** (kept minimal, feed tests stay green):
  stall now freezes pong replies too (the README already said "sending
  **and generating** stop" — a stalled server answering pings can never
  trip silent-death detection); `TAPE_INSTRUMENTS=0` is now honored (was
  clamped to 1) with generation disabled for an empty universe.

### Shared helpers (`lib/`)

`lib/feed.ts` — `fault(name, body?)` POSTs `/fault/<name>`; `spawnFeed(env)`
boots an extra feed (detached process group, killable as a unit) and waits
for `/healthz`. `lib/page.ts` — `metrics`, `bannerState`, `waitForLive`,
`waitForRows`, `openMonitor`, `installFrameProbe` (pre-navigation
`addInitScript`: `window.__frames`, `window.__longTasks`),
`installStateRecorder` (`window.__bannerStates`, `window.__clientStates`),
error sentries, row sampling/ticking, and the gap scenario's store-level
volume watcher (refcounted `subscribe` with the app's own policy → the same
store, exact values). `lib/stats.ts` — percentiles and windowed metric
deltas.

The monitor exposes its client as `window.__tapeClient` and honors a
`?feed=` query param (priority: query param → `VITE_TAPE_URL` → default
`ws://localhost:4400`) — both instrumentation-only seams.
