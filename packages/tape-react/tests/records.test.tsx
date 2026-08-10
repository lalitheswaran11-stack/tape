/**
 * Render granularity: useRecord wakes only the component whose record
 * changed; useRecordIds wakes only on membership changes.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { memo } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TapeClient } from '@lalitheswaran11-stack/tape-core';
import { useRecord, useRecordIds, useSubscription } from '../src';
import type { Stream } from '../src';
import { makeHarness, settle, snap, upd } from './helpers';

afterEach(cleanup);

const renderCounts: Record<string, number> = {};
let idsRenders = 0;

beforeEach(() => {
  for (const key of Object.keys(renderCounts)) delete renderCounts[key];
  idsRenders = 0;
});

const Reader = memo(function Reader({
  stream,
  id,
}: {
  stream: Stream;
  id: string;
}) {
  renderCounts[id] = (renderCounts[id] ?? 0) + 1;
  const rec = useRecord(stream, id);
  return <span data-testid={id}>{String(rec?.fields['last'] ?? '-')}</span>;
});

function TwoReaders({ client }: { client: TapeClient }) {
  const stream = useSubscription(client, {
    channel: 'quotes',
    policy: { last: 'latest' },
  });
  return (
    <>
      <Reader stream={stream} id="AAPL" />
      <Reader stream={stream} id="MSFT" />
    </>
  );
}

function IdsView({ client }: { client: TapeClient }) {
  const stream = useSubscription(client, {
    channel: 'quotes',
    policy: { last: 'latest' },
  });
  const ids = useRecordIds(stream);
  idsRenders++;
  return <div data-testid="ids">{ids.join(',')}</div>;
}

describe('useRecord', () => {
  it('a tick on one record re-renders only that reader', async () => {
    const h = makeHarness();
    h.fetch.queueSnapshot(
      snap('quotes', 1, [
        { id: 'AAPL', fields: { last: 190 } },
        { id: 'MSFT', fields: { last: 420 } },
      ]),
    );
    render(<TwoReaders client={h.client} />);
    await act(async () => {
      h.client.connect();
      h.sockets.latest().open();
      await settle();
    });
    expect(screen.getByTestId('AAPL').textContent).toBe('190');
    expect(screen.getByTestId('MSFT').textContent).toBe('420');

    const aaplBefore = renderCounts['AAPL']!;
    const msftBefore = renderCounts['MSFT']!;
    await act(async () => {
      h.sockets
        .latest()
        .push(upd('quotes', 2, [{ id: 'AAPL', fields: { last: 191 } }]));
      h.frames.fire();
    });
    expect(screen.getByTestId('AAPL').textContent).toBe('191');
    expect(renderCounts['AAPL']).toBe(aaplBefore + 1);
    expect(renderCounts['MSFT']).toBe(msftBefore); // never woken
  });

  it('returns undefined before the subscription is live, without tearing', () => {
    const h = makeHarness();
    render(<TwoReaders client={h.client} />);
    // No connection: records simply do not exist yet.
    expect(screen.getByTestId('AAPL').textContent).toBe('-');
    expect(screen.getByTestId('MSFT').textContent).toBe('-');
  });
});

describe('useRecordIds', () => {
  it('updates on membership changes, not on value ticks', async () => {
    const h = makeHarness();
    h.fetch.queueSnapshot(
      snap('quotes', 1, [{ id: 'AAPL', fields: { last: 190 } }]),
    );
    render(<IdsView client={h.client} />);
    await act(async () => {
      h.client.connect();
      h.sockets.latest().open();
      await settle();
    });
    expect(screen.getByTestId('ids').textContent).toBe('AAPL');

    const before = idsRenders;
    // Value tick on an existing record: membership unchanged, no render.
    await act(async () => {
      h.sockets
        .latest()
        .push(upd('quotes', 2, [{ id: 'AAPL', fields: { last: 191 } }]));
      h.frames.fire();
    });
    expect(idsRenders).toBe(before);
    expect(screen.getByTestId('ids').textContent).toBe('AAPL');

    // A never-seen record id arrives: membership changes, one render.
    await act(async () => {
      h.sockets
        .latest()
        .push(upd('quotes', 3, [{ id: 'TSLA', fields: { last: 900 } }]));
      h.frames.fire();
    });
    expect(screen.getByTestId('ids').textContent).toBe('AAPL,TSLA');
    expect(idsRenders).toBe(before + 1);
  });
});
