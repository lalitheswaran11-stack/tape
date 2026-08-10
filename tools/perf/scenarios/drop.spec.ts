/**
 * /fault/drop — network partition / server crash: every socket is
 * hard-terminated with no close frame.
 *
 * A correct client leaves 'live', reconnects, reconciles via snapshot
 * ('resyncing' MUST appear — reconnects always resync), and returns to
 * 'live', all within 15s. 'connecting' / 'degraded' may appear in between
 * (Chromium usually sees the TCP reset immediately → 'connecting'; a
 * swallowed reset would surface as heartbeat 'degraded' instead — both are
 * sanctioned detection paths).
 */

import { expect, test } from '@playwright/test';
import { fault } from '../lib/feed';
import {
  attachErrorSentry,
  expectRowTicking,
  installStateRecorder,
  metrics,
  openMonitor,
  readBannerStates,
  sampleFirstRow,
} from '../lib/page';

const ALLOWED_RECOVERY_STATES = ['connecting', 'degraded', 'resyncing', 'live'];

test('drop: hard socket kill → reconnect → snapshot resync → live, values ticking again', async ({
  page,
}) => {
  const sentry = attachErrorSentry(page);
  await installStateRecorder(page);
  await openMonitor(page);

  const baseline = (await readBannerStates(page)).length;
  const before = await metrics(page);
  const row = await sampleFirstRow(page);

  await fault('drop');

  // Within 15s the banner sequence must leave live, pass through resyncing,
  // and end back at live. The poll returns the raw sequence on failure so
  // the report shows exactly what path the client took.
  await expect
    .poll(
      async () => {
        const seq = (await readBannerStates(page))
          .slice(baseline)
          .map((s) => s.state);
        const recovered =
          seq.length >= 2 &&
          seq.includes('resyncing') &&
          seq[seq.length - 1] === 'live';
        return recovered ? 'recovered' : `not yet: [${seq.join(' → ')}]`;
      },
      { timeout: 15_000 },
    )
    .toBe('recovered');

  const seq = (await readBannerStates(page)).slice(baseline).map((s) => s.state);
  for (const state of seq) {
    expect(ALLOWED_RECOVERY_STATES, `unexpected state in ${seq.join(' → ')}`).toContain(
      state,
    );
  }
  console.log(`[drop] recovery sequence: live → ${seq.join(' → ')}`);

  const after = await metrics(page);
  expect(after.reconnects, 'reconnects incremented').toBeGreaterThan(before.reconnects);
  expect(after.snapshotsLoaded, 'snapshotsLoaded incremented').toBeGreaterThan(
    before.snapshotsLoaded,
  );
  console.log(
    `[drop] reconnects +${after.reconnects - before.reconnects}, ` +
      `snapshotsLoaded +${after.snapshotsLoaded - before.snapshotsLoaded}`,
  );

  // The symbol sampled before the drop must still be ticking after recovery.
  await expectRowTicking(page, row.id);

  expect(sentry.errors).toEqual([]);
});
