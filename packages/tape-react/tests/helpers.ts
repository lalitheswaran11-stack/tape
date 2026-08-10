/**
 * Deterministic fakes so tests drive a REAL createTapeClient with no real
 * timers, sockets, network, or animation frames. Modeled on
 * tape-core/tests/helpers.ts (copied — never import across packages), plus
 * accessors for the jsdom stubs installed by tests/setup.ts.
 */

import { createTapeClient } from '@lalitheswaran11-stack/tape-core';
import type {
  ClientMessage,
  ConnectionState,
  FetchLike,
  FetchResponseLike,
  FieldValue,
  FrameScheduler,
  SequenceEntry,
  ServerMessage,
  SnapshotResponse,
  TapeClient,
  TapeClientOptions,
  TimerScheduler,
  UpdateMessage,
  WebSocketFactory,
  WebSocketLike,
  WireFieldValue,
} from '@lalitheswaran11-stack/tape-core';

// ---------------------------------------------------------------------------
// FakeSocket

export class FakeSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closedByClient = false;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  /** Called by the transport. Does NOT fire onclose (mimics async close). */
  close(): void {
    this.closedByClient = true;
    this.readyState = 3;
  }

  /** Test control: server accepts the connection. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Test control: the connection drops (or the attempt fails). */
  serverClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** Test control: push a server message. */
  push(msg: ServerMessage | string): void {
    this.onmessage?.({
      data: typeof msg === 'string' ? msg : JSON.stringify(msg),
    });
  }

  sentFrames(): ClientMessage[] {
    return this.sent.map((s) => JSON.parse(s) as ClientMessage);
  }

  sentOfType<T extends ClientMessage['type']>(
    type: T,
  ): Extract<ClientMessage, { type: T }>[] {
    return this.sentFrames().filter(
      (f): f is Extract<ClientMessage, { type: T }> => f.type === type,
    );
  }
}

export interface SocketFactory {
  factory: WebSocketFactory;
  all: FakeSocket[];
  latest(): FakeSocket;
}

export function makeSocketFactory(): SocketFactory {
  const all: FakeSocket[] = [];
  return {
    factory: () => {
      const socket = new FakeSocket();
      all.push(socket);
      return socket;
    },
    all,
    latest: () => {
      const socket = all[all.length - 1];
      if (socket === undefined) throw new Error('no socket created yet');
      return socket;
    },
  };
}

// ---------------------------------------------------------------------------
// ManualTimers — virtual time

interface ScheduledTimer {
  id: number;
  at: number;
  cb: () => void;
}

export class ManualTimers implements TimerScheduler {
  now = 0;
  scheduledLog: Array<{ delay: number; at: number }> = [];
  private nextId = 1;
  private timers: ScheduledTimer[] = [];

  schedule(cb: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this.now + delayMs, cb });
    this.scheduledLog.push({ delay: delayMs, at: this.now + delayMs });
    return id;
  }

  cancel(handle: unknown): void {
    const idx = this.timers.findIndex((t) => t.id === handle);
    if (idx >= 0) this.timers.splice(idx, 1);
  }

  /** Advance virtual time, firing due timers in time order (FIFO on ties). */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let due: ScheduledTimer | null = null;
      for (const t of this.timers) {
        if (
          t.at <= target &&
          (due === null || t.at < due.at || (t.at === due.at && t.id < due.id))
        ) {
          due = t;
        }
      }
      if (due === null) break;
      this.timers.splice(this.timers.indexOf(due), 1);
      this.now = due.at;
      due.cb();
    }
    this.now = target;
  }

  get pendingCount(): number {
    return this.timers.length;
  }
}

// ---------------------------------------------------------------------------
// ManualFrameScheduler — the CLIENT's frame seam (distinct from the global
// requestAnimationFrame stub, which components use).

export class ManualFrameScheduler implements FrameScheduler {
  private nextId = 1;
  private pending = new Map<number, (now: number) => void>();

  request(cb: (now: number) => void): unknown {
    const id = this.nextId++;
    this.pending.set(id, cb);
    return id;
  }

  cancel(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Fire all currently-requested frame callbacks. */
  fire(now = 0): void {
    const cbs = Array.from(this.pending.values());
    this.pending.clear();
    for (const cb of cbs) cb(now);
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

// ---------------------------------------------------------------------------
// FakeFetch

interface HeldRequest {
  url: string;
  resolve: (res: FetchResponseLike) => void;
  reject: (err: unknown) => void;
}

export class FakeFetch {
  calls: string[] = [];
  hold = false;
  private queue: SnapshotResponse[] = [];
  private responder:
    | ((channel: string, url: string) => SnapshotResponse)
    | null = null;
  private held: HeldRequest[] = [];

  fn: FetchLike = (url: string) => {
    this.calls.push(url);
    return new Promise<FetchResponseLike>((resolve, reject) => {
      const entry: HeldRequest = { url, resolve, reject };
      if (this.hold) this.held.push(entry);
      else this.answer(entry);
    });
  };

  queueSnapshot(snapshot: SnapshotResponse): void {
    this.queue.push(snapshot);
  }

  respondWith(fn: (channel: string, url: string) => SnapshotResponse): void {
    this.responder = fn;
  }

  release(): void {
    const entry = this.held.shift();
    if (entry !== undefined) this.answer(entry);
  }

  releaseAll(): void {
    while (this.held.length > 0) this.release();
  }

  get heldCount(): number {
    return this.held.length;
  }

  private answer(entry: HeldRequest): void {
    const channel = channelFromUrl(entry.url);
    const snapshot = this.responder
      ? this.responder(channel, entry.url)
      : this.queue.shift();
    if (snapshot === undefined) {
      entry.reject(new Error('FakeFetch: nothing queued for ' + entry.url));
      return;
    }
    entry.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(snapshot),
    });
  }
}

export function channelFromUrl(url: string): string {
  const match = /[?&]channel=([^&]*)/.exec(url);
  return match ? decodeURIComponent(match[1] ?? '') : '';
}

// ---------------------------------------------------------------------------
// Message builders

export function snap(
  channel: string,
  seq: number,
  records: Array<{
    id: string;
    fields: Record<string, FieldValue | SequenceEntry[]>;
    ts?: number;
  }>,
): SnapshotResponse {
  return {
    channel,
    seq,
    serverTime: 0,
    records: records.map((r) => ({
      id: r.id,
      fields: r.fields,
      ts: r.ts ?? 0,
    })),
  };
}

export function upd(
  channel: string,
  seq: number,
  updates: Array<{
    id: string;
    fields: Record<string, WireFieldValue>;
    ts?: number;
  }>,
): UpdateMessage {
  return {
    type: 'update',
    channel,
    seq,
    updates: updates.map((u) => ({ id: u.id, fields: u.fields, ts: u.ts ?? 0 })),
  };
}

// ---------------------------------------------------------------------------
// Harness

export interface Harness {
  client: TapeClient;
  timers: ManualTimers;
  frames: ManualFrameScheduler;
  sockets: SocketFactory;
  fetch: FakeFetch;
  states: ConnectionState[];
}

export function makeHarness(
  overrides: Partial<TapeClientOptions> = {},
): Harness {
  const timers = new ManualTimers();
  const frames = new ManualFrameScheduler();
  const sockets = makeSocketFactory();
  const fetch = new FakeFetch();
  const client = createTapeClient({
    url: 'ws://feed.test:4400',
    webSocketFactory: sockets.factory,
    fetchFn: fetch.fn,
    scheduler: frames,
    timers,
    now: () => timers.now,
    random: () => 0.5,
    ...overrides,
  });
  const states: ConnectionState[] = [];
  client.onStateChange((s) => states.push(s));
  return { client, timers, frames, sockets, fetch, states };
}

/** Drain pending microtasks (snapshot fetch resolution). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Accessors for the jsdom stubs from tests/setup.ts

const g = globalThis as unknown as Record<string, unknown>;

/** Set the rect the stubbed ResizeObserver reports. Call BEFORE mounting. */
export function setObservedSize(width: number, height: number): void {
  g['__tapeObservedRect'] = { width, height };
}

/** Fire (and clear) all pending global rAF callbacks. Returns the count. */
export function fireAnimationFrames(now = 0): number {
  return (g['__tapeFireFrames'] as (now?: number) => number)(now);
}

export function pendingAnimationFrames(): number {
  return (g['__tapeRafPending'] as () => number)();
}

export interface RecordedCall {
  op: string;
  args: unknown[];
}

export interface RecordingCtx {
  calls: RecordedCall[];
  canvas: HTMLCanvasElement;
  callsOf(op: string): RecordedCall[];
}

/** The recording 2d context attached to a canvas by the setup stub. */
export function recordingCtx(canvas: HTMLCanvasElement): RecordingCtx {
  canvas.getContext('2d');
  return (canvas as unknown as { __recordingCtx: RecordingCtx }).__recordingCtx;
}

export function setDevicePixelRatio(value: number): void {
  Object.defineProperty(globalThis, 'devicePixelRatio', {
    configurable: true,
    value,
  });
}

/** jsdom's scrollTop is layout-backed (always 0); shadow it per element. */
export function setScrollTop(el: Element, top: number): void {
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    writable: true,
    value: top,
  });
}
