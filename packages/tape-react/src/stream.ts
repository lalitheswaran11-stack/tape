/**
 * StreamHandle — the internal machinery behind useSubscription (the
 * declarative hook in ./subscription.ts).
 *
 * The handle's identity is stable for the component instance (per client +
 * channel). After each commit, useSubscription reconciles the declarative
 * spec against the live subscription: if the spec's policy and options
 * deep-equal the live subscription's, nothing happens; otherwise the old
 * subscription is closed and a new one opened via client.subscribe (which
 * is refcounted per channel in tape-core).
 *
 * The handle is itself subscribable (internally): useRecord / useRecordIds
 * attach through it so they re-render exactly once when the store becomes
 * available or is replaced — no polling, no tearing.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { resolveFieldPolicy } from '@lalitheswaran11-stack/tape-core';
import type {
  PolicySpec,
  RecordStore,
  Subscription,
  TapeClient,
  Unsubscribe,
} from '@lalitheswaran11-stack/tape-core';

/** @internal Options reconciled alongside the policy (see reconcile). */
export interface StreamOptions {
  /** Flush priority under backpressure — higher flushes first. Default 0. */
  priority?: number;
  /** Reconcile against the REST snapshot on subscribe. Default true. */
  snapshot?: boolean;
}

export interface Stream {
  readonly channel: string;
  /** The live subscription's store; null until the first commit subscribes. */
  readonly store: RecordStore | null;
  /** @internal */
  readonly _internal: unknown;
}

/** Semantic equality: entries that resolve to the same policy are equal. */
function policiesEqual(a: PolicySpec, b: PolicySpec): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    const ra = resolveFieldPolicy(a, key);
    const rb = resolveFieldPolicy(b, key);
    if (ra.policy !== rb.policy || ra.capacity !== rb.capacity) return false;
  }
  return true;
}

/** Equality after default-filling: {priority: 0} === undefined, etc. */
function optionsEqual(
  a: StreamOptions | undefined,
  b: StreamOptions | undefined,
): boolean {
  return (
    (a?.priority ?? 0) === (b?.priority ?? 0) &&
    (a?.snapshot ?? true) === (b?.snapshot ?? true)
  );
}

/** @internal */
export class StreamHandle implements Stream {
  readonly channel: string;
  readonly client: TapeClient;

  private subscription: Subscription | null = null;
  private activePolicy: PolicySpec | null = null;
  private activeOpts: StreamOptions | undefined = undefined;
  private readonly listeners = new Set<() => void>();

  constructor(client: TapeClient, channel: string) {
    this.client = client;
    this.channel = channel;
  }

  get store(): RecordStore | null {
    return this.subscription === null ? null : this.subscription.store;
  }

  get _internal(): unknown {
    return this;
  }

  /**
   * Reconcile the live subscription against an explicit policy + options.
   * Called from useSubscription's post-commit effect with the declarative
   * spec's policy. Deep-equal (post resolveFieldPolicy normalization) →
   * no-op; changed → close then resubscribe.
   */
  reconcile(policy: PolicySpec, opts: StreamOptions | undefined): void {
    if (
      this.subscription !== null &&
      this.activePolicy !== null &&
      policiesEqual(this.activePolicy, policy) &&
      optionsEqual(this.activeOpts, opts)
    ) {
      return; // identical rerender — do nothing
    }
    const previous = this.subscription;
    if (previous !== null) {
      // Close BEFORE resubscribing: tape-core allows one live policy per
      // channel, so the old subscription must release its ref first.
      this.subscription = null;
      previous.close();
    }
    this.subscription = this.client.subscribe(
      this.channel,
      { ...policy },
      { priority: opts?.priority, snapshot: opts?.snapshot },
    );
    this.activePolicy = { ...policy };
    this.activeOpts = opts === undefined ? undefined : { ...opts };
    this.emit();
  }

  /** Unmount (incl. strict mode's simulated unmount): close and reset. */
  teardown(): void {
    const previous = this.subscription;
    this.subscription = null;
    this.activePolicy = null;
    this.activeOpts = undefined;
    if (previous !== null) {
      previous.close();
      this.emit();
    }
  }

  /** @internal Handle-level change signal: fires when the store is swapped. */
  subscribeHandle(cb: () => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Per-record subscription that survives store replacement: attaches to
   * the current store (if any) and re-attaches — notifying once — whenever
   * the handle swaps stores (first commit, policy change, remount).
   */
  subscribeRecordThrough(id: string, cb: () => void): Unsubscribe {
    let attached = this.store;
    let storeUnsub: Unsubscribe | null =
      attached === null ? null : attached.subscribeRecord(id, cb);
    const handleUnsub = this.subscribeHandle(() => {
      const next = this.store;
      if (next === attached) return;
      if (storeUnsub !== null) storeUnsub();
      attached = next;
      storeUnsub = next === null ? null : next.subscribeRecord(id, cb);
      cb();
    });
    return () => {
      handleUnsub();
      if (storeUnsub !== null) storeUnsub();
      storeUnsub = null;
    };
  }

  /** Ids-array subscription with the same store-replacement semantics. */
  subscribeIdsThrough(cb: () => void): Unsubscribe {
    let attached = this.store;
    let storeUnsub: Unsubscribe | null =
      attached === null ? null : attached.subscribeIds(cb);
    const handleUnsub = this.subscribeHandle(() => {
      const next = this.store;
      if (next === attached) return;
      if (storeUnsub !== null) storeUnsub();
      attached = next;
      storeUnsub = next === null ? null : next.subscribeIds(cb);
      cb();
    });
    return () => {
      handleUnsub();
      if (storeUnsub !== null) storeUnsub();
      storeUnsub = null;
    };
  }

  private emit(): void {
    for (const cb of Array.from(this.listeners)) cb();
  }
}

/** @internal */
export function asHandle(stream: Stream, hook: string): StreamHandle {
  if (!(stream instanceof StreamHandle)) {
    throw new Error(
      `tape-react: ${hook} was given a Stream that did not come from useSubscription`,
    );
  }
  return stream;
}

/** @internal The stream's store as a subscribable value (null until live). */
export function useHandleStore(stream: Stream): RecordStore | null {
  const handle = asHandle(stream, 'useHandleStore');
  const subscribe = useCallback(
    (cb: () => void) => handle.subscribeHandle(cb),
    [handle],
  );
  const read = useCallback(() => handle.store, [handle]);
  return useSyncExternalStore(subscribe, read, read);
}
