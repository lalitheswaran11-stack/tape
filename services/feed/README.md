# @tape/feed

Deterministic, seeded market-data feed for the Tape platform: a WebSocket
update stream plus a REST snapshot, with fault-injection endpoints that
scenario tests drive to exercise client resilience (gap detection, reorder
healing, reconnect, snapshot resync).

```sh
pnpm --filter @tape/feed dev            # boot on :4400 with defaults
pnpm --filter @tape/feed dev -- --port 4500 --seed 7 --rate 1000
pnpm --filter @tape/feed typecheck
pnpm --filter @tape/feed test
```

## Channels

| Channel       | Records                 | Encoding                                                                                       |
| ------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `instruments` | one per instrument, `id = symbol` | Fields `symbol, bid, ask, last, open, change, volume`. `volume` is **delta-encoded** in updates and absolute in snapshots (the `accumulate` policy); all other fields are absolute. Each update message carries 1–8 record updates. |
| `tape`        | single record `id = 'global'` | The `trades` field is **sequence-encoded**: each update carries exactly one entry `{ sym, price, size, side, ts }`; the snapshot carries the most recent 256 entries as an array. |

Roughly 90% of update messages go to `instruments` and 10% to `tape`,
interleaved deterministically from the seed. Prices follow a bounded random
walk (clamped to `[open/2, open*2]`, integer cents internally) so values look
alive but stay sane: `bid < last-ish < ask`, `change` recomputed from `open`
on every step.

## Message flow

1. **Connect** to `ws://host:port`. The server sends
   `hello { serverTime, channels }`.
2. **Subscribe** with `{ type: 'subscribe', channel }`. The server acks
   `subscribed { channel, seq }` where `seq` is the last update applied to
   that channel; updates then stream with seqs `seq+1, seq+2, …`,
   incrementing by exactly 1 per update message. Unknown channels get an
   `error` message.
3. **Resync** any time via `GET /snapshot?channel=X`, which returns
   `{ channel, seq, serverTime, records }` — the full record set as of update
   `seq`. Apply the snapshot, then replay only updates with
   `seq > snapshot.seq` to converge on server state.
4. `ping { t }` → `pong { t, serverTime }`; `unsubscribe` → `unsubscribed`.

Generation is shared and authoritative: one stream, applied to server state
at generation time. Every subscriber of a channel sees the same messages with
the same seqs.

## REST endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/snapshot?channel=X` | GET | Full record set + `seq` of last applied update. 404 for unknown channels. |
| `/healthz` | GET | `{ ok: true }` |
| `/info` | GET | Seed, rate, instrument count, per-channel seqs, uptime (seconds). |
| `/fault` | GET | Current fault state. |
| `/fault/*` | POST | Fault injection (below). Each responds with the current fault state. |

All REST responses carry `Access-Control-Allow-Origin: *`; `OPTIONS`
preflight is handled.

## Fault matrix

| Fault | Body (defaults) | What it simulates | What a correct client does |
| --- | --- | --- | --- |
| `POST /fault/drop` | — | Network partition / server crash: every socket is hard-terminated with no close frame. | Detect the dead connection itself (heartbeat timeout), reconnect, resubscribe, resync from snapshot. |
| `POST /fault/reorder` | `{ window: 8, count: 32 }` | Out-of-order delivery: the next `count` updates are buffered `window` at a time and each window is emitted in seeded-shuffled order, then order restores. | Buffer ahead-of-sequence updates and heal by seq; apply once the missing seqs arrive. No data is lost. |
| `POST /fault/burst` | `{ factor: 10, ms: 2000 }` | Load spike: the generation rate is multiplied for the window. | Keep up via coalescing/backpressure; seqs stay contiguous, so no resync is needed. |
| `POST /fault/stall` | `{ ms: 3000 }` | Upstream freeze: sending **and generating** stop for the window; seq stays contiguous and the pacing clock resets on resume, so there is no catch-up burst. | Tolerate silence (don't declare the connection dead prematurely if pings still answer); resume normally. |
| `POST /fault/gap` | `{ skip: 100 }` | Lost messages: the next `skip` updates are generated and applied to server state — seq advances — but never transmitted. | Detect the seq hole, give up waiting, and recover the data via `GET /snapshot` resync. Stream replay alone cannot fill the gap. |

## Profiles and flags

| Flag | Env | Default | Notes |
| --- | --- | --- | --- |
| `--port` | `TAPE_PORT` | `4400` | |
| `--seed` | `TAPE_SEED` | `42` | Drives all generated content. |
| `--rate` | `TAPE_RATE` | `5000` | Update messages per second, global across channels. |
| `--instruments` | `TAPE_INSTRUMENTS` | `10000` | Universe size. |
| `--profile ci` | — | — | Pins `seed=42 rate=5000 instruments=10000` regardless of flags/env. Port is not pinned. |

Precedence: flag > env > default; `--profile ci` overrides seed/rate/instruments.

## How determinism is achieved

- **One seeded PRNG (mulberry32), no dependencies.** The instrument
  universe, every price step, message composition (how many record updates,
  which instruments), and the channel interleave are all drawn from a single
  PRNG stream seeded with `--seed`. Content is therefore a pure function of
  `(seed, message index)`: two generators with the same seed produce
  byte-identical message sequences, run to run.
- **Synthetic data-clock.** Data timestamps are `DATA_EPOCH + index *
  DATA_STEP_MS` (a fixed epoch, 1 ms per message index) — never `Date.now()`.
  Wall time appears only in envelope fields like `serverTime`.
- **Pacing is decoupled from content.** A drift-corrected loop (about every
  20 ms) reads the real clock to decide *how many* messages are owed, with a
  per-tick cap so an event-loop stall cannot produce an unbounded burst —
  but never *what* those messages contain. Running at rate 50 or rate 50000
  yields the same byte sequence, just delivered on a different schedule.
- **State and seq move in lockstep.** Each generated update is applied to
  the authoritative in-memory state in the same synchronous step that
  assigns its seq, and snapshots read seq and records without an intervening
  await, so `snapshot.seq` always names exactly the state serialized.
