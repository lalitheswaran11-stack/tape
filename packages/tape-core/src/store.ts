/**
 * RecordStore implementation.
 *
 * Copy-on-write at flush: each changed record gets a brand-new fields object
 * (spread of the previous fields plus the staged changes; sequence fields
 * become a new capped array), so a record's object identity is stable
 * between flushes and replaced exactly when it changes — that identity is
 * what useSyncExternalStore consumers key on.
 *
 * ids() returns a cached array replaced only when membership changes.
 * After each flush only the CHANGED ids are notified — a tick on one record
 * never wakes subscribers of another.
 */

import type { FieldValue, SequenceEntry, SnapshotRecord } from './protocol';
import type { CompiledPolicy } from './policy';
import type { RecordStore, TapeRecord, Unsubscribe } from './types';
import type { Metrics } from './metrics';
import type { PendingRecord } from './buffer';

type MutableFields = Record<string, FieldValue | readonly SequenceEntry[]>;

export class TapeStore implements RecordStore {
  private readonly records = new Map<string, TapeRecord>();
  private cachedIds: readonly string[] = [];
  private readonly recordSubs = new Map<string, Set<() => void>>();
  private readonly idsSubs = new Set<() => void>();
  private readonly flushSubs = new Set<(ids: ReadonlySet<string>) => void>();

  constructor(
    private readonly compiled: CompiledPolicy,
    private readonly metrics: Metrics,
  ) {}

  get(id: string): TapeRecord | undefined {
    return this.records.get(id);
  }

  ids(): readonly string[] {
    return this.cachedIds;
  }

  size(): number {
    return this.records.size;
  }

  subscribeRecord(id: string, cb: () => void): Unsubscribe {
    let subs = this.recordSubs.get(id);
    if (subs === undefined) {
      subs = new Set();
      this.recordSubs.set(id, subs);
    }
    subs.add(cb);
    return () => {
      const current = this.recordSubs.get(id);
      if (current !== undefined) {
        current.delete(cb);
        if (current.size === 0) this.recordSubs.delete(id);
      }
    };
  }

  subscribeIds(cb: () => void): Unsubscribe {
    this.idsSubs.add(cb);
    return () => this.idsSubs.delete(cb);
  }

  onFlush(cb: (changedIds: ReadonlySet<string>) => void): Unsubscribe {
    this.flushSubs.add(cb);
    return () => this.flushSubs.delete(cb);
  }

  /**
   * Apply one channel's pending coalesce map. Returns the number of record
   * writes performed (one per changed record — the denominator of
   * coalesceRatio).
   */
  flushPending(pending: Map<string, PendingRecord>): number {
    if (pending.size === 0) return 0;
    let written = 0;
    let membershipChanged = false;
    const changed = new Set<string>();
    for (const [id, pend] of pending) {
      const prev = this.records.get(id);
      const fields: MutableFields =
        prev === undefined ? {} : { ...prev.fields };
      for (const [key, cell] of pend.fields) {
        if (cell.policy === 'latest') {
          fields[key] = cell.value;
        } else if (cell.policy === 'accumulate') {
          const current = fields[key];
          fields[key] = (typeof current === 'number' ? current : 0) + cell.sum;
        } else {
          const current = fields[key];
          const prevEntries: readonly SequenceEntry[] = Array.isArray(current)
            ? current
            : [];
          const added = cell.entries ?? [];
          let next: readonly SequenceEntry[] = prevEntries.concat(added);
          if (next.length > cell.capacity) {
            next = next.slice(next.length - cell.capacity);
          }
          fields[key] = next;
        }
      }
      if (prev === undefined) membershipChanged = true;
      this.records.set(id, { id, fields, ts: pend.ts });
      changed.add(id);
      written++;
    }
    if (membershipChanged) this.rebuildIds();
    this.notify(changed, membershipChanged);
    return written;
  }

  /**
   * Wholesale replace from a REST snapshot: clear + rebuild, notify every
   * previously-or-newly present id, notify ids subscribers if membership
   * changed. An empty snapshot clears the store and still notifies — no
   * stale row survives a resync.
   */
  applySnapshot(snapshotRecords: readonly SnapshotRecord[]): void {
    const affected = new Set<string>(this.records.keys());
    const before = this.cachedIds;
    this.records.clear();
    for (const rec of snapshotRecords) {
      const fields: MutableFields = {};
      const src = rec.fields;
      for (const key in src) {
        const value = src[key];
        if (value === undefined) continue;
        const resolved = this.compiled.for(key);
        if (resolved.policy === 'sequence') {
          // Snapshots carry an entry array; cap it, keeping the newest.
          const entries: readonly SequenceEntry[] = Array.isArray(value)
            ? value
            : value === null
              ? []
              : [value as unknown as SequenceEntry];
          fields[key] =
            entries.length > resolved.capacity
              ? entries.slice(entries.length - resolved.capacity)
              : entries.slice();
        } else {
          // accumulate fields are ABSOLUTE in snapshots; store as-is.
          fields[key] = value as FieldValue;
        }
      }
      this.records.set(rec.id, { id: rec.id, fields, ts: rec.ts });
      affected.add(rec.id);
    }
    let membershipChanged = before.length !== this.records.size;
    if (!membershipChanged) {
      for (const id of before) {
        if (!this.records.has(id)) {
          membershipChanged = true;
          break;
        }
      }
    }
    if (membershipChanged) this.rebuildIds();
    this.metrics.snapshotsLoaded++;
    this.notify(affected, membershipChanged);
  }

  private rebuildIds(): void {
    this.cachedIds = Array.from(this.records.keys());
  }

  private notify(
    changed: ReadonlySet<string>,
    membershipChanged: boolean,
  ): void {
    for (const id of changed) {
      const subs = this.recordSubs.get(id);
      if (subs !== undefined) {
        for (const cb of subs) cb();
      }
    }
    if (membershipChanged) {
      for (const cb of this.idsSubs) cb();
    }
    for (const cb of this.flushSubs) cb(changed);
  }
}
