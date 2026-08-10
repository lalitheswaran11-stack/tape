/**
 * In-app confirmation for the destructive cancel action. role='dialog',
 * aria-modal, focus moves in on open (to the non-destructive default),
 * Escape closes, Tab cycles between the two explicit buttons. Only
 * Confirm cancels the order.
 */

import { useEffect, useRef } from 'react';
import type { Order } from './types';
import { fmtPrice } from './format';

export interface ConfirmDialogProps {
  order: Order;
  onConfirm: () => void;
  onKeep: () => void;
}

export function ConfirmDialog({ order, onConfirm, onKeep }: ConfirmDialogProps) {
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // Move focus into the dialog on open; default to the safe action.
  useEffect(() => {
    keepRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onKeep();
      } else if (e.key === 'Tab') {
        // Two-stop focus trap: Tab and Shift+Tab toggle between buttons.
        e.preventDefault();
        const next =
          document.activeElement === keepRef.current
            ? confirmRef.current
            : keepRef.current;
        next?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onKeep]);

  return (
    <div className="dialog-overlay" onClick={onKeep}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-dialog-title"
        className="dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="cancel-dialog-title">Cancel this order?</h2>
        <p className="dialog-body">
          <span className={order.side === 'buy' ? 'up' : 'down'}>
            {order.side.toUpperCase()}
          </span>{' '}
          <span className="num">{order.qty}</span>{' '}
          <span className="sym">{order.symbol}</span> at limit{' '}
          <span className="num">{fmtPrice(order.limit)}</span>. A cancelled
          order cannot be reinstated.
        </p>
        <div className="dialog-actions">
          <button type="button" ref={keepRef} className="btn" onClick={onKeep}>
            Keep order
          </button>
          <button
            type="button"
            ref={confirmRef}
            className="btn danger"
            onClick={onConfirm}
          >
            Confirm cancel
          </button>
        </div>
      </div>
    </div>
  );
}
