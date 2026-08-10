/** Entry point: resolve config from flags/env, boot the feed server. */

import { resolveConfig } from './config';
import { startFeedServer } from './server';

const config = resolveConfig(process.argv.slice(2), process.env);
const feed = await startFeedServer(config);
console.log(
  `[feed] listening on http://localhost:${feed.port} ` +
    `(seed=${feed.config.seed} rate=${feed.config.rate}/s ` +
    `instruments=${feed.config.instruments})`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void feed.close().then(() => process.exit(0));
  });
}
