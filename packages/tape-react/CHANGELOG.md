# Changelog — @lalithesh-star/tape-react

Format loosely follows [Keep a Changelog](https://keepachangelog.com/).
Versions correspond to git tags `react-v<version>`.

## 2.0.0 — 2026-08-09

### Removed

- **BREAKING:** `useStream` and `useCoalesced` (deprecated since 1.1.0) are
  removed, along with the render-phase pending-collection machinery that
  existed solely to serve `useCoalesced`. `useSubscription` is the only
  subscription API.

### Migration

- Migrate on 1.x first, then upgrade. The codemod rewrites v1 call sites
  mechanically: `pnpm exec tape-codemod v1-to-v2 <paths...>` (`--dry` to
  preview). See `docs/MIGRATION-v2.md` for the bail-out cases it marks with
  `TODO(tape-codemod)` comments.
- Both in-repo consumers were migrated this way ahead of the release
  (branches `migrate/monitor-v2`, `migrate/entry-v2`).
- Everything else is unchanged: `useRecord`, `useRecordIds`,
  `useConnectionState`, `useMetrics`, `VirtualGrid`, `CanvasChart`,
  `ConnectionBanner`, `PerfHud` accept the same `Stream` handle
  `useSubscription` returns.

## 1.1.0 — 2026-08-09

### Added

- `useSubscription(client, { channel, policy, priority, snapshot })` — the
  v2 subscription API as a non-breaking minor. Policy is declarative at the
  subscription site instead of assembled imperatively across `useCoalesced`
  calls; re-rendering with a semantically equal spec is a no-op (deep policy
  equality after core normalization — no `useMemo` needed).

### Deprecated

- `useStream` and `useCoalesced`: `@deprecated` JSDoc in the types plus a
  once-per-session `console.warn` on first call naming the replacement, the
  codemod command, and `docs/MIGRATION-v2.md`. Both remain fully functional
  in 1.x; removal lands in 2.0.0.

## 1.0.0 — 2026-08-09

### Added

- Initial stable release (tape platform 1.0.0).
- Subscription hooks: `useStream` + `useCoalesced` (the v1 pair —
  subscription and per-field coalescing policy registered separately).
- Data hooks: `useRecord`, `useRecordIds`; client hooks:
  `useConnectionState`, `useMetrics`.
- Components: `VirtualGrid` (per-visible-row subscriptions), `CanvasChart`
  (DPR-aware), `ConnectionBanner`, `PerfHud`.
