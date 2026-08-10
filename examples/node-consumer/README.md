# @tape/example-node-consumer

The no-React boundary proof.

`@lalitheswaran11-stack/tape-core` claims to be framework-free: every
environment-specific dependency — WebSocket construction, fetch, frame
scheduling, timers, clock, randomness — enters through an injectable seam
with sensible defaults, and the core never touches React or the DOM. That
claim is only real if the package runs in an environment that has none of
those things provided by a browser or a test harness.

This example is that environment: plain Node 22, zero injected seams.

- `globalThis.WebSocket` and `fetch` come from Node itself.
- The frame scheduler falls back to `setTimeout` because
  `requestAnimationFrame` does not exist here.
- No bundler, no JSX, no test doubles — just `node index.mjs`.

It connects to a running tape feed, subscribes to `instruments` (with
`latest` price fields and an `accumulate` volume) and `tape` (a `sequence`
trade log), runs for a few seconds, then prints a JSON summary: record
counts, one sample record, and the full metrics snapshot. It exits non-zero
if it saw no records, no messages, or a coalesce ratio below 1 — so it
doubles as a live smoke test of the whole platform boundary.

## Run

Start the feed, then:

```sh
# default: ws://localhost:4499 for ~3 seconds
node index.mjs

# explicit URL and a longer window (useful for reconnect testing)
node index.mjs ws://localhost:4400 --duration 8000
```
