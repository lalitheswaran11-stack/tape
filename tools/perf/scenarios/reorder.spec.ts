/**
 * /fault/reorder — out-of-order delivery: 64 updates emitted in shuffled
 * windows of 8.
 *
 * With the client's holdback window at 16 (> the shuffle window) healing is
 * the expected outcome: reordersHealed increases and no data is lost. A
 * declared-and-resynced gap (gapsDetected AND snapshotsLoaded up) is also
 * correct behavior — a client may legitimately give up on a hole and
 * resync. SILENCE is the only wrong answer: metrics unchanged would mean
 * misordered data was applied or dropped without recovery.
 */

import { expect, test } from '@playwright/test';
import { fault } from '../lib/feed';
import {
  attachErrorSentry,
  expectRowTicking,
  metrics,
  openMonitor,
  sampleFirstRow,
} from '../lib/page';

test('reorder: shuffled windows are healed by holdback (or declared and resynced) — never silent', async ({
  page,
}) => {
  const sentry = attachErrorSentry(page);
  await openMonitor(page);

  const before = await metrics(page);
  const row = await sampleFirstRow(page);

  await fault('reorder', { window: 8, count: 64 });

  // At 5000 msg/s the 64 shuffled messages pass in well under a second;
  // give the evidence ~5s to land in metrics.
  await expect
    .poll(
      async () => {
        const m = await metrics(page);
        const healed = m.reordersHealed > before.reordersHealed;
        const declaredAndResynced =
          m.gapsDetected > before.gapsDetected &&
          m.snapshotsLoaded > before.snapshotsLoaded;
        return healed || declaredAndResynced
          ? 'handled'
          : `silent: healed=${m.reordersHealed - before.reordersHealed} ` +
              `gaps=${m.gapsDetected - before.gapsDetected} ` +
              `snapshots=${m.snapshotsLoaded - before.snapshotsLoaded}`;
      },
      { timeout: 8_000 },
    )
    .toBe('handled');

  const after = await metrics(page);
  console.log(
    `[reorder] reordersHealed +${after.reordersHealed - before.reordersHealed}, ` +
      `gapsDetected +${after.gapsDetected - before.gapsDetected}, ` +
      `snapshotsLoaded +${after.snapshotsLoaded - before.snapshotsLoaded}, ` +
      `staleDropped +${after.staleDropped - before.staleDropped}`,
  );

  // Rows still updating, no page errors: the reorder was absorbed, not survived.
  await expectRowTicking(page, row.id);
  expect(sentry.errors).toEqual([]);
});
