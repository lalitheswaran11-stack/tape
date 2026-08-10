/**
 * Manual seams for the Tier 1 microbenchmark.
 *
 * Modeled on packages/tape-core/tests/helpers.ts — copied and trimmed, not
 * imported (no cross-package test imports; the bench consumes only the BUILT
 * package). Nothing here is asynchronous or clocked:
 *
 * - FakeSocket        the bench invokes socket.onmessage directly with
 *                     pre-encoded frames; nothing arrives on its own.
 * - ManualTimers      records scheduled callbacks and NEVER fires them.
 *                     Virtual time never advances, so heartbeat staleness and
 *                     holdback timeouts can't trigger mid-measurement — the
 *                     timing loop measures ingest/flush, not lifecycle.
 * - ManualFrameScheduler  frames fire only when the bench calls fire().
 * - makeFakeFetch     resolves immediately with a canned SnapshotResponse
 *                     per channel; no network, no latency.
 *
 * Every nanosecond measured through these seams belongs to tape-core.
 */

import type {
  FetchLike,
  FetchResponseLike,
  FrameScheduler,
  ServerMessage,
  SnapshotResponse,
  TimerScheduler,
  WebSocketLike,
} from '@lalithesh-star/tape-core';

// ---------------------------------------------------------------------------
// FakeSocket

export class FakeSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  /** Bench control: server accepts the connection. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Bench control (setup only): push one server message, encoded here. */
  push(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

// ---------------------------------------------------------------------------
// ManualTimers — parked forever

export class ManualTimers implements TimerScheduler {
  private nextId = 1;
  private readonly timers = new Map<number, () => void>();

  schedule(cb: () => void, _delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, cb);
    return id;
  }

  cancel(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get pendingCount(): number {
    return this.timers.size;
  }
}

// ---------------------------------------------------------------------------
// ManualFrameScheduler

export class ManualFrameScheduler implements FrameScheduler {
  private nextId = 1;
  private readonly pending = new Map<number, (now: number) => void>();

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
// FakeFetch — canned snapshot per channel, resolved on the microtask queue

export function makeFakeFetch(
  snapshotsByChannel: Readonly<Record<string, SnapshotResponse>>,
): FetchLike {
  return (url: string) => {
    const match = /[?&]channel=([^&]*)/.exec(url);
    const channel = match ? decodeURIComponent(match[1] ?? '') : '';
    const snapshot = snapshotsByChannel[channel];
    if (snapshot === undefined) {
      return Promise.reject(
        new Error(`makeFakeFetch: no snapshot canned for channel '${channel}'`),
      );
    }
    const res: FetchResponseLike = {
      ok: true,
      status: 200,
      json: () => Promise.resolve(snapshot),
    };
    return Promise.resolve(res);
  };
}
