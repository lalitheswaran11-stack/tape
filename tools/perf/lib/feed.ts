/**
 * Node-side feed helpers: fault injection against the shared feed on :4400,
 * plus spawning ephemeral extra feeds (e.g. the zero-instrument feed the
 * empty-state scenario needs).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FEED_URL = 'http://localhost:4400';

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

export type FaultName = 'drop' | 'reorder' | 'burst' | 'stall' | 'gap';

/** POST /fault/<name>; resolves with the feed's reported fault state. */
export async function fault(
  name: FaultName,
  body?: Record<string, number>,
  base: string = FEED_URL,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/fault/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new Error(`POST ${base}/fault/${name} failed: ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function waitForHealthz(
  base: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`feed at ${base} not healthy within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

export interface SpawnedFeed {
  proc: ChildProcess;
  base: string;
  /** SIGTERM the whole process group (tsx spawns a node child); SIGKILL after 2s. */
  kill(): Promise<void>;
}

/**
 * Spawn a second feed as a child process (env decides port/universe) and
 * wait for /healthz. Spawned detached so the whole process group — tsx AND
 * the node child it launches — can be killed as one unit; a stray feed
 * would poison later runs on the same port.
 */
export async function spawnFeed(env: Record<string, string>): Promise<SpawnedFeed> {
  const port = env.TAPE_PORT ?? '4400';
  const feedDir = path.join(REPO_ROOT, 'services', 'feed');
  const tsxBin = path.join(feedDir, 'node_modules', '.bin', 'tsx');
  const proc = spawn(tsxBin, ['src/main.ts'], {
    cwd: feedDir,
    env: { ...process.env, ...env },
    stdio: 'ignore',
    detached: true,
  });
  const base = `http://localhost:${port}`;

  async function kill(): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    const pid = proc.pid;
    try {
      if (pid !== undefined) process.kill(-pid, 'SIGTERM');
      else proc.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    const hammer = setTimeout(() => {
      try {
        if (pid !== undefined) process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, 2_000);
    await exited;
    clearTimeout(hammer);
  }

  try {
    await waitForHealthz(base);
  } catch (err) {
    await kill();
    throw err;
  }
  return { proc, base, kill };
}
