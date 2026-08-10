/**
 * Flag/env resolution, side-effect free so tests can import it.
 *
 * Precedence: --profile ci pins seed/rate/instruments; otherwise
 * flag > env > default. Port is never pinned by a profile.
 */

import { DEFAULT_CONFIG, type FeedConfig } from './server';

interface RawOptions {
  port?: string;
  seed?: string;
  rate?: string;
  instruments?: string;
  profile?: string;
}

const FLAG_NAMES = ['port', 'seed', 'rate', 'instruments', 'profile'] as const;

function parseFlags(argv: string[]): RawOptions {
  const out: RawOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)) as
      (typeof FLAG_NAMES)[number];
    if (!FLAG_NAMES.includes(name)) continue;
    if (eq !== -1) {
      out[name] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[name] = next;
        i++;
      }
    }
  }
  return out;
}

function toNum(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function resolveConfig(
  argv: string[],
  env: NodeJS.ProcessEnv,
): FeedConfig {
  const flags = parseFlags(argv);
  const cfg: FeedConfig = {
    port: toNum(flags.port) ?? toNum(env.TAPE_PORT) ?? DEFAULT_CONFIG.port,
    seed: toNum(flags.seed) ?? toNum(env.TAPE_SEED) ?? DEFAULT_CONFIG.seed,
    rate: toNum(flags.rate) ?? toNum(env.TAPE_RATE) ?? DEFAULT_CONFIG.rate,
    instruments:
      toNum(flags.instruments) ??
      toNum(env.TAPE_INSTRUMENTS) ??
      DEFAULT_CONFIG.instruments,
  };
  if (flags.profile === 'ci') {
    cfg.seed = 42;
    cfg.rate = 5000;
    cfg.instruments = 10_000;
  }
  return cfg;
}
