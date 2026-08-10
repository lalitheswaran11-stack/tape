import { describe, expect, it } from 'vitest';
import { makeHarness, settle, snap, upd } from './helpers';

const CH = 'book';

describe('resync after reconnect', () => {
  it('a record absent from the post-reconnect snapshot is gone; state passes through resyncing', async () => {
    const h = makeHarness();
    h.fetch.queueSnapshot(
      snap(CH, 5, [
        { id: 'r1', fields: { last: 1 } },
        { id: 'r2', fields: { last: 2 } },
      ]),
    );
    const sub = h.client.subscribe(CH, { last: 'latest' });
    h.client.connect();
    const s0 = h.sockets.latest();
    s0.open();
    await settle();
    s0.push(upd(CH, 6, [{ id: 'r1', fields: { last: 10 } }]));
    h.frames.fire();
    expect(sub.store.get('r1')!.fields['last']).toBe(10);
    expect(sub.store.get('r2')!.fields['last']).toBe(2);

    // Kill the socket mid-update: seq 7 lands in pending, never flushed.
    s0.push(upd(CH, 7, [{ id: 'r2', fields: { last: 99 } }]));
    s0.serverClose();
    expect(h.client.getState()).toBe('connecting');

    h.timers.advance(0.5 * 250);
    const s1 = h.sockets.latest();
    // The world moved on while we were away: r2 no longer exists.
    h.fetch.queueSnapshot(snap(CH, 20, [{ id: 'r1', fields: { last: 50 } }]));
    s1.open();
    expect(h.client.getState()).toBe('resyncing');
    await settle();
    expect(h.client.getState()).toBe('live');
    h.frames.fire(); // any straggler frame must not resurrect r2

    expect(sub.store.get('r2')).toBeUndefined(); // no stale record survives
    expect(sub.store.ids()).toEqual(['r1']);
    expect(sub.store.get('r1')!.fields['last']).toBe(50);
    // resyncing was observed before returning to live
    const lastResync = h.states.lastIndexOf('resyncing');
    expect(lastResync).toBeGreaterThan(-1);
    expect(h.states[h.states.length - 1]).toBe('live');
  });
});

describe('snapshot replay', () => {
  it('discards buffered updates with seq <= snapshot.seq, applies seq > snapshot.seq', async () => {
    const h = makeHarness();
    h.fetch.hold = true;
    const sub = h.client.subscribe(CH, { last: 'latest', vol: 'accumulate' });
    h.client.connect();
    const s = h.sockets.latest();
    s.open();
    expect(h.client.getState()).toBe('resyncing');
    // Live updates race the snapshot fetch; they buffer, ordered by seq.
    s.push(upd(CH, 5, [{ id: 'r1', fields: { last: 'A', vol: 1 } }]));
    s.push(upd(CH, 7, [{ id: 'r1', fields: { last: 'C', vol: 1 } }])); // out of order
    s.push(upd(CH, 6, [{ id: 'r1', fields: { last: 'B', vol: 1 } }]));
    s.push(upd(CH, 8, [{ id: 'r1', fields: { last: 'D', vol: 1 } }]));
    // Snapshot is cut at seq 6: it already contains updates 5 and 6.
    h.fetch.queueSnapshot(snap(CH, 6, [{ id: 'r1', fields: { last: 'S', vol: 100 } }]));
    h.fetch.release();
    await settle();
    h.frames.fire();
    const r1 = sub.store.get('r1')!;
    expect(r1.fields['last']).toBe('D'); // 7 and 8 replayed in order
    expect(r1.fields['vol']).toBe(102); // 100 absolute + deltas from 7,8 only
    expect(h.client.getState()).toBe('live');
  });

  it('clears pre-snapshot pending coalesce state before the snapshot applies', async () => {
    const h = makeHarness();
    h.fetch.queueSnapshot(snap(CH, 0, [{ id: 'r1', fields: { vol: 0 } }]));
    const sub = h.client.subscribe(CH, { vol: 'accumulate' });
    h.client.connect();
    const s = h.sockets.latest();
    s.open();
    await settle();
    expect(h.client.getState()).toBe('live');

    // Deltas land in pending but no frame ever fires...
    s.push(upd(CH, 1, [{ id: 'r1', fields: { vol: 5 } }]));
    s.push(upd(CH, 2, [{ id: 'r1', fields: { vol: 7 } }]));
    // ...then a gap forces a resync.
    h.fetch.hold = true;
    s.push(upd(CH, 5, [{ id: 'r1', fields: { vol: 1000 } }])); // 3,4 missing
    h.timers.advance(250);
    expect(h.client.getMetrics().gapsDetected).toBe(1);
    // Updates during the fetch buffer for replay.
    s.push(upd(CH, 10, [{ id: 'r1', fields: { vol: 1 } }]));
    s.push(upd(CH, 11, [{ id: 'r1', fields: { vol: 2 } }]));
    h.fetch.queueSnapshot(snap(CH, 9, [{ id: 'r1', fields: { vol: 100 } }]));
    h.fetch.release();
    await settle();
    h.frames.fire();
    // 100 (absolute) + 1 + 2; the stale pending deltas (5, 7) are GONE and
    // the held seq-5 message was discarded with the gap.
    expect(sub.store.get('r1')!.fields['vol']).toBe(103);
  });
});

describe('empty snapshot', () => {
  it('clears the store and notifies ids subscribers — no stale rows', async () => {
    const h = makeHarness();
    h.fetch.queueSnapshot(
      snap(CH, 5, [
        { id: 'r1', fields: { last: 1 } },
        { id: 'r2', fields: { last: 2 } },
      ]),
    );
    const sub = h.client.subscribe(CH, { last: 'latest' });
    h.client.connect();
    const s0 = h.sockets.latest();
    s0.open();
    await settle();
    expect(sub.store.size()).toBe(2);

    let idsNotified = 0;
    let r1Notified = 0;
    sub.store.subscribeIds(() => idsNotified++);
    sub.store.subscribeRecord('r1', () => r1Notified++);

    s0.serverClose();
    h.timers.advance(0.5 * 250);
    h.fetch.queueSnapshot(snap(CH, 9, []));
    h.sockets.latest().open();
    await settle();

    expect(h.client.getState()).toBe('live');
    expect(sub.store.size()).toBe(0);
    expect(sub.store.ids()).toEqual([]);
    expect(sub.store.get('r1')).toBeUndefined();
    expect(idsNotified).toBe(1); // membership changed
    expect(r1Notified).toBe(1); // previously-present id notified
  });
});
