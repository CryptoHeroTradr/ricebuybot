import { WebSocket } from 'ws';

import { Backoff } from '../ingest/backoff.js';
import type { Logger } from '../ops/logger.js';
import { PriceBook, type PriceSourceName } from './price-book.js';

/**
 * SOL/USD: Binance.US WS primary, Coinbase WS secondary, REST bootstrap for both.
 *
 * The REST bootstrap matters more than it looks. Without it, `solUsd()` is null
 * for however long the first WS trade takes to arrive — on a quiet market that can
 * be tens of seconds, during which every SOL-quoted buy is held. One REST call per
 * source at boot removes that window entirely.
 */

/**
 * bookTicker, NOT the trade stream.
 *
 * Binance.US SOL/USDT is thin: measured live, `solusdt@trade` emitted ZERO trades
 * in 30 seconds while `solusdt@bookTicker` emitted 279 updates. On the trade
 * stream the "primary" source would cross the 10s staleness line within seconds of
 * boot and stay there — every buy would silently ride the Coinbase failover path,
 * and a single Coinbase blip would then take the whole feed to null even though
 * Binance was reachable the entire time.
 *
 * bookTicker publishes on every best-bid/ask change, so it ticks even when nobody
 * trades. We take the mid.
 */
const BINANCE_WS = 'wss://stream.binance.us:9443/ws/solusdt@bookTicker';
const BINANCE_REST = 'https://api.binance.us/api/v3/ticker/price?symbol=SOLUSDT';
const COINBASE_WS = 'wss://ws-feed.exchange.coinbase.com';
const COINBASE_REST = 'https://api.exchange.coinbase.com/products/SOL-USD/ticker';

/**
 * Binance.US bookTicker -> mid price. Pure, so the guards below are testable.
 *
 * `b` = best bid, `a` = best ask. Rejects a crossed book (ask < bid) or an
 * absurdly wide one: a bad mark here would misprice every buy that follows it.
 */
export function parseBinanceBookTicker(raw: string): number | null {
  try {
    const m = JSON.parse(raw) as { b?: string; a?: string };
    const bid = Number(m.b);
    const ask = Number(m.a);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
    if (ask < bid) return null;
    if ((ask - bid) / bid > 0.05) return null;
    return (bid + ask) / 2;
  } catch {
    return null;
  }
}

/** Coinbase ticker -> last price. Ignores every other message type on the socket. */
export function parseCoinbaseTicker(raw: string): number | null {
  try {
    const m = JSON.parse(raw) as { type?: string; price?: string };
    if (m.type !== 'ticker') return null;
    const p = Number(m.price);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

export interface SolUsdFeedDeps {
  readonly log: Logger;
  /** Test seam. */
  readonly now?: () => number;
  readonly fetchFn?: typeof fetch;
}

export class SolUsdFeed {
  readonly #book: PriceBook;
  readonly #log: Logger;
  readonly #fetch: typeof fetch;

  #sockets: WebSocket[] = [];
  #timers: NodeJS.Timeout[] = [];
  #stopping = false;
  /** Log a feed-down / feed-back transition once, not once per buy. */
  #wasDown = false;

  constructor(deps: SolUsdFeedDeps) {
    this.#log = deps.log;
    this.#fetch = deps.fetchFn ?? fetch;
    this.#book = new PriceBook(deps.now ?? Date.now);
  }

  get book(): PriceBook {
    return this.#book;
  }

  solUsd(): number | null {
    const reading = this.#book.read();

    // Edge-triggered logging: the state CHANGE is the event worth a line.
    if (reading === null && !this.#wasDown) {
      this.#wasDown = true;
      this.#log.error('SOL/USD feed is stale on BOTH sources; holding SOL-quoted buys');
    } else if (reading !== null && this.#wasDown) {
      this.#wasDown = false;
      this.#log.info({ source: reading.source, price: reading.price }, 'SOL/USD feed recovered');
    }

    return reading?.price ?? null;
  }

  ageMs(): number | null {
    return this.#book.ageMs();
  }

  source(): PriceSourceName | null {
    return this.#book.read()?.source ?? null;
  }

  async start(): Promise<void> {
    this.#stopping = false;

    // Bootstrap first, and in parallel, so price is never null after start().
    await Promise.all([this.#bootstrapBinance(), this.#bootstrapCoinbase()]);

    if (this.#book.read() === null) {
      // Not fatal — the sockets may still come up — but it means the first buys
      // will be held, and that is worth knowing at boot rather than discovering later.
      this.#log.warn('SOL/USD bootstrap produced no price from either source');
    } else {
      this.#log.info({ price: this.#book.solUsd(), source: this.source() }, 'SOL/USD bootstrapped');
    }

    this.#connectBinance();
    this.#connectCoinbase();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers = [];
    for (const ws of this.#sockets) {
      ws.removeAllListeners();
      ws.terminate();
    }
    this.#sockets = [];
  }

  // --- REST bootstrap ---------------------------------------------------------

  async #bootstrapBinance(): Promise<void> {
    try {
      const res = await this.#fetch(BINANCE_REST, { signal: AbortSignal.timeout(5_000) });
      const json = (await res.json()) as { price?: string };
      const price = Number(json.price);
      if (Number.isFinite(price) && price > 0) this.#book.set('binance', price);
    } catch (err) {
      this.#log.warn({ err: msg(err) }, 'binance bootstrap failed');
    }
  }

  async #bootstrapCoinbase(): Promise<void> {
    try {
      const res = await this.#fetch(COINBASE_REST, { signal: AbortSignal.timeout(5_000) });
      const json = (await res.json()) as { price?: string };
      const price = Number(json.price);
      if (Number.isFinite(price) && price > 0) this.#book.set('coinbase', price);
    } catch (err) {
      this.#log.warn({ err: msg(err) }, 'coinbase bootstrap failed');
    }
  }

  // --- websockets -------------------------------------------------------------

  #connect(
    name: PriceSourceName,
    url: string,
    onOpen: (ws: WebSocket) => void,
    parse: (raw: string) => number | null,
  ): void {
    if (this.#stopping) return;

    const backoff = new Backoff();
    const open = (): void => {
      if (this.#stopping) return;

      const ws = new WebSocket(url);
      this.#sockets = [...this.#sockets.filter((s) => s.readyState !== WebSocket.CLOSED), ws];

      ws.on('open', () => {
        this.#log.info({ source: name }, 'price ws connected');
        backoff.reset();
        onOpen(ws);
      });

      ws.on('message', (raw) => {
        const price = parse(raw.toString());
        if (price !== null) this.#book.set(name, price);
      });

      ws.on('error', (err) => this.#log.warn({ source: name, err: err.message }, 'price ws error'));

      ws.on('close', () => {
        if (this.#stopping) return;
        const delay = backoff.next();
        this.#log.warn({ source: name, retryInMs: delay }, 'price ws disconnected; reconnecting');
        const t = setTimeout(open, delay);
        t.unref();
        this.#timers.push(t);
      });
    };

    open();
  }

  #connectBinance(): void {
    // Stream is in the URL; nothing to subscribe to.
    this.#connect('binance', BINANCE_WS, () => undefined, parseBinanceBookTicker);
  }

  #connectCoinbase(): void {
    this.#connect(
      'coinbase',
      COINBASE_WS,
      (ws) => ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['SOL-USD'], channels: ['ticker'] })),
      parseCoinbaseTicker,
    );
  }
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
