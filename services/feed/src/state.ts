/**
 * Authoritative in-memory feed state. Every generated update is applied here
 * at generation time (see generator.ts), so a snapshot stamped with the
 * current per-channel seq is always consistent with the update stream —
 * Node is single-threaded and nothing awaits between generate, apply, and
 * snapshot stamping.
 *
 * Prices are stored internally as integer cents to keep the bounded random
 * walk free of float drift; they are converted to dollars at the wire edge.
 */

import type {
  SnapshotRecord,
  SequenceEntry,
} from '@lalithesh-star/tape-core/protocol';

export const CHANNELS = ['instruments', 'tape'] as const;
export type Channel = (typeof CHANNELS)[number];

export function isChannel(x: unknown): x is Channel {
  return x === 'instruments' || x === 'tape';
}

/** Depth of the trade tape kept for snapshots. */
export const TAPE_DEPTH = 256;

/** Fixed start of the synthetic data-clock: 2026-01-01T00:00:00Z. */
export const DATA_EPOCH = 1_767_225_600_000;
/** Data-clock milliseconds per message index. */
export const DATA_STEP_MS = 1;

export interface InstrumentState {
  symbol: string;
  /** All *C fields are integer cents. */
  openC: number;
  lastC: number;
  bidC: number;
  askC: number;
  /** Percent vs open, rounded to 2 decimals. */
  change: number;
  /** Absolute cumulative volume. */
  volume: number;
  /** Data timestamp of the last applied update. */
  ts: number;
}

/**
 * One tape entry. A type alias (not an interface) so it structurally
 * satisfies the protocol's SequenceEntry index signature.
 */
export type TradeEntry = {
  sym: string;
  price: number;
  size: number;
  side: 'buy' | 'sell';
  ts: number;
};

/** Integer cents to dollars. Exact for 2-decimal prices. */
export function centsToPrice(c: number): number {
  return c / 100;
}

export class FeedState {
  readonly instruments = new Map<string, InstrumentState>();
  /** Symbols in deterministic creation order, for indexed picks. */
  readonly symbols: string[] = [];
  /** Most recent trades, capped at TAPE_DEPTH. */
  readonly trades: TradeEntry[] = [];
  /** Per-channel seq of the last applied update. Starts at 0; first update is 1. */
  readonly seq: Record<Channel, number> = { instruments: 0, tape: 0 };
  /** Data timestamp of the last applied tape update. */
  tapeTs = DATA_EPOCH;

  pushTrade(entry: TradeEntry): void {
    this.trades.push(entry);
    if (this.trades.length > TAPE_DEPTH) this.trades.shift();
    this.tapeTs = entry.ts;
  }

  /** Full record set for a channel, with absolute values for every field. */
  snapshotRecords(channel: Channel): SnapshotRecord[] {
    if (channel === 'instruments') {
      return this.symbols.map((sym) => {
        const s = this.instruments.get(sym) as InstrumentState;
        return {
          id: s.symbol,
          fields: {
            symbol: s.symbol,
            bid: centsToPrice(s.bidC),
            ask: centsToPrice(s.askC),
            last: centsToPrice(s.lastC),
            open: centsToPrice(s.openC),
            change: s.change,
            volume: s.volume,
          },
          ts: s.ts,
        };
      });
    }
    const entries: SequenceEntry[] = this.trades.map((t) => ({ ...t }));
    return [{ id: 'global', fields: { trades: entries }, ts: this.tapeTs }];
  }
}
