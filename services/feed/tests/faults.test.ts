import { describe, it, expect } from 'vitest';
import { FaultController, type WireItem } from '../src/faults';
import {
  startTestFeed,
  WsClient,
  waitUntil,
  sleep,
  getJson,
  postJson,
  isContiguous,
} from './helpers';

describe('fault: reorder (unit)', () => {
  it('emits the same message set, windows shuffled, then returns to passthrough', () => {
    const f = new FaultController(42);
    f.startReorder(4, 12);
    const inputs: WireItem[] = Array.from({ length: 12 }, (_, i) => ({
      channel: 'instruments',
      wire: String(i + 1),
    }));
    const out: WireItem[] = [];
    for (const item of inputs) out.push(...f.pipe(item));

    // Nothing lost, nothing duplicated.
    expect(out).toHaveLength(12);
    expect(out.map((i) => i.wire).sort()).toEqual(inputs.map((i) => i.wire).sort());
    // Seeded shuffle actually changed the order (deterministic for seed 42).
    expect(out.map((i) => i.wire)).not.toEqual(inputs.map((i) => i.wire));
    // Windows stay intact: each window of 4 holds the same 4 messages.
    for (let w = 0; w < 3; w++) {
      const windowWires = out.slice(w * 4, w * 4 + 4).map((i) => Number(i.wire));
      expect(windowWires.sort((a, b) => a - b)).toEqual([1, 2, 3, 4].map((x) => x + w * 4));
    }
    // Run complete: back to passthrough, in order.
    const after = f.pipe({ channel: 'instruments', wire: 'next' });
    expect(after).toEqual([{ channel: 'instruments', wire: 'next' }]);
  });

  it('flushes a partial final window when count is not a multiple of window', () => {
    const f = new FaultController(1);
    f.startReorder(8, 10);
    const out: WireItem[] = [];
    for (let i = 0; i < 10; i++) {
      out.push(...f.pipe({ channel: 'tape', wire: String(i) }));
    }
    expect(out).toHaveLength(10);
    expect(out.map((i) => i.wire).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i)).sort(),
    );
  });
});

describe('fault: gap', () => {
  it('advances seq by exactly skip without transmitting; snapshot reflects the skipped data', { timeout: 15_000 }, async () => {
    // rate 0: the paced loop generates nothing, so the gap is the only
    // source of updates and the seq arithmetic is exact.
    const t = await startTestFeed({ rate: 0, instruments: 20 });
    try {
      const c = await WsClient.connect(t.wsUrl);
      await c.subscribe('instruments');
      await c.subscribe('tape');

      const before = (await getJson(t.base, '/info')).body;
      const snapBefore = (await getJson(t.base, '/snapshot?channel=instruments')).body;
      const volBefore = snapBefore.records.reduce(
        (s: number, r: { fields: { volume: number } }) => s + r.fields.volume,
        0,
      );

      const res = await postJson(t.base, '/fault/gap', { skip: 100 });
      expect(res.status).toBe(200);
      expect(res.body.gap.totalSkipped).toBe(100);

      const after = (await getJson(t.base, '/info')).body;
      const advanced =
        after.channels.instruments - before.channels.instruments +
        (after.channels.tape - before.channels.tape);
      expect(advanced).toBe(100);

      // Snapshot reflects the skipped updates (volume only ever grows).
      const snapAfter = (await getJson(t.base, '/snapshot?channel=instruments')).body;
      expect(snapAfter.seq).toBe(after.channels.instruments);
      const volAfter = snapAfter.records.reduce(
        (s: number, r: { fields: { volume: number } }) => s + r.fields.volume,
        0,
      );
      expect(volAfter).toBeGreaterThan(volBefore);

      // Nothing was transmitted: clients saw no update messages at all.
      await sleep(150);
      expect(c.updates('instruments')).toHaveLength(0);
      expect(c.updates('tape')).toHaveLength(0);

      await c.close();
    } finally {
      await t.close();
    }
  });
});

describe('fault: drop', () => {
  it('hard-terminates every socket; the client sees close without asking', { timeout: 15_000 }, async () => {
    const t = await startTestFeed({ rate: 500, instruments: 20 });
    try {
      const c1 = await WsClient.connect(t.wsUrl);
      const c2 = await WsClient.connect(t.wsUrl);
      await c1.subscribe('instruments');

      const res = await postJson(t.base, '/fault/drop');
      expect(res.status).toBe(200);
      expect(res.body.drop.count).toBe(1);

      await c1.closed;
      await c2.closed;
    } finally {
      await t.close();
    }
  });
});

describe('fault: reorder (integration)', () => {
  it('delivers the same seq set out of order, then recovers to strict order', { timeout: 20_000 }, async () => {
    const t = await startTestFeed({ rate: 2000, instruments: 30 });
    try {
      const c = await WsClient.connect(t.wsUrl);
      await c.subscribe('instruments');
      await c.subscribe('tape');
      await waitUntil(() => c.updates('instruments').length >= 5, 10_000, 'stream warmup');

      const res = await postJson(t.base, '/fault/reorder', { window: 6, count: 36 });
      expect(res.status).toBe(200);

      // Collect well past the reorder run.
      const targetLen = c.updates('instruments').length + 80;
      await waitUntil(
        () => c.updates('instruments').length >= targetLen,
        15_000,
        'post-reorder updates',
      );

      const seqs = c.updates('instruments').map((m) => m.seq as number);
      // Same seq set: sorted, the sequence is contiguous — nothing lost or duplicated.
      const sorted = [...seqs].sort((a, b) => a - b);
      expect(new Set(sorted).size).toBe(sorted.length);
      expect(isContiguous(sorted)).toBe(true);
      // Different order: at least one inversion was observed in arrival order.
      const inversions = seqs.filter((s, i) => i > 0 && s < (seqs[i - 1] as number));
      expect(inversions.length).toBeGreaterThan(0);
      // Recovered: the tail is strictly ordered again and the run is over.
      const tail = seqs.slice(-30);
      expect(isContiguous(tail)).toBe(true);
      const fault = (await getJson(t.base, '/fault')).body;
      expect(fault.reorder.active).toBe(false);

      await c.close();
    } finally {
      await t.close();
    }
  });
});

describe('fault: stall', () => {
  it('goes quiet for the window and resumes with contiguous seq and no catch-up burst', { timeout: 20_000 }, async () => {
    const t = await startTestFeed({ rate: 1000, instruments: 20 });
    try {
      const c = await WsClient.connect(t.wsUrl);
      const ack = await c.subscribe('instruments');
      await waitUntil(() => c.updates('instruments').length >= 5, 10_000, 'stream warmup');

      const res = await postJson(t.base, '/fault/stall', { ms: 800 });
      expect(res.status).toBe(200);
      expect(res.body.stall.active).toBe(true);

      // Let in-flight messages drain, then measure the quiet window.
      await sleep(250);
      const quietStart = c.messages.length;
      await sleep(350);
      const arrivedDuringStall = c.messages.length - quietStart;
      expect(arrivedDuringStall).toBeLessThanOrEqual(2); // generous

      // Resumes and stays contiguous across the stall.
      const countAtResume = c.updates('instruments').length;
      await waitUntil(
        () => c.updates('instruments').length >= countAtResume + 10,
        10_000,
        'resume after stall',
      );
      const seqs = c.updates('instruments').map((m) => m.seq as number);
      expect(seqs[0]).toBe((ack.seq as number) + 1);
      expect(isContiguous(seqs)).toBe(true); // arrival order IS seq order — no gap, no reorder

      await c.close();
    } finally {
      await t.close();
    }
  });
});

describe('fault: burst', () => {
  it('reports an active burst and keeps seqs contiguous throughout', { timeout: 15_000 }, async () => {
    const t = await startTestFeed({ rate: 500, instruments: 20 });
    try {
      const c = await WsClient.connect(t.wsUrl);
      await c.subscribe('instruments');
      await waitUntil(() => c.updates('instruments').length >= 3, 10_000, 'warmup');

      const res = await postJson(t.base, '/fault/burst', { factor: 5, ms: 400 });
      expect(res.status).toBe(200);
      expect(res.body.burst.active).toBe(true);
      expect(res.body.burst.factor).toBe(5);

      const before = c.updates('instruments').length;
      await waitUntil(
        () => c.updates('instruments').length >= before + 30,
        10_000,
        'burst updates',
      );
      const seqs = c.updates('instruments').map((m) => m.seq as number);
      expect(isContiguous(seqs)).toBe(true);

      await sleep(500);
      const after = (await getJson(t.base, '/fault')).body;
      expect(after.burst.active).toBe(false);

      await c.close();
    } finally {
      await t.close();
    }
  });
});
