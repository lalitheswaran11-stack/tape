/**
 * VirtualGrid — hand-rolled row virtualization with per-visible-row
 * subscriptions.
 *
 * The container measures its own height with ResizeObserver; a spacer div
 * carries the total height (ids.length * rowHeight); the visible window is
 * absolutely positioned via translateY.
 *
 * THE CRITICAL PROPERTY: each visible row is its own memoized component
 * that calls useRecord(stream, id) — a tick on one record re-renders only
 * that row, never the viewport. Scrolling changes only the window slice.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, UIEvent } from 'react';
import type {
  FieldValue,
  SequenceEntry,
  TapeRecord,
} from '@lalithesh-star/tape-core';
import type { Stream } from './stream';
import { useRecord } from './records';

export type CellValue = FieldValue | readonly SequenceEntry[] | undefined;

export interface ColumnDef {
  key: string;
  header: string;
  /** number → px flex-basis; string passed through. Omitted → flexes. */
  width?: number | string;
  align?: 'left' | 'right' | 'center';
  format?(value: CellValue, record: TapeRecord): ReactNode;
  cellClass?(value: CellValue, record: TapeRecord): string | undefined;
}

export interface VirtualGridProps {
  stream: Stream;
  /** The app owns filtering/sorting; the grid renders exactly this order. */
  ids: readonly string[];
  columns: readonly ColumnDef[];
  rowHeight?: number;
  overscan?: number;
  selectedId?: string;
  onRowClick?: (id: string) => void;
  className?: string;
  style?: CSSProperties;
}

// Module-level render counter so the HUD and tests can verify render
// granularity: it increments once per row-component render, nothing else.
let rowRenders = 0;

export function readRowRenderCount(): number {
  return rowRenders;
}

function defaultFormat(value: CellValue): ReactNode {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return String(value.length);
  return String(value);
}

function cellStyle(col: ColumnDef): CSSProperties {
  const width = col.width;
  return {
    flex:
      width === undefined
        ? '1 1 60px'
        : `0 0 ${typeof width === 'number' ? `${width}px` : width}`,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '0 8px',
    boxSizing: 'border-box',
    textAlign: col.align ?? 'left',
  };
}

interface GridRowProps {
  stream: Stream;
  id: string;
  index: number;
  columns: readonly ColumnDef[];
  rowHeight: number;
  selected: boolean;
  onRowClick?: (id: string) => void;
}

const GridRow = memo(function GridRow(props: GridRowProps) {
  rowRenders++;
  const { stream, id, index, columns, rowHeight, selected, onRowClick } = props;
  const record = useRecord(stream, id);
  return (
    <div
      role="row"
      data-tape-row={id}
      aria-selected={selected || undefined}
      onClick={onRowClick === undefined ? undefined : () => onRowClick(id)}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: rowHeight,
        transform: `translateY(${index * rowHeight}px)`,
        display: 'flex',
        alignItems: 'center',
        boxSizing: 'border-box',
        borderBottom: '1px solid var(--tape-border, #21262d)',
        background: selected
          ? 'var(--tape-selected, rgba(88,166,255,0.15))'
          : 'transparent',
        cursor: onRowClick === undefined ? undefined : 'pointer',
      }}
    >
      {columns.map((col) => {
        const value: CellValue = record?.fields[col.key];
        const cls =
          record === undefined ? undefined : col.cellClass?.(value, record);
        const content =
          record === undefined
            ? ''
            : col.format !== undefined
              ? col.format(value, record)
              : defaultFormat(value);
        return (
          <div key={col.key} role="gridcell" className={cls} style={cellStyle(col)}>
            {content}
          </div>
        );
      })}
    </div>
  );
});

export function VirtualGrid(props: VirtualGridProps) {
  const {
    stream,
    ids,
    columns,
    rowHeight = 28,
    overscan = 10,
    selectedId,
    onRowClick,
    className,
    style,
  } = props;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewHeight, setViewHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    const el = viewportRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const next = entry.contentRect.height;
        setViewHeight((prev) => (prev === next ? prev : next));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const total = ids.length * rowHeight;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(
    ids.length,
    Math.ceil((scrollTop + viewHeight) / rowHeight) + overscan,
  );

  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    const id = ids[i];
    if (id === undefined) break;
    rows.push(
      <GridRow
        key={id}
        stream={stream}
        id={id}
        index={i}
        columns={columns}
        rowHeight={rowHeight}
        selected={id === selectedId}
        onRowClick={onRowClick}
      />,
    );
  }

  return (
    <div
      role="grid"
      aria-rowcount={ids.length}
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        fontSize: 13,
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--tape-text, #c9d1d9)',
        background: 'var(--tape-bg, #0d1117)',
        ...style,
      }}
    >
      <div
        role="row"
        style={{
          display: 'flex',
          alignItems: 'center',
          height: rowHeight,
          flex: 'none',
          fontWeight: 600,
          color: 'var(--tape-text-dim, #8b949e)',
          borderBottom: '1px solid var(--tape-border, #21262d)',
          boxSizing: 'border-box',
        }}
      >
        {columns.map((col) => (
          <div key={col.key} role="columnheader" style={cellStyle(col)}>
            {col.header}
          </div>
        ))}
      </div>
      <div
        ref={viewportRef}
        onScroll={onScroll}
        data-tape-viewport=""
        style={{ position: 'relative', flex: 1, minHeight: 0, overflowY: 'auto' }}
      >
        <div style={{ position: 'relative', height: total }}>{rows}</div>
      </div>
    </div>
  );
}
