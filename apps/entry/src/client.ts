/**
 * The one TapeClient for this app. Created and connected at module load;
 * every component imports this instance.
 */

import { createTapeClient } from '@lalithesh-star/tape-core';

const url: string =
  (import.meta.env.VITE_TAPE_URL as string | undefined) ?? 'ws://localhost:4400';

export const client = createTapeClient({ url });
client.connect();
