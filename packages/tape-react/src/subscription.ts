/**
 * useSubscription — the v2 declarative subscription hook.
 *
 * The whole subscription — channel, per-field coalescing policy, priority,
 * snapshot — is one spec at the subscription site. No render-phase
 * registration: the subscription is established in an effect from the
 * spec, re-renders with a semantically equal spec (deep policy equality
 * via core's resolveFieldPolicy normalization) do nothing, and a changed
 * spec closes the old subscription and opens a new one.
 *
 * It drives the internal StreamHandle machinery in ./stream.ts, so the
 * returned Stream works unchanged with useRecord / useRecordIds /
 * VirtualGrid / CanvasChart.
 */

import { useEffect, useRef } from 'react';
import type { PolicySpec, TapeClient } from '@lalitheswaran11-stack/tape-core';
import { StreamHandle } from './stream';
import type { Stream } from './stream';

export interface SubscriptionSpec {
  /** Channel to subscribe to. */
  channel: string;
  /** Field name → coalescing policy. Unlisted fields default to 'latest'. */
  policy?: PolicySpec;
  /** Flush priority under backpressure — higher flushes first. Default 0. */
  priority?: number;
  /** Reconcile against the REST snapshot on subscribe. Default true. */
  snapshot?: boolean;
}

const EMPTY_POLICY: PolicySpec = Object.freeze({});

export function useSubscription(
  client: TapeClient,
  spec: SubscriptionSpec,
): Stream {
  const ref = useRef<StreamHandle | null>(null);
  if (
    ref.current === null ||
    ref.current.client !== client ||
    ref.current.channel !== spec.channel
  ) {
    ref.current = new StreamHandle(client, spec.channel);
  }
  const handle = ref.current;

  const specRef = useRef(spec);
  specRef.current = spec;

  // Reconcile after EVERY commit. A semantically equal spec (deep policy
  // equality after resolveFieldPolicy normalization, default-filled
  // options) is a no-op; a changed spec closes and resubscribes.
  useEffect(() => {
    const current = specRef.current;
    handle.reconcile(current.policy ?? EMPTY_POLICY, {
      priority: current.priority,
      snapshot: current.snapshot,
    });
  });

  // Lifecycle: close on unmount or handle replacement (client/channel
  // changed). Strict mode's simulated unmount closes here and the effect
  // above resubscribes on remount — combined with tape-core's refcounted
  // subscribe this neither leaks nor double-subscribes.
  useEffect(() => () => handle.teardown(), [handle]);

  return handle;
}
