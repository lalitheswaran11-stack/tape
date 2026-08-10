import { describe, expect, it } from 'vitest';
import { makeHarness, settle, snap, upd } from './helpers';

const CH = 'grid';

async function syncTwoRecords() {
  const h = makeHarness();
  h.fetch.queueSnapshot(
    snap(CH, 0, [
      { id: 'r1', fields: { last: 1 } },
      { id: 'r2', fields: { last: 2 } },
    ]),
  );
  const sub = h.client.subscribe(CH, { last: 'latest' });
  h.client.connect();
  h.sockets.latest().open();
  await settle();
  return { h, sub, s: h.sockets.latest() };
}

describe('notification granularity', () => {
  it('a tick on one record never wakes subscribers of another', async () => {
    const { h, sub, s } = await syncTwoRecords();
    let r1Ticks = 0;
    let r2Ticks = 0;
    let idsTicks = 0;
    const flushes: Array<ReadonlySet<string>> = [];
    sub.store.subscribeRecord('r1', () => r1Ticks++);
    sub.store.subscribeRecord('r2', () => r2Ticks++);
    sub.store.subscribeIds(() => idsTicks++);
    sub.store.onFlush((ids) => flushes.push(ids));
    const idsBefore = sub.store.ids();

    s.push(upd(CH, 1, [{ id: 'r1', fields: { last: 10 } }]));
    h.frames.fire();
    expect(r1Ticks).toBe(1);
    expect(r2Ticks).toBe(0); // untouched record stays asleep
    expect(idsTicks).toBe(0); // membership unchanged
    expect(sub.store.ids()).toBe(idsBefore); // cached array identity kept
    expect(flushes).toEqual([new Set(['r1'])]);

    // A new record changes membership: ids subscribers fire exactly then.
    s.push(upd(CH, 2, [{ id: 'r3', fields: { last: 30 } }]));
    h.frames.fire();
    expect(idsTicks).toBe(1);
    expect(r1Ticks).toBe(1);
    expect(sub.store.ids()).not.toBe(idsBefore);
    expect([...sub.store.ids()].sort()).toEqual(['r1', 'r2', 'r3']);
    expect(sub.store.size()).toBe(3);
  });
});

describe('metrics', () => {
  it('coalesceRatio = updatesIn / updatesApplied under a burst; p95FlushMs populates', async () => {
    const clock = { t: 0, step: 0 };
    const h = makeHarness({
      now: () => {
        clock.t += clock.step;
        return clock.t;
      },
    });
    h.fetch.queueSnapshot(snap(CH, 0, []));
    const sub = h.client.subscribe(CH, { last: 'latest' });
    h.client.connect();
    const s = h.sockets.latest();
    s.open();
    await settle();

    // A 10-update burst against one record inside a single frame.
    for (let seq = 1; seq <= 10; seq++) {
      s.push(upd(CH, seq, [{ id: 'r1', fields: { last: seq } }]));
    }
    clock.step = 1; // give the flush a measurable duration
    h.frames.fire();
    clock.step = 0;

    expect(sub.store.get('r1')!.fields['last']).toBe(10);
    const m = h.client.getMetrics();
    expect(m.updatesIn).toBe(10);
    expect(m.updatesApplied).toBe(1); // one record write for ten updates
    expect(m.coalesceRatio).toBe(10);
    expect(m.framesFlushed).toBe(1);
    expect(m.p95FlushMs).toBeGreaterThan(0);
    expect(m.messagesIn).toBeGreaterThanOrEqual(10);
  });
});
