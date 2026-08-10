/**
 * Order ticket. Validation is app-owned: symbol must exist in the store,
 * quantity is an integer 1..10000, limit is a positive number. A limit
 * more than 2% from the live last raises a NON-blocking warning. Submit
 * is disabled — with the reason shown — whenever the connection is not
 * live or resyncing. Submitting creates the order locally with status
 * 'working': the optimistic write. No server ack exists.
 */

import { memo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useRecord } from '@lalithesh-star/tape-react';
import type { Stream } from '@lalithesh-star/tape-react';
import type { InstrumentFields, OrderSide } from './types';
import { fmtPrice } from './format';

const QTY_MIN = 1;
const QTY_MAX = 10_000;
const WARN_PCT = 2;

export interface OrderTicketProps {
  stream: Stream;
  knownSymbols: ReadonlySet<string>;
  datalistId: string;
  /** Non-null while submit is disabled (connection not live/resyncing). */
  disabledReason: string | null;
  onPlace: (symbol: string, side: OrderSide, qty: number, limit: number) => void;
}

export const OrderTicket = memo(function OrderTicket({
  stream,
  knownSymbols,
  datalistId,
  disabledReason,
  onPlace,
}: OrderTicketProps) {
  const [symbolInput, setSymbolInput] = useState('');
  const [side, setSide] = useState<OrderSide>('buy');
  const [qtyInput, setQtyInput] = useState('');
  const [limitInput, setLimitInput] = useState('');
  const [attempted, setAttempted] = useState(false);

  const symbol = symbolInput.trim().toUpperCase();
  // Live context for the typed symbol; '' simply yields undefined.
  const record = useRecord<InstrumentFields>(stream, symbol);

  const symbolError =
    symbol === ''
      ? 'Symbol is required.'
      : !knownSymbols.has(symbol)
        ? `Unknown symbol "${symbol}" — not in the instruments store.`
        : null;

  const qty = Number(qtyInput);
  const qtyError =
    qtyInput.trim() === ''
      ? 'Quantity is required.'
      : !Number.isInteger(qty)
        ? 'Quantity must be a whole number.'
        : qty < QTY_MIN || qty > QTY_MAX
          ? `Quantity must be ${QTY_MIN}–${QTY_MAX}.`
          : null;

  const limit = Number(limitInput);
  const limitError =
    limitInput.trim() === ''
      ? 'Limit price is required.'
      : !Number.isFinite(limit) || limit <= 0
        ? 'Limit must be a positive number.'
        : null;

  // Non-blocking price sanity check against the live last.
  let priceWarning: string | null = null;
  if (limitError === null && record !== undefined) {
    const lastPx = record.fields.last;
    if (lastPx > 0) {
      const awayPct = (Math.abs(limit - lastPx) / lastPx) * 100;
      if (awayPct > WARN_PCT) {
        priceWarning = `Limit ${fmtPrice(limit)} is ${awayPct.toFixed(1)}% away from last ${fmtPrice(lastPx)} — submitting anyway is allowed.`;
      }
    }
  }

  // Show a field's error once submit was attempted, or as soon as the
  // field has content (so typos surface while typing, but a fresh form
  // is not a wall of red).
  const shownSymbolError =
    symbolError !== null && (attempted || symbolInput.trim() !== '') ? symbolError : null;
  const shownQtyError =
    qtyError !== null && (attempted || qtyInput.trim() !== '') ? qtyError : null;
  const shownLimitError =
    limitError !== null && (attempted || limitInput.trim() !== '') ? limitError : null;

  const formValid = symbolError === null && qtyError === null && limitError === null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (disabledReason !== null || !formValid) return;
    onPlace(symbol, side, qty, limit);
    setQtyInput('');
    setLimitInput('');
    setAttempted(false);
  };

  let context: ReactNode;
  if (symbol === '') {
    context = <span className="dim">Type a symbol to see live bid / ask / last.</span>;
  } else if (!knownSymbols.has(symbol)) {
    context = <span className="dim">No instrument "{symbol}" in the store.</span>;
  } else if (record === undefined) {
    context = <span className="dim">Waiting for {symbol} data…</span>;
  } else {
    context = (
      <>
        <span className="sym">{symbol}</span>
        <span className="num">bid {fmtPrice(record.fields.bid)}</span>
        <span className="num">ask {fmtPrice(record.fields.ask)}</span>
        <span className="num">last {fmtPrice(record.fields.last)}</span>
      </>
    );
  }

  return (
    <section className="panel ticket" aria-label="Order ticket">
      <header className="panel-header">
        <h2>Order ticket</h2>
        <span className="panel-note">limit orders only</span>
      </header>

      <form className="ticket-form" onSubmit={handleSubmit} noValidate>
        <div className="ticket-grid">
          <label className="field">
            <span className="field-label">Symbol</span>
            <input
              type="text"
              list={datalistId}
              value={symbolInput}
              onChange={(e) => setSymbolInput(e.target.value)}
              placeholder="ABC"
              aria-invalid={shownSymbolError !== null}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <div className="field">
            <span className="field-label" id="side-label">
              Side
            </span>
            <div className="side-toggle" role="group" aria-labelledby="side-label">
              <button
                type="button"
                className="side-btn buy"
                aria-pressed={side === 'buy'}
                onClick={() => setSide('buy')}
              >
                BUY
              </button>
              <button
                type="button"
                className="side-btn sell"
                aria-pressed={side === 'sell'}
                onClick={() => setSide('sell')}
              >
                SELL
              </button>
            </div>
          </div>

          <label className="field">
            <span className="field-label">Quantity</span>
            <input
              type="text"
              inputMode="numeric"
              value={qtyInput}
              onChange={(e) => setQtyInput(e.target.value)}
              placeholder="100"
              aria-invalid={shownQtyError !== null}
              autoComplete="off"
            />
          </label>

          <label className="field">
            <span className="field-label">Limit price</span>
            <input
              type="text"
              inputMode="decimal"
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
              placeholder="100.00"
              aria-invalid={shownLimitError !== null}
              autoComplete="off"
            />
          </label>
        </div>

        {shownSymbolError !== null && <p className="field-error" role="alert">{shownSymbolError}</p>}
        {shownQtyError !== null && <p className="field-error" role="alert">{shownQtyError}</p>}
        {shownLimitError !== null && <p className="field-error" role="alert">{shownLimitError}</p>}
        {priceWarning !== null && <p className="field-warning">{priceWarning}</p>}

        <div className="context-line" aria-live="polite">
          {context}
        </div>

        <div className="ticket-footer">
          <button type="submit" className="btn primary" disabled={disabledReason !== null}>
            Place {side === 'buy' ? 'buy' : 'sell'} order
          </button>
          {disabledReason !== null && (
            <p className="form-reason">Submit disabled: {disabledReason}.</p>
          )}
        </div>
      </form>
    </section>
  );
});
