/**
 * Playwright config for Tier 2 of the perf harness.
 *
 * Two projects:
 * - 'scenarios'    fault-injection correctness under stress (hard gates).
 * - 'frame-budget' 3x30s measured runs under 4x CPU throttle (loose gate,
 *                  the report is the product).
 *
 * Policy decisions, deliberate:
 * - retries: 0   — flake must be designed out, not retried away.
 * - workers: 1   — the feed's fault state is global; interleaved tests
 *                  would poison each other's fault windows.
 *
 * Servers:
 * - feed: `--profile ci` pins seed=42 rate=5000 instruments=10000 so every
 *   run sees the same byte stream; the port comes from TAPE_PORT.
 * - monitor: vite preview serves dist/. CI builds the app in an earlier
 *   step; the `build &&` prefix here makes local first runs self-sufficient
 *   (an existing dist/ makes it a fast no-op-ish rebuild).
 */

import { defineConfig } from '@playwright/test';

const CI =
  process.env.CI !== undefined && process.env.CI !== '' && process.env.CI !== 'false';

export default defineConfig({
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: CI,
  reporter: [['list']],
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:4401',
  },
  projects: [
    {
      name: 'scenarios',
      testDir: './scenarios',
      timeout: 90_000,
    },
    {
      name: 'frame-budget',
      testDir: './browser',
      timeout: 600_000,
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @tape/feed dev -- --profile ci',
      port: 4400,
      env: { TAPE_PORT: '4400' },
      reuseExistingServer: !CI,
      timeout: 30_000,
    },
    {
      command:
        'pnpm --filter @tape/monitor build && pnpm --filter @tape/monitor preview',
      port: 4401,
      reuseExistingServer: !CI,
      timeout: 180_000,
    },
  ],
});
