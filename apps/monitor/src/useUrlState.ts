/**
 * useUrlState — one string of component state mirrored into a query param
 * via history.replaceState, restored from the URL on load. No router.
 *
 * State updates are immediate; the URL write trails by 150 ms so rapid
 * typing coalesces into one replaceState (Safari throttles replaceState).
 * Each write re-reads window.location, so multiple instances compose.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const WRITE_DELAY_MS = 150;

export function useUrlState(key: string): [string, (value: string) => void] {
  const [value, setValue] = useState<string>(
    () => new URLSearchParams(window.location.search).get(key) ?? '',
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = useCallback(
    (next: string) => {
      setValue(next);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const url = new URL(window.location.href);
        if (next === '') url.searchParams.delete(key);
        else url.searchParams.set(key, next);
        history.replaceState(null, '', url);
      }, WRITE_DELAY_MS);
    },
    [key],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return [value, set];
}
