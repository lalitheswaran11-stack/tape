/**
 * Detail panel for the selected instrument: CanvasChart of 'last' plus a
 * stat block from useRecord. Re-renders only when THIS record flushes; the
 * chart draws on its own rAF and never touches the DOM per tick.
 */

import { CanvasChart, useRecord } from '@lalithesh-star/tape-react';
import type { Stream } from '@lalithesh-star/tape-react';
import type { InstrumentFields } from './types';
import { formatPrice, formatSignedPct, formatVolume, trendClass } from './format';

export interface DetailPanelProps {
  stream: Stream;
  symbol: string;
}

export function DetailPanel({ stream, symbol }: DetailPanelProps) {
  // The seam where the generic platform meets the app's schema.
  const record = useRecord<InstrumentFields>(stream, symbol);
  const f = record?.fields;

  return (
    <section className="detail">
      <header className="panel-header">{symbol} · last</header>
      <CanvasChart
        stream={stream}
        recordId={symbol}
        field="last"
        height={170}
      />
      {f === undefined ? (
        <div className="empty detail-empty">No data for {symbol} yet.</div>
      ) : (
        <dl className="stats">
          <dt>Last</dt>
          <dd>{formatPrice(f.last)}</dd>
          <dt>Bid</dt>
          <dd>{formatPrice(f.bid)}</dd>
          <dt>Ask</dt>
          <dd>{formatPrice(f.ask)}</dd>
          <dt>Spread</dt>
          <dd>{formatPrice(f.ask - f.bid)}</dd>
          <dt>Open</dt>
          <dd>{formatPrice(f.open)}</dd>
          <dt>Change</dt>
          {/* Sign in the text is primary; tint is secondary. */}
          <dd className={trendClass(f.change)}>{formatSignedPct(f.change)}</dd>
          <dt>Volume</dt>
          <dd>{formatVolume(f.volume)}</dd>
        </dl>
      )}
    </section>
  );
}
