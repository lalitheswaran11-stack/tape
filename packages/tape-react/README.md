# @lalithesh-star/tape-react

React bindings for [`@lalithesh-star/tape-core`](../tape-core/README.md):
subscription hooks built on `useSyncExternalStore`, a virtualized grid with
**per-visible-row subscriptions**, a DPR-aware canvas chart, a connection
banner, and a performance HUD.

The subscription API is the declarative `useSubscription` hook. **2.0.0
removed** the imperative v1 pair (`useStream` + `useCoalesced`) that was
deprecated in 1.1.0 — if you are upgrading from 1.x, see
[Migrating from 1.x](#migrating-from-1x) below.

## The hooks

| Hook | What it does |
| --- | --- |
| `useSubscription(client, spec)` | **The subscription API.** `spec` is `{ channel, policy?, priority?, snapshot? }` — the whole subscription, including every field's coalescing policy, declared in one place. Returns a `Stream` handle, stable for the component instance. |
| `useRecord(stream, id)` | The record, via a per-record store subscription — re-renders **only** when that record changes. `undefined` before the subscription is live (no tearing). |
| `useRecordIds(stream)` | The store's cached ids array — re-renders on membership changes only, never on value ticks. |
| `useConnectionState(client)` | `'idle' \| 'connecting' \| 'live' \| 'degraded' \| 'resyncing' \| 'disconnected'`, event-driven. |
| `useMetrics(client, intervalMs?)` | Polls `getMetrics()` (default every 500 ms). |

### How useSubscription works

The subscription is established in an effect after the render commits.
On every re-render the spec is compared against the live subscription
**semantically**: policies deep-equal after core's `resolveFieldPolicy`
normalization (so `'sequence'` equals `{ policy: 'sequence', capacity:
256 }`), options default-filled (`{ priority: 0 }` equals omitting
`priority`). Equal → nothing happens — fresh object literals every render
are fine, no `useMemo` needed. Changed → the old subscription is closed
and a new one opened. Unmount closes. Under React strict mode's
mount → unmount → remount cycle this closes and cleanly resubscribes —
tape-core's refcounted `subscribe` guarantees no leak and no
double-subscription.

One caveat inherited from the core: a channel has **one live policy**. If
two mounted components open the same channel with different policies, the
second `subscribe` throws (a programming error by design). Keep policy
spellings identical across components that share a channel.

## Full example

```tsx
import { createTapeClient } from '@lalithesh-star/tape-core';
import {
  ConnectionBanner, PerfHud, useRecordIds, useSubscription, VirtualGrid,
} from '@lalithesh-star/tape-react';
import type { ColumnDef } from '@lalithesh-star/tape-react';

const client = createTapeClient({ url: 'ws://localhost:4400' });
client.connect();

const columns: ColumnDef[] = [
  { key: 'last',   header: 'Last',  align: 'right',
    cellClass: (v) => (typeof v === 'number' && v < 0 ? 'down' : undefined) },
  { key: 'volume', header: 'Vol',   align: 'right', width: 90 },
  { key: 'trades', header: 'Prints', width: 70,
    format: (v) => (Array.isArray(v) ? v.length : 0) },
];

function Quotes() {
  const stream = useSubscription(client, {
    channel: 'quotes',
    policy: {
      last: 'latest',                              // newest value wins
      volume: 'accumulate',                        // deltas sum, nothing lost
      trades: { policy: 'sequence', capacity: 64 },
    },
    priority: 1,
  });

  const ids = useRecordIds(stream); // the app owns filtering/sorting

  return (
    <div style={{ height: 480, display: 'flex', flexDirection: 'column' }}>
      <ConnectionBanner client={client} />
      <VirtualGrid
        stream={stream}
        ids={ids}
        columns={columns}
        rowHeight={28}
        onRowClick={(id) => console.log('selected', id)}
      />
      <PerfHud client={client} /> {/* press ` to toggle */}
    </div>
  );
}
```

## Migrating from 1.x

**2.0.0 removed `useStream` and `useCoalesced`** (deprecated since
1.1.0). Their replacement is `useSubscription(client, { channel, policy,
priority, snapshot })` — the same subscription expressed as one
declarative spec instead of imperative render-phase policy registration.
The `Stream` handle it returns works with `useRecord` / `useRecordIds` /
`VirtualGrid` / `CanvasChart` exactly as before; nothing else in the
package changed shape.

If you are on 1.x, migrate **before** upgrading: most call sites rewrite
mechanically with the codemod (run it against your 1.x sources):

```
pnpm exec tape-codemod v1-to-v2 src        # add --dry to preview
```

then search for `TODO(tape-codemod)` markers and finish those few sites
by hand. The full guide, including every bail-out case, is
[docs/MIGRATION-v2.md](../../docs/MIGRATION-v2.md).

## Per-visible-row subscriptions — why this grid stays fast

The trap with virtualized real-time grids: the grid subscribes to the
stream, so **every tick re-renders the whole viewport** — 30 rows × N
columns of vDOM per update, even though one cell changed. Virtualization
solved the DOM size problem and silently created a render-frequency one.

`VirtualGrid` inverts it. The grid component itself subscribes to
*nothing*; it only windows `ids` (spacer div for total height, absolutely
positioned rows via `translateY`, viewport height from a ResizeObserver).
Each **visible row** is its own memoized component calling
`useRecord(stream, id)` — and tape-core's store notifies **only the
subscribers of records that changed in a flush**. A tick on one record
re-renders exactly one row; a tick on an off-screen record renders
nothing; scrolling changes only which rows are mounted.

That property is observable: `readRowRenderCount()` exposes a module-level
counter incremented once per row render. The PerfHud graphs it as "row
renders/s", and the test suite asserts one tick → exactly one row render.

## CanvasChart and device pixel ratio

`CanvasChart` draws one record field as a single-series line: recessive
grid, min/max and value labels in the text color, direction-colored
current-point dot, crosshair + tooltip on hover — all in **one canvas
pass**, at most **one draw per animation frame**, and only when new data
arrived (dirty flag). Ticks never touch the DOM.

The canvas backing store is sized `cssPixels * devicePixelRatio` with
`ctx.scale(dpr, dpr)` re-applied once per resize (ResizeObserver).
Without this, a 400 px-wide chart on a 2× display rasterizes at 400
device pixels and every line and glyph is blurry. Colors are props with
dark defaults: `line '#58a6ff'`, `up '#3fb950'`, `down '#f85149'`,
`grid 'rgba(139,148,158,0.15)'`, `text '#8b949e'`.

## PerfHud

Toggled with the **backquote key** (`` ` ``, `KeyboardEvent.code
'Backquote'`; configurable via `toggleKey`). While visible it runs one rAF
loop that only records frame intervals, and every `sampleMs` (default
500 ms) publishes: FPS, p95 frame interval, longest recent frame,
messages/s, coalesce ratio, deferred frames, stale drops, gaps,
reconnects, p95 flush ms, and row renders/s.

## Theming

Components use inline styles driven by CSS custom properties with dark
defaults — override any of `--tape-bg`, `--tape-text`, `--tape-text-dim`,
`--tape-border`, `--tape-selected`, `--tape-pill-bg`, `--tape-hud-bg`, and
the state colors (`--tape-live`, `--tape-degraded`, `--tape-resyncing`,
`--tape-connecting`, `--tape-disconnected`, `--tape-idle`). Every
component accepts `className` and `style`.

## Scripts

```
pnpm --filter @lalithesh-star/tape-react build
pnpm --filter @lalithesh-star/tape-react typecheck
pnpm --filter @lalithesh-star/tape-react test
```

Tests drive a **real** `createTapeClient` through injected fakes (socket,
timers, frame scheduler, fetch) plus jsdom stubs for ResizeObserver,
requestAnimationFrame, and a recording Canvas 2D context — fully
deterministic, no sleeps.
