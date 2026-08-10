/**
 * createTapeClient: wires transport, sequencer, coalescing buffer, and
 * stores into the public TapeClient.
 *
 * Snapshot reconcile per channel — used on initial subscribe (unless
 * opts.snapshot === false), after every reconnect, and after a detected
 * sequence gap:
 *   1. buffer live updates (ordered by seq) without applying them,
 *   2. fetch `{snapshotUrl}/snapshot?channel=...` with the injected fetchFn,
 *   3. on a response with seq Sn: clear the channel's pending coalesce
 *      buffer, applySnapshot, replay buffered updates with seq > Sn through
 *      the sequencer/buffer (seq <= Sn are discarded — the snapshot already
 *      contains them), mark the channel synced.
 *
 * Client state is 'resyncing' while any channel reconciles with the socket
 * open, 'live' when all are synced.
 *
 * All environment access goes through injectable seams with defaults read
 * off globalThis — tape-core compiles against lib ES2022 (no DOM) and runs
 * unmodified in Node 22.
 */

import { SNAPSHOT_PATH } from './protocol';
import type { ServerMessage, SnapshotResponse, UpdateMessage } from './protocol';
import { compilePolicy } from './policy';
import type { PolicySpec } from './policy';
import type {
  FetchLike,
  FetchResponseLike,
  Fields,
  FrameScheduler,
  GapEvent,
  SubscribeOptions,
  Subscription,
  TapeClient,
  TapeClientOptions,
  TimerScheduler,
  WebSocketFactory,
  WebSocketLike,
} from './types';
import { Metrics } from './metrics';
import { CoalescingBuffer } from './buffer';
import { TapeStore } from './store';
import { ChannelSequencer } from './sequencer';
import { Transport } from './transport';

/** Default tuning; every value can be overridden via TapeClientOptions. */
export const TAPE_DEFAULTS = {
  backoff: { baseMs: 250, capMs: 10_000 },
  heartbeat: { intervalMs: 1_000, timeoutMs: 2_500 },
  reorder: { window: 16, timeoutMs: 250 },
  flushBudgetMs: 8,
} as const;

// ---------------------------------------------------------------------------
// Default seams. Browser globals are reached via globalThis with casts so
// the package compiles against lib ES2022 (no DOM) and runs in plain Node.

function defaultNow(): () => number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  if (perf !== undefined && typeof perf.now === 'function') {
    return () => perf.now();
  }
  return () => Date.now();
}

function defaultTimers(): TimerScheduler {
  return {
    schedule: (cb, delayMs) => setTimeout(cb, delayMs),
    cancel: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
  };
}

function defaultWebSocketFactory(): WebSocketFactory {
  return (url) => {
    const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike })
      .WebSocket;
    if (typeof Ctor !== 'function') {
      throw new Error(
        'tape-core: no global WebSocket; inject options.webSocketFactory',
      );
    }
    return new Ctor(url);
  };
}

function defaultFetch(): FetchLike {
  return (url) => {
    const fetchImpl = (globalThis as {
      fetch?: (url: string) => Promise<FetchResponseLike>;
    }).fetch;
    if (typeof fetchImpl !== 'function') {
      return Promise.reject(
        new Error('tape-core: no global fetch; inject options.fetchFn'),
      );
    }
    return fetchImpl.call(globalThis, url) as Promise<FetchResponseLike>;
  };
}

function defaultFrameScheduler(now: () => number): FrameScheduler {
  const g = globalThis as {
    requestAnimationFrame?: (cb: (t: number) => void) => number;
    cancelAnimationFrame?: (handle: number) => void;
  };
  const raf = g.requestAnimationFrame;
  const caf = g.cancelAnimationFrame;
  if (typeof raf === 'function' && typeof caf === 'function') {
    return {
      request: (cb) => raf.call(globalThis, cb),
      cancel: (handle) => caf.call(globalThis, handle as number),
    };
  }
  return {
    request: (cb) => setTimeout(() => cb(now()), 16),
    cancel: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
  };
}

/** ws:// → http://, wss:// → https:// */
function deriveSnapshotUrl(wsUrl: string): string {
  if (/^wss:/i.test(wsUrl)) return 'https:' + wsUrl.slice(4);
  if (/^ws:/i.test(wsUrl)) return 'http:' + wsUrl.slice(3);
  return wsUrl;
}

function policiesEqual(a: PolicySpec, b: PolicySpec): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const av = a[key];
    const bv = b[key];
    if (av === bv) continue;
    if (
      av === undefined ||
      bv === undefined ||
      typeof av === 'string' ||
      typeof bv === 'string'
    ) {
      return false;
    }
    if (av.policy !== bv.policy || av.capacity !== bv.capacity) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------

type SyncVia = 'snapshot' | 'ack';

/**
 * - 'unsynced'  no socket (pre-connect or between drops); nothing flows.
 * - 'syncing'   reconciling: live updates buffer, ordered by seq.
 * - 'synced'    live updates flow through the sequencer into the buffer.
 */
type ChannelPhase = 'unsynced' | 'syncing' | 'synced';

interface ChannelState {
  readonly channel: string;
  readonly policySpec: PolicySpec;
  readonly store: TapeStore;
  sequencer: ChannelSequencer;
  subscription: Subscription;
  refcount: number;
  priority: number;
  wantSnapshot: boolean;
  /** Has this channel seen a socket open since it was subscribed? */
  seenOpen: boolean;
  phase: ChannelPhase;
  syncVia: SyncVia;
  /** Updates held (ordered by seq) while the channel reconciles. */
  resyncBuffer: UpdateMessage[];
  /** Bumped to invalidate in-flight snapshot fetches. */
  resyncToken: number;
}

export function createTapeClient(options: TapeClientOptions): TapeClient {
  const now = options.now ?? defaultNow();
  const random = options.random ?? Math.random;
  const timers = options.timers ?? defaultTimers();
  const scheduler = options.scheduler ?? defaultFrameScheduler(now);
  const webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory();
  const fetchFn = options.fetchFn ?? defaultFetch();
  const backoff = {
    baseMs: options.backoff?.baseMs ?? TAPE_DEFAULTS.backoff.baseMs,
    capMs: options.backoff?.capMs ?? TAPE_DEFAULTS.backoff.capMs,
  };
  const heartbeat = {
    intervalMs: options.heartbeat?.intervalMs ?? TAPE_DEFAULTS.heartbeat.intervalMs,
    timeoutMs: options.heartbeat?.timeoutMs ?? TAPE_DEFAULTS.heartbeat.timeoutMs,
  };
  const reorder = {
    window: options.reorder?.window ?? TAPE_DEFAULTS.reorder.window,
    timeoutMs: options.reorder?.timeoutMs ?? TAPE_DEFAULTS.reorder.timeoutMs,
  };
  const flushBudgetMs = options.flushBudgetMs ?? TAPE_DEFAULTS.flushBudgetMs;
  const snapshotBase = options.snapshotUrl ?? deriveSnapshotUrl(options.url);

  const metrics = new Metrics();
  const buffer = new CoalescingBuffer({ scheduler, now, flushBudgetMs, metrics });
  const channels = new Map<string, ChannelState>();
  const gapSubs = new Set<(gap: GapEvent) => void>();
  let closed = false;

  const transport = new Transport({
    url: options.url,
    webSocketFactory,
    timers,
    now,
    random,
    backoff,
    heartbeat,
    metrics,
    onOpen: handleSocketOpen,
    onMessage: handleServerMessage,
    onDown: handleSocketDown,
  });

  function handleSocketOpen(): void {
    for (const ch of channels.values()) {
      transport.send({ type: 'subscribe', channel: ch.channel });
      // First open honors opts.snapshot; every later open is a reconnect and
      // always reconciles via snapshot.
      const via: SyncVia = !ch.seenOpen && !ch.wantSnapshot ? 'ack' : 'snapshot';
      ch.seenOpen = true;
      startResync(ch, via);
    }
  }

  function handleSocketDown(): void {
    for (const ch of channels.values()) {
      ch.resyncToken++; // any in-flight snapshot is now for a dead socket
      ch.phase = 'unsynced';
      ch.resyncBuffer.length = 0;
      ch.sequencer.deactivate();
    }
    updateResyncCount();
  }

  function handleServerMessage(msg: ServerMessage): void {
    if (msg.type === 'update') {
      const ch = channels.get(msg.channel);
      if (ch === undefined) return;
      if (ch.phase === 'synced') ch.sequencer.push(msg);
      else if (ch.phase === 'syncing') insertBySeq(ch.resyncBuffer, msg);
      return;
    }
    if (msg.type === 'subscribed') {
      const ch = channels.get(msg.channel);
      if (ch === undefined) return;
      // The ack's seq is the baseline only when not snapshotting (the
      // snapshot's own seq governs otherwise).
      if (ch.phase === 'syncing' && ch.syncVia === 'ack') {
        completeSync(ch, msg.seq);
      }
      return;
    }
    // hello / pong / unsubscribed / error: liveness only (already counted).
  }

  function startResync(ch: ChannelState, via: SyncVia): void {
    ch.phase = 'syncing';
    ch.syncVia = via;
    ch.resyncBuffer.length = 0;
    const token = ++ch.resyncToken;
    updateResyncCount();
    if (via === 'snapshot') void fetchSnapshot(ch, token);
  }

  async function fetchSnapshot(ch: ChannelState, token: number): Promise<void> {
    const url =
      snapshotBase + SNAPSHOT_PATH + '?channel=' + encodeURIComponent(ch.channel);
    let body: SnapshotResponse;
    try {
      const res = await fetchFn(url);
      if (!isCurrent(ch, token)) return;
      if (!res.ok) throw new Error(`snapshot fetch failed: ${res.status}`);
      body = (await res.json()) as SnapshotResponse;
    } catch {
      if (!isCurrent(ch, token)) return;
      // Retry while this resync attempt is still the current one.
      timers.schedule(() => {
        if (isCurrent(ch, token)) void fetchSnapshot(ch, token);
      }, backoff.baseMs);
      return;
    }
    if (!isCurrent(ch, token)) return;
    // Pending coalesce state predates the snapshot: the snapshot supersedes
    // it, so it must be cleared BEFORE the snapshot applies.
    buffer.clearPending(ch.channel);
    ch.store.applySnapshot(body.records);
    completeSync(ch, body.seq);
  }

  function isCurrent(ch: ChannelState, token: number): boolean {
    return (
      !closed &&
      ch.resyncToken === token &&
      channels.get(ch.channel) === ch &&
      ch.phase === 'syncing'
    );
  }

  /** Arm the sequencer at `seq`, replay buffered updates > seq, go live. */
  function completeSync(ch: ChannelState, seq: number): void {
    ch.sequencer.reset(seq);
    ch.phase = 'synced';
    const buffered = ch.resyncBuffer;
    ch.resyncBuffer = [];
    for (const msg of buffered) {
      if (msg.seq > seq) ch.sequencer.push(msg);
      // seq <= baseline: already contained in the snapshot — discard.
    }
    updateResyncCount();
  }

  function updateResyncCount(): void {
    let count = 0;
    for (const ch of channels.values()) {
      if (ch.phase === 'syncing') count++;
    }
    transport.setResyncing(count);
  }

  function handleGap(ch: ChannelState, gap: GapEvent): void {
    for (const cb of gapSubs) cb(gap);
    if (channels.get(ch.channel) === ch && transport.isOpen()) {
      startResync(ch, 'snapshot');
    }
  }

  function insertBySeq(buf: UpdateMessage[], msg: UpdateMessage): void {
    let i = buf.length;
    while (i > 0 && buf[i - 1]!.seq > msg.seq) i--;
    buf.splice(i, 0, msg);
  }

  function subscribe<F extends Fields = Fields>(
    channel: string,
    policy: PolicySpec,
    opts?: SubscribeOptions,
  ): Subscription<F> {
    if (closed) throw new Error('tape-core: client is closed');
    const existing = channels.get(channel);
    if (existing !== undefined) {
      if (!policiesEqual(existing.policySpec, policy)) {
        throw new Error(
          `tape-core: subscribe('${channel}') with a different policy than the live subscription`,
        );
      }
      existing.refcount++;
      return existing.subscription as unknown as Subscription<F>;
    }
    const compiled = compilePolicy(policy); // once per subscription
    const store = new TapeStore(compiled, metrics);
    const priority = opts?.priority ?? 0;
    const wantSnapshot = opts?.snapshot !== false;
    const ch: ChannelState = {
      channel,
      policySpec: policy,
      store,
      sequencer: undefined as unknown as ChannelSequencer,
      subscription: undefined as unknown as Subscription,
      refcount: 1,
      priority,
      wantSnapshot,
      seenOpen: false,
      phase: 'unsynced',
      syncVia: 'snapshot',
      resyncBuffer: [],
      resyncToken: 0,
    };
    ch.sequencer = new ChannelSequencer({
      channel,
      window: reorder.window,
      timeoutMs: reorder.timeoutMs,
      timers,
      metrics,
      onDeliver: (msg) => buffer.ingest(channel, msg.updates),
      onGap: (gap) => handleGap(ch, gap),
    });
    ch.subscription = { channel, store, close: () => release(ch) };
    channels.set(channel, ch);
    buffer.addChannel(channel, store, compiled, priority);
    if (transport.isOpen()) {
      transport.send({ type: 'subscribe', channel });
      ch.seenOpen = true;
      startResync(ch, wantSnapshot ? 'snapshot' : 'ack');
    }
    return ch.subscription as unknown as Subscription<F>;
  }

  function release(ch: ChannelState): void {
    if (channels.get(ch.channel) !== ch) return; // already dropped
    ch.refcount--;
    if (ch.refcount > 0) return;
    channels.delete(ch.channel);
    buffer.removeChannel(ch.channel);
    ch.sequencer.deactivate();
    ch.resyncToken++;
    transport.send({ type: 'unsubscribe', channel: ch.channel });
    updateResyncCount();
  }

  return {
    connect(): void {
      if (!closed) transport.connect();
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const ch of channels.values()) {
        ch.sequencer.deactivate();
        ch.resyncToken++;
      }
      buffer.dispose();
      transport.close();
    },
    getState: () => transport.getState(),
    onStateChange: (cb) => transport.onStateChange(cb),
    onGap(cb): () => void {
      gapSubs.add(cb);
      return () => gapSubs.delete(cb);
    },
    subscribe,
    getMetrics: () => metrics.snapshot(),
  };
}
