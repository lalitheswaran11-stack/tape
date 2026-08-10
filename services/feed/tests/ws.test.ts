import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestFeed, WsClient, waitUntil, type TestFeed } from './helpers';

describe('websocket basics', () => {
  let t: TestFeed;

  beforeAll(async () => {
    t = await startTestFeed({ rate: 2000 });
  });

  afterAll(async () => {
    await t.close();
  });

  it('sends hello with serverTime and the channel list on connect', async () => {
    const c = await WsClient.connect(t.wsUrl);
    const hello = await c.waitForMessage((m) => m.type === 'hello');
    expect(hello['channels']).toEqual(['instruments', 'tape']);
    expect(typeof hello['serverTime']).toBe('number');
    await c.close();
  });

  it('subscribed ack carries the current seq and update seqs increment strictly by 1', async () => {
    const c = await WsClient.connect(t.wsUrl);
    const ack = await c.subscribe('instruments');
    const ackSeq = ack.seq as number;
    expect(ackSeq).toBeGreaterThanOrEqual(0);

    await waitUntil(
      () => c.updates('instruments').length >= 50,
      10_000,
      '50 instrument updates',
    );
    const seqs = c.updates('instruments').map((m) => m.seq as number);
    expect(seqs[0]).toBe(ackSeq + 1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe((seqs[i - 1] as number) + 1);
    }
    await c.close();
  });

  it('update messages carry 1..8 record updates on instruments, exactly 1 entry on tape', async () => {
    const c = await WsClient.connect(t.wsUrl);
    await c.subscribe('instruments');
    await c.subscribe('tape');
    await waitUntil(
      () => c.updates('instruments').length >= 30 && c.updates('tape').length >= 2,
      10_000,
      'updates on both channels',
    );
    for (const m of c.updates('instruments')) {
      expect(m.updates!.length).toBeGreaterThanOrEqual(1);
      expect(m.updates!.length).toBeLessThanOrEqual(8);
      for (const u of m.updates!) {
        expect(typeof u.fields['volume']).toBe('number');
        expect((u.fields['bid'] as number) < (u.fields['ask'] as number)).toBe(true);
      }
    }
    for (const m of c.updates('tape')) {
      expect(m.updates!).toHaveLength(1);
      const u = m.updates![0]!;
      expect(u.id).toBe('global');
      const trade = u.fields['trades'] as Record<string, unknown>;
      expect(typeof trade['sym']).toBe('string');
      expect(typeof trade['price']).toBe('number');
      expect(typeof trade['size']).toBe('number');
      expect(['buy', 'sell']).toContain(trade['side']);
      expect(typeof trade['ts']).toBe('number');
    }
    await c.close();
  });

  it('subscribing to an unknown channel produces an error message', async () => {
    const c = await WsClient.connect(t.wsUrl);
    c.send({ type: 'subscribe', channel: 'nope' });
    const err = await c.waitForMessage((m) => m.type === 'error');
    expect(err['code']).toBe('unknown_channel');
    await c.close();
  });

  it('ping replies pong echoing t', async () => {
    const c = await WsClient.connect(t.wsUrl);
    c.send({ type: 'ping', t: 12345 });
    const pong = await c.waitForMessage((m) => m.type === 'pong');
    expect(pong['t']).toBe(12345);
    expect(typeof pong['serverTime']).toBe('number');
    await c.close();
  });

  it('unsubscribe acks and stops the stream for that channel', async () => {
    const c = await WsClient.connect(t.wsUrl);
    await c.subscribe('instruments');
    await waitUntil(() => c.updates('instruments').length >= 5, 10_000, 'updates');
    c.send({ type: 'unsubscribe', channel: 'instruments' });
    const ackIdx = await waitUntil(() => {
      const i = c.messages.findIndex((m) => m.type === 'unsubscribed');
      return i === -1 ? undefined : i;
    }, 5000, 'unsubscribed ack');
    // Server processes messages in order: nothing after the ack may be an
    // update for the unsubscribed channel.
    await new Promise((r) => setTimeout(r, 100));
    const after = c.messages.slice((ackIdx as number) + 1);
    expect(after.filter((m) => m.type === 'update' && m.channel === 'instruments')).toHaveLength(0);
    await c.close();
  });
});
