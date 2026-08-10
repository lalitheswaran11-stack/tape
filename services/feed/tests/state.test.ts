import { describe, it, expect } from 'vitest';
import { Generator } from '../src/generator';
import { TAPE_DEPTH } from '../src/state';

describe('state consistency', () => {
  it('absolute volume equals initial volume plus the sum of update deltas; seq equals message count', () => {
    const g = new Generator({ seed: 7, instruments: 40 });
    const initialVolumes = new Map<string, number>();
    for (const [sym, inst] of g.state.instruments) {
      initialVolumes.set(sym, inst.volume);
    }

    const N = 1000;
    const deltaSums = new Map<string, number>();
    let instrumentMsgs = 0;
    let tapeMsgs = 0;
    for (let i = 0; i < N; i++) {
      const msg = g.next();
      if (msg.channel === 'instruments') {
        instrumentMsgs++;
        for (const u of msg.updates) {
          const dv = u.fields['volume'] as number;
          deltaSums.set(u.id, (deltaSums.get(u.id) ?? 0) + dv);
        }
      } else {
        tapeMsgs++;
      }
    }

    expect(instrumentMsgs + tapeMsgs).toBe(N);
    expect(g.state.seq.instruments).toBe(instrumentMsgs);
    expect(g.state.seq.tape).toBe(tapeMsgs);

    for (const [sym, inst] of g.state.instruments) {
      const expected =
        (initialVolumes.get(sym) as number) + (deltaSums.get(sym) ?? 0);
      expect(inst.volume).toBe(expected);
    }
  });

  it('prices stay sane: bid < ask around last, change recomputed from open', () => {
    const g = new Generator({ seed: 11, instruments: 10 });
    for (let i = 0; i < 500; i++) g.next();
    for (const inst of g.state.instruments.values()) {
      expect(inst.bidC).toBeLessThan(inst.askC);
      expect(inst.bidC).toBeLessThanOrEqual(inst.lastC);
      expect(inst.askC).toBeGreaterThanOrEqual(inst.lastC);
      expect(inst.lastC).toBeGreaterThanOrEqual(Math.round(inst.openC * 0.5) - 1);
      expect(inst.lastC).toBeLessThanOrEqual(Math.round(inst.openC * 2) + 1);
      const expectedChange =
        Math.round(((inst.lastC - inst.openC) / inst.openC) * 10_000) / 100;
      expect(inst.change).toBe(expectedChange);
    }
  });

  it('tape keeps at most 256 entries and snapshot mirrors the newest trades', () => {
    const g = new Generator({ seed: 3, instruments: 5 });
    // Enough messages that tape (~10%) definitely exceeds 256 entries.
    for (let i = 0; i < 4000; i++) g.next();
    expect(g.state.trades.length).toBe(TAPE_DEPTH);
    const records = g.state.snapshotRecords('tape');
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.id).toBe('global');
    const trades = rec.fields['trades'] as unknown[];
    expect(trades).toHaveLength(TAPE_DEPTH);
    expect(trades[TAPE_DEPTH - 1]).toEqual(g.state.trades[TAPE_DEPTH - 1]);
  });

  it('instrument snapshots carry absolute values for every field', () => {
    const g = new Generator({ seed: 5, instruments: 8 });
    for (let i = 0; i < 200; i++) g.next();
    const records = g.state.snapshotRecords('instruments');
    expect(records).toHaveLength(8);
    for (const rec of records) {
      const inst = g.state.instruments.get(rec.id)!;
      expect(rec.fields).toEqual({
        symbol: inst.symbol,
        bid: inst.bidC / 100,
        ask: inst.askC / 100,
        last: inst.lastC / 100,
        open: inst.openC / 100,
        change: inst.change,
        volume: inst.volume,
      });
    }
  });
});
