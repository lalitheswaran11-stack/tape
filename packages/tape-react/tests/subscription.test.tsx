/**
 * useSubscription: declarative spec, effect-time subscribe, spec-equality
 * no-ops, resubscribe-on-change, wire-level release on unmount,
 * multi-channel independence, strict-mode hygiene, and interop with
 * useRecord / useRecordIds.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PolicySpec, TapeClient } from '@lalitheswaran11-stack/tape-core';
import { useRecord, useRecordIds, useSubscription } from '../src';
import type { SubscriptionSpec } from '../src';
import { makeHarness, settle, snap, upd } from './helpers';

afterEach(cleanup);

function Quotes({
  client,
  spec,
}: {
  client: TapeClient;
  spec: SubscriptionSpec;
}) {
  const stream = useSubscription(client, spec);
  const rec = useRecord(stream, 'AAPL');
  const ids = useRecordIds(stream);
  return (
    <>
      <div data-testid="last">{String(rec?.fields['last'] ?? '-')}</div>
      <div data-testid="ids">{ids.join(',')}</div>
    </>
  );
}

function SeqOnly({
  client,
  policy,
  priority,
}: {
  client: TapeClient;
  policy?: PolicySpec;
  priority?: number;
}) {
  useSubscription(client, { channel: 'book', policy, priority });
  return null;
}

const QUOTES_SPEC: SubscriptionSpec = {
  channel: 'quotes',
  policy: {
    last: 'latest',
    volume: 'accumulate',
    trades: { policy: 'sequence', capacity: 64 },
  },
  priority: 2,
};

describe('useSubscription', () => {
  it('subscribes once after commit with the declared policy; unmount closes', async () => {
    const h = makeHarness();
    const spy = vi.spyOn(h.client, 'subscribe');
    const view = render(<Quotes client={h.client} spec={QUOTES_SPEC} />);

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

    // While mounted the channel is live: a mismatched policy throws (core).
    expect(() => h.client.subscribe('quotes', {})).toThrow();

    view.unmount();
    // Unmount released the subscription on the wire…
    expect(
      h.sockets.latest().sentOfType('unsubscribe').map((f) => f.channel),
    ).toEqual(['quotes']);
    // …and the channel is fully released: any policy subscribes fresh.
    const fresh = h.client.subscribe('quotes', {});
    fresh.close();
  });

  it('two components on different channels subscribe independently', async () => {
    const h = makeHarness();
    const spy = vi.spyOn(h.client, 'subscribe');
    h.fetch.respondWith((channel) =>
      snap(channel, 1, [{ id: 'AAPL', fields: { last: 190, volume: 5 } }]),
    );

    function ChannelQuotes({ channel }: { channel: string }) {
      const stream = useSubscription(h.client, {
        channel,
        policy: { last: 'latest', volume: 'accumulate' },
      });
      const rec = useRecord(stream, 'AAPL');
      return (
        <div data-testid={`last-${channel}`}>
          {String(rec?.fields['last'] ?? '-')}
        </div>
      );
    }
    const view = render(
      <>
        <ChannelQuotes channel="quotes" />
        <ChannelQuotes channel="book" />
      </>,
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(['book', 'quotes']);

    // One connection carries both channels; data reaches both components.
    await act(async () => {
      h.client.connect();
      h.sockets.latest().open();
      await settle();
    });
    expect(screen.getByTestId('last-quotes').textContent).toBe('190');
    expect(screen.getByTestId('last-book').textContent).toBe('190');
    view.unmount();
  });

  it('useRecord and useRecordIds work through a useSubscription stream', async () => {
    const h = makeHarness();
    h.fetch.queueSnapshot(
      snap('quotes', 3, [{ id: 'AAPL', fields: { last: 190, volume: 1000 } }]),
    );
    render(<Quotes client={h.client} spec={QUOTES_SPEC} />);

    // Before the connection is live: undefined record, empty ids, no tearing.
    expect(screen.getByTestId('last').textContent).toBe('-');
    expect(screen.getByTestId('ids').textContent).toBe('');

    await act(async () => {
      h.client.connect();
      h.sockets.latest().open();
      await settle();
    });
    expect(screen.getByTestId('last').textContent).toBe('190');
    expect(screen.getByTestId('ids').textContent).toBe('AAPL');

    await act(async () => {
      h.sockets
        .latest()
        .push(upd('quotes', 4, [{ id: 'AAPL', fields: { last: 191 } }]));
      h.frames.fire();
    });
    expect(screen.getByTestId('last').textContent).toBe('191');
  });

  it('spec-equal rerenders do not resubscribe (fresh objects, defaults)', () => {
    const h = makeHarness();
    const spy = vi.spyOn(h.client, 'subscribe');
    const view = render(
      <SeqOnly
        client={h.client}
        policy={{ trades: { policy: 'sequence', capacity: 16 } }}
      />,
    );
    expect(spy).toHaveBeenCalledTimes(1);

    // Fresh-but-deep-equal policy object every render: no resubscribe.
    view.rerender(
      <SeqOnly
        client={h.client}
        policy={{ trades: { policy: 'sequence', capacity: 16 } }}
      />,
    );
    // Normalization-equal: {priority: 0} === priority omitted.
    view.rerender(
      <SeqOnly
        client={h.client}
        policy={{ trades: { policy: 'sequence', capacity: 16 } }}
        priority={0}
      />,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('a changed policy closes the old subscription and resubscribes', () => {
    const h = makeHarness();
    const spy = vi.spyOn(h.client, 'subscribe');
    const view = render(
      <SeqOnly
        client={h.client}
        policy={{ trades: { policy: 'sequence', capacity: 16 } }}
      />,
    );
    expect(spy).toHaveBeenCalledTimes(1);

    // Changed capacity: close old, subscribe new. (If the old subscription
    // were still open, core would throw on the mismatched policy.)
    view.rerender(
      <SeqOnly
        client={h.client}
        policy={{ trades: { policy: 'sequence', capacity: 32 } }}
      />,
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![1]).toEqual({
      trades: { policy: 'sequence', capacity: 32 },
    });

    // Changed options also resubscribe.
    view.rerender(
      <SeqOnly
        client={h.client}
        policy={{ trades: { policy: 'sequence', capacity: 32 } }}
        priority={5}
      />,
    );
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[2]![2]).toMatchObject({ priority: 5 });

    view.unmount();
    const fresh = h.client.subscribe('book', {});
    fresh.close();
  });

  it('a changed channel closes the old subscription and opens the new one', () => {
    const h = makeHarness();
    const spy = vi.spyOn(h.client, 'subscribe');

    function Switcher({ channel }: { channel: string }) {
      useSubscription(h.client, { channel });
      return null;
    }
    const view = render(<Switcher channel="quotes" />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe('quotes');

    view.rerender(<Switcher channel="book" />);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![0]).toBe('book');
    // The old channel was released: any policy subscribes fresh.
    const fresh = h.client.subscribe('quotes', { x: 'accumulate' });
    fresh.close();
    view.unmount();
  });

  it('strict-mode double mount neither leaks nor double-subscribes', () => {
    const h = makeHarness();
    const spy = vi.spyOn(h.client, 'subscribe');
    const view = render(
      <StrictMode>
        <Quotes client={h.client} spec={QUOTES_SPEC} />
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
});
