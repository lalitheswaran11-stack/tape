/**
 * Tier 1 microbenchmark gate: tape-core hot paths in plain Node, no browser,
 * no real sockets, no real timers — every nanosecond measured belongs to
 * tape-core (see fakes.ts). Runs in seconds, gates tight.
 *
 * Benchmarks (MINIMUM over SAMPLES timed samples, after WARMUP discarded —
 * microbenchmark noise is one-sided: GC pauses and scheduler preemption only
 * ever ADD time, so the min is the clean measurement of intrinsic cost and
 * is dramatically more stable run-to-run than the median):
 * - snapshot-sync   socket open → 'live': two snapshot reconciles
 *                   (10 000-record instruments + 1 000-record tape) through
 *                   the real resync path. Unit: ms per sync.
 * - ingest          all fixture frames through socket.onmessage with no
 *                   flush: decode + sequencer fast path + per-field
 *                   coalescing. Unit: ns per message.
 * - flush-drain     one full drain of everything the ingest staged
 *                   (~10 000 pending instrument records + tape rings)
 *                   through store.flushPending. Unit: ms per drain.
 * - e2e-frame       steady state: 84-message chunks (≈ the ci feed's
 *                   5 000 msg/s at 60fps) each followed by a full drain.
 *                   Unit: ns per message, ingest + flush combined.
 *
 * The gate compares MACHINE-NORMALIZED scores, not wall time: every best
 * is divided by the calibration cost (JSON.parse + field walk of
 * CALIBRATION_FRAME — the same primitive mix the hot path spends its time
 * in). Machine speed cancels out, so the committed baseline.json transfers
 * across runner classes and the tolerance can stay tight enough to catch
 * real regressions.
 *
 * Calibration BRACKETS every benchmark rather than running once up front.
 * Observed on a shared GitHub runner (run 31352849222, 2026-08-10): a
 * byte-identical tree that had passed the gate three times failed with
 * all four scores up uniformly +22-34% — a noisy neighbor arrived after
 * the single up-front calibration, so the phases slowed while the
 * denominator did not. Each phase is now normalized by the SLOWER of its
 * two adjacent calibrations: noise that spans a phase inflates at least
 * one bracket and cancels. The asymmetry is deliberate — a spike that
 * hits only a bracket can understate one run's score (self-correcting on
 * the next run), whereas the old scheme turned neighbor noise into a
 * false FAIL that blocks CI.
 *
 * Correctness tripwires run alongside the timing and fail the run
 * regardless of speed: exact message/update counts, zero gaps, zero
 * reorders, zero stale drops, exactly two snapshots per client, state
 * 'live' before any timing starts, coalesceRatio >= 1. A "fast" run that
 * dropped work is a broken run.
 *
 * Usage:
 *   pnpm --filter @tape/perf bench            # gate against baseline.json
 *   pnpm --filter @tape/perf bench:update     # rewrite baseline.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTapeClient } from '@lalitheswaran11-stack/tape-core';
import type { TapeClient } from '@lalitheswaran11-stack/tape-core';

import {
  FakeSocket,
  ManualFrameScheduler,
  ManualTimers,
  makeFakeFetch,
} from './fakes';
import { buildFixture, CALIBRATION_FRAME } from './fixture';
import type { Fixture } from './fixture';

// ---------------------------------------------------------------------------
// Tuning

/** Fixture frames per sample: big enough that a sample runs ~15–40ms (far
 * above timer noise), small enough that the whole gate stays under ~15s. */
const MESSAGE_COUNT = 20_000;

/** ≈ ci feed rate (5 000 msg/s) / 60fps. */
const E2E_CHUNK = 84;

const WARMUP = 3;
const SAMPLES = 15;
const CALIBRATION_ITERS = 10_000;

/**
 * Gate tolerance on the normalized score, per benchmark.
 *
 * Observed distribution (2026-08-09, darwin/arm64, Node 22.23.1): with
 * median-of-9 aggregation, 6 back-to-back runs showed per-benchmark
 * max/min score spreads of 13–49% (worst: flush-drain — a GC pause landing
 * inside one ~3ms drain moves that sample's median). Switching to
 * min-of-15 (one-sided noise: interference only ever adds time) tightened
 * the 6-run spread to snapshot-sync 6.2%, ingest 5.1%, flush-drain 12.3%,
 * e2e-frame 13.8% — the tail of each range coming from the last runs of
 * the sustained back-to-back batch (thermal drift). Worst single-run
 * deviation seen against a fresh single-pass baseline was +14.8%; the
 * committed baseline is a median-of-3-passes, which centers it and cuts
 * typical deviation to single digits. 25% clears the worst observed
 * deviation with ~1.7x headroom while a real hot-path regression (a
 * quarter slower) still trips the gate. Do not raise this without
 * re-measuring the spread and recording it here.
 *
 * CI runs on a HETEROGENEOUS x64 fleet and gets a wider band, measured,
 * not guessed. Runs 31352849222 and 31353009934 (2026-08-10) failed on a
 * byte-identical tree that had passed three prior runner runs; run 5's
 * calibration brackets had 1.5% spread, ruling out transient noise. The
 * raw per-phase ratios vs the darwin/arm64 baseline machine told the
 * real story: calibration 1.7x slower, ingest 1.8x, snapshot-sync 2.0x,
 * flush-drain 2.4x — the allocation/GC-heavy phases scale WORSE than the
 * calibration mix on that silicon, so their normalized scores read up to
 * +34% with zero code change. That ratio is the architecture, not a
 * regression, and it varies across the fleet's runner models (which is
 * why runs 1-3 passed). Tight enforcement therefore lives where the
 * machine is constant — local dev, 25% — and CI keeps a 50% band that
 * still catches genuinely broken hot paths while absorbing the measured
 * cross-model spread (~1.12x headroom over the worst observed +33.6%).
 */
const TOLERANCE = process.env.CI ? 0.5 : 0.25;

const BASELINE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'baseline.json',
);

// ---------------------------------------------------------------------------
// Plumbing

interface BenchClient {
  client: TapeClient;
  socket: FakeSocket;
  frames: ManualFrameScheduler;
  timers: ManualTimers;
}

/** Drain pending microtasks (snapshot fetch → json → completeSync). */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Best (minimum) sample — see the aggregation note in the header. */
function best(samples: number[]): number {
  let min = Infinity;
  for (const s of samples) if (s < min) min = s;
  return min;
}

/** Create a client wired to the fakes, subscribed like the monitor app
 * (same channels, same policies, same priorities), NOT yet connected. */
function makeClient(fixture: Fixture): BenchClient {
  const timers = new ManualTimers();
  const frames = new ManualFrameScheduler();
  let socket: FakeSocket | null = null;
  const client = createTapeClient({
    url: 'ws://bench.invalid:4400',
    webSocketFactory: () => {
      socket = new FakeSocket();
      return socket;
    },
    fetchFn: makeFakeFetch({
      instruments: fixture.instrumentsSnapshot,
      tape: fixture.tapeSnapshot,
    }),
    scheduler: frames,
    timers,
    now: () => performance.now(),
    random: () => 0.5,
  });
  client.subscribe('instruments', { volume: 'accumulate' }, { priority: 1 });
  client.subscribe(
    'tape',
    { trades: { policy: 'sequence', capacity: 512 } },
    { priority: 0 },
  );
  client.connect();
  if (socket === null) throw new Error('bench: connect() created no socket');
  return { client, socket, frames, timers };
}

/** Open the socket and reconcile both snapshots; assert 'live'. */
async function goLive(bc: BenchClient): Promise<void> {
  bc.socket.open();
  await settle();
  const state = bc.client.getState();
  if (state !== 'live') {
    throw new Error(`bench: expected state 'live' after sync, got '${state}'`);
  }
}

function pushAll(bc: BenchClient, frames: readonly string[]): void {
  const onmessage = bc.socket.onmessage;
  if (onmessage === null) throw new Error('bench: socket has no onmessage');
  for (let i = 0; i < frames.length; i++) onmessage({ data: frames[i] });
}

/** Fire frame callbacks until the buffer stops requesting frames. */
function drain(bc: BenchClient): void {
  let guard = 0;
  while (bc.frames.pendingCount > 0) {
    bc.frames.fire(performance.now());
    if (++guard > 10_000) throw new Error('bench: drain did not terminate');
  }
}

function tripwire(cond: boolean, label: string): void {
  if (!cond) throw new Error(`bench tripwire: ${label}`);
}

/** Exact-count invariants after a full ingest+drain of the fixture. */
function checkFullRun(bc: BenchClient, fixture: Fixture): void {
  const m = bc.client.getMetrics();
  tripwire(
    m.messagesIn === fixture.messageCount,
    `messagesIn ${m.messagesIn} !== ${fixture.messageCount}`,
  );
  tripwire(
    m.updatesIn === fixture.recordUpdateCount,
    `updatesIn ${m.updatesIn} !== ${fixture.recordUpdateCount}`,
  );
  tripwire(m.gapsDetected === 0, `gapsDetected ${m.gapsDetected} !== 0`);
  tripwire(m.reordersHealed === 0, `reordersHealed ${m.reordersHealed} !== 0`);
  tripwire(m.staleDropped === 0, `staleDropped ${m.staleDropped} !== 0`);
  tripwire(
    m.snapshotsLoaded === 2,
    `snapshotsLoaded ${m.snapshotsLoaded} !== 2`,
  );
  tripwire(
    m.updatesApplied > 0 && m.updatesApplied <= m.updatesIn,
    `updatesApplied ${m.updatesApplied} out of range (0, ${m.updatesIn}]`,
  );
  tripwire(m.coalesceRatio >= 1, `coalesceRatio ${m.coalesceRatio} < 1`);
}

// ---------------------------------------------------------------------------
// Calibration — machine-speed proxy with the hot path's primitive mix

let calibrationSink = 0;

function calibrationOp(): void {
  const msg = JSON.parse(CALIBRATION_FRAME) as {
    updates: Array<{ fields: Record<string, unknown> }>;
  };
  for (const u of msg.updates) {
    for (const key in u.fields) {
      const v = u.fields[key];
      if (typeof v === 'number') calibrationSink += v;
    }
  }
}

function calibrate(): number {
  const samples: number[] = [];
  for (let s = 0; s < WARMUP + SAMPLES; s++) {
    const t0 = performance.now();
    for (let i = 0; i < CALIBRATION_ITERS; i++) calibrationOp();
    const t1 = performance.now();
    if (s >= WARMUP) samples.push(((t1 - t0) * 1e6) / CALIBRATION_ITERS);
  }
  tripwire(calibrationSink !== 0, 'calibration sink is zero (DCE?)');
  return best(samples);
}

// ---------------------------------------------------------------------------
// Benchmarks. Each sample gets a FRESH live client (seqs are consumed by
// ingest, so clients cannot be reused across samples); setup is untimed.

interface BenchResult {
  name: string;
  /** Best-sample cost in ns of the benchmark's unit (msg, sync, drain). */
  bestNs: number;
  unit: string;
  /** bestNs / calibration nsPerOp — the machine-normalized gate value. */
  score: number;
}

async function benchSnapshotSync(fixture: Fixture): Promise<number> {
  const samples: number[] = [];
  for (let s = 0; s < WARMUP + SAMPLES; s++) {
    const bc = makeClient(fixture);
    const t0 = performance.now();
    await goLive(bc);
    const t1 = performance.now();
    const m = bc.client.getMetrics();
    tripwire(m.snapshotsLoaded === 2, `snapshot-sync loaded ${m.snapshotsLoaded}`);
    bc.client.close();
    if (s >= WARMUP) samples.push((t1 - t0) * 1e6);
  }
  return best(samples);
}

async function benchIngest(fixture: Fixture): Promise<number> {
  const samples: number[] = [];
  for (let s = 0; s < WARMUP + SAMPLES; s++) {
    const bc = makeClient(fixture);
    await goLive(bc);
    const t0 = performance.now();
    pushAll(bc, fixture.frames);
    const t1 = performance.now();
    drain(bc);
    checkFullRun(bc, fixture);
    bc.client.close();
    if (s >= WARMUP) samples.push(((t1 - t0) * 1e6) / fixture.messageCount);
  }
  return best(samples);
}

async function benchFlushDrain(fixture: Fixture): Promise<number> {
  const samples: number[] = [];
  for (let s = 0; s < WARMUP + SAMPLES; s++) {
    const bc = makeClient(fixture);
    await goLive(bc);
    pushAll(bc, fixture.frames); // untimed: stages ~10k pending records
    const t0 = performance.now();
    drain(bc);
    const t1 = performance.now();
    checkFullRun(bc, fixture);
    bc.client.close();
    if (s >= WARMUP) samples.push((t1 - t0) * 1e6);
  }
  return best(samples);
}

async function benchE2eFrame(fixture: Fixture): Promise<number> {
  const samples: number[] = [];
  for (let s = 0; s < WARMUP + SAMPLES; s++) {
    const bc = makeClient(fixture);
    await goLive(bc);
    const onmessage = bc.socket.onmessage;
    if (onmessage === null) throw new Error('bench: socket has no onmessage');
    const frames = fixture.frames;
    const t0 = performance.now();
    for (let i = 0; i < frames.length; i += E2E_CHUNK) {
      const end = Math.min(i + E2E_CHUNK, frames.length);
      for (let j = i; j < end; j++) onmessage({ data: frames[j] });
      drain(bc);
    }
    const t1 = performance.now();
    checkFullRun(bc, fixture);
    bc.client.close();
    if (s >= WARMUP) samples.push(((t1 - t0) * 1e6) / fixture.messageCount);
  }
  return best(samples);
}

// ---------------------------------------------------------------------------
// Baseline + gate

interface Baseline {
  version: 1;
  createdAt: string;
  node: string;
  platform: string;
  tolerance: number;
  calibrationNsPerOp: number;
  benchmarks: Record<string, { bestNs: number; unit: string; score: number }>;
}

function loadBaseline(): Baseline | null {
  let raw: string;
  try {
    raw = readFileSync(BASELINE_PATH, 'utf8');
  } catch {
    return null;
  }
  return JSON.parse(raw) as Baseline;
}

function fmt(ns: number, unit: string): string {
  if (unit.startsWith('ms')) return (ns / 1e6).toFixed(2) + ' ' + unit;
  return ns.toFixed(0) + ' ' + unit;
}

interface Pass {
  calibrationNsPerOp: number;
  results: BenchResult[];
}

/** One full measurement pass: all four benchmarks, each BRACKETED by
 * calibrations and normalized by the slower of its two brackets (see the
 * header — this is what makes mid-run runner noise cancel instead of
 * reading as a uniform regression). */
async function measurePass(fixture: Fixture): Promise<Pass> {
  const cals: number[] = [calibrate()];
  const raw: Array<{ name: string; unit: string; bestNs: number }> = [];
  const phase = async (
    name: string,
    unit: string,
    bench: () => Promise<number>,
  ): Promise<void> => {
    raw.push({ name, unit, bestNs: await bench() });
    cals.push(calibrate());
  };
  await phase('snapshot-sync', 'ms/sync', () => benchSnapshotSync(fixture));
  await phase('ingest', 'ns/msg', () => benchIngest(fixture));
  await phase('flush-drain', 'ms/drain', () => benchFlushDrain(fixture));
  await phase('e2e-frame', 'ns/msg', () => benchE2eFrame(fixture));
  const spreadPct =
    (100 * (Math.max(...cals) - Math.min(...cals))) / Math.min(...cals);
  console.log(
    `calibration brackets: [${cals.map((c) => c.toFixed(0)).join(', ')}] ` +
      `ns/op (spread ${spreadPct.toFixed(1)}% — drift visible here means ` +
      'the runner was noisy, and the bracketing absorbed it)',
  );
  const results: BenchResult[] = raw.map((r, i) => ({
    ...r,
    score: r.bestNs / Math.max(cals[i]!, cals[i + 1]!),
  }));
  return { calibrationNsPerOp: medianOf(cals), results };
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** --update runs 3 passes and keeps per-benchmark MEDIANS, so the committed
 * reference sits at the center of the run-to-run distribution instead of at
 * one lucky (or unlucky) pass's value. */
const UPDATE_PASSES = 3;

async function main(): Promise<void> {
  const update = process.argv.includes('--update');

  console.log(
    `tape perf tier 1 — ${MESSAGE_COUNT} msgs/sample, ` +
      `${SAMPLES} samples (+${WARMUP} warmup), node ${process.version}`,
  );

  const fixture = buildFixture(MESSAGE_COUNT);

  if (update) {
    const passes: Pass[] = [];
    for (let p = 0; p < UPDATE_PASSES; p++) {
      const pass = await measurePass(fixture);
      passes.push(pass);
      console.log(
        `pass ${p + 1}/${UPDATE_PASSES}: calibration ` +
          `${pass.calibrationNsPerOp.toFixed(0)} ns/op, scores ` +
          pass.results.map((r) => `${r.name}=${r.score.toFixed(2)}`).join(' '),
      );
    }
    const results: BenchResult[] = passes[0]!.results.map((r, i) => ({
      name: r.name,
      unit: r.unit,
      bestNs: medianOf(passes.map((p) => p.results[i]!.bestNs)),
      score: medianOf(passes.map((p) => p.results[i]!.score)),
    }));
    const baseline: Baseline = {
      version: 1,
      createdAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      tolerance: TOLERANCE,
      calibrationNsPerOp: Math.round(
        medianOf(passes.map((p) => p.calibrationNsPerOp)),
      ),
      benchmarks: Object.fromEntries(
        results.map((r) => [
          r.name,
          {
            bestNs: Math.round(r.bestNs),
            unit: r.unit,
            score: Number(r.score.toFixed(3)),
          },
        ]),
      ),
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    console.log('');
    for (const r of results) {
      console.log(
        `  ${r.name.padEnd(14)} ${fmt(r.bestNs, r.unit).padStart(14)}   score ${r.score.toFixed(2)}`,
      );
    }
    console.log(`\nbaseline written: ${BASELINE_PATH}`);
    return;
  }

  const { calibrationNsPerOp, results } = await measurePass(fixture);
  console.log(`calibration: ${calibrationNsPerOp.toFixed(0)} ns/op\n`);

  const baseline = loadBaseline();
  if (baseline === null) {
    console.error(
      `no baseline at ${BASELINE_PATH} — run 'pnpm --filter @tape/perf bench:update' and commit it`,
    );
    process.exitCode = 1;
    return;
  }

  let failed = false;
  let improved = false;
  console.log(
    `gate: score <= baseline * ${(1 + TOLERANCE).toFixed(2)} ` +
      `(baseline ${baseline.createdAt}, ${baseline.platform}, ${baseline.node})\n`,
  );
  for (const r of results) {
    const base = baseline.benchmarks[r.name];
    if (base === undefined) {
      console.error(`  ${r.name.padEnd(14)} MISSING from baseline — re-baseline`);
      failed = true;
      continue;
    }
    const limit = base.score * (1 + TOLERANCE);
    const delta = ((r.score - base.score) / base.score) * 100;
    const ok = r.score <= limit;
    if (!ok) failed = true;
    if (delta < -30) improved = true;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'} ${r.name.padEnd(14)} ` +
        `${fmt(r.bestNs, r.unit).padStart(14)}   ` +
        `score ${r.score.toFixed(2)} vs ${base.score.toFixed(2)} ` +
        `(${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%, limit ${limit.toFixed(2)})`,
    );
  }

  console.log('');
  if (failed) {
    console.error(
      'tier 1 gate FAILED — a hot path regressed beyond tolerance (or the baseline is missing entries)',
    );
    process.exitCode = 1;
    return;
  }
  if (improved) {
    console.log(
      'note: >30% faster than baseline on some benchmark — consider re-baselining to keep the gate tight',
    );
  }
  console.log('tier 1 gate PASSED');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
