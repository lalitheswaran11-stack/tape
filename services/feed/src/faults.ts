/**
 * Fault-injection state machine. The server consults this controller on
 * every pacing tick (stall, burst) and pipes every outbound update through
 * it (reorder). Drop and gap are one-shot actions performed by the server;
 * the controller only records them for /fault reporting.
 */

import { mulberry32, shuffleInPlace, type Rng } from './prng';

/** An encoded update ready to send to a channel's subscribers. */
export interface WireItem {
  channel: string;
  wire: string;
}

export interface FaultStatus {
  drop: { count: number };
  reorder: { active: boolean; window: number; remaining: number };
  burst: { active: boolean; factor: number; remainingMs: number };
  stall: { active: boolean; remainingMs: number };
  gap: { totalSkipped: number };
  serverTime: number;
}

interface ReorderRun {
  window: number;
  remaining: number;
  buffer: WireItem[];
  rng: Rng;
}

export class FaultController {
  private reorder: ReorderRun | null = null;
  private reorderActivations = 0;
  private burstState: { factor: number; until: number } | null = null;
  private stallUntil = 0;
  private dropCount = 0;
  private gapTotal = 0;

  constructor(private readonly seed: number) {}

  /**
   * Begin a reorder run: the next `count` update messages are buffered
   * `window` at a time and each full window is emitted in seeded-shuffled
   * order. Returns any leftover buffer from a previous run (flushed in
   * arrival order) so no message is ever lost.
   */
  startReorder(window: number, count: number): WireItem[] {
    const leftover = this.reorder ? this.reorder.buffer : [];
    this.reorderActivations++;
    this.reorder = {
      window: Math.max(1, Math.floor(window)),
      remaining: Math.max(1, Math.floor(count)),
      buffer: [],
      rng: mulberry32((this.seed ^ (0x9e3779b9 + this.reorderActivations)) >>> 0),
    };
    return leftover;
  }

  startBurst(factor: number, ms: number, now: number): void {
    this.burstState = { factor: Math.max(1, factor), until: now + Math.max(0, ms) };
  }

  startStall(ms: number, now: number): void {
    this.stallUntil = now + Math.max(0, ms);
  }

  noteDrop(): void {
    this.dropCount++;
  }

  noteGap(skipped: number): void {
    this.gapTotal += skipped;
  }

  stalled(now: number): boolean {
    return now < this.stallUntil;
  }

  /** Base rate scaled by an active burst, if any. */
  effectiveRate(base: number, now: number): number {
    if (this.burstState !== null) {
      if (now < this.burstState.until) return base * this.burstState.factor;
      this.burstState = null;
    }
    return base;
  }

  /**
   * Route one outbound message through the reorder buffer. Returns the
   * messages to transmit right now, in transmit order. With no reorder
   * active this is the identity function.
   */
  pipe(item: WireItem): WireItem[] {
    const r = this.reorder;
    if (r === null) return [item];
    r.buffer.push(item);
    r.remaining--;
    const out: WireItem[] = [];
    if (r.buffer.length >= r.window || r.remaining <= 0) {
      shuffleInPlace(r.rng, r.buffer);
      out.push(...r.buffer);
      r.buffer = [];
    }
    if (r.remaining <= 0) this.reorder = null;
    return out;
  }

  status(now: number): FaultStatus {
    return {
      drop: { count: this.dropCount },
      reorder: {
        active: this.reorder !== null,
        window: this.reorder?.window ?? 0,
        remaining: this.reorder?.remaining ?? 0,
      },
      burst: {
        active: this.burstState !== null && now < this.burstState.until,
        factor: this.burstState?.factor ?? 0,
        remainingMs:
          this.burstState !== null ? Math.max(0, this.burstState.until - now) : 0,
      },
      stall: {
        active: now < this.stallUntil,
        remainingMs: Math.max(0, this.stallUntil - now),
      },
      gap: { totalSkipped: this.gapTotal },
      serverTime: now,
    };
  }
}
