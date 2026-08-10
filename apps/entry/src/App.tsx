/**
 * Tape Entry — order entry against the live instruments stream.
 *
 * One stream for the whole app: useStream + useCoalesced live here and the
 * Stream handle is passed down, so a single channel policy exists no
 * matter how many rows subscribe through it. `volume` is a running total
 * (deltas must sum — accumulate); every other field is current-state and
 * takes the default `latest`.
 *
 * Orders are the app's own optimistic state: placed locally as 'working'
 * with no server ack, persisted in localStorage, and reconciled against
 * the stream by per-order components in the Blotter. The fill/cancel
 * transitions below only apply to orders still 'working', which makes
 * reconciliation idempotent under strict-mode double effects and
 * fill-vs-cancel races.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConnectionBanner, useConnectionState, useRecordIds, useSubscription } from '@lalithesh-star/tape-react';
import { client } from './client';
import type { Order, OrderSide } from './types';
import { loadOrders, saveOrders } from './storage';
import { Watchlist } from './Watchlist';
import { OrderTicket } from './OrderTicket';
import { Blotter } from './Blotter';

const SYMBOL_DATALIST_ID = 'instrument-symbols';
const DATALIST_CAP = 200;

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ord-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function App() {
  const stream = useSubscription(client, {
    channel: 'instruments',

    policy: {
      volume: 'accumulate'
    }
  });

  const connectionState = useConnectionState(client);
  const formsEnabled =
    connectionState === 'live' || connectionState === 'resyncing';
  const disabledReason = formsEnabled ? null : `connection is ${connectionState}`;

  // Membership-keyed derivations: the ids array identity changes only when
  // records are added or removed, never on value ticks — so these memos
  // recompute on membership changes only.
  const ids = useRecordIds(stream);
  const knownSymbols = useMemo(() => new Set(ids), [ids]);
  const datalist = useMemo(
    () => (
      <datalist id={SYMBOL_DATALIST_ID}>
        {ids.slice(0, DATALIST_CAP).map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    ),
    [ids],
  );

  const [orders, setOrders] = useState<Order[]>(loadOrders);
  useEffect(() => {
    saveOrders(orders);
  }, [orders]);

  // The optimistic write: the order exists the instant the user submits.
  const placeOrder = useCallback(
    (symbol: string, side: OrderSide, qty: number, limit: number) => {
      const order: Order = {
        id: makeId(),
        createdAt: Date.now(),
        symbol,
        side,
        qty,
        limit,
        status: 'working',
      };
      setOrders((prev) => [order, ...prev]);
    },
    [],
  );

  const fillOrder = useCallback((id: string, price: number, ts: number) => {
    setOrders((prev) =>
      prev.map(
        (o): Order =>
          o.id === id && o.status === 'working'
            ? { ...o, status: 'filled', fillPrice: price, fillTs: ts }
            : o,
      ),
    );
  }, []);

  const cancelOrder = useCallback((id: string) => {
    setOrders((prev) =>
      prev.map(
        (o): Order =>
          o.id === id && o.status === 'working'
            ? { ...o, status: 'cancelled' }
            : o,
      ),
    );
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Tape Entry</h1>
        <span className="app-subtitle">order entry / blotter</span>
        <ConnectionBanner client={client} className="banner" />
      </header>
      {datalist}
      <main className="columns">
        <Watchlist
          stream={stream}
          knownSymbols={knownSymbols}
          datalistId={SYMBOL_DATALIST_ID}
          disabledReason={disabledReason}
        />
        <div className="right-col">
          <OrderTicket
            stream={stream}
            knownSymbols={knownSymbols}
            datalistId={SYMBOL_DATALIST_ID}
            disabledReason={disabledReason}
            onPlace={placeOrder}
          />
          <Blotter
            stream={stream}
            orders={orders}
            onFill={fillOrder}
            onCancel={cancelOrder}
          />
        </div>
      </main>
    </div>
  );
}
