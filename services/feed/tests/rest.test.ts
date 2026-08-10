import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestFeed, getJson, type TestFeed } from './helpers';
import { resolveConfig } from '../src/config';

describe('REST endpoints', () => {
  let t: TestFeed;

  beforeAll(async () => {
    t = await startTestFeed({ rate: 1000, seed: 42, instruments: 50 });
  });

  afterAll(async () => {
    await t.close();
  });

  it('GET /healthz returns { ok: true } with CORS header', async () => {
    const res = await getJson(t.base, '/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('GET /info returns seed, rate, instrument count, channel seqs, uptime', async () => {
    const res = await getJson(t.base, '/info');
    expect(res.status).toBe(200);
    expect(res.body.seed).toBe(42);
    expect(res.body.rate).toBe(1000);
    expect(res.body.instruments).toBe(50);
    expect(typeof res.body.channels.instruments).toBe('number');
    expect(typeof res.body.channels.tape).toBe('number');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('GET /snapshot returns the record set with seq and serverTime', async () => {
    const res = await getJson(t.base, '/snapshot?channel=instruments');
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe('instruments');
    expect(typeof res.body.seq).toBe('number');
    expect(typeof res.body.serverTime).toBe('number');
    expect(res.body.records).toHaveLength(50);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    const tape = await getJson(t.base, '/snapshot?channel=tape');
    expect(tape.status).toBe(200);
    expect(tape.body.records).toHaveLength(1);
    expect(tape.body.records[0].id).toBe('global');
    expect(Array.isArray(tape.body.records[0].fields.trades)).toBe(true);
  });

  it('GET /snapshot with an unknown channel returns 404', async () => {
    const res = await getJson(t.base, '/snapshot?channel=bogus');
    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('GET /fault returns the fault state', async () => {
    const res = await getJson(t.base, '/fault');
    expect(res.status).toBe(200);
    expect(res.body.drop).toBeDefined();
    expect(res.body.reorder).toBeDefined();
    expect(res.body.burst).toBeDefined();
    expect(res.body.stall).toBeDefined();
    expect(res.body.gap).toBeDefined();
  });

  it('OPTIONS preflight is handled with CORS headers', async () => {
    const res = await fetch(`${t.base}/snapshot?channel=instruments`, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('unknown paths return 404 with CORS header', async () => {
    const res = await getJson(t.base, '/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('config resolution', () => {
  it('flags beat env, env beats defaults', () => {
    const cfg = resolveConfig(['--seed', '7', '--rate=100'], {
      TAPE_SEED: '99',
      TAPE_PORT: '5555',
    });
    expect(cfg.seed).toBe(7);
    expect(cfg.rate).toBe(100);
    expect(cfg.port).toBe(5555);
    expect(cfg.instruments).toBe(10_000);
  });

  it('--profile ci pins seed/rate/instruments regardless of env', () => {
    const cfg = resolveConfig(['--profile', 'ci'], {
      TAPE_SEED: '99',
      TAPE_RATE: '1',
      TAPE_INSTRUMENTS: '3',
      TAPE_PORT: '6666',
    });
    expect(cfg.seed).toBe(42);
    expect(cfg.rate).toBe(5000);
    expect(cfg.instruments).toBe(10_000);
    expect(cfg.port).toBe(6666); // port is not pinned
  });
});
