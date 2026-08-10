/**
 * useStream + useCoalesced: render-phase policy collection, post-commit
 * subscribe, resubscribe-on-change, and strict-mode hygiene.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TapeClient } from '@lalithesh-star/tape-core';
import { useCoalesced, useRecord, useStream } from '../src';
import type { StreamOptions } from '../src';
import { makeHarness, settle, snap, upd } from './helpers';

afterEach(cleanup);

function Quotes({
  client,
  cap = 64,
  opts,
}: {
  client: TapeClient;
  cap?: number;
  opts?: StreamOptions;
}) {
  const stream = useStream(client, 'quotes', opts);
  useCoalesced(stream, 'last', 'latest');
  useCoalesced(stream, 'volume', 'accumulate');
  useCoalesced(stream, 'trades', { policy: 'sequence', capacity: cap });
  const rec = useRecord(stream, 'AAPL');
  return <div data-testid="last">{String(rec?.fields['last'] ?? '-')}</div>;
}

function SeqOnly({
  client,
  cap,
  opts,
}: {
  client: TapeClient;
  cap: number;
  opts?: StreamOptions;
}) {
  const stream = useStream(client, 'book', opts);
  useCoalesced(stream, 'trades', { policy: 'sequence', capacity: cap });
  return null;
}

describe('useStream + useCoalesced', () => {
  it('subscribes once after commit with the merged policy; unmount closes', async () => {
    const h = makeHarness();
    const spy = vi.spyOn(h.client, 'subscribe');
    const view = render(<Quotes client={h.client} opts={{ priority: 2 }} />);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe('quotes');
    expect(spy.mock.calls[0]![1]).toEqual({
      last: 'latest',
      volume: 'accumulate',
      trades: { policy: 'sequence', capacity: 64 },
    });
    expect(spy.mock.calls[0]![2]).toMatchObject({ priority: 2 });

    // Data flows end-to-end into the component through the fake seams.
    h.fetch.queueSnapshot(
      snap('quotes', 3, [{ id: 'AAPL', fields: { last: 190, volume: 1000 } }]),
    );
    await act(async () => {
      h.client.connect();
      h.sockets.latest().open();
      await settle();
    });
    expect(screen.getByTestId('last').textContent).toBe('190');

    await act(async () => {
      h.sockets
        .latest()
        .push(upd('quotes', 4, [{ id: 'AAPL', fields: { last: 191 } }]));
      h.frames.fire();
    });
    expect(screen.getByTestId('last').textContent).toBe('191');

    // While mounted the channel is live: a mismatched policy throws (core).
    expect(() => h.client.subscribe('quotes', {})).toThrow();

    view.unmount();
    expect(
      h.sockets.latest().sentOfType('unsubscribe').map((f) => f.channel),
    ).toEqual(['quotes']);
    // The channel is fully released: any policy subscribes fresh.
    const fresh = h.client.subscribe('quotes', {});
    fresh.close();
  });

  it('strict-mode double mount neither leaks nor double-subscribes', () => {
    const h = makeHarness();
    const spy = vi.spyOn(h.client, 'subscribe');
    const view = render(
      <StrictMode>
        <Quotes client={h.client} />
      </StrictMode>,
    );
    // mount → simulated unmount → remount: subscribe, close, subscribe.
    expect(spy).toHaveBeenCalledTimes(2);
    // Exactly one live subscription remains (a mismatched policy throws)…
    expect(() => h.client.subscribe('quotes', {})).toThrow();

    view.unmount();
    // …and unmount releases it completely: refcount reached zero, so a
    // fresh subscribe with a different policy succeeds (no leak).
    const fresh = h.client.subscribe('quotes', {});
    fresh.close();
  });

  it('resubscribes on policy change; identical rerenders are no-ops', () => {
    const h = makeHarness();
    const spy = vi.spyOn(h.client, 'subscribe');
    const view = render(<SeqOnly client={h.client} cap={16} />);
    expect(spy).toHaveBeenCalledTimes(1);

    // Deep-equal policy (fresh object every render) and normalize-equal
    // options ({priority: 0} === undefined): no resubscribe.
    view.rerender(<SeqOnly client={h.client} cap={16} />);
    view.rerender(<SeqOnly client={h.client} cap={16} opts={{ priority: 0 }} />);
    expect(spy).toHaveBeenCalledTimes(1);

    // Changed policy: close old, subscribe new. (If the old subscription
    // were still open, core would throw on the mismatched policy.)
    view.rerender(<SeqOnly client={h.client} cap={32} />);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![1]).toEqual({
      trades: { policy: 'sequence', capacity: 32 },
    });

    // Changed options also resubscribe.
    view.rerender(<SeqOnly client={h.client} cap={32} opts={{ priority: 5 }} />);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[2]![2]).toMatchObject({ priority: 5 });

    view.unmount();
    const fresh = h.client.subscribe('book', {});
    fresh.close();
  });
});
