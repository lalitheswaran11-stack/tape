/**
 * Deprecation warnings for the v1 pair: each of useStream / useCoalesced
 * warns exactly ONCE per session, no matter how many calls, components, or
 * renders — and the v1 pair keeps working functionally.
 *
 * This lives in its own test file: the once-per-session flags are module
 * state, so a file that renders v1 hooks elsewhere would consume them.
 * Vitest's per-file isolation gives this file a fresh module registry.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TapeClient } from '@lalithesh-star/tape-core';
import { useCoalesced, useRecord, useStream } from '../src';
import { makeHarness, settle, snap } from './helpers';

afterEach(cleanup);

const STREAM_MSG =
  '[tape-react] useStream() is deprecated and will be removed in 2.0.0; ' +
  'use useSubscription({ channel, policy }). ' +
  'Run: pnpm exec tape-codemod v1-to-v2 <src> — see docs/MIGRATION-v2.md';
const COALESCED_MSG =
  '[tape-react] useCoalesced() is deprecated and will be removed in 2.0.0; ' +
  'use useSubscription({ channel, policy }). ' +
  'Run: pnpm exec tape-codemod v1-to-v2 <src> — see docs/MIGRATION-v2.md';

function V1Quotes({ client, channel }: { client: TapeClient; channel: string }) {
  const stream = useStream(client, channel);
  // Multiple useCoalesced calls in one component.
  useCoalesced(stream, 'last', 'latest');
  useCoalesced(stream, 'volume', 'accumulate');
  const rec = useRecord(stream, 'AAPL');
  return <div data-testid={`last-${channel}`}>{String(rec?.fields['last'] ?? '-')}</div>;
}

describe('v1 deprecation warnings', () => {
  it('each hook warns exactly once across multiple calls, components, and renders', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = makeHarness();
      // Two components, each calling useStream once and useCoalesced twice.
      const view = render(
        <>
          <V1Quotes client={h.client} channel="quotes" />
          <V1Quotes client={h.client} channel="book" />
        </>,
      );
      // Rerender a few times — render-phase calls happen again each pass.
      view.rerender(
        <>
          <V1Quotes client={h.client} channel="quotes" />
          <V1Quotes client={h.client} channel="book" />
        </>,
      );
      view.rerender(
        <>
          <V1Quotes client={h.client} channel="quotes" />
          <V1Quotes client={h.client} channel="book" />
        </>,
      );

      const tapeWarnings = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.startsWith('[tape-react]'));
      expect(tapeWarnings).toHaveLength(2);
      expect(tapeWarnings).toContain(STREAM_MSG);
      expect(tapeWarnings).toContain(COALESCED_MSG);

      // …and the deprecated pair still WORKS: data flows end to end.
      h.fetch.respondWith((channel) =>
        snap(channel, 1, [{ id: 'AAPL', fields: { last: 190, volume: 5 } }]),
      );
      await act(async () => {
        h.client.connect();
        h.sockets.latest().open();
        await settle();
      });
      expect(screen.getByTestId('last-quotes').textContent).toBe('190');
      expect(screen.getByTestId('last-book').textContent).toBe('190');

      // Still no additional warnings after the async work + data renders.
      expect(
        warn.mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.startsWith('[tape-react]')),
      ).toHaveLength(2);
      view.unmount();
    } finally {
      warn.mockRestore();
    }
  });

  it('a later mount in the same session does not warn again', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = makeHarness();
      const view = render(<V1Quotes client={h.client} channel="tape" />);
      expect(
        warn.mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.startsWith('[tape-react]')),
      ).toHaveLength(0);
      view.unmount();
    } finally {
      warn.mockRestore();
    }
  });
});
