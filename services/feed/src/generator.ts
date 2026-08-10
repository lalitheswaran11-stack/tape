/**
 * Deterministic market-data generator.
 *
 * Everything — the instrument universe, every price step, message
 * composition, channel interleave — is drawn from a single seeded PRNG,
 * so content is a pure function of (seed, message index). Data timestamps
 * come from a synthetic data-clock (DATA_EPOCH + index * DATA_STEP_MS),
 * never Date.now(), so the byte sequence is identical run to run no matter
 * how delivery is paced.
 *
 * next() both builds the UpdateMessage and applies it to the authoritative
 * FeedState in the same synchronous step, bumping that channel's seq by
 * exactly 1.
 */

import type { UpdateMessage, RecordUpdate } from '@lalithesh-star/tape-core/protocol';
import { mulberry32, randInt, type Rng } from './prng';
import {
  FeedState,
  DATA_EPOCH,
  DATA_STEP_MS,
  centsToPrice,
  type InstrumentState,
  type TradeEntry,
} from './state';

export { DATA_EPOCH, DATA_STEP_MS };

export interface GeneratorOptions {
  seed: number;
  instruments: number;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function genSymbol(rng: Rng): string {
  const len = randInt(rng, 3, 5);
  let s = '';
  for (let i = 0; i < len; i++) s += LETTERS[randInt(rng, 0, 25)];
  return s;
}

function buildUniverse(rng: Rng, count: number): FeedState {
  const state = new FeedState();
  for (let i = 0; i < count; i++) {
    let sym = genSymbol(rng);
    while (state.instruments.has(sym)) sym = genSymbol(rng);
    const openC = randInt(rng, 500, 50_000); // $5.00 – $500.00
    const spreadC = Math.max(1, Math.round(openC * 0.0008));
    const inst: InstrumentState = {
      symbol: sym,
      openC,
      lastC: openC,
      bidC: Math.max(1, openC - spreadC),
      askC: openC + spreadC,
      change: 0,
      volume: randInt(rng, 0, 1_000_000),
      ts: DATA_EPOCH,
    };
    state.instruments.set(sym, inst);
    state.symbols.push(sym);
  }
  return state;
}

export class Generator {
  readonly state: FeedState;
  private readonly rng: Rng;
  private index = 0;

  constructor(opts: GeneratorOptions) {
    this.rng = mulberry32(opts.seed);
    this.state = buildUniverse(this.rng, Math.max(0, opts.instruments));
  }

  /** Global message index (count of messages generated so far). */
  get messageIndex(): number {
    return this.index;
  }

  /** Generate the next update message and apply it to state. */
  next(): UpdateMessage {
    const ts = DATA_EPOCH + this.index * DATA_STEP_MS;
    this.index++;
    const msg =
      this.rng() < 0.9 ? this.nextInstruments(ts) : this.nextTape(ts);
    return msg;
  }

  private pickInstrument(): InstrumentState {
    const idx = Math.floor(this.rng() * this.state.symbols.length);
    const sym = this.state.symbols[idx] as string;
    return this.state.instruments.get(sym) as InstrumentState;
  }

  private nextInstruments(ts: number): UpdateMessage {
    const n = randInt(this.rng, 1, 8);
    const updates: RecordUpdate[] = [];
    for (let i = 0; i < n; i++) {
      const inst = this.pickInstrument();
      // Bounded random walk in integer cents: step up to ±0.4% of last,
      // clamped to [open/2, open*2] so values stay sane forever.
      const pct = (this.rng() * 2 - 1) * 0.004;
      let lastC = inst.lastC + Math.round(inst.lastC * pct);
      const lo = Math.max(1, Math.round(inst.openC * 0.5));
      const hi = Math.round(inst.openC * 2);
      if (lastC < lo) lastC = lo;
      if (lastC > hi) lastC = hi;
      const spreadC = Math.max(1, Math.round(lastC * 0.0008 * (0.5 + this.rng())));
      const dv = randInt(this.rng, 1, 1000);
      // Apply to authoritative state...
      inst.lastC = lastC;
      inst.bidC = Math.max(1, lastC - spreadC);
      inst.askC = lastC + spreadC;
      inst.change = Math.round(((lastC - inst.openC) / inst.openC) * 10_000) / 100;
      inst.volume += dv;
      inst.ts = ts;
      // ...and mirror the same values on the wire. Volume is the DELTA.
      updates.push({
        id: inst.symbol,
        fields: {
          bid: centsToPrice(inst.bidC),
          ask: centsToPrice(inst.askC),
          last: centsToPrice(inst.lastC),
          open: centsToPrice(inst.openC),
          change: inst.change,
          volume: dv,
        },
        ts,
      });
    }
    const seq = ++this.state.seq.instruments;
    return { type: 'update', channel: 'instruments', seq, updates };
  }

  private nextTape(ts: number): UpdateMessage {
    const inst = this.pickInstrument();
    const priceC = Math.max(1, inst.lastC + randInt(this.rng, -5, 5));
    const entry: TradeEntry = {
      sym: inst.symbol,
      price: centsToPrice(priceC),
      size: randInt(this.rng, 1, 500),
      side: this.rng() < 0.5 ? 'buy' : 'sell',
      ts,
    };
    this.state.pushTrade(entry);
    const seq = ++this.state.seq.tape;
    return {
      type: 'update',
      channel: 'tape',
      seq,
      updates: [{ id: 'global', fields: { trades: entry }, ts }],
    };
  }
}
