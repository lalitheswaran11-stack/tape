/**
 * Trade tape: the 'global' record's bounded trades ring (sequence policy,
 * capacity 512), newest first, capped at ~40 visible rows. This component
 * re-renders once per flush of ONE record — bounded work, never scaling
 * with the instrument universe. Rows are keyed by the entry's data
 * timestamp (unique per print), so unchanged rows reconcile cheaply.
 */

import type { ReactNode } from 'react';
import { useRecord } from '@lalithesh-star/tape-react';
import type { Stream } from '@lalithesh-star/tape-react';
import type { TapeFields } from './types';
import { formatPrice, formatTime } from './format';

const VISIBLE_ROWS = 40;

export interface TapePanelProps {
  stream: Stream;
  selected: string;
}

export function TapePanel({ stream, selected }: TapePanelProps) {
  const record = useRecord<TapeFields>(stream, 'global');
  const trades = record?.fields.trades;

  let body: ReactNode;
  if (trades === undefined || trades.length === 0) {
    body = <div className="empty">No trades yet.</div>;
  } else {
    const recent = trades.slice(-VISIBLE_ROWS).reverse();
    body = recent.map((t) => {
      const buy = t.side === 'buy';
      return (
        <div
          key={t.ts}
          className={t.sym === selected ? 'tape-row sel' : 'tape-row'}
        >
          <span className="tape-time">{formatTime(t.ts)}</span>
          <span className="tape-sym">{t.sym}</span>
          <span className="tape-price">{formatPrice(t.price)}</span>
          <span className="tape-size">{t.size}</span>
          {/* The WORD is the carrier; the tint is secondary. */}
          <span className={`tape-side ${buy ? 'up' : 'down'}`}>
            {buy ? 'BUY' : 'SELL'}
          </span>
        </div>
      );
    });
  }

  return (
    <section className="tape">
      <header className="panel-header">Trade tape</header>
      <div className="tape-list">{body}</div>
    </section>
  );
}
