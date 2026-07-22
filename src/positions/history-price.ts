import type { Logger } from '../ops/logger.js';

/**
 * SOL/USD at a point in the PAST, for replaying historical buys during a backfill.
 *
 * The live feed is useless here: replaying a buy from three weeks ago at today's
 * SOL price produces a cost basis that is wrong by however much SOL has moved,
 * and that error lands straight in the Position % — the one number Phase 4 exists
 * to stop being confidently wrong about.
 *
 * Hourly granularity, from Binance.US klines. Intra-hour drift on SOL is small
 * relative to the two-orders-of-magnitude errors reconciliation is guarding
 * against, and every bucket is cached so a 1000-signature replay costs a handful
 * of requests, not a thousand.
 *
 * Stable-quoted historical buys need none of this — they were already in dollars.
 */
export interface HistoricalSolUsd {
  /** SOL/USD around `unixSeconds`, or null if unavailable. */
  at(unixSeconds: number): Promise<number | null>;
}

const HOUR_MS = 3_600_000;

export class BinanceHistoricalSolUsd implements HistoricalSolUsd {
  readonly #cache = new Map<number, number | null>();
  readonly #log: Logger;
  readonly #fetch: typeof fetch;

  constructor(log: Logger, fetchFn: typeof fetch = fetch) {
    this.#log = log;
    this.#fetch = fetchFn;
  }

  async at(unixSeconds: number): Promise<number | null> {
    if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return null;

    const bucket = Math.floor((unixSeconds * 1000) / HOUR_MS) * HOUR_MS;
    const cached = this.#cache.get(bucket);
    if (cached !== undefined) return cached;

    let price: number | null = null;
    try {
      const url =
        `https://api.binance.us/api/v3/klines?symbol=SOLUSDT&interval=1h` +
        `&startTime=${bucket}&limit=1`;
      const res = await this.#fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (res.ok) {
        // [ openTime, open, high, low, close, ... ] — close is index 4.
        const rows = (await res.json()) as unknown[][];
        const close = Number(rows?.[0]?.[4]);
        if (Number.isFinite(close) && close > 0) price = close;
      }
    } catch (err) {
      this.#log.debug({ err: err instanceof Error ? err.message : String(err) }, 'historical SOL price lookup failed');
    }

    this.#cache.set(bucket, price);
    return price;
  }
}

/** Fixed price, for tests and for offline replay of stable-only histories. */
export class StaticHistoricalSolUsd implements HistoricalSolUsd {
  constructor(private readonly price: number | null) {}
  async at(): Promise<number | null> {
    return this.price;
  }
}
