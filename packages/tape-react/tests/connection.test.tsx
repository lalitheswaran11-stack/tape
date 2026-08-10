/**
 * useConnectionState + ConnectionBanner over fake-socket transitions, and
 * the PerfHud toggle key.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TapeClient } from '@lalitheswaran11-stack/tape-core';
import { ConnectionBanner, PerfHud, useConnectionState } from '../src';
import { makeHarness } from './helpers';

afterEach(cleanup);

function StateProbe({ client }: { client: TapeClient }) {
  return <div data-testid="state">{useConnectionState(client)}</div>;
}

describe('useConnectionState', () => {
  it('reflects transitions driven through the fake socket', () => {
    const h = makeHarness();
    render(
      <>
        <StateProbe client={h.client} />
        <ConnectionBanner client={h.client} />
      </>,
    );
    expect(screen.getByTestId('state').textContent).toBe('idle');
    expect(screen.getByRole('status').textContent).toContain('idle');

    act(() => h.client.connect());
    expect(screen.getByTestId('state').textContent).toBe('connecting');

    act(() => h.sockets.latest().open());
    expect(screen.getByTestId('state').textContent).toBe('live');
    // The banner encodes the state as visible TEXT, never color alone.
    expect(screen.getByRole('status').textContent).toContain('live');

    act(() => h.sockets.latest().serverClose());
    expect(screen.getByTestId('state').textContent).toBe('connecting');
    expect(screen.getByRole('status').textContent).toContain('connecting');

    act(() => h.client.close());
    expect(screen.getByTestId('state').textContent).toBe('disconnected');
  });
});

describe('PerfHud', () => {
  it('toggles with the backquote key', () => {
    const h = makeHarness();
    const { container } = render(<PerfHud client={h.client} />);
    expect(container.querySelector('[data-tape-hud]')).toBeNull();

    fireEvent.keyDown(window, { code: 'Backquote', key: '`' });
    expect(container.querySelector('[data-tape-hud]')).not.toBeNull();

    fireEvent.keyDown(window, { code: 'Backquote', key: '`' });
    expect(container.querySelector('[data-tape-hud]')).toBeNull();
  });
});
