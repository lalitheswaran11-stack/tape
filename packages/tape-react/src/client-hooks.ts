/**
 * Client-level hooks: connection state (event-driven) and metrics (polled).
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type {
  ConnectionState,
  MetricsSnapshot,
  TapeClient,
} from '@lalithesh-star/tape-core';

export function useConnectionState(client: TapeClient): ConnectionState {
  const subscribe = useCallback(
    (cb: () => void) => client.onStateChange(cb),
    [client],
  );
  const read = useCallback(() => client.getState(), [client]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Polls client.getMetrics() on an interval (default 500 ms). The component
 * re-renders once per sample with a fresh MetricsSnapshot; the interval is
 * cleared on unmount.
 */
export function useMetrics(
  client: TapeClient,
  intervalMs = 500,
): MetricsSnapshot {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot>(() =>
    client.getMetrics(),
  );
  useEffect(() => {
    setSnapshot(client.getMetrics());
    const timer = setInterval(() => setSnapshot(client.getMetrics()), intervalMs);
    return () => clearInterval(timer);
  }, [client, intervalMs]);
  return snapshot;
}
