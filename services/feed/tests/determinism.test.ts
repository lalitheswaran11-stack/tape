import { describe, it, expect } from 'vitest';
import { Generator, DATA_EPOCH, DATA_STEP_MS } from '../src/generator';

describe('determinism', () => {
  it('same seed yields byte-identical first 500 messages across independent instances', () => {
    const a = new Generator({ seed: 42, instruments: 25 });
    const b = new Generator({ seed: 42, instruments: 25 });
    const msgsA = Array.from({ length: 500 }, () => a.next());
    const msgsB = Array.from({ length: 500 }, () => b.next());
    expect(msgsA).toEqual(msgsB);
    expect(JSON.stringify(msgsA)).toBe(JSON.stringify(msgsB));
  });

  it('a different seed produces a different sequence', () => {
    const a = new Generator({ seed: 42, instruments: 25 });
    const c = new Generator({ seed: 43, instruments: 25 });
    const msgsA = Array.from({ length: 500 }, () => a.next());
    const msgsC = Array.from({ length: 500 }, () => c.next());
    expect(JSON.stringify(msgsA)).not.toBe(JSON.stringify(msgsC));
  });

  it('the same seed also yields an identical instrument universe', () => {
    const a = new Generator({ seed: 7, instruments: 100 });
    const b = new Generator({ seed: 7, instruments: 100 });
    expect(a.state.symbols).toEqual(b.state.symbols);
    expect([...a.state.instruments.values()]).toEqual([
      ...b.state.instruments.values(),
    ]);
  });

  it('timestamps come from the synthetic data-clock, not the wall clock', () => {
    const g = new Generator({ seed: 42, instruments: 25 });
    for (let i = 0; i < 50; i++) {
      const msg = g.next();
      const expected = DATA_EPOCH + i * DATA_STEP_MS;
      for (const u of msg.updates) expect(u.ts).toBe(expected);
    }
  });

  it('roughly 90/10 instruments/tape interleave, deterministic from the seed', () => {
    const g = new Generator({ seed: 42, instruments: 25 });
    let tape = 0;
    const total = 2000;
    for (let i = 0; i < total; i++) {
      if (g.next().channel === 'tape') tape++;
    }
    const ratio = tape / total;
    expect(ratio).toBeGreaterThan(0.05);
    expect(ratio).toBeLessThan(0.15);
  });
});
