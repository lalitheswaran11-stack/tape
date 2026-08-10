/**
 * Per-channel sequencing over the wire's monotonically increasing `seq`.
 *
 * For an incoming update with seq `s` against the last delivered seq:
 * - `s === last + 1`  deliver immediately, then drain any held messages that
 *                     have become contiguous.
 * - `s <= last`       duplicate or stale — drop and count `staleDropped`.
 * - `s >  last + 1`   hold in a small reorder buffer. If the missing seqs
 *                     arrive before the buffer exceeds `window` messages and
 *                     before `timeoutMs` elapses, everything is released in
 *                     order and counted as `reordersHealed`. Otherwise a gap
 *                     is declared: `gapsDetected` is counted, the gap event
 *                     fires, and the sequencer deactivates until the owner
 *                     resyncs the channel and calls reset().
 *
 * All timing goes through the injected TimerScheduler.
 */

import type { UpdateMessage } from './protocol';
import type { GapEvent, TimerScheduler } from './types';
import type { Metrics } from './metrics';

export interface SequencerOptions {
  channel: string;
  /** Max out-of-order messages held back awaiting a missing seq. */
  window: number;
  /** Max time (ms) to hold before declaring a gap. */
  timeoutMs: number;
  timers: TimerScheduler;
  metrics: Metrics;
  /** Called with each message as it becomes deliverable, in seq order. */
  onDeliver: (msg: UpdateMessage) => void;
  /** Called once when a gap is declared; the sequencer is inactive after. */
  onGap: (gap: GapEvent) => void;
}

export class ChannelSequencer {
  private lastSeq = 0;
  private active = false;
  private readonly held = new Map<number, UpdateMessage>();
  private holdTimer: unknown = null;

  constructor(private readonly opts: SequencerOptions) {}

  /**
   * (Re)arm the sequencer at a known baseline: `lastSeq` is the seq of the
   * snapshot (or subscribe ack) already reflected in the store; delivery
   * resumes at `lastSeq + 1`.
   */
  reset(lastSeq: number): void {
    this.lastSeq = lastSeq;
    this.active = true;
    this.held.clear();
    this.cancelTimer();
  }

  /** Stop delivering and drop held state (socket loss, resync, teardown). */
  deactivate(): void {
    this.active = false;
    this.held.clear();
    this.cancelTimer();
  }

  push(msg: UpdateMessage): void {
    if (!this.active) return;
    const seq = msg.seq;
    if (seq <= this.lastSeq) {
      this.opts.metrics.staleDropped++;
      return;
    }
    if (seq === this.lastSeq + 1) {
      this.lastSeq = seq;
      this.opts.onDeliver(msg);
      this.drainHeld();
      return;
    }
    // Out of order: hold, awaiting the missing seq(s).
    if (this.held.has(seq)) {
      this.opts.metrics.staleDropped++;
      return;
    }
    this.held.set(seq, msg);
    if (this.held.size > this.opts.window) {
      this.fireGap();
      return;
    }
    if (this.holdTimer === null) {
      this.holdTimer = this.opts.timers.schedule(() => {
        this.holdTimer = null;
        this.fireGap();
      }, this.opts.timeoutMs);
    }
  }

  private drainHeld(): void {
    let healed = 0;
    let next = this.held.get(this.lastSeq + 1);
    while (next !== undefined) {
      this.held.delete(next.seq);
      this.lastSeq = next.seq;
      this.opts.onDeliver(next);
      healed++;
      next = this.held.get(this.lastSeq + 1);
    }
    if (healed > 0) this.opts.metrics.reordersHealed += healed;
    if (this.held.size === 0) this.cancelTimer();
  }

  private fireGap(): void {
    let received = Number.POSITIVE_INFINITY;
    for (const seq of this.held.keys()) {
      if (seq < received) received = seq;
    }
    const gap: GapEvent = {
      channel: this.opts.channel,
      expected: this.lastSeq + 1,
      received,
    };
    this.opts.metrics.gapsDetected++;
    this.held.clear();
    this.cancelTimer();
    this.active = false;
    this.opts.onGap(gap);
  }

  private cancelTimer(): void {
    if (this.holdTimer !== null) {
      this.opts.timers.cancel(this.holdTimer);
      this.holdTimer = null;
    }
  }
}
