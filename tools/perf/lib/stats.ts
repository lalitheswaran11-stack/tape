/** Small numeric helpers shared by burst.spec and the frame-budget run. */

import type { MetricsSnapshot } from '@lalithesh-star/tape-core';

/** Nearest-rank percentile over an UNSORTED sample (copies + sorts). */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function maxOf(samples: readonly number[]): number {
  let out = 0;
  for (const s of samples) if (s > out) out = s;
  return out;
}

export interface MetricsWindow {
  updatesIn: number;
  updatesApplied: number;
  /** Windowed coalesce ratio: ingested / applied within the window. */
  ratio: number;
}

/** Delta between two metric snapshots — a windowed view of coalescing. */
export function metricsWindow(a: MetricsSnapshot, b: MetricsSnapshot): MetricsWindow {
  const updatesIn = b.updatesIn - a.updatesIn;
  const updatesApplied = b.updatesApplied - a.updatesApplied;
  return {
    updatesIn,
    updatesApplied,
    ratio: updatesIn / Math.max(1, updatesApplied),
  };
}
