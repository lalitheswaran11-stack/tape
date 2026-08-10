/**
 * Deterministic fixture for the Tier 1 microbenchmark: a 10 000-instrument
 * universe snapshot plus a stream of pre-encoded `update` frames shaped like
 * the real feed.
 *
 * Determinism: everything derives from mulberry32 seeded with 42. Two runs of
 * buildFixture(N) produce byte-identical frames, so run-to-run deltas are the
 * code under test, never the workload.
 *
 * Shape (mirrors services/feed):
 * - Most messages hit the `instruments` channel: 1–8 record updates each,
 *   fields bid/ask/last/change with `latest` semantics and volume as an
 *   `accumulate` delta.
 * - Every ~10th message is a `tape` channel update carrying ONE trades entry
 *   (a `sequence` field), spread over the 1 000 most-active instruments.
 * - Per-channel seq increases by exactly 1 from the snapshot's seq — the
 *   sequencer's fast path, verified by the bench's metric tripwires.
 *
 * Frames are pre-encoded ONCE into an array of strings before any timing
 * starts: the bench measures tape-core, not fixture generation.
 */

import type {
  RecordUpdate,
  SnapshotRecord,
  SnapshotResponse,
  UpdateMessage,
} from '@lalitheswaran11-stack/tape-core';

export const UNIVERSE_SIZE = 10_000;
export const TAPE_RECORD_COUNT = 1_000;
export const INSTRUMENTS_SNAPSHOT_SEQ = 1_000;
export const TAPE_SNAPSHOT_SEQ = 500;
export const SEED = 42;

/** Small, fast, deterministic PRNG (Tommy Ettinger's mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Fixture {
  instrumentsSnapshot: SnapshotResponse;
  tapeSnapshot: SnapshotResponse;
  /** Pre-encoded JSON `update` frames, ready for socket.onmessage. */
  frames: readonly string[];
  messageCount: number;
  tapeMessageCount: number;
  /** Total RecordUpdates across all frames — the updatesIn tripwire. */
  recordUpdateCount: number;
}

function instrumentId(i: number): string {
  return 'INS-' + String(i).padStart(5, '0');
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function buildFixture(messageCount: number): Fixture {
  const rng = mulberry32(SEED);

  // --- Snapshots -----------------------------------------------------------
  const instrumentRecords: SnapshotRecord[] = [];
  for (let i = 0; i < UNIVERSE_SIZE; i++) {
    const mid = round2(5 + rng() * 995);
    instrumentRecords.push({
      id: instrumentId(i),
      fields: {
        bid: round2(mid - 0.05),
        ask: round2(mid + 0.05),
        last: mid,
        change: 0,
        // accumulate fields are ABSOLUTE in snapshots (protocol.ts).
        volume: Math.floor(rng() * 1_000_000),
      },
      ts: 1,
    });
  }
  const instrumentsSnapshot: SnapshotResponse = {
    channel: 'instruments',
    seq: INSTRUMENTS_SNAPSHOT_SEQ,
    serverTime: 0,
    records: instrumentRecords,
  };

  // The tape channel tracks the 1 000 most-active instruments; sequence
  // fields appear in snapshots as entry arrays (empty at the start of day).
  const tapeRecords: SnapshotRecord[] = [];
  for (let i = 0; i < TAPE_RECORD_COUNT; i++) {
    tapeRecords.push({ id: instrumentId(i), fields: { trades: [] }, ts: 1 });
  }
  const tapeSnapshot: SnapshotResponse = {
    channel: 'tape',
    seq: TAPE_SNAPSHOT_SEQ,
    serverTime: 0,
    records: tapeRecords,
  };

  // --- Update stream -------------------------------------------------------
  const frames: string[] = [];
  let instrumentsSeq = INSTRUMENTS_SNAPSHOT_SEQ;
  let tapeSeq = TAPE_SNAPSHOT_SEQ;
  let tapeMessageCount = 0;
  let recordUpdateCount = 0;

  for (let m = 0; m < messageCount; m++) {
    const ts = 1_770_000_000_000 + m;
    let msg: UpdateMessage;
    if ((m + 1) % 10 === 0) {
      // Tape message: one trades entry on one active instrument.
      tapeMessageCount++;
      recordUpdateCount++;
      msg = {
        type: 'update',
        channel: 'tape',
        seq: ++tapeSeq,
        updates: [
          {
            id: instrumentId(Math.floor(rng() * TAPE_RECORD_COUNT)),
            fields: {
              trades: {
                price: round2(5 + rng() * 995),
                size: 1 + Math.floor(rng() * 900),
                side: rng() < 0.5 ? 'buy' : 'sell',
                t: ts,
              },
            },
            ts,
          },
        ],
      };
    } else {
      // Instruments message: 1–8 record updates across the whole universe.
      const n = 1 + Math.floor(rng() * 8);
      const updates: RecordUpdate[] = [];
      for (let u = 0; u < n; u++) {
        const mid = round2(5 + rng() * 995);
        updates.push({
          id: instrumentId(Math.floor(rng() * UNIVERSE_SIZE)),
          fields: {
            bid: round2(mid - 0.05),
            ask: round2(mid + 0.05),
            last: mid,
            change: round2(rng() * 4 - 2),
            // Delta on the wire — the `accumulate` policy sums these.
            volume: 1 + Math.floor(rng() * 500),
          },
          ts,
        });
      }
      recordUpdateCount += n;
      msg = {
        type: 'update',
        channel: 'instruments',
        seq: ++instrumentsSeq,
        updates,
      };
    }
    frames.push(JSON.stringify(msg));
  }

  return {
    instrumentsSnapshot,
    tapeSnapshot,
    frames,
    messageCount,
    tapeMessageCount,
    recordUpdateCount,
  };
}

/**
 * One representative pre-encoded frame for the calibration workload. Fixed
 * literal — NOT drawn from the rng stream — so calibration is identical
 * regardless of fixture size.
 */
export const CALIBRATION_FRAME: string = JSON.stringify({
  type: 'update',
  channel: 'instruments',
  seq: 123_456,
  updates: [
    {
      id: 'INS-00042',
      fields: { bid: 101.23, ask: 101.27, last: 101.25, change: -0.42, volume: 137 },
      ts: 1_770_000_000_000,
    },
    {
      id: 'INS-01337',
      fields: { bid: 55.1, ask: 55.12, last: 55.11, change: 0.08, volume: 12 },
      ts: 1_770_000_000_001,
    },
    {
      id: 'INS-09001',
      fields: { bid: 903.4, ask: 903.9, last: 903.65, change: 1.9, volume: 450 },
      ts: 1_770_000_000_002,
    },
    {
      id: 'INS-00007',
      fields: { bid: 7.77, ask: 7.79, last: 7.78, change: -0.01, volume: 88 },
      ts: 1_770_000_000_003,
    },
  ],
});
