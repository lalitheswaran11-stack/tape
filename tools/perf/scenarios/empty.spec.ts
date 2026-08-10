/**
 * Empty universe — a second feed with TAPE_INSTRUMENTS=0 on :4406. The
 * page is pointed at it via the '?feed=' query param. A correct client
 * connects, subscribes, resyncs against honestly-empty snapshots, reaches
 * 'live', and the app renders an EXPLICIT empty state: a visible message,
 * zero data rows — no crash, no stale rows, and it stays that way.
 */

import { expect, test } from '@playwright/test';
import { spawnFeed } from '../lib/feed';
import { attachErrorSentry, waitForLive } from '../lib/page';

const EMPTY_FEED_PORT = '4406';

test('empty: zero-instrument feed → explicit empty state, live connection, no crash', async ({
  page,
}) => {
  const sentry = attachErrorSentry(page);
  const feed = await spawnFeed({
    TAPE_PORT: EMPTY_FEED_PORT,
    TAPE_INSTRUMENTS: '0',
  });
  try {
    await page.goto(`/?feed=ws://localhost:${EMPTY_FEED_PORT}`);

    // The client must reach live even with nothing to show: subscribed,
    // snapshot-reconciled (against empty record sets), heartbeat fresh.
    await waitForLive(page);

    const emptyMessage = page.locator('.grid-pane .empty');
    await expect(emptyMessage).toBeVisible();
    await expect(emptyMessage).toContainText('Store is empty');
    await expect(page.locator('[data-tape-row]')).toHaveCount(0);

    // Snapshots were actually loaded — this is a resynced-to-empty state,
    // not a never-loaded one.
    const m = await page.evaluate(() => window.__tapeClient!.getMetrics());
    expect(m.snapshotsLoaded).toBeGreaterThan(0);

    // ...and it STAYS empty (no phantom rows trickling in).
    await page.waitForTimeout(1_000);
    await expect(page.locator('[data-tape-row]')).toHaveCount(0);
    await expect(emptyMessage).toBeVisible();

    console.log(
      `[empty] live against ws://localhost:${EMPTY_FEED_PORT}, ` +
        `snapshotsLoaded=${m.snapshotsLoaded}, rows=0, empty message visible`,
    );
    expect(sentry.errors).toEqual([]);
  } finally {
    await feed.kill();
  }
});
