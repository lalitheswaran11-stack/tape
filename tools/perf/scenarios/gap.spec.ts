/**
 * /fault/gap — 200 updates generated and applied to server state but never
 * transmitted. Stream replay can NEVER fill the hole; the only correct
 * recovery is: detect the seq gap, declare it, resync via REST snapshot.
 *
 * The volume assertion is the sharp edge: `volume` is delta-encoded on the
 * wire ('accumulate') and absolute in snapshots. The skipped updates DID
 * happen server-side, so the post-resync absolute volume must be >= the
 * client's pre-gap accumulated value — a decrease would mean the snapshot
 * semantics dropped data. Sampled straight from the client store (same
 * refcounted subscription as the app), so no display rounding is involved.
 */

import { expect, test } from '@playwright/test';
import { fault } from '../lib/feed';
import {
  attachErrorSentry,
  expectRowTicking,
  metrics,
  openMonitor,
  startVolumeWatch,
  stopVolumeWatch,
} from '../lib/page';

test('gap: 200 skipped updates → gap declared → snapshot resync; volume monotone across the resync', async ({
  page,
}) => {
  const sentry = attachErrorSentry(page);
  await openMonitor(page);

  const before = await metrics(page);
  const watchedId = await startVolumeWatch(page);

  await page.waitForTimeout(500); // collect pre-gap samples
  await fault('gap', { skip: 200 });

  // Snapshot resync is the ONLY way to recover skipped data: both counters
  // must move within 10s.
  await expect
    .poll(
      async () => {
        const m = await metrics(page);
        const done =
          m.gapsDetected > before.gapsDetected &&
          m.snapshotsLoaded > before.snapshotsLoaded;
        return done
          ? 'resynced'
          : `waiting: gaps +${m.gapsDetected - before.gapsDetected}, ` +
              `snapshots +${m.snapshotsLoaded - before.snapshotsLoaded}`;
      },
      { timeout: 10_000 },
    )
    .toBe('resynced');

  await page.waitForTimeout(1_000); // collect post-resync samples
  const { id, samples } = await stopVolumeWatch(page);
  expect(samples.length, 'watcher collected samples across the resync').toBeGreaterThan(
    10,
  );

  const decreases: string[] = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]! < samples[i - 1]!) {
      decreases.push(`sample ${i}: ${samples[i - 1]!} → ${samples[i]!}`);
    }
  }
  expect(decreases, `volume of ${id} decreased across the resync`).toEqual([]);

  const after = await metrics(page);
  console.log(
    `[gap] gapsDetected +${after.gapsDetected - before.gapsDetected}, ` +
      `snapshotsLoaded +${after.snapshotsLoaded - before.snapshotsLoaded}, ` +
      `volume(${id}) ${samples[0]!} → ${samples[samples.length - 1]!} over ${samples.length} samples, monotone`,
  );

  await expectRowTicking(page, watchedId);
  expect(sentry.errors).toEqual([]);
});
