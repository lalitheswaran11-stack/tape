/**
 * useRecord / useRecordIds — useSyncExternalStore over the stream's store.
 *
 * Both subscribe THROUGH the stream handle, so they work before the
 * subscription exists (returning undefined / an empty-array constant
 * without tearing) and wake up exactly once when the store arrives or is
 * replaced. useRecord attaches per record: a tick on another record never
 * re-renders this component.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { Fields, TapeRecord } from '@lalitheswaran11-stack/tape-core';
import { asHandle } from './stream';
import type { Stream } from './stream';

const EMPTY_IDS: readonly string[] = Object.freeze([]);

export function useRecord<F extends Fields = Fields>(
  stream: Stream,
  id: string,
): TapeRecord<F> | undefined {
  const handle = asHandle(stream, 'useRecord');
  const subscribe = useCallback(
    (cb: () => void) => handle.subscribeRecordThrough(id, cb),
    [handle, id],
  );
  const read = useCallback(() => handle.store?.get(id), [handle, id]);
  return useSyncExternalStore(subscribe, read, read) as
    | TapeRecord<F>
    | undefined;
}

export function useRecordIds(stream: Stream): readonly string[] {
  const handle = asHandle(stream, 'useRecordIds');
  const subscribe = useCallback(
    (cb: () => void) => handle.subscribeIdsThrough(cb),
    [handle],
  );
  const read = useCallback((): readonly string[] => {
    const store = handle.store;
    return store === null ? EMPTY_IDS : store.ids();
  }, [handle]);
  return useSyncExternalStore(subscribe, read, read);
}
