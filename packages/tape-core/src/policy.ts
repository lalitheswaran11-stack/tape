/**
 * Per-field coalescing policy: what happens to a field when messages outrun
 * frames. The buffer applies at most one write per record per frame; the
 * policy decides what that write contains.
 *
 * - `latest`     keep the newest value; intermediates are dropped.
 * - `accumulate` updates are numeric deltas; within a frame they are summed.
 *                Nothing is lost — arrival granularity is.
 * - `sequence`   every entry is kept in arrival order in a bounded ring.
 *
 * The full consumer-facing contract lives in docs/POLICIES.md.
 */

export type FieldPolicy = 'latest' | 'accumulate' | 'sequence';

export interface SequencePolicyOptions {
  policy: 'sequence';
  /** Entries retained per record; oldest are evicted. Default 256. */
  capacity?: number;
}

export type PolicyEntry = FieldPolicy | SequencePolicyOptions;

/** Field name → policy. Fields not listed default to `latest`. */
export type PolicySpec = Readonly<Record<string, PolicyEntry>>;

export interface ResolvedFieldPolicy {
  readonly policy: FieldPolicy;
  readonly capacity: number;
}

export const DEFAULT_SEQUENCE_CAPACITY = 256;

const LATEST: ResolvedFieldPolicy = { policy: 'latest', capacity: 0 };

export function resolveFieldPolicy(
  spec: PolicySpec,
  field: string,
): ResolvedFieldPolicy {
  const entry = spec[field];
  if (entry === undefined) return LATEST;
  if (typeof entry === 'string') {
    return entry === 'sequence'
      ? { policy: 'sequence', capacity: DEFAULT_SEQUENCE_CAPACITY }
      : { policy: entry, capacity: 0 };
  }
  return {
    policy: 'sequence',
    capacity: entry.capacity ?? DEFAULT_SEQUENCE_CAPACITY,
  };
}

/**
 * Pre-resolved lookup for the ingest hot path — resolve once per
 * subscription, not once per field per message.
 */
export interface CompiledPolicy {
  for(field: string): ResolvedFieldPolicy;
}

export function compilePolicy(spec: PolicySpec): CompiledPolicy {
  const cache = new Map<string, ResolvedFieldPolicy>();
  for (const field of Object.keys(spec)) {
    cache.set(field, resolveFieldPolicy(spec, field));
  }
  return {
    for(field: string): ResolvedFieldPolicy {
      let resolved = cache.get(field);
      if (resolved === undefined) {
        resolved = LATEST;
        cache.set(field, resolved);
      }
      return resolved;
    },
  };
}
