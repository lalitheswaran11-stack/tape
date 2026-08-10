/**
 * CanvasChart: DPR-scaled backing store, dirty-flag rAF drawing, and
 * graceful behavior when the record is absent.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TapeClient } from '@lalitheswaran11-stack/tape-core';
import { CanvasChart, useSubscription } from '../src';
import {
  fireAnimationFrames,
  makeHarness,
  pendingAnimationFrames,
  recordingCtx,
  setDevicePixelRatio,
  setObservedSize,
  settle,
  snap,
  upd,
} from './helpers';
import type { Harness } from './helpers';

beforeEach(() => {
  setDevicePixelRatio(2);
  setObservedSize(400, 160);
});

afterEach(() => {
  cleanup();
  setDevicePixelRatio(1);
});

function ChartApp({
  client,
  recordId,
}: {
  client: TapeClient;
  recordId: string;
}) {
  const stream = useSubscription(client, {
    channel: 'quotes',
    policy: { last: 'latest' },
  });
  return (
    <CanvasChart stream={stream} recordId={recordId} field="last" height={160} />
  );
}

async function mountChart(h: Harness, recordId: string) {
  h.fetch.queueSnapshot(
    snap('quotes', 1, [{ id: 'AAPL', fields: { last: 190 }, ts: 1000 }]),
  );
  const view = render(<ChartApp client={h.client} recordId={recordId} />);
  await act(async () => {
    h.client.connect();
    h.sockets.latest().open();
    await settle();
  });
  return view;
}

describe('CanvasChart', () => {
  it('sizes the backing store to cssPixels * dpr and scales the context', async () => {
    const h = makeHarness();
    const { container } = await mountChart(h, 'AAPL');
    const canvas = container.querySelector('canvas')!;
    expect(canvas.width).toBe(800); // 400 css px * dpr 2
    expect(canvas.height).toBe(320); // 160 css px * dpr 2
    const ctx = recordingCtx(canvas);
    expect(ctx.callsOf('scale').map((c) => c.args)).toContainEqual([2, 2]);
  });

  it('a flush with a changed record and ONE fired rAF produces one draw', async () => {
    const h = makeHarness();
    const { container } = await mountChart(h, 'AAPL');
    const canvas = container.querySelector('canvas')!;
    const ctx = recordingCtx(canvas);

    fireAnimationFrames(); // drain the setup draws (resize + seed)
    expect(pendingAnimationFrames()).toBe(0);

    await act(async () => {
      h.sockets
        .latest()
        .push(upd('quotes', 2, [{ id: 'AAPL', fields: { last: 195 }, ts: 2000 }]));
      h.frames.fire(); // client flush → onFlush → point pushed → dirty
    });
    // Dirty but not drawn yet: drawing happens once per animation frame.
    expect(pendingAnimationFrames()).toBeGreaterThan(0);

    const before = ctx.calls.length;
    fireAnimationFrames();
    expect(ctx.calls.length).toBeGreaterThan(before);
    expect(ctx.callsOf('clearRect').length).toBeGreaterThan(0);
    expect(ctx.callsOf('stroke').length).toBeGreaterThan(0); // grid + series
    // Current-value label drawn.
    expect(
      ctx.callsOf('fillText').some((c) => String(c.args[0]).includes('195')),
    ).toBe(true);

    // Nothing dirty → firing another frame draws nothing.
    const after = ctx.calls.length;
    fireAnimationFrames();
    expect(ctx.calls.length).toBe(after);
  });

  it('does not crash when the record is absent', async () => {
    const h = makeHarness();
    const { container } = await mountChart(h, 'MISSING');
    const canvas = container.querySelector('canvas')!;
    const ctx = recordingCtx(canvas);

    await act(async () => {
      h.sockets
        .latest()
        .push(upd('quotes', 2, [{ id: 'AAPL', fields: { last: 195 } }]));
      h.frames.fire();
    });
    fireAnimationFrames();
    // Draws the empty state instead of throwing.
    expect(
      ctx.callsOf('fillText').some((c) => c.args[0] === 'no data'),
    ).toBe(true);
  });
});
