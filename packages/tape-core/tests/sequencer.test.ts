import { describe, expect, it } from 'vitest';
import type { GapEvent, Subscription } from '../src/types';
import { makeHarness, settle, snap, upd } from './helpers';

const CH = 'tape';
const POLICY = { last: 'latest', trail: 'sequence' } as const;

async function syncAt(seq: number) {
  const h = makeHarness();
  h.fetch.queueSnapshot(
    snap(CH, seq, [{ id: 'r1', fields: { last: 0, trail: [] } }]),
  );
  const sub = h.client.subscribe(CH, POLICY);
  h.client.connect();
  const s = h.sockets.latest();
  s.open();
  await settle();
  expect(h.client.getState()).toBe('live');
  return { h, s, sub };
}

function trailOf(sub: Subscription): number[] {
  const trail = sub.store.get('r1')?.fields['trail'] as ReadonlyArray<{
    n: number;
  }>;
  return trail.map((e) => e.n);
}

describe('sequencer', () => {
  it('drops duplicates and stale seqs', async () => {
    const { h, s, sub } = await syncAt(10);
    s.push(upd(CH, 10, [{ id: 'r1', fields: { last: -1 } }])); // stale: == baseline
    s.push(upd(CH, 11, [{ id: 'r1', fields: { last: 11 } }])); // delivered
    s.push(upd(CH, 11, [{ id: 'r1', fields: { last: -2 } }])); // duplicate
    s.push(upd(CH, 5, [{ id: 'r1', fields: { last: -3 } }])); // ancient
    h.frames.fire();
    expect(sub.store.get('r1')!.fields['last']).toBe(11);
    expect(h.client.getMetrics().staleDropped).toBe(3);
  });

  it('heals out-of-order arrivals within the window, in order', async () => {
    const { h, s, sub } = await syncAt(10);
    s.push(upd(CH, 11, [{ id: 'r1', fields: { last: 11, trail: { n: 11 } } }]));
    // 13 and 14 arrive before 12: held back.
    s.push(upd(CH, 13, [{ id: 'r1', fields: { last: 13, trail: { n: 13 } } }]));
    s.push(upd(CH, 14, [{ id: 'r1', fields: { last: 14, trail: { n: 14 } } }]));
    h.frames.fire();
    // Only seq 11 has been applied — 13/14 are held awaiting 12.
    expect(sub.store.get('r1')!.fields['last']).toBe(11);
    expect(trailOf(sub)).toEqual([11]);

    s.push(upd(CH, 12, [{ id: 'r1', fields: { last: 12, trail: { n: 12 } } }]));
    h.frames.fire();
    expect(sub.store.get('r1')!.fields['last']).toBe(14);
    expect(trailOf(sub)).toEqual([11, 12, 13, 14]); // strict arrival order
    expect(h.client.getMetrics().reordersHealed).toBe(2);
    expect(h.client.getMetrics().gapsDetected).toBe(0);

    // No regression: a late replay of an older seq never rolls values back.
    s.push(upd(CH, 12, [{ id: 'r1', fields: { last: 999 } }]));
    h.frames.fire();
    expect(sub.store.get('r1')!.fields['last']).toBe(14);
  });

  it('declares a gap after the holdback timeout and resyncs the channel', async () => {
    const { h, s, sub } = await syncAt(10);
    const gaps: GapEvent[] = [];
    h.client.onGap((g) => gaps.push(g));
    s.push(upd(CH, 11, [{ id: 'r1', fields: { last: 11 } }]));
    h.frames.fire();
    s.push(upd(CH, 13, [{ id: 'r1', fields: { last: 13 } }])); // 12 missing
    h.timers.advance(250); // holdback timeout expires
    expect(gaps).toEqual([{ channel: CH, expected: 12, received: 13 }]);
    expect(h.client.getMetrics().gapsDetected).toBe(1);
    expect(h.client.getState()).toBe('resyncing');
    expect(h.fetch.calls.length).toBe(2); // initial + gap resync

    // Nothing was queued for the resync fetch, so it failed; the client
    // schedules a retry. Queue the snapshot, let the failure land, retry.
    h.fetch.queueSnapshot(
      snap(CH, 20, [{ id: 'r1', fields: { last: 20, trail: [] } }]),
    );
    await settle(); // failed fetch settles; retry timer scheduled
    h.timers.advance(250); // fire the retry
    await settle();
    expect(h.fetch.calls.length).toBe(3);
    expect(h.client.getState()).toBe('live');
    expect(sub.store.get('r1')!.fields['last']).toBe(20);
  });

  it('declares a gap immediately when the reorder window overflows', async () => {
    const { h, s } = await syncAt(0);
    const gaps: GapEvent[] = [];
    h.client.onGap((g) => gaps.push(g));
    // seq 1 never arrives; the window holds 16 messages.
    for (let seq = 2; seq <= 18; seq++) {
      s.push(upd(CH, seq, [{ id: 'r1', fields: { last: seq } }]));
    }
    expect(gaps).toEqual([{ channel: CH, expected: 1, received: 2 }]);
    expect(h.client.getMetrics().gapsDetected).toBe(1);
    expect(h.client.getState()).toBe('resyncing');
  });
});
