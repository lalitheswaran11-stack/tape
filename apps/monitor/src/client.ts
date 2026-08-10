/**
 * The one TapeClient for the app. Components never call client.subscribe
 * directly — they go through the v1 hooks (useStream + useCoalesced).
 */

import { createTapeClient } from '@lalithesh-star/tape-core';

const url =
  (import.meta.env.VITE_TAPE_URL as string | undefined) ??
  'ws://localhost:4400';

export const client = createTapeClient({ url });
client.connect();
