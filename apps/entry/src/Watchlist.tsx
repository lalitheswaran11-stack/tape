/**
 * User-managed watchlist, persisted in localStorage. Each row is its own
 * component holding a per-record subscription via useRecord — a tick on
 * one symbol re-renders exactly that row.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useRecord } from '@lalitheswaran11-stack/tape-react';
import type { Stream } from '@lalitheswaran11-stack/tape-react';
import type { InstrumentFields } from './types';
import { loadWatchlist, saveWatchlist } from './storage';
import { fmtPrice, fmtSignedPct, polarityClass } from './format';

const DEFAULT_COUNT = 8;

export interface WatchlistProps {
  stream: Stream;
  /** Membership set, rebuilt only when the ids array identity changes. */
  knownSymbols: ReadonlySet<string>;
  datalistId: string;
  /** Non-null while forms are disabled (connection not live/resyncing). */
  disabledReason: string | null;
}

export const Watchlist = memo(function Watchlist({
  stream,
  knownSymbols,
  datalistId,
  disabledReason,
}: WatchlistProps) {
  // null = never persisted → seed from the first ids that arrive.
  const [symbols, setSymbols] = useState<string[] | null>(loadWatchlist);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  // One-time seed: the first 8 ids, only when nothing was ever persisted.
  // An explicitly emptied watchlist ([]) is respected and never re-seeded.
  useEffect(() => {
    if (symbols === null && knownSymbols.size > 0) {
      setSymbols(Array.from(knownSymbols).slice(0, DEFAULT_COUNT));
    }
  }, [symbols, knownSymbols]);

  useEffect(() => {
    if (symbols !== null) saveWatchlist(symbols);
  }, [symbols]);

  const remove = useCallback((sym: string) => {
    setSymbols((prev) => (prev === null ? prev : prev.filter((s) => s !== sym)));
  }, []);

  const handleAdd = (e: FormEvent) => {
    e.preventDefault();
    const sym = input.trim().toUpperCase();
    if (sym === '') {
      setError('Enter a symbol.');
      return;
    }
    if (!knownSymbols.has(sym)) {
      setError(`Unknown symbol "${sym}" — not in the instruments store.`);
      return;
    }
    if ((symbols ?? []).includes(sym)) {
      setError(`${sym} is already on the watchlist.`);
      return;
    }
    setSymbols((prev) => [...(prev ?? []), sym]);
    setInput('');
    setError(null);
  };

  return (
    <section className="panel watchlist" aria-label="Watchlist">
      <header className="panel-header">
        <h2>Watchlist</h2>
        <span className="panel-note">{symbols === null ? 0 : symbols.length} symbols</span>
      </header>

      <form className="add-form" onSubmit={handleAdd}>
        <label className="field">
          <span className="field-label">Add symbol</span>
          <input
            type="text"
            list={datalistId}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError(null);
            }}
            placeholder="e.g. ABC"
            disabled={disabledReason !== null}
            aria-invalid={error !== null}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button type="submit" className="btn" disabled={disabledReason !== null}>
          Add
        </button>
      </form>
      {disabledReason !== null && (
        <p className="form-reason">Adding disabled: {disabledReason}.</p>
      )}
      {error !== null && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      <div className="watch-rows">
        <div className="watch-row watch-head" aria-hidden="true">
          <span>Symbol</span>
          <span className="num">Last</span>
          <span className="num">Change</span>
          <span className="num">Bid / Ask</span>
          <span />
        </div>
        {symbols === null ? (
          <p className="empty">Waiting for instruments to seed the default watchlist…</p>
        ) : symbols.length === 0 ? (
          <p className="empty">Watchlist is empty — add a symbol above.</p>
        ) : (
          symbols.map((sym) => (
            <WatchRow key={sym} stream={stream} symbol={sym} onRemove={remove} />
          ))
        )}
      </div>
    </section>
  );
});

interface WatchRowProps {
  stream: Stream;
  symbol: string;
  onRemove: (symbol: string) => void;
}

const WatchRow = memo(function WatchRow({ stream, symbol, onRemove }: WatchRowProps) {
  const record = useRecord<InstrumentFields>(stream, symbol);
  const f = record?.fields;
  return (
    <div className="watch-row">
      <span className="sym">{symbol}</span>
      <span className="num">{f === undefined ? '—' : fmtPrice(f.last)}</span>
      <span className={f === undefined ? 'num' : `num ${polarityClass(f.change)}`}>
        {f === undefined ? '—' : fmtSignedPct(f.change)}
      </span>
      <span className="num dim">
        {f === undefined ? '—' : `${fmtPrice(f.bid)} / ${fmtPrice(f.ask)}`}
      </span>
      <button
        type="button"
        className="btn ghost"
        onClick={() => onRemove(symbol)}
        aria-label={`Remove ${symbol} from watchlist`}
        title={`Remove ${symbol}`}
      >
        ×
      </button>
    </div>
  );
});
