/**
 * ConnectionBanner — a small status pill for the client's connection state.
 * The state NAME is always the visible text; color is reinforcement, never
 * the sole encoding.
 */

import type { CSSProperties } from 'react';
import type { ConnectionState, TapeClient } from '@lalithesh-star/tape-core';
import { useConnectionState } from './client-hooks';

const STATE_COLOR: Record<ConnectionState, string> = {
  live: 'var(--tape-live, #3fb950)',
  degraded: 'var(--tape-degraded, #d29922)',
  resyncing: 'var(--tape-resyncing, #58a6ff)',
  connecting: 'var(--tape-connecting, #8b949e)',
  disconnected: 'var(--tape-disconnected, #f85149)',
  idle: 'var(--tape-idle, #6e7681)',
};

export interface ConnectionBannerProps {
  client: TapeClient;
  className?: string;
  style?: CSSProperties;
}

export function ConnectionBanner({
  client,
  className,
  style,
}: ConnectionBannerProps) {
  const state = useConnectionState(client);
  const color = STATE_COLOR[state];
  return (
    <span
      role="status"
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px',
        borderRadius: 999,
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: 'var(--tape-text, #c9d1d9)',
        background: 'var(--tape-pill-bg, rgba(110,118,129,0.15))',
        border: `1px solid ${color}`,
        ...style,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          flex: 'none',
        }}
      />
      {state}
    </span>
  );
}
