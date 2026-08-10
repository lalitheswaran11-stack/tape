/**
 * The one TapeClient for the app. Components never call client.subscribe
 * directly — they go through the v1 hooks (useStream + useCoalesced).
 */

import { createTapeClient } from '@lalithesh-star/tape-core';

// Feed url priority: '?feed=' query param (lets the perf harness point one
// page at a different feed), then build-time env, then the local default.
const url =
  new URLSearchParams(window.location.search).get('feed') ??
  (import.meta.env.VITE_TAPE_URL as string | undefined) ??
  'ws://localhost:4400';

export const client = createTapeClient({ url });
// Exposed for instrumentation (perf harness reads metrics/state); not API.
(globalThis as Record<string, unknown>).__tapeClient = client;
client.connect();
