/**
 * The centerpiece: 10k instruments through VirtualGrid.
 *
 * Render economics: this component re-renders only when membership, the
 * filter query, or the selection changes — NEVER on value ticks. Value
 * ticks land in individual GridRow components via their per-record
 * subscriptions inside VirtualGrid. The filtered/sorted ids array is
 * memoized on [ids, query]; `ids` identity changes only on membership
 * change (useRecordIds contract), so the 10k-element scan runs on
 * membership/query change, not per tick.
 */

import { useMemo } from 'react';
import { useRecordIds, VirtualGrid } from '@lalithesh-star/tape-react';
import type { CellValue, ColumnDef, Stream } from '@lalithesh-star/tape-react';
import { formatPrice, formatSignedPct, formatVolume, trendClass } from './format';

function priceCell(v: CellValue) {
  return typeof v === 'number' ? formatPrice(v) : '';
}

/**
 * Module-level (stable identity) so memoized rows never see a new columns
 * prop. The `last` cell remounts a keyed span only when its DISPLAYED value
 * changes, restarting a one-shot CSS flash — no extra React renders, no JS
 * animation.
 */
const COLUMNS: ColumnDef[] = [
  { key: 'symbol', header: 'Symbol', width: 90, format: (_v, record) => record.id },
  {
    key: 'last',
    header: 'Last',
    align: 'right',
    format: (v) => {
      if (typeof v !== 'number') return '';
      const text = formatPrice(v);
      return (
        <span key={text} className="cell-flash">
          {text}
        </span>
      );
    },
  },
  { key: 'bid', header: 'Bid', align: 'right', format: priceCell },
  { key: 'ask', header: 'Ask', align: 'right', format: priceCell },
  {
    key: 'change',
    header: 'Chg%',
    align: 'right',
    width: 90,
    // Signed text is the carrier; the up/down tint is secondary encoding.
    format: (v) => (typeof v === 'number' ? formatSignedPct(v) : ''),
    cellClass: (v) => (typeof v === 'number' ? trendClass(v) : undefined),
  },
  {
    key: 'volume',
    header: 'Volume',
    align: 'right',
    width: 110,
    format: (v) => (typeof v === 'number' ? formatVolume(v) : ''),
  },
];

export interface InstrumentsGridProps {
  stream: Stream;
  query: string;
  selected: string;
  onSelect: (id: string) => void;
}

export function InstrumentsGrid({
  stream,
  query,
  selected,
  onSelect,
}: InstrumentsGridProps) {
  const ids = useRecordIds(stream);

  const visible = useMemo(() => {
    const q = query.trim().toUpperCase();
    const out =
      q === ''
        ? [...ids]
        : ids.filter((id) => id.toUpperCase().includes(q));
    out.sort();
    return out;
  }, [ids, query]);

  return (
    <section className="grid-pane">
      <div className="grid-body">
        {ids.length === 0 ? (
          // Honest empty state: before the first snapshot (or after a
          // resync to empty) there is nothing to show — never a stale grid.
          <div className="empty">
            Store is empty — waiting for the first snapshot.
          </div>
        ) : visible.length === 0 ? (
          <div className="empty">No symbols match &ldquo;{query}&rdquo;.</div>
        ) : (
          <VirtualGrid
            stream={stream}
            ids={visible}
            columns={COLUMNS}
            rowHeight={28}
            selectedId={selected === '' ? undefined : selected}
            onRowClick={onSelect}
          />
        )}
      </div>
      <div className="grid-status">
        {formatVolume(visible.length)} / {formatVolume(ids.length)} instruments
      </div>
    </section>
  );
}
