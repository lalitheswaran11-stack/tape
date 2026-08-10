/**
 * Monitor's domain schema. The platform stays generic (tape-core knows only
 * Fields); the consumer owns what the records mean. These are type ALIASES,
 * not interfaces, so they structurally satisfy tape-core's index-signature
 * Fields constraint at the useRecord<F> seam.
 */

/** One record on the 'instruments' channel; record id === symbol. */
export type InstrumentFields = {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  open: number;
  /** Percent vs open, e.g. 1.24 means +1.24%. */
  change: number;
  /** Cumulative volume (delta-encoded on the wire → 'accumulate'). */
  volume: number;
};

/** One print on the trade tape (a 'sequence' entry). */
export type TradeEntry = {
  sym: string;
  price: number;
  size: number;
  /** 'buy' | 'sell' on the wire. */
  side: string;
  ts: number;
};

/** The single 'global' record on the 'tape' channel. */
export type TapeFields = {
  trades: readonly TradeEntry[];
};
