/**
 * Plain-Node consumer of @lalitheswaran11-stack/tape-core with DEFAULT seams.
 *
 * Nothing is injected: Node 22 supplies globalThis.WebSocket and fetch,
 * and the client's frame scheduler falls back to setTimeout when
 * requestAnimationFrame is absent. If this script works, the "framework
 * free" claim on tape-core is real, not aspirational.
 *
 * Usage:
 *   node index.mjs [ws://host:port] [--duration <ms>]
 *
 * Exits 0 with a JSON summary on stdout; exits 1 if the run saw no
 * instrument records, no inbound messages, or a coalesce ratio below 1.
 */

import { createTapeClient } from '@lalitheswaran11-stack/tape-core';

// ---------------------------------------------------------------------------
// argv: optional positional ws URL, optional --duration <ms>

let url = 'ws://localhost:4499';
let durationMs = 3000;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--duration') {
    const next = Number(argv[i + 1]);
    if (Number.isFinite(next) && next > 0) durationMs = next;
    i++;
  } else if (arg.startsWith('--duration=')) {
    const val = Number(arg.slice('--duration='.length));
    if (Number.isFinite(val) && val > 0) durationMs = val;
  } else if (arg.startsWith('ws://') || arg.startsWith('wss://')) {
    url = arg;
  }
}

// ---------------------------------------------------------------------------

const client = createTapeClient({ url });

client.onStateChange((state) => {
  console.error(`[consumer] state -> ${state}`);
});
client.onGap((gap) => {
  console.error(
    `[consumer] gap on ${gap.channel}: expected ${gap.expected}, got ${gap.received}`,
  );
});

const instruments = client.subscribe('instruments', {
  last: 'latest',
  bid: 'latest',
  ask: 'latest',
  change: 'latest',
  volume: 'accumulate',
});

const tape = client.subscribe('tape', {
  trades: 'sequence',
});

client.connect();

await new Promise((resolve) => setTimeout(resolve, durationMs));

const ids = instruments.store.ids();
const sampleId = ids[0];
const sample = sampleId !== undefined ? instruments.store.get(sampleId) : null;

const tapeRecord = tape.store.get('global');
const trades = tapeRecord?.fields.trades;
const tapeTradesLength = Array.isArray(trades) ? trades.length : 0;

const metrics = client.getMetrics();
client.close();

const summary = {
  url,
  durationMs,
  instruments: {
    recordCount: ids.length,
    sample,
  },
  tape: {
    tradesLength: tapeTradesLength,
  },
  metrics,
};

console.log(JSON.stringify(summary, null, 2));

const failures = [];
if (ids.length === 0) failures.push('instrument record count is 0');
if (metrics.messagesIn === 0) failures.push('messagesIn is 0');
if (metrics.coalesceRatio < 1) {
  failures.push(`coalesceRatio ${metrics.coalesceRatio} < 1`);
}

if (failures.length > 0) {
  console.error(`[consumer] FAIL: ${failures.join('; ')}`);
  process.exit(1);
}
process.exit(0);
