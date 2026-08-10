/**
 * VirtualGrid: windowed DOM, scroll moves the window, row clicks, and
 * per-visible-row render granularity via readRowRenderCount.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TapeClient } from '@lalithesh-star/tape-core';
import { readRowRenderCount, useSubscription, VirtualGrid } from '../src';
import type { ColumnDef } from '../src';
import {
  makeHarness,
  setObservedSize,
  setScrollTop,
  settle,
  snap,
  upd,
} from './helpers';
import type { Harness } from './helpers';

afterEach(cleanup);

const columns: ColumnDef[] = [
  { key: 'last', header: 'Last', align: 'right' },
  { key: 'volume', header: 'Vol', width: 80 },
];

const IDS = Array.from({ length: 10000 }, (_, i) => `r${i}`);

function GridApp({
  client,
  onRowClick,
}: {
  client: TapeClient;
  onRowClick?: (id: string) => void;
}) {
  const stream = useSubscription(client, {
    channel: 'grid',
    policy: { last: 'latest', volume: 'accumulate' },
  });
  return (
    <VirtualGrid
      stream={stream}
      ids={IDS}
      columns={columns}
      rowHeight={30}
      overscan={10}
      onRowClick={onRowClick}
    />
  );
}

async function mountGrid(h: Harness, onRowClick?: (id: string) => void) {
  setObservedSize(800, 300); // viewport height from the stubbed ResizeObserver
  h.fetch.queueSnapshot(
    snap(
      'grid',
      1,
      Array.from({ length: 10 }, (_, i) => ({
        id: `r${i}`,
        fields: { last: 100 + i, volume: 0 },
      })),
    ),
  );
  const view = render(<GridApp client={h.client} onRowClick={onRowClick} />);
  await act(async () => {
    h.client.connect();
    h.sockets.latest().open();
    await settle();
  });
  return view;
}

describe('VirtualGrid', () => {
  it('renders ~visible + 2*overscan rows, not 10000', async () => {
    const h = makeHarness();
    const { container } = await mountGrid(h);
    const rows = container.querySelectorAll('[data-tape-row]');
    // 300px viewport / 30px rows = 10 visible; overscan 10 each side
    // (clamped at the top edge) → 20 here, never anywhere near 10000.
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.length).toBeLessThanOrEqual(31);
    expect(container.querySelector('[data-tape-row="r0"]')).not.toBeNull();
    expect(container.querySelector('[data-tape-row="r500"]')).toBeNull();
    // Snapshot values reached the visible cells.
    expect(
      container.querySelector('[data-tape-row="r0"]')!.textContent,
    ).toContain('100');
  });

  it('scrolling moves the window to different ids', async () => {
    const h = makeHarness();
    const { container } = await mountGrid(h);
    const viewport = container.querySelector('[data-tape-viewport]')!;
    setScrollTop(viewport, 3000); // row 100 at the top
    fireEvent.scroll(viewport);

    expect(container.querySelector('[data-tape-row="r0"]')).toBeNull();
    expect(container.querySelector('[data-tape-row="r100"]')).not.toBeNull();
    const rows = container.querySelectorAll('[data-tape-row]');
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.length).toBeLessThanOrEqual(31); // 10 visible + 2*10 overscan
  });

  it('onRowClick fires with the row id', async () => {
    const h = makeHarness();
    const onClick = vi.fn();
    const { container } = await mountGrid(h, onClick);
    fireEvent.click(container.querySelector('[data-tape-row="r3"]')!);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith('r3');
  });

  it('a record tick re-renders exactly one visible row', async () => {
    const h = makeHarness();
    const { container } = await mountGrid(h);
    const before = readRowRenderCount();
    await act(async () => {
      h.sockets
        .latest()
        .push(upd('grid', 2, [{ id: 'r2', fields: { last: 999 } }]));
      h.frames.fire();
    });
    expect(readRowRenderCount() - before).toBe(1);
    expect(
      container.querySelector('[data-tape-row="r2"]')!.textContent,
    ).toContain('999');
  });

  it('a tick on an off-screen record renders no rows at all', async () => {
    const h = makeHarness();
    await mountGrid(h);
    const before = readRowRenderCount();
    await act(async () => {
      h.sockets
        .latest()
        .push(upd('grid', 2, [{ id: 'r5000', fields: { last: 1 } }]));
      h.frames.fire();
    });
    expect(readRowRenderCount() - before).toBe(0);
  });
});
