/**
 * /fault/stall — upstream freeze: updates AND pong replies stop, so the
 * server is fully silent while the socket stays open. This is the
 * silent-death-socket case the heartbeat exists for: after timeoutMs
 * (2500ms) with no traffic the client must declare 'degraded', force a
 * reconnect, resync, and return to 'live'.
 *
 * Two deliberate deviations from the design-doc sketch, both documented:
 * - stall ms is 4000, not 3000: heartbeat checks run on a 1000ms cadence,
 *   so a 3000ms stall leaves only a ~500ms window for a check to land in
 *   the stale zone — a literal coin flip. 4000ms guarantees a check lands
 *   (2500 + 1000 < 4000) while detection still happens DURING the stall,
 *   which the test asserts by timestamp.
 * - 'degraded' is asserted on the client-level state log, not the banner
 *   DOM: the transport sets degraded and starts reconnecting in the same
 *   synchronous task, so React can only ever paint the later state — the
 *   banner physically cannot show it. The recorder's onStateChange log
 *   captures every transition; staleTransitions corroborates.
 */

import { expect, test } from '@playwright/test';
import { fault } from '../lib/feed';
import {
  attachErrorSentry,
  bannerState,
  expectRowTicking,
  installStateRecorder,
  metrics,
  openMonitor,
  readBannerStates,
  readClientStates,
  sampleFirstRow,
} from '../lib/page';

const STALL_MS = 4_000;

test('stall: fully silent upstream → heartbeat declares degraded during the stall → reconnect → live', async ({
  page,
}) => {
  const sentry = attachErrorSentry(page);
  await installStateRecorder(page);
  await openMonitor(page);

  const bannerBaseline = (await readBannerStates(page)).length;
  const clientBaseline = (await readClientStates(page)).length;
  const before = await metrics(page);
  const row = await sampleFirstRow(page);

  const pageT0 = await page.evaluate(() => performance.now());
  await fault('stall', { ms: STALL_MS });

  // The heartbeat (timeout 2500ms, checked every 1000ms) must declare
  // degraded no later than ~3500ms in — before the stall ends.
  await expect
    .poll(
      async () => {
        const seq = (await readClientStates(page))
          .slice(clientBaseline)
          .map((s) => s.state);
        return seq.includes('degraded')
          ? 'degraded'
          : `not yet: [${seq.join(' → ')}]`;
      },
      { timeout: STALL_MS + 2_000 },
    )
    .toBe('degraded');

  const degradedEntry = (await readClientStates(page))
    .slice(clientBaseline)
    .find((s) => s.state === 'degraded');
  expect(degradedEntry).toBeDefined();
  // DURING the stall: after the fault was posted, before the resume.
  expect(degradedEntry!.at, 'degraded declared after the stall began').toBeGreaterThan(
    pageT0,
  );
  expect(degradedEntry!.at, 'degraded declared before the stall ended').toBeLessThan(
    pageT0 + STALL_MS,
  );

  // ...then back to live.
  await expect.poll(() => bannerState(page), { timeout: 10_000 }).toBe('live');

  const clientSeq = (await readClientStates(page))
    .slice(clientBaseline)
    .map((s) => s.state);
  const bannerSeq = (await readBannerStates(page))
    .slice(bannerBaseline)
    .map((s) => s.state);
  console.log(`[stall] client states: live → ${clientSeq.join(' → ')}`);
  console.log(
    `[stall] banner painted: live → ${bannerSeq.join(' → ')} ` +
      `(degraded → connecting is atomic; the banner cannot paint degraded)`,
  );
  console.log(
    `[stall] degraded declared ${(degradedEntry!.at - pageT0).toFixed(0)}ms into the ${STALL_MS}ms stall`,
  );

  const after = await metrics(page);
  expect(after.staleTransitions, 'staleTransitions incremented').toBeGreaterThan(
    before.staleTransitions,
  );
  expect(after.reconnects, 'forced reconnect happened').toBeGreaterThan(
    before.reconnects,
  );
  expect(after.snapshotsLoaded, 'reconnect resynced via snapshot').toBeGreaterThan(
    before.snapshotsLoaded,
  );

  await expectRowTicking(page, row.id);
  expect(sentry.errors).toEqual([]);
});
