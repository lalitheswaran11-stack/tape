# Migrating to the tape-react v2 subscription API

Audience: teams consuming `@lalithesh-star/tape-react`. This guide covers
the move from the v1 subscription pair (`useStream` + `useCoalesced`) to
the v2 hook `useSubscription`, introduced in **tape-react 1.1.0**.

## What changed, and why

In v1, opening a channel took two hooks: `useStream` created the
subscription, and each field's coalescing policy was registered
**imperatively** during the render phase with a separate `useCoalesced`
call. That design had a real flaw: the subscription's policy was never
visible in one place. It was assembled implicitly from however many
`useCoalesced` calls happened to run between `useStream` and the end of
the render — easy to scatter, easy to drift between components sharing a
channel (which the core rejects at runtime: one live policy per channel),
and impossible to type as a unit.

v2 makes the policy **declarative at the subscription site**. One hook,
one spec object, the whole subscription readable and typecheckable in
one place:

```tsx
// Before (v1 — deprecated)
const stream = useStream(client, 'instruments', { priority: 1 });
useCoalesced(stream, 'volume', 'accumulate');
useCoalesced(stream, 'trades', { policy: 'sequence', capacity: 512 });

// After (v2)
const stream = useSubscription(client, {
  channel: 'instruments',
  policy: {
    volume: 'accumulate',
    trades: { policy: 'sequence', capacity: 512 },
  },
  priority: 1,
});
```

The semantics you rely on are unchanged. `useSubscription` drives the
same internal stream machinery as the v1 pair:

- The subscription is established in an effect after commit.
- Re-rendering with a **semantically equal** spec does nothing — equality
  is deep policy equality after core normalization (`'sequence'` equals
  `{ policy: 'sequence', capacity: 256 }`) plus default-filled options
  (`{ priority: 0 }` equals omitting `priority`). Fresh object literals
  every render are fine; you do not need `useMemo`.
- A changed spec (policy, options, or channel) closes the old
  subscription and opens a new one.
- Strict mode's mount → unmount → remount cycle neither leaks nor
  double-subscribes.

## What does NOT change

`useRecord`, `useRecordIds`, `useConnectionState`, `useMetrics`, and the
components (`VirtualGrid`, `CanvasChart`, `ConnectionBanner`, `PerfHud`)
are **unchanged**. They accept the `Stream` handle returned by either
hook — you can migrate one subscription at a time.

## Deprecation timeline

| Version | Status |
| --- | --- |
| **1.1.0** (now) | `useSubscription` available. `useStream` and `useCoalesced` deprecated: `@deprecated` in the types, and each hook logs **one** `console.warn` per session on its first call (never per call). Fully functional otherwise — 1.1.0 is non-breaking. |
| **2.0.0** | `useStream` and `useCoalesced` are **removed**. |

## The codemod

`@lalithesh-star/tape-codemod` rewrites v1 call sites mechanically:

```
pnpm exec tape-codemod v1-to-v2 <paths...>        # rewrite in place
pnpm exec tape-codemod v1-to-v2 <paths...> --dry  # preview only, no writes
```

`<paths...>` are files or directories; `.ts` and `.tsx` files are
processed (parser: tsx). The transform is idempotent — running it over
already-migrated code changes nothing.

For each function scope it collapses

```ts
const s = useStream(client, CHANNEL, OPTS?);
useCoalesced(s, FIELD, POLICY);  // any number of these
```

into

```ts
const s = useSubscription(client, { channel: CHANNEL, policy: { FIELD: POLICY, ... }, ...OPTS });
```

removing the `useCoalesced` statements, and rewrites the
`@lalithesh-star/tape-react` import (drops `useStream` / `useCoalesced`
when no longer referenced, adds `useSubscription`, preserves everything
else including aliases). Multiple independent streams in one component
are each transformed separately, and the `policy` property is omitted
when a stream had no `useCoalesced` calls.

## What needs manual work

The codemod is deliberately conservative. When it cannot prove a rewrite
is safe it leaves the call site untouched and attaches a marker comment:

```
// TODO(tape-codemod): manual migration needed — <reason>
```

Search for `TODO(tape-codemod)` after running it. The bail-out cases:

- **Non-object-literal options** — `useStream(client, ch, makeOpts())` or
  an options object containing a spread. The codemod cannot know which
  properties to merge into the spec.
- **A stream it did not create** — `useCoalesced(stream, ...)` where
  `stream` was not created by a `useStream` in the same function (for
  example a stream received via props). Move the policy to that stream's
  `useSubscription` site by hand.
- **Dynamic field or policy expressions** — a field or policy argument
  that is not liftable verbatim (e.g. a function call like
  `pickPolicy(x)`). Identifiers, literals, and object literals are fine
  and are lifted as-is.
- **Conditional registration** — `useCoalesced` inside an `if`/loop.
  This violated the rules of hooks in v1 anyway; express the policy
  unconditionally in the spec.

A non-literal channel (`useStream(client, props.channel)`) is **not** a
bail-out — any channel expression passes through into `{ channel: ... }`.

## Checklist

1. Upgrade `@lalithesh-star/tape-react` to `^1.1.0`.
2. `pnpm exec tape-codemod v1-to-v2 src --dry` — review the preview.
3. `pnpm exec tape-codemod v1-to-v2 src` — apply.
4. Search for `TODO(tape-codemod)` and migrate those sites by hand.
5. Typecheck and run your tests. The deprecation warnings are gone when
   no v1 call sites remain.
6. You are ready for 2.0.0.
