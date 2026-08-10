import { describe, it, expect } from 'vitest';
import {
  startTestFeed,
  WsClient,
  waitUntil,
  getJson,
  type AnyMessage,
} from './helpers';

interface InstRecord {
  bid: number;
  ask: number;
  last: number;
  open: number;
  change: number;
  volume: number;
}

function recordMap(records: Array<{ id: string; fields: Record<string, unknown> }>): Map<string, InstRecord> {
  const map = new Map<string, InstRecord>();
  for (const r of records) {
    map.set(r.id, {
      bid: r.fields['bid'] as number,
      ask: r.fields['ask'] as number,
      last: r.fields['last'] as number,
      open: r.fields['open'] as number,
      change: r.fields['change'] as number,
      volume: r.fields['volume'] as number,
    });
  }
  return map;
}

describe('snapshot/stream coherence', () => {
  it('updates with seq > snapshot.seq apply cleanly on top of the snapshot', { timeout: 20_000 }, async () => {
    const t = await startTestFeed({ rate: 2000, instruments: 50 });
    try {
      const c = await WsClient.connect(t.wsUrl);
      const ack = await c.subscribe('instruments');
      const ackSeq = ack.seq as number;

      // Let the stream run, then snapshot mid-stream.
      await waitUntil(() => c.updates('instruments').length >= 20, 15_000, 'warmup updates');
      const snap1 = (await getJson(t.base, '/snapshot?channel=instruments')).body;
      expect(snap1.channel).toBe('instruments');
      expect(snap1.seq).toBeGreaterThanOrEqual(ackSeq);

      // Keep streaming past the snapshot, then take a second snapshot and
      // wait until we have collected every update up to snap2.seq.
      await waitUntil(
        () => c.updates('instruments').some((m) => (m.seq as number) >= snap1.seq + 30),
        15_000,
        'updates past snapshot1',
      );
      const snap2 = (await getJson(t.base, '/snapshot?channel=instruments')).body;
      expect(snap2.seq).toBeGreaterThan(snap1.seq);
      await waitUntil(
        () => c.updates('instruments').some((m) => (m.seq as number) >= snap2.seq),
        15_000,
        'updates covering snapshot2',
      );

      // Updates in (snap1.seq, snap2.seq] must be contiguous from snap1.seq + 1.
      const window = c
        .updates('instruments')
        .filter((m) => (m.seq as number) > snap1.seq && (m.seq as number) <= snap2.seq);
      const seqs = window.map((m) => m.seq as number);
      expect(seqs[0]).toBe(snap1.seq + 1);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBe((seqs[i - 1] as number) + 1);
      }
      expect(seqs[seqs.length - 1]).toBe(snap2.seq);

      // Applying those updates on top of snapshot1 reproduces snapshot2
      // exactly: absolute fields overwrite, volume accumulates deltas.
      const applied = recordMap(snap1.records);
      for (const m of window) {
        for (const u of (m as AnyMessage).updates!) {
          const rec = applied.get(u.id)!;
          expect(rec).toBeDefined();
          rec.bid = u.fields['bid'] as number;
          rec.ask = u.fields['ask'] as number;
          rec.last = u.fields['last'] as number;
          rec.open = u.fields['open'] as number;
          rec.change = u.fields['change'] as number;
          rec.volume += u.fields['volume'] as number;
        }
      }
      const expected = recordMap(snap2.records);
      expect(applied.size).toBe(expected.size);
      for (const [id, rec] of expected) {
        expect(applied.get(id), `record ${id}`).toEqual(rec);
      }

      await c.close();
    } finally {
      await t.close();
    }
  });
});
