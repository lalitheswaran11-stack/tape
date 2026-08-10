/** Shared test utilities: WS test client, polling waits, REST helpers. */

import { WebSocket } from 'ws';
import { startFeedServer, type FeedConfig, type RunningFeed } from '../src/server';

export interface TestFeed {
  feed: RunningFeed;
  base: string;
  wsUrl: string;
  close(): Promise<void>;
}

/** Boot a feed on an ephemeral port with small, fast test defaults. */
export async function startTestFeed(
  overrides: Partial<FeedConfig> = {},
): Promise<TestFeed> {
  const feed = await startFeedServer({
    port: 0,
    seed: 42,
    rate: 2000,
    instruments: 50,
    ...overrides,
  });
  return {
    feed,
    base: `http://127.0.0.1:${feed.port}`,
    wsUrl: `ws://127.0.0.1:${feed.port}`,
    close: () => feed.close(),
  };
}

export async function waitUntil<T>(
  fn: () => T | undefined | false,
  timeoutMs = 5000,
  what = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Messages are hand-parsed JSON; tests treat them loosely.
export type AnyMessage = {
  type: string;
  channel?: string;
  seq?: number;
  updates?: Array<{
    id: string;
    fields: Record<string, unknown>;
    ts: number;
  }>;
  [k: string]: unknown;
};

export class WsClient {
  readonly messages: AnyMessage[] = [];
  readonly closed: Promise<void>;

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => ws.on('close', () => resolve()));
    ws.on('message', (data) => {
      try {
        this.messages.push(JSON.parse(String(data)) as AnyMessage);
      } catch {
        // ignore unparseable frames
      }
    });
  }

  static connect(url: string): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const client = new WsClient(ws);
      ws.on('open', () => resolve(client));
      ws.on('error', reject);
    });
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  /** All update messages for a channel, in arrival order. */
  updates(channel: string): AnyMessage[] {
    return this.messages.filter(
      (m) => m.type === 'update' && m.channel === channel,
    );
  }

  waitForMessage(
    pred: (m: AnyMessage) => boolean,
    timeoutMs = 5000,
    what = 'message',
  ): Promise<AnyMessage> {
    return waitUntil(() => this.messages.find(pred), timeoutMs, what);
  }

  async subscribe(channel: string): Promise<AnyMessage> {
    this.send({ type: 'subscribe', channel });
    return this.waitForMessage(
      (m) => m.type === 'subscribed' && m.channel === channel,
      5000,
      `subscribed ack for ${channel}`,
    );
  }

  close(): Promise<void> {
    this.ws.close();
    return this.closed;
  }
}

export async function getJson(
  base: string,
  path: string,
): Promise<{ status: number; headers: Headers; body: any }> {
  const res = await fetch(base + path);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

export async function postJson(
  base: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; headers: Headers; body: any }> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

/** Assert-helper: seqs of a channel's updates, in arrival order. */
export function seqsOf(msgs: AnyMessage[]): number[] {
  return msgs.map((m) => m.seq as number);
}

export function isContiguous(sorted: number[]): boolean {
  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i] as number) !== (sorted[i - 1] as number) + 1) return false;
  }
  return true;
}
