# @lalithesh-star/tape-core

Framework-free core for real-time UIs. tape-core turns a WebSocket firehose
into frame-budgeted record updates behind a small API:

- **Transport** — socket lifecycle with heartbeat staleness detection
  (silent-death sockets are force-closed and reconnected) and full-jitter
  exponential backoff.
- **Sequencer** — per-channel `seq` tracking: duplicates dropped, small
  reorders healed in a holdback window, real gaps trigger a snapshot resync.
- **Coalescing buffer** — updates merge per field (`latest` / `accumulate` /
  `sequence`) into a pending map; ONE frame loop drains all channels in
  priority order under a flush budget. Under load, frames shed visibly
  (metrics), never silently.
- **Record store** — copy-on-write records with stable identity between
  flushes, a cached `ids()` array, and per-record notifications, designed for
  `useSyncExternalStore` consumers. A tick on one record never wakes
  subscribers of another.

The per-field coalescing contract lives in [`docs/POLICIES.md`](../../docs/POLICIES.md).

## API

```ts
import { createTapeClient, TAPE_DEFAULTS } from '@lalithesh-star/tape-core';

const client = createTapeClient({
  url: 'ws://localhost:4400',
  // snapshotUrl defaults to the ws url with ws→http / wss→https swapped
});

// One live subscription per channel; per-field coalescing policy.
const quotes = client.subscribe(
  'quotes',
  {
    last: 'latest',                            // newest value wins
    volume: 'accumulate',                      // deltas sum, nothing lost
    trades: { policy: 'sequence', capacity: 64 }, // bounded in-order ring
  },
  { priority: 1 }, // flushes before priority-0 channels under backpressure
);

client.onStateChange((state) => console.log('connection:', state));
client.onGap((gap) => console.warn('gap on', gap.channel, gap));
client.connect();

// Store reads are cheap and identity-stable between flushes.
const unsub = quotes.store.subscribeRecord('AAPL', () => {
  const rec = quotes.store.get('AAPL');
  console.log(rec?.fields.last, rec?.fields.volume);
});

quotes.store.onFlush((changedIds) => console.log('changed:', changedIds.size));
console.log(client.getMetrics().coalesceRatio);

unsub();
quotes.close();  // refcounted; at zero the channel unsubscribes
client.close();  // tear down sockets and timers
```

## Reconnect backoff (full jitter)

```
delay = random() * min(capMs, baseMs * 2^attempt)
```

`attempt` resets to 0 on every successful open. Defaults (see
`TAPE_DEFAULTS`): base 250 ms, cap 10 000 ms. On reconnect the client
re-sends `subscribe` for every active channel and reconciles each one
against a REST snapshot before going `live` again — no stale row survives.

## Zero dependencies, no DOM

tape-core has **zero runtime dependencies** and compiles against
`lib: ["ES2022"]` — no DOM types anywhere. Every environment touchpoint is
an injectable seam on `TapeClientOptions`, with sensible defaults read off
`globalThis`:

| Seam               | Default                                          |
| ------------------ | ------------------------------------------------ |
| `webSocketFactory` | `globalThis.WebSocket`                           |
| `fetchFn`          | `globalThis.fetch`                               |
| `scheduler`        | `requestAnimationFrame`, else `setTimeout(16ms)` |
| `timers`           | `setTimeout` / `clearTimeout`                    |
| `now`              | `performance.now`, else `Date.now`               |
| `random`           | `Math.random`                                    |

## Plain Node

Node 22 has global `WebSocket` and `fetch`, so the defaults just work
(frames fall back to a 16 ms `setTimeout` loop — only while there is
pending work; an idle client schedules nothing):

```ts
import { createTapeClient } from '@lalithesh-star/tape-core';

const client = createTapeClient({ url: 'ws://localhost:4400' });
const book = client.subscribe('book', { bid: 'latest', ask: 'latest' });
client.connect();
book.store.onFlush(() => {
  for (const id of book.store.ids()) console.log(book.store.get(id));
});
```

For tests (or exotic runtimes), inject fakes for all six seams and drive
time by hand — the entire client is deterministic under injected clocks.

## Scripts

```
pnpm --filter @lalithesh-star/tape-core build
pnpm --filter @lalithesh-star/tape-core typecheck
pnpm --filter @lalithesh-star/tape-core test
```
