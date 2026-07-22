import { WebSocket } from 'ws';

import type { Mint } from '../core/types.js';
import { scrubUrl, type Logger } from '../ops/logger.js';
import { Backoff } from './backoff.js';
import { BaseIngestor, type IngestorDeps } from './base.js';
import type { ConfirmedTx } from './solana-types.js';

/** Ping this often; if no pong comes back within the timeout, the socket is dead. */
const HEARTBEAT_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
/** A connection that survives this long is "healthy" and resets the backoff ramp. */
const HEALTHY_AFTER_MS = 60_000;

/**
 * Helius Enhanced WebSocket (`transactionSubscribe`, Geyser-backed).
 *
 * One subscription per mint, so Phase 8 can add and drop mints at runtime without
 * tearing down the socket.
 */
export class HeliusWsIngestor extends BaseIngestor {
  readonly #url: string;
  readonly #log: Logger;
  readonly #backoff = new Backoff();

  #ws: WebSocket | null = null;
  /** mint -> Helius subscription id. Absent = requested but not yet confirmed. */
  #subs = new Map<Mint, number>();
  /** JSON-RPC request id -> the mint that request was for. */
  #pending = new Map<number, Mint>();
  #nextId = 1;

  #heartbeat: NodeJS.Timeout | null = null;
  #pongTimer: NodeJS.Timeout | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #healthyTimer: NodeJS.Timeout | null = null;
  #stopping = false;
  #connected = false;

  constructor(url: string, deps: IngestorDeps) {
    super(deps);
    this.#url = url;
    this.#log = deps.log;
  }

  override get connected(): boolean {
    return this.#connected;
  }

  async start(): Promise<void> {
    this.#stopping = false;
    this.#open();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#clearTimers();
    this.#connected = false;

    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      ws.removeAllListeners();
      // close() waits for a handshake we do not care about during shutdown.
      ws.terminate();
    }
    this.#subs.clear();
    this.#pending.clear();
  }

  // --- connection -------------------------------------------------------------

  #open(): void {
    if (this.#stopping) return;

    // INVARIANT 5: the URL carries the API key in its query string. It must never
    // be logged raw — not here, not in an error handler, not anywhere.
    this.#log.info({ url: scrubUrl(this.#url), attempt: this.#backoff.attempt }, 'ws connecting');

    const ws = new WebSocket(this.#url);
    this.#ws = ws;

    ws.on('open', () => {
      this.#connected = true;
      this.#log.info({ url: scrubUrl(this.#url), mints: this.mints.length }, 'ws connected');

      // Re-subscribe EVERY active mint. A reconnect starts from nothing on the
      // Helius side — old subscription ids are dead.
      this.#subs.clear();
      this.#pending.clear();
      for (const mint of this.mints) this.#sendSubscribe(mint);

      this.#startHeartbeat();
      this.#healthyTimer = setTimeout(() => this.#backoff.reset(), HEALTHY_AFTER_MS);
      this.#healthyTimer.unref();

      // We were away; buys landed while we were. Gap recovery hangs off this.
      this.emitReconnect();
    });

    ws.on('message', (raw) => this.#onMessage(raw.toString()));
    ws.on('pong', () => this.#onPong());

    ws.on('error', (err) => {
      // scrub(): a ws error message can embed the request URL, key and all.
      this.#log.warn({ err: err.message }, 'ws error');
    });

    ws.on('close', (code, reason) => {
      this.#connected = false;
      this.#clearTimers();
      if (this.#stopping) return;

      const delay = this.#backoff.next();
      this.#log.warn(
        {
          url: scrubUrl(this.#url),
          code,
          reason: reason.toString().slice(0, 200),
          attempt: this.#backoff.attempt,
          retryInMs: delay,
          mints: this.mints.length,
        },
        'ws disconnected; reconnecting',
      );

      this.#reconnectTimer = setTimeout(() => this.#open(), delay);
      this.#reconnectTimer.unref();
    });
  }

  #startHeartbeat(): void {
    this.#heartbeat = setInterval(() => {
      const ws = this.#ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      ws.ping();
      // A TCP connection can be silently black-holed: the socket stays "open" and
      // we get no data and no close. Only a missing pong reveals it.
      this.#pongTimer = setTimeout(() => {
        this.#log.warn('ws heartbeat timed out; terminating to force reconnect');
        ws.terminate(); // fires 'close' -> reconnect path
      }, PONG_TIMEOUT_MS);
      this.#pongTimer.unref();
    }, HEARTBEAT_MS);
    this.#heartbeat.unref();
  }

  #onPong(): void {
    if (this.#pongTimer) {
      clearTimeout(this.#pongTimer);
      this.#pongTimer = null;
    }
  }

  #clearTimers(): void {
    for (const t of [this.#heartbeat, this.#pongTimer, this.#reconnectTimer, this.#healthyTimer]) {
      if (t) clearTimeout(t as NodeJS.Timeout);
    }
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = this.#pongTimer = this.#reconnectTimer = this.#healthyTimer = null;
  }

  // --- subscriptions ----------------------------------------------------------

  protected override onSubscribe(mint: Mint): void {
    if (this.#connected) this.#sendSubscribe(mint);
  }

  protected override onUnsubscribe(mint: Mint): void {
    const id = this.#subs.get(mint);
    this.#subs.delete(mint);
    if (id === undefined || !this.#connected) return;

    this.#send({ jsonrpc: '2.0', id: this.#nextId++, method: 'transactionUnsubscribe', params: [id] });
    this.#log.info({ mint }, 'unsubscribed');
  }

  #sendSubscribe(mint: Mint): void {
    const id = this.#nextId++;
    this.#pending.set(id, mint);

    this.#send({
      jsonrpc: '2.0',
      id,
      method: 'transactionSubscribe',
      params: [
        { accountInclude: [mint], failed: false, vote: false },
        {
          commitment: 'confirmed',
          encoding: 'jsonParsed',
          transactionDetails: 'full',
          maxSupportedTransactionVersion: 0,
        },
      ],
    });
  }

  #send(payload: unknown): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  // --- messages ---------------------------------------------------------------

  #onMessage(text: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: { result?: unknown };
    };
    try {
      msg = JSON.parse(text);
    } catch {
      this.#log.warn('ws sent unparseable JSON');
      return;
    }

    // Subscription ack / error.
    if (msg.id !== undefined && this.#pending.has(msg.id)) {
      const mint = this.#pending.get(msg.id) as Mint;
      this.#pending.delete(msg.id);

      if (msg.error) {
        this.#log.error({ mint, err: msg.error.message }, 'subscribe rejected');
        return;
      }
      if (typeof msg.result === 'number') {
        this.#subs.set(mint, msg.result);
        this.#log.info({ mint, subscription: msg.result }, 'subscribed');
      }
      return;
    }

    if (msg.method !== 'transactionNotification') return;

    const tx = toConfirmedTx(msg.params?.result);
    if (!tx) {
      this.#log.warn('transactionNotification in an unexpected shape; ignoring');
      return;
    }

    void this.ingest(tx);
  }
}

/**
 * Helius wraps the transaction differently from `getTransaction`: the slot and
 * signature live on the envelope, and the tx/meta are nested a level down.
 * Reshape into the plain ConfirmedTx the normalizer takes, so BOTH adapters feed
 * one identical code path.
 */
export function toConfirmedTx(result: unknown): ConfirmedTx | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as {
    slot?: number;
    signature?: string;
    blockTime?: number | null;
    transaction?: { transaction?: unknown; meta?: unknown; message?: unknown; signatures?: unknown };
  };

  const outer = r.transaction;
  if (!outer || typeof outer !== 'object') return null;

  // Helius: { transaction: { transaction: {message, signatures}, meta } }
  // RPC:    { transaction: {message, signatures}, meta }
  const inner = (outer.transaction ?? outer) as { message?: unknown; signatures?: unknown };
  const meta = (outer.meta ?? (r as { meta?: unknown }).meta) as ConfirmedTx['meta'];

  if (!inner || typeof inner !== 'object' || !inner.message) return null;
  if (typeof r.slot !== 'number') return null;

  const signatures = Array.isArray(inner.signatures)
    ? (inner.signatures as string[])
    : r.signature
      ? [r.signature]
      : [];

  return {
    slot: r.slot,
    blockTime: r.blockTime ?? null,
    transaction: { message: inner.message as ConfirmedTx['transaction']['message'], signatures },
    meta: meta ?? null,
  };
}
