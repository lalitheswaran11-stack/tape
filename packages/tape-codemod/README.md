# @lalitheswaran11-stack/tape-codemod

jscodeshift codemods for `@lalitheswaran11-stack/tape-react` major-version
migrations.

## v1-to-v2

Collapses the deprecated render-phase pair into the declarative v2 hook.
Within each function scope,

```tsx
const stream = useStream(client, 'instruments', { priority: 1 });
useCoalesced(stream, 'volume', 'accumulate');
useCoalesced(stream, 'trades', { policy: 'sequence', capacity: 512 });
```

becomes

```tsx
const stream = useSubscription(client, {
  channel: 'instruments',
  policy: {
    volume: 'accumulate',
    trades: { policy: 'sequence', capacity: 512 },
  },
  priority: 1,
});
```

with the `useCoalesced` statements removed and the
`@lalitheswaran11-stack/tape-react` import rewritten: `useStream` /
`useCoalesced` are dropped once nothing in the file references them,
`useSubscription` is added once, and every other specifier — including
aliases, and aliased imports of the two v1 hooks — is preserved.
Multiple independent streams in one component each transform separately;
a stream with no `useCoalesced` calls gets a spec without a `policy`
property. Options object-literal properties (`priority`, `snapshot`) are
merged into the spec after `channel`/`policy`.

## Usage

```
pnpm exec tape-codemod v1-to-v2 <paths...>        # rewrite in place
pnpm exec tape-codemod v1-to-v2 <paths...> --dry  # preview, write nothing
```

`<paths...>` are files or directories. The CLI spawns jscodeshift with
`--parser=tsx --extensions=ts,tsx`, so `.ts` and `.tsx` files are
processed. The transform is idempotent — re-running it (including over a
half-migrated codebase) changes nothing that is already migrated.

## What it cannot do automatically

Call sites the transform cannot migrate provably-safely are left
untouched and annotated:

```
// TODO(tape-codemod): manual migration needed — <reason>
```

Search for `TODO(tape-codemod)` afterwards. It bails when:

- the `useStream` options argument is not an inline object literal, or
  contains a spread (`{ ...defaults }`) — it cannot know which
  properties to merge into the spec;
- a `useCoalesced` references a stream variable that was not created by
  a `useStream` in the **same** function (e.g. a stream passed in via
  props) — move that policy to the stream's `useSubscription` site by
  hand;
- a field or policy argument cannot be lifted verbatim (e.g. a function
  call like `pickPolicy(mode)`); literals, identifiers, and object
  literals of those are lifted as-is;
- `useCoalesced` appears inside a conditional or loop (which violated
  the rules of hooks in v1 anyway);
- a `useStream` call is not a plain
  `const stream = useStream(...)` statement at the top level of a
  function body.

A **non-literal channel is fine** — any channel expression passes
through into `{ channel: <expr> }` unchanged.

Formatting note: recast (jscodeshift's printer) inserts blank lines
around multi-line property values in the generated spec object. The
output is valid and stable (idempotent); run your formatter afterwards
if you want it house-style.

See the full migration guide: `docs/MIGRATION-v2.md` at the repo root.
