import { describe, expect, it } from 'vitest';
import { makeHarness, settle, snap } from './helpers';

describe('reconnect backoff (full jitter)', () => {
  it('delays equal random() * min(cap, base * 2^attempt), attempt resets on open', () => {
    const h = makeHarness({ random: () => 0.5 });
    h.client.connect();
    h.sockets.latest().open(); // successful open: attempt = 0
    expect(h.client.getState()).toBe('live');

    // Each failure schedules the next attempt with a doubled (capped) ceiling.
    const expected = [
      0.5 * 250, // attempt 0
      0.5 * 500, // attempt 1
      0.5 * 1000,
      0.5 * 2000,
      0.5 * 4000,
      0.5 * 8000,
      0.5 * 10_000, // 250 * 2^6 = 16000 → capped at 10000
      0.5 * 10_000, // stays capped
    ];
    const observed: number[] = [];
    for (const delay of expected) {
      h.sockets.latest().serverClose();
      expect(h.client.getState()).toBe('connecting'); // backoff wait counts
      observed.push(h.timers.lastScheduledDelay() ?? -1);
      h.timers.advance(delay); // fire the reconnect timer → new socket
    }
    expect(observed).toEqual(expected);
    expect(h.sockets.all.length).toBe(9); // initial + 8 retries

    // A successful open resets attempt: next failure is back to attempt 0.
    h.sockets.latest().open();
    expect(h.client.getState()).toBe('live');
    h.sockets.latest().serverClose();
    expect(h.timers.lastScheduledDelay()).toBe(0.5 * 250);
  });

  it('multiplies by the injected random source', () => {
    const h = makeHarness({ random: () => 0.2 });
    h.client.connect();
    h.sockets.latest().open();
    h.sockets.latest().serverClose();
    expect(h.timers.lastScheduledDelay()).toBe(0.2 * 250);
  });
});

describe('resubscribe after reconnect', () => {
  it('re-sends subscribe for every active channel and resyncs both via snapshot', async () => {
    const h = makeHarness();
    h.fetch.respondWith((channel) =>
      snap(channel, 10, [{ id: `${channel}-r1`, fields: { last: 1 } }]),
    );
    h.client.subscribe('alpha', { last: 'latest' });
    h.client.subscribe('beta', { last: 'latest' });
    h.client.connect();
    const s0 = h.sockets.latest();
    s0.open();
    await settle();
    expect(h.client.getState()).toBe('live');
    expect(s0.sentOfType('subscribe').map((f) => f.channel).sort()).toEqual([
      'alpha',
      'beta',
    ]);
    expect(h.fetch.calls.length).toBe(2);

    s0.serverClose();
    h.timers.advance(0.5 * 250);
    const s1 = h.sockets.latest();
    expect(s1).not.toBe(s0);
    s1.open();
    // Both subscribes re-sent on the NEW socket, both snapshots re-fetched.
    expect(s1.sentOfType('subscribe').map((f) => f.channel).sort()).toEqual([
      'alpha',
      'beta',
    ]);
    expect(h.fetch.calls.length).toBe(4);
    expect(h.client.getState()).toBe('resyncing');
    await settle();
    expect(h.client.getState()).toBe('live');
    const m = h.client.getMetrics();
    expect(m.snapshotsLoaded).toBe(4);
    expect(m.reconnects).toBe(1);
  });
});

describe('heartbeat staleness', () => {
  it('pings every interval; silence for timeoutMs → degraded, force-close, reconnect', () => {
    const h = makeHarness();
    h.client.connect();
    const s = h.sockets.latest();
    s.open();
    expect(h.client.getState()).toBe('live');

    h.timers.advance(1000);
    expect(s.sentOfType('ping').length).toBe(1);
    s.push({ type: 'pong', t: 1000, serverTime: 0 }); // traffic at t=1000

    h.timers.advance(1000); // t=2000: 1000ms since traffic → still fine
    expect(s.sentOfType('ping').length).toBe(2);
    h.timers.advance(1000); // t=3000: 2000ms < 2500 → still fine
    expect(s.sentOfType('ping').length).toBe(3);

    h.timers.advance(1000); // t=4000: 3000ms >= 2500 → stale
    expect(h.states).toContain('degraded');
    expect(s.closedByClient).toBe(true); // force-closed
    expect(h.client.getState()).toBe('connecting'); // reconnect path entered
    expect(h.client.getMetrics().staleTransitions).toBe(1);

    // The scheduled reconnect actually happens.
    h.timers.advance(0.5 * 250);
    expect(h.sockets.all.length).toBe(2);
  });

  it('any server message (not just pong) keeps the connection fresh', () => {
    const h = makeHarness();
    h.client.connect();
    const s = h.sockets.latest();
    s.open();
    for (let t = 0; t < 10; t++) {
      h.timers.advance(1000);
      s.push({ type: 'hello', serverTime: 0, channels: [] });
    }
    expect(h.client.getState()).toBe('live');
    expect(h.client.getMetrics().staleTransitions).toBe(0);
  });
});
