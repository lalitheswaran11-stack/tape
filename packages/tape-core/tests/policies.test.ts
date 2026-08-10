import { describe, expect, it } from 'vitest';
import { makeHarness, settle, snap, upd } from './helpers';

const CH = 'mkt';

describe('coalescing policies', () => {
  it('latest wins, accumulate sums, sequence keeps order bounded by capacity', async () => {
    const h = makeHarness();
    h.fetch.queueSnapshot(
      snap(CH, 0, [
        { id: 'r1', fields: { last: 10, vol: 100, trades: [{ px: 1 }] } },
      ]),
    );
    const sub = h.client.subscribe(CH, {
      last: 'latest',
      vol: 'accumulate',
      trades: { policy: 'sequence', capacity: 3 },
    });
    h.client.connect();
    h.sockets.latest().open();
    await settle();
    const snapshotRef = sub.store.get('r1')!;
    expect(snapshotRef.fields['vol']).toBe(100); // absolute in snapshots

    let recordTicks = 0;
    sub.store.subscribeRecord('r1', () => recordTicks++);

    const s = h.sockets.latest();
    s.push(upd(CH, 1, [{ id: 'r1', fields: { last: 11, vol: 5, trades: { px: 2 } } }]));
    s.push(upd(CH, 2, [{ id: 'r1', fields: { last: 12, vol: 7, trades: { px: 3 } } }]));
    s.push(upd(CH, 3, [{ id: 'r1', fields: { last: 13, vol: 9, trades: { px: 4 } } }]));
    s.push(upd(CH, 4, [{ id: 'r1', fields: { last: 14, vol: 4, trades: { px: 5 } } }]));

    // Nothing observable until the frame flushes — intermediates never leak.
    expect(sub.store.get('r1')).toBe(snapshotRef);
    expect(sub.store.get('r1')!.fields['last']).toBe(10);
    expect(recordTicks).toBe(0);

    h.frames.fire();
    const r1 = sub.store.get('r1')!;
    expect(r1).not.toBe(snapshotRef); // copy-on-write: new identity per change
    expect(r1.fields['last']).toBe(14); // newest wins; 11/12/13 never observable
    expect(r1.fields['vol']).toBe(100 + 5 + 7 + 9 + 4); // deltas sum in-frame
    // sequence: every entry in order, capacity 3 → oldest evicted
    expect(r1.fields['trades']).toEqual([{ px: 3 }, { px: 4 }, { px: 5 }]);
    expect(recordTicks).toBe(1); // one flush, one notification

    // Across frames: identity is stable until the next flush changes it.
    expect(sub.store.get('r1')).toBe(r1);
    s.push(upd(CH, 5, [{ id: 'r1', fields: { vol: 3 } }]));
    h.frames.fire();
    const r1b = sub.store.get('r1')!;
    expect(r1b).not.toBe(r1);
    expect(r1b.fields['vol']).toBe(125 + 3);
    expect(r1b.fields['last']).toBe(14); // untouched fields carry over
    expect(h.frames.pendingCount).toBe(0); // idle → no frame scheduled
  });
});

describe('backpressure', () => {
  it('defers lower-priority channels past the budget; nothing is lost', async () => {
    // now() advances 10 virtual ms per call once `step` is set, so a single
    // channel flush blows an 8ms budget deterministically.
    const clock = { t: 0, step: 0 };
    const h = makeHarness({
      now: () => {
        clock.t += clock.step;
        return clock.t;
      },
      flushBudgetMs: 8,
    });
    h.fetch.respondWith((channel) => snap(channel, 0, []));
    const hi = h.client.subscribe('hi', { vol: 'accumulate' }, { priority: 5 });
    const lo = h.client.subscribe('lo', { vol: 'accumulate' }, { priority: 0 });
    h.client.connect();
    const s = h.sockets.latest();
    s.open();
    await settle();
    expect(h.client.getState()).toBe('live');

    s.push(upd('hi', 1, [{ id: 'h1', fields: { vol: 5 } }]));
    s.push(upd('lo', 1, [{ id: 'l1', fields: { vol: 5 } }]));
    expect(h.frames.pendingCount).toBe(1); // one frame loop for all channels

    clock.step = 10; // every now() call costs 10ms from here on
    h.frames.fire();
    // Highest priority flushed; the budget was blown; 'lo' deferred.
    expect(hi.store.get('h1')!.fields['vol']).toBe(5);
    expect(lo.store.get('l1')).toBeUndefined();
    expect(h.client.getMetrics().deferredFrames).toBe(1);
    expect(h.frames.pendingCount).toBe(1); // next frame requested immediately

    // More deltas for the deferred channel keep coalescing — nothing lost.
    s.push(upd('lo', 2, [{ id: 'l1', fields: { vol: 7 } }]));

    h.frames.fire();
    expect(lo.store.get('l1')!.fields['vol']).toBe(12); // 5 + 7 across deferral
    expect(h.frames.pendingCount).toBe(0); // drained → idle, nothing scheduled

    const m = h.client.getMetrics();
    expect(m.deferredFrames).toBe(1);
    expect(m.framesFlushed).toBe(2);
    expect(m.updatesIn).toBe(3);
    expect(m.updatesApplied).toBe(2); // h1 once, l1 once
  });
});
