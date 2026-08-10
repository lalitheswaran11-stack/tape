/**
 * Tape Monitor — dense, read-only monitoring view over the tape platform.
 *
 * App owns BOTH streams (one subscription per channel for the whole tree)
 * and passes the handles down, so per-channel policies cannot diverge
 * between components. App itself subscribes to no tick data: it re-renders
 * only on filter/selection changes.
 */

import { useCallback } from 'react';
import { ConnectionBanner, PerfHud, useSubscription } from '@lalithesh-star/tape-react';
import { client } from './client';
import { useUrlState } from './useUrlState';
import { InstrumentsGrid } from './InstrumentsGrid';
import { DetailPanel } from './DetailPanel';
import { TapePanel } from './TapePanel';

export default function App() {
  const [query, setQuery] = useUrlState('q');
  const [selected, setSelected] = useUrlState('sym');

  // Instruments: the grid is the product — highest flush priority.
  // volume is a wire delta → 'accumulate' (lossless totals under load);
  // bid/ask/last/open/change stay on the default 'latest'.
  const instruments = useSubscription(client, {
    channel: 'instruments',

    policy: {
      volume: 'accumulate'
    },

    priority: 1
  });

  // Tape: an event log → 'sequence', bounded well above what we render.
  const tape = useSubscription(client, {
    channel: 'tape',

    policy: {
      trades: { policy: 'sequence', capacity: 512 }
    },

    priority: 0
  });

  const onSelect = useCallback(
    (id: string) => setSelected(id === selected ? '' : id),
    [selected, setSelected],
  );

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Tape Monitor</h1>
        <ConnectionBanner client={client} />
        <input
          className="filter"
          type="search"
          placeholder="Filter symbols…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter symbols"
          spellCheck={false}
        />
        <span className="hint">` toggles perf HUD · click a row to select</span>
      </header>
      <main className="app-main">
        <InstrumentsGrid
          stream={instruments}
          query={query}
          selected={selected}
          onSelect={onSelect}
        />
        <aside className="side-pane">
          {selected !== '' && (
            <DetailPanel stream={instruments} symbol={selected} />
          )}
          <TapePanel stream={tape} selected={selected} />
        </aside>
      </main>
      <PerfHud client={client} />
    </div>
  );
}
