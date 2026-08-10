/**
 * App-owned domain types. The platform ships untyped Fields; the app
 * declares what an `instruments` record looks like and casts at the
 * useRecord generic.
 */

/** Client-side view of one record on the `instruments` channel. */
export type InstrumentFields = {
  readonly bid: number;
  readonly ask: number;
  readonly last: number;
  readonly open: number;
  /** Percent change vs open, e.g. 1.23 means +1.23%. */
  readonly change: number;
  /** Running total (consumed with the `accumulate` policy). */
  readonly volume: number;
};

export type OrderSide = 'buy' | 'sell';

export type OrderStatus = 'working' | 'filled' | 'cancelled';

/**
 * A local order. Created optimistically with status 'working' — there is
 * no server ack. 'working' orders are reconciled against the live stream:
 * they fill when the observed last crosses the limit, at that observed
 * last, stamped with the record's data timestamp.
 */
export interface Order {
  readonly id: string;
  /** Wall-clock ms when the order was placed locally. */
  readonly createdAt: number;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly qty: number;
  readonly limit: number;
  readonly status: OrderStatus;
  /** The live `last` observed at the moment of the fill. */
  readonly fillPrice?: number;
  /** The record's data timestamp at the moment of the fill. */
  readonly fillTs?: number;
}
