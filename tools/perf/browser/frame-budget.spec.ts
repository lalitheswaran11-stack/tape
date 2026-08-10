/**
 * Tier 2: browser frame-budget run. High signal, LOOSE gate — the report
 * is the product.
 *
 * 3 measurement runs, each a fresh page load: install probes → goto →
 * live + rows → CDP Emulation.setCPUThrottlingRate(4) → measure 30s.
 * The 4x CPU throttle makes the numbers far less dependent on runner
 * class (an M-series laptop vs a shared CI vCPU) and therefore comparable
 * over time; the snapshot/boot cost is deliberately excluded (throttle is
 * applied only once the app is live).
 *
 * Gate — median run ONLY (median = the run with the median p95 frame
 * interval): p95 frame interval <= 25ms AND longest task <= 100ms.
 * Everything else (p50/p99, over-16.7ms share, heap delta, coalesce ratio,
 * deferred frames, flush p95) is reported, not gated.
 *
 * Full 3-run report + median + environment is written to
 * tools/perf/report/frame-budget.json (directory is gitignored).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';
import type { MetricsSnapshot } from '@lalitheswaran11-stack/tape-core';
import {
  attachErrorSentry,
  installFrameProbe,
  metrics,
  openMonitor,
  readFrames,
  readLongTasks,
  readLongTaskSupport,
  resetProbes,
} from '../lib/page';
import { maxOf, percentile } from '../lib/stats';

const RUNS = 3;
const WINDOW_MS = 30_000;

/**
 * The p95 frame gate is environment-split, from measured evidence, not
 * convenience. First run on a GitHub shared runner (2 vCPU, no GPU,
 * 2026-08-10, run 31351859189): p50 116.7ms / p95 133.4ms in all three
 * runs — every value an exact multiple of the 16.7ms vsync tick — while
 * longest JS task was 0.0ms in all three. That signature is Chromium's
 * software compositor skipping 6-7 vsyncs per frame under the 4x
 * throttle; the JS main thread (the thing this platform controls) was
 * idle. On such runners the frame interval measures the software
 * rasterizer, not tape, so the 25ms budget gate applies where a GPU
 * exists (local dev) and CI keeps a catastrophic-regression backstop:
 * the observed 133.4ms was stable across runs, so 200ms trips only if
 * rendering work genuinely multiplies. The longest-task gate transfers
 * unchanged — it watches our code, and it is the gate that matters in
 * CI. Frame intervals remain fully reported in the artifact either way.
 */
const CPU_THROTTLE = 4;
const GATE_P95_FRAME_MS = process.env.CI ? 200 : 25;
const GATE_LONGEST_TASK_MS = 100;
const FRAME_BUDGET_MS = 16.7;

const REPORT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'report',
);

interface RunStats {
  run: number;
  frames: number;
  p50FrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  framesOverBudget: number;
  shareOverBudget: number;
  longestFrameMs: number;
  longestTaskMs: number;
  longTasks: number;
  longTaskObserverSupported: boolean;
  heapSource: string;
  coalesceRatio: number;
  deferredFramesDelta: number;
  p95FlushMs: number;
  heapStartBytes: number;
  heapEndBytes: number;
  heapDeltaBytes: number;
}

/**
 * JS heap in bytes. CDP Runtime.getHeapUsage is preferred because Chromium
 * QUANTIZES performance.memory (~100KB buckets, rate-limited) without
 * --enable-precise-memory-info — deltas over a 30s window read as 0.
 * performance.memory is the fallback when no CDP session is possible.
 */
async function readHeapBytes(
  page: Page,
  cdp: CDPSession,
): Promise<{ bytes: number; source: string }> {
  try {
    const usage = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
    return { bytes: usage.usedSize, source: 'cdp:Runtime.getHeapUsage' };
  } catch {
    const fromPerformance = await page.evaluate(() => {
      const perf = performance as Performance & {
        memory?: { usedJSHeapSize: number };
      };
      return perf.memory === undefined ? null : perf.memory.usedJSHeapSize;
    });
    if (fromPerformance === null) throw new Error('no heap measurement available');
    return { bytes: fromPerformance, source: 'performance.memory (quantized)' };
  }
}

function computeStats(
  run: number,
  frames: number[],
  longTasks: number[],
  longTaskObserverSupported: boolean,
  mStart: MetricsSnapshot,
  mEnd: MetricsSnapshot,
  heapStart: { bytes: number; source: string },
  heapEnd: { bytes: number; source: string },
): RunStats {
  const over = frames.filter((f) => f > FRAME_BUDGET_MS).length;
  return {
    run,
    frames: frames.length,
    p50FrameMs: percentile(frames, 50),
    p95FrameMs: percentile(frames, 95),
    p99FrameMs: percentile(frames, 99),
    framesOverBudget: over,
    shareOverBudget: frames.length === 0 ? 0 : over / frames.length,
    longestFrameMs: maxOf(frames),
    longestTaskMs: maxOf(longTasks),
    longTasks: longTasks.length,
    longTaskObserverSupported,
    heapSource: heapStart.source,
    coalesceRatio: mEnd.coalesceRatio,
    deferredFramesDelta: mEnd.deferredFrames - mStart.deferredFrames,
    p95FlushMs: mEnd.p95FlushMs,
    heapStartBytes: heapStart.bytes,
    heapEndBytes: heapEnd.bytes,
    heapDeltaBytes: heapEnd.bytes - heapStart.bytes,
  };
}

const ms = (v: number): string => v.toFixed(1);
const mb = (v: number): string => (v / (1024 * 1024)).toFixed(1);

test('frame budget: 3 x 30s @ 4x CPU throttle; gate median p95 <= 25ms and longest task <= 100ms', async ({
  browser,
}) => {
  const runs: RunStats[] = [];

  for (let i = 1; i <= RUNS; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const sentry = attachErrorSentry(page);
    await installFrameProbe(page);
    await openMonitor(page); // fresh goto + live + rows, unthrottled boot

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });

    await resetProbes(page); // measurement window starts clean
    const mStart = await metrics(page);
    const heapStart = await readHeapBytes(page, cdp);

    await page.waitForTimeout(WINDOW_MS);

    const frames = await readFrames(page);
    const longTasks = await readLongTasks(page);
    const longTaskSupport = await readLongTaskSupport(page);
    const mEnd = await metrics(page);
    const heapEnd = await readHeapBytes(page, cdp);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    expect(sentry.errors, `run ${i} page errors`).toEqual([]);
    await context.close();

    const stats = computeStats(
      i,
      frames,
      longTasks,
      longTaskSupport,
      mStart,
      mEnd,
      heapStart,
      heapEnd,
    );
    runs.push(stats);
    console.log(
      `[frame-budget] run ${i}: p50 ${ms(stats.p50FrameMs)} / p95 ${ms(stats.p95FrameMs)} / ` +
        `p99 ${ms(stats.p99FrameMs)}ms, longest frame ${ms(stats.longestFrameMs)}ms, ` +
        `longest task ${ms(stats.longestTaskMs)}ms`,
    );
  }

  // Median run = the run with the median p95 frame interval.
  const median = [...runs].sort((a, b) => a.p95FrameMs - b.p95FrameMs)[
    Math.floor(RUNS / 2)
  ]!;

  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      ci: process.env.CI !== undefined && process.env.CI !== '',
      cpuThrottleFactor: CPU_THROTTLE,
      measurementWindowMs: WINDOW_MS,
      runs: RUNS,
      platform: `${process.platform}/${process.arch}`,
    },
    gate: {
      appliedTo: 'median run only',
      p95FrameMsMax: GATE_P95_FRAME_MS,
      longestTaskMsMax: GATE_LONGEST_TASK_MS,
      passed:
        median.p95FrameMs <= GATE_P95_FRAME_MS &&
        median.longestTaskMs <= GATE_LONGEST_TASK_MS,
    },
    medianRun: median.run,
    median,
    runs,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, 'frame-budget.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`[frame-budget] report written to ${reportPath}`);

  // Compact summary table.
  const header =
    'run  frames  p50    p95    p99    >16.7ms        longestF  longestT  defer  coalesce  flushP95  heapΔ';
  console.log(header);
  for (const r of runs) {
    const marker = r.run === median.run ? '*' : ' ';
    console.log(
      `${String(r.run)}${marker}   ` +
        `${String(r.frames).padEnd(7)} ` +
        `${ms(r.p50FrameMs).padEnd(6)} ` +
        `${ms(r.p95FrameMs).padEnd(6)} ` +
        `${ms(r.p99FrameMs).padEnd(6)} ` +
        `${`${r.framesOverBudget} (${(r.shareOverBudget * 100).toFixed(1)}%)`.padEnd(14)} ` +
        `${`${ms(r.longestFrameMs)}ms`.padEnd(9)} ` +
        `${`${ms(r.longestTaskMs)}ms`.padEnd(9)} ` +
        `${String(r.deferredFramesDelta).padEnd(6)} ` +
        `${r.coalesceRatio.toFixed(2).padEnd(9)} ` +
        `${`${r.p95FlushMs.toFixed(2)}ms`.padEnd(9)} ` +
        `${mb(r.heapDeltaBytes)}MB`,
    );
  }
  console.log(`(* = median run by p95 frame interval)`);

  // Gate on the median run ONLY.
  expect(
    median.p95FrameMs,
    `median-run p95 frame interval (gate ${GATE_P95_FRAME_MS}ms)`,
  ).toBeLessThanOrEqual(GATE_P95_FRAME_MS);
  expect(
    median.longestTaskMs,
    `median-run longest task (gate ${GATE_LONGEST_TASK_MS}ms)`,
  ).toBeLessThanOrEqual(GATE_LONGEST_TASK_MS);
});
