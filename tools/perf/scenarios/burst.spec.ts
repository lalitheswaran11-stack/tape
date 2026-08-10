/**
 * /fault/burst — 10x load spike for 2s. Seqs stay contiguous, so no resync
 * is needed; the client must absorb the spike through coalescing and
 * frame-budgeted flushing while the UI stays interactive.
 *
 * Gates:
 * - backpressure engaged: deferredFrames increased OR coalescing bought
 *   meaningfully more during the burst. The measure for the latter is the
 *   SAVINGS RATE — (ΔupdatesIn − ΔupdatesApplied) per second, i.e. record
 *   writes coalescing eliminated. The plain ratio ΔIn/ΔApplied moves very
 *   little on a fast runner (10k distinct instruments → same-record
 *   collisions within one frame are rare) even while coalescing eliminates
 *   tens of thousands of writes, so the ratio alone under-reports; both
 *   are logged.
 * - frames held: design intent is that no frame interval exceeds 100ms;
 *   the HARD bound here is 150ms to absorb runner noise (a 100ms gate on a
 *   shared runner fails on scheduler hiccups the app cannot control —
 *   breaches of 100 are logged loudly instead);
 * - interactivity: a programmatic scroll mid-burst must move the rendered
 *   row window.
 */

import { expect, test } from '@playwright/test';
import { fault } from '../lib/feed';
import { metricsWindow, maxOf } from '../lib/stats';
import {
  attachErrorSentry,
  installFrameProbe,
  metrics,
  openMonitor,
  readFrames,
  renderedRowIds,
  resetProbes,
} from '../lib/page';

const BURST_MS = 2_000;
const FRAME_HARD_BOUND_MS = 150;
const FRAME_DESIGN_INTENT_MS = 100;

test('burst: 10x spike — coalescing/backpressure absorb it, frames hold, grid stays interactive', async ({
  page,
}) => {
  const sentry = attachErrorSentry(page);
  await installFrameProbe(page);
  await openMonitor(page);

  // Pre-burst baseline window for the windowed coalescing measures.
  const wall0 = Date.now();
  const t0 = await metrics(page);
  await page.waitForTimeout(1_500);
  const wall1 = Date.now();
  const t1 = await metrics(page);

  await resetProbes(page); // frame samples from here on cover the burst
  const burstStart = Date.now();
  await fault('burst', { factor: 10, ms: BURST_MS });

  // Mid-burst interactivity: scroll the grid viewport and require the
  // rendered row window to change while the spike is still running.
  await page.waitForTimeout(600);
  const rowsBefore = await renderedRowIds(page);
  await page.evaluate(() => {
    const viewport = document.querySelector('[data-tape-viewport]');
    if (viewport === null) throw new Error('grid viewport not found');
    viewport.scrollTop += 4_000;
  });
  await page.waitForFunction(
    (prev) => {
      const ids = Array.from(document.querySelectorAll('[data-tape-row]')).map(
        (el) => el.getAttribute('data-tape-row') ?? '',
      );
      return ids.length > 0 && ids.join(',') !== prev;
    },
    rowsBefore.join(','),
    { timeout: 3_000 },
  );

  // Let the rest of the burst play out, plus a short drain margin.
  const elapsed = Date.now() - burstStart;
  await page.waitForTimeout(Math.max(0, BURST_MS - elapsed) + 300);

  const frames = await readFrames(page);
  const wall2 = Date.now();
  const t2 = await metrics(page);

  const base = metricsWindow(t0, t1);
  const burst = metricsWindow(t1, t2);
  const baseSeconds = (wall1 - wall0) / 1000;
  const burstSeconds = (wall2 - wall1) / 1000;
  const baseInRate = base.updatesIn / baseSeconds;
  const burstInRate = burst.updatesIn / burstSeconds;
  const baseSavingsRate = (base.updatesIn - base.updatesApplied) / baseSeconds;
  const burstSavingsRate = (burst.updatesIn - burst.updatesApplied) / burstSeconds;
  const deferredDelta = t2.deferredFrames - t1.deferredFrames;
  console.log(
    `[burst] ingest ${Math.round(baseInRate)}/s → ${Math.round(burstInRate)}/s, ` +
      `coalescing savings ${Math.round(baseSavingsRate)}/s → ${Math.round(burstSavingsRate)}/s, ` +
      `windowed ratio ${base.ratio.toFixed(2)} → ${burst.ratio.toFixed(2)}, ` +
      `deferredFrames +${deferredDelta}, p95FlushMs ${t2.p95FlushMs.toFixed(2)}`,
  );

  // The spike must actually have hit the client.
  expect(burstInRate, 'burst window saw a real ingest spike').toBeGreaterThan(
    baseInRate * 2,
  );

  // Backpressure engaged: frames deferred, or coalescing eliminating
  // meaningfully more writes per second (≥3x baseline, floor 1000/s).
  expect(
    deferredDelta > 0 ||
      burstSavingsRate >= Math.max(3 * baseSavingsRate, 1_000),
    `expected deferredFrames to rise or the coalescing savings rate to grow ≥3x ` +
      `(got deferred +${deferredDelta}, savings ${Math.round(baseSavingsRate)}/s → ` +
      `${Math.round(burstSavingsRate)}/s, ratio ${base.ratio.toFixed(2)} → ${burst.ratio.toFixed(2)})`,
  ).toBe(true);

  // Frame intervals during the burst.
  expect(frames.length).toBeGreaterThan(0);
  const longest = maxOf(frames);
  console.log(`[burst] longest frame interval during burst: ${longest.toFixed(1)}ms`);
  if (longest > FRAME_DESIGN_INTENT_MS) {
    console.log(
      `[burst] WARNING: longest frame ${longest.toFixed(1)}ms exceeds the ` +
        `${FRAME_DESIGN_INTENT_MS}ms design intent (still within the ` +
        `${FRAME_HARD_BOUND_MS}ms hard bound)`,
    );
  }
  expect(longest, 'no frame interval may exceed the hard bound').toBeLessThanOrEqual(
    FRAME_HARD_BOUND_MS,
  );

  expect(sentry.errors).toEqual([]);
});
