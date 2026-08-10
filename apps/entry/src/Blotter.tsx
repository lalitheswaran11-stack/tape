/**
 * Blotter + reconciliation.
 *
 * Only WORKING orders hold live subscriptions: the row for a working
 * order is a component calling useRecord on its symbol, with an effect
 * that fills the order when the observed live last crosses the limit
 * (buy: last <= limit, sell: last >= limit) — at that observed last,
 * stamped with the record's data ts. The stream is the source of truth;
 * the optimistic 'working' state is reconciled against it. The moment an
 * order fills or is cancelled the Blotter swaps in a static row and the
 * per-record subscription closes with the unmounting component — settled
 * orders never tick.
 */

import { memo, useEffect, useState } from 'react';
import { useRecord } from '@lalithesh-star/tape-react';
import type { Stream } from '@lalithesh-star/tape-react';
import type { InstrumentFields, Order } from './types';
import { fmtPrice, fmtTime } from './format';
import { ConfirmDialog } from './ConfirmDialog';

export interface BlotterProps {
  stream: Stream;
  orders: readonly Order[];
  onFill: (id: string, price: number, ts: number) => void;
  onCancel: (id: string) => void;
}

export const Blotter = memo(function Blotter({
  stream,
  orders,
  onFill,
  onCancel,
}: BlotterProps) {
  const [cancelId, setCancelId] = useState<string | null>(null);

  // Resolve the dialog target from live state: if the order fills while
  // the dialog is open it stops being cancellable and the dialog closes.
  const target =
    cancelId === null
      ? null
      : (orders.find((o) => o.id === cancelId && o.status === 'working') ?? null);

  const workingCount = orders.reduce(
    (n, o) => (o.status === 'working' ? n + 1 : n),
    0,
  );

  return (
    <section className="panel blotter" aria-label="Order blotter">
      <header className="panel-header">
        <h2>Blotter</h2>
        <span className="panel-note">
          {orders.length} orders · {workingCount} working
        </span>
      </header>

      {orders.length === 0 ? (
        <p className="empty">
          No orders yet — build one in the ticket above. Orders persist across
          reloads and keep reconciling against the stream.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Symbol</th>
                <th>Side</th>
                <th className="num-h">Qty</th>
                <th className="num-h">Limit</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) =>
                o.status === 'working' ? (
                  <WorkingRow
                    key={o.id}
                    stream={stream}
                    order={o}
                    onFill={onFill}
                    onCancelClick={setCancelId}
                  />
                ) : (
                  <SettledRow key={o.id} order={o} />
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      {target !== null && (
        <ConfirmDialog
          order={target}
          onConfirm={() => {
            onCancel(target.id);
            setCancelId(null);
          }}
          onKeep={() => setCancelId(null)}
        />
      )}
    </section>
  );
});

interface WorkingRowProps {
  stream: Stream;
  order: Order;
  onFill: (id: string, price: number, ts: number) => void;
  onCancelClick: (id: string) => void;
}

const WorkingRow = memo(function WorkingRow({
  stream,
  order,
  onFill,
  onCancelClick,
}: WorkingRowProps) {
  const record = useRecord<InstrumentFields>(stream, order.symbol);

  // Reconciliation: runs on every tick of THIS record (that is the point —
  // each observation must be checked for a crossing). A rehydrated
  // 'working' order re-reconciles here on its first observed record after
  // reload. The fill transition itself is idempotent: App only applies it
  // to orders still 'working'.
  useEffect(() => {
    if (record === undefined) return;
    const last = record.fields.last;
    const crossed =
      order.side === 'buy' ? last <= order.limit : last >= order.limit;
    if (crossed) onFill(order.id, last, record.ts);
  }, [record, order.id, order.side, order.limit, onFill]);

  return (
    <tr>
      <td className="num dim">{fmtTime(order.createdAt)}</td>
      <td className="sym">{order.symbol}</td>
      <td className={order.side === 'buy' ? 'side up' : 'side down'}>
        {order.side.toUpperCase()}
      </td>
      <td className="num">{order.qty}</td>
      <td className="num">{fmtPrice(order.limit)}</td>
      <td>
        <span className="status status-working">working</span>
        <span className="num dim status-extra">
          {record === undefined
            ? 'awaiting data'
            : `last ${fmtPrice(record.fields.last)}`}
        </span>
      </td>
      <td className="actions">
        <button
          type="button"
          className="btn ghost danger"
          onClick={() => onCancelClick(order.id)}
        >
          Cancel
        </button>
      </td>
    </tr>
  );
});

const SettledRow = memo(function SettledRow({ order }: { order: Order }) {
  return (
    <tr className="settled">
      <td className="num dim">{fmtTime(order.createdAt)}</td>
      <td className="sym">{order.symbol}</td>
      <td className={order.side === 'buy' ? 'side up' : 'side down'}>
        {order.side.toUpperCase()}
      </td>
      <td className="num">{order.qty}</td>
      <td className="num">{fmtPrice(order.limit)}</td>
      <td>
        {order.status === 'filled' ? (
          <span
            className="status status-filled"
            title={
              order.fillTs === undefined
                ? undefined
                : `fill data ts ${fmtTime(order.fillTs)}`
            }
          >
            filled @ {order.fillPrice === undefined ? '—' : fmtPrice(order.fillPrice)}
          </span>
        ) : (
          <span className="status status-cancelled">cancelled</span>
        )}
      </td>
      <td className="actions" />
    </tr>
  );
});
