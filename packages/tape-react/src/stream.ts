/**
 * useStream + useCoalesced — the render-phase policy-collection pair.
 * DEPRECATED since 1.1.0 (removal in 2.0.0) in favor of the declarative
 * useSubscription in ./subscription.ts, which drives the same StreamHandle.
 *
 * useStream returns a Stream handle whose identity is stable for the
 * component instance (per client + channel). Each render pass resets the
 * handle's policy collection; subsequent useCoalesced calls in the same
 * render register per-field policies onto it. After the render commits, an
 * effect inside useStream reconciles: if the collected policy and options
 * deep-equal the live subscription's, nothing happens; otherwise the old
 * subscription is closed and a new one opened via client.subscribe (which
 * is refcounted per channel in tape-core).
 *
 * The handle is itself subscribable (internally): useRecord / useRecordIds
 * attach through it so they re-render exactly once when the store becomes
 * available or is replaced — no polling, no tearing.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { resolveFieldPolicy } from '@lalithesh-star/tape-core';
import type {
  PolicyEntry,
  PolicySpec,
  RecordStore,
  Subscription,
  TapeClient,
  Unsubscribe,
} from '@lalithesh-star/tape-core';

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
  /** Field policies collected during the current render pass. */
  private pending: Record<string, PolicyEntry> = {};

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

  /** Render phase: start a fresh policy collection for this render pass. */
  beginRender(): void {
    this.pending = {};
  }

  /** Render phase (useCoalesced): register one field. Last write wins. */
  registerField(field: string, policy: PolicyEntry): void {
    this.pending[field] = policy;
  }

  /** Commit phase (v1): reconcile with the render-collected policy. */
  commit(opts: StreamOptions | undefined): void {
    this.reconcile(this.pending, opts);
  }

  /**
   * Reconcile the live subscription against an explicit policy + options.
   * Shared by both APIs: useStream funnels the render-collected policy in
   * via commit(); useSubscription passes the declarative spec's policy
   * directly. Deep-equal (post resolveFieldPolicy normalization) → no-op;
   * changed → close then resubscribe.
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
      `tape-react: ${hook} was given a Stream that did not come from useStream`,
    );
  }
  return stream;
}

// ---------------------------------------------------------------------------
// Deprecation warnings — once per hook per session, never per call.

const deprecationWarned = { useStream: false, useCoalesced: false };

/** @internal */
function warnDeprecatedOnce(hook: 'useStream' | 'useCoalesced'): void {
  if (deprecationWarned[hook]) return;
  deprecationWarned[hook] = true;
  console.warn(
    `[tape-react] ${hook}() is deprecated and will be removed in 2.0.0; ` +
      'use useSubscription({ channel, policy }). ' +
      'Run: pnpm exec tape-codemod v1-to-v2 <src> — see docs/MIGRATION-v2.md',
  );
}

/**
 * @deprecated Removed in 2.0.0 — use `useSubscription(client, { channel,
 * policy, priority, snapshot })` instead (declarative policy at the
 * subscription site). See docs/MIGRATION-v2.md, or run
 * `pnpm exec tape-codemod v1-to-v2 <src>`.
 */
export function useStream(
  client: TapeClient,
  channel: string,
  opts?: StreamOptions,
): Stream {
  warnDeprecatedOnce('useStream');
  const ref = useRef<StreamHandle | null>(null);
  if (
    ref.current === null ||
    ref.current.client !== client ||
    ref.current.channel !== channel
  ) {
    ref.current = new StreamHandle(client, channel);
  }
  const handle = ref.current;
  handle.beginRender();

  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Reconcile after EVERY commit — by effect time all useCoalesced calls of
  // this render pass have registered. Deep-equal policy + options → no-op.
  useEffect(() => {
    handle.commit(optsRef.current);
  });

  // Lifecycle: close on unmount or handle replacement (client/channel
  // changed). Strict mode's simulated unmount closes here and the commit
  // effect above resubscribes on remount — combined with tape-core's
  // refcounted subscribe this neither leaks nor double-subscribes.
  useEffect(() => () => handle.teardown(), [handle]);

  return handle;
}

/**
 * Render-phase registration of one field's coalescing policy onto the
 * stream for this render pass. Call between useStream and the end of the
 * same component's render, any number of times. Fields never registered
 * default to 'latest' (core behavior).
 *
 * @deprecated Removed in 2.0.0 — declare the policy in `useSubscription`'s
 * spec instead: `useSubscription(client, { channel, policy: { field:
 * policy } })`. See docs/MIGRATION-v2.md, or run
 * `pnpm exec tape-codemod v1-to-v2 <src>`.
 */
export function useCoalesced(
  stream: Stream,
  field: string,
  policy: PolicyEntry,
): void {
  warnDeprecatedOnce('useCoalesced');
  asHandle(stream, 'useCoalesced').registerField(field, policy);
}

/** @internal The stream's store as a subscribable value (null until live). */
export function useStreamStore(stream: Stream): RecordStore | null {
  const handle = asHandle(stream, 'useStreamStore');
  const subscribe = useCallback(
    (cb: () => void) => handle.subscribeHandle(cb),
    [handle],
  );
  const read = useCallback(() => handle.store, [handle]);
  return useSyncExternalStore(subscribe, read, read);
}
