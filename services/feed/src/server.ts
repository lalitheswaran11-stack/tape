/**
 * One HTTP server: REST (snapshot, healthz, info, fault injection) plus
 * WebSocket upgrade for the update stream.
 *
 * Generation is shared and authoritative — a single drift-corrected pacing
 * loop generates messages, applies them to state, and broadcasts each to
 * every subscriber of its channel. Every subscriber sees the same messages
 * with the same seqs. Pacing reads the real clock; content never does.
 *
 * Wire messages are hand-rolled JSON matching the tape-core protocol; the
 * protocol module is imported as types only and never at runtime.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  HelloMessage,
  SubscribedMessage,
  UnsubscribedMessage,
  PongMessage,
  ErrorMessage,
  UpdateMessage,
  SnapshotResponse,
  ServerMessage,
} from '@lalitheswaran11-stack/tape-core/protocol';
import { Generator } from './generator';
import { CHANNELS, isChannel, type Channel } from './state';
import { FaultController } from './faults';

export interface FeedConfig {
  port: number;
  seed: number;
  rate: number;
  instruments: number;
}

export const DEFAULT_CONFIG: FeedConfig = {
  port: 4400,
  seed: 42,
  rate: 5000,
  instruments: 10_000,
};

export interface RunningFeed {
  port: number;
  config: FeedConfig;
  generator: Generator;
  faults: FaultController;
  server: Server;
  close(): Promise<void>;
}

const TICK_MS = 20;

function sendMsg(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function errorMsg(code: string, message: string): ErrorMessage {
  return { type: 'error', code, message };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed: unknown = text ? JSON.parse(text) : {};
        resolve(
          parsed !== null && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>)
            : {},
        );
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function bodyNum(
  body: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = body[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function startFeedServer(
  overrides: Partial<FeedConfig> = {},
): Promise<RunningFeed> {
  const config: FeedConfig = { ...DEFAULT_CONFIG, ...overrides };
  const generator = new Generator({
    seed: config.seed,
    instruments: config.instruments,
  });
  const state = generator.state;
  const faults = new FaultController(config.seed);
  const startedAt = Date.now();

  const channelSubs: Record<Channel, Set<WebSocket>> = {
    instruments: new Set(),
    tape: new Set(),
  };

  // ---- outbound path -------------------------------------------------------

  function transmit(channel: string, wire: string): void {
    if (!isChannel(channel)) return;
    for (const ws of channelSubs[channel]) {
      if (ws.readyState === WebSocket.OPEN) ws.send(wire);
    }
  }

  /** Encode once, route through the fault pipe, fan out to subscribers. */
  function emit(msg: UpdateMessage): void {
    const items = faults.pipe({ channel: msg.channel, wire: JSON.stringify(msg) });
    for (const item of items) transmit(item.channel, item.wire);
  }

  // ---- pacing loop ---------------------------------------------------------
  // Drift-corrected: owed messages accrue from elapsed real time; a per-tick
  // cap bounds the burst after an event-loop stall, and the owed bank is
  // clamped so backlog can never grow without bound.

  let lastTick = Date.now();
  let owed = 0;

  function tick(): void {
    // An empty universe (instruments=0) generates nothing: seqs stay 0 and
    // snapshots are honestly empty — clients render an explicit empty state.
    if (state.symbols.length === 0) return;
    const now = Date.now();
    if (faults.stalled(now)) {
      // Freeze generation and reset the owed clock: no catch-up burst later.
      lastTick = now;
      owed = 0;
      return;
    }
    const rate = faults.effectiveRate(config.rate, now);
    owed += ((now - lastTick) / 1000) * rate;
    lastTick = now;
    const cap = Math.max(100, Math.ceil((rate * TICK_MS) / 1000) * 5);
    let n = Math.min(Math.floor(owed), cap);
    owed = Math.min(owed - n, cap);
    while (n-- > 0) emit(generator.next());
  }

  const timer = setInterval(tick, TICK_MS);

  // ---- HTTP ---------------------------------------------------------------

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && path === '/healthz') {
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && path === '/info') {
      json(res, 200, {
        seed: config.seed,
        rate: config.rate,
        instruments: config.instruments,
        channels: {
          instruments: state.seq.instruments,
          tape: state.seq.tape,
        },
        uptime: (Date.now() - startedAt) / 1000,
      });
      return;
    }

    if (req.method === 'GET' && path === '/snapshot') {
      const channel = url.searchParams.get('channel') ?? '';
      if (!isChannel(channel)) {
        json(res, 404, { error: 'unknown channel', channel });
        return;
      }
      // Synchronous between seq read and record serialization: the snapshot
      // is exactly the state after update `seq`.
      const body: SnapshotResponse = {
        channel,
        seq: state.seq[channel],
        serverTime: Date.now(),
        records: state.snapshotRecords(channel),
      };
      json(res, 200, body);
      return;
    }

    if (req.method === 'GET' && path === '/fault') {
      json(res, 200, faults.status(Date.now()));
      return;
    }

    if (req.method === 'POST' && path.startsWith('/fault/')) {
      const body = await readBody(req);
      const now = Date.now();
      switch (path) {
        case '/fault/drop': {
          for (const ws of wss.clients) ws.terminate();
          faults.noteDrop();
          break;
        }
        case '/fault/reorder': {
          const window = bodyNum(body, 'window', 8);
          const count = bodyNum(body, 'count', 32);
          const leftover = faults.startReorder(window, count);
          for (const item of leftover) transmit(item.channel, item.wire);
          break;
        }
        case '/fault/burst': {
          faults.startBurst(bodyNum(body, 'factor', 10), bodyNum(body, 'ms', 2000), now);
          break;
        }
        case '/fault/stall': {
          faults.startStall(bodyNum(body, 'ms', 3000), now);
          break;
        }
        case '/fault/gap': {
          const skip = Math.max(0, Math.floor(bodyNum(body, 'skip', 100)));
          // Generate and apply without transmitting: seq advances, state
          // moves on, clients see a hole they can only fill via snapshot.
          if (state.symbols.length > 0) {
            for (let i = 0; i < skip; i++) generator.next();
            faults.noteGap(skip);
          }
          break;
        }
        default: {
          json(res, 404, { error: 'unknown fault', path });
          return;
        }
      }
      json(res, 200, faults.status(Date.now()));
      return;
    }

    json(res, 404, { error: 'not found', path });
  }

  // ---- WebSocket -----------------------------------------------------------

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket) => {
    ws.on('error', () => {
      /* swallow; close handler does cleanup */
    });

    const hello: HelloMessage = {
      type: 'hello',
      serverTime: Date.now(),
      channels: [...CHANNELS],
    };
    sendMsg(ws, hello);

    ws.on('message', (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(data));
      } catch {
        sendMsg(ws, errorMsg('bad_json', 'message is not valid JSON'));
        return;
      }
      if (msg === null || typeof msg === 'string' || typeof msg !== 'object') {
        sendMsg(ws, errorMsg('bad_message', 'message must be a JSON object'));
        return;
      }
      const m = msg as { type?: unknown; channel?: unknown; t?: unknown };
      switch (m.type) {
        case 'subscribe': {
          if (!isChannel(m.channel)) {
            sendMsg(
              ws,
              errorMsg('unknown_channel', `unknown channel: ${String(m.channel)}`),
            );
            return;
          }
          channelSubs[m.channel].add(ws);
          const ack: SubscribedMessage = {
            type: 'subscribed',
            channel: m.channel,
            seq: state.seq[m.channel],
          };
          sendMsg(ws, ack);
          return;
        }
        case 'unsubscribe': {
          if (!isChannel(m.channel)) {
            sendMsg(
              ws,
              errorMsg('unknown_channel', `unknown channel: ${String(m.channel)}`),
            );
            return;
          }
          channelSubs[m.channel].delete(ws);
          const ack: UnsubscribedMessage = {
            type: 'unsubscribed',
            channel: m.channel,
          };
          sendMsg(ws, ack);
          return;
        }
        case 'ping': {
          // A stalled upstream is fully silent — pongs freeze with updates
          // (README: "sending and generating stop"), so a stall longer than
          // the client's heartbeat window is indistinguishable from a dead
          // socket and MUST trip its silent-death detection.
          if (faults.stalled(Date.now())) return;
          const pong: PongMessage = {
            type: 'pong',
            t: typeof m.t === 'number' ? m.t : 0,
            serverTime: Date.now(),
          };
          sendMsg(ws, pong);
          return;
        }
        default:
          sendMsg(
            ws,
            errorMsg('unsupported', `unsupported message type: ${String(m.type)}`),
          );
      }
    });

    ws.on('close', () => {
      for (const ch of CHANNELS) channelSubs[ch].delete(ws);
    });
  });

  // ---- boot / shutdown -----------------------------------------------------

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        config,
        generator,
        faults,
        server,
        close(): Promise<void> {
          clearInterval(timer);
          for (const ws of wss.clients) ws.terminate();
          return new Promise((done) => {
            wss.close(() => {
              server.close(() => done());
            });
          });
        },
      });
    });
  });
}
