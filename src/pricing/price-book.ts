/** Where a quote came from. Primary is preferred while it is fresh. */
export type PriceSourceName = 'binance' | 'coinbase';

/** Primary must be fresher than this, or we fail over. */
export const PRIMARY_STALE_MS = 10_000;
/** Beyond this, a source is dead to us. Both dead => solUsd() is null. */
export const DEAD_MS = 30_000;

interface Quote {
  price: number;
  atMs: number;
}

export interface Reading {
  readonly price: number;
  readonly source: PriceSourceName;
  readonly ageMs: number;
}

/**
 * The staleness state machine, isolated from the sockets so it can be tested
 * exhaustively without one.
 *
 * Rules:
 *   - primary (Binance.US) fresh (<=10s)  -> use it
 *   - else secondary (Coinbase) alive (<=30s) -> fail over
 *   - else primary still alive (<=30s)    -> better a 12s-old primary than nothing
 *   - else                                -> null. Hold the buy; NEVER guess.
 *
 * Returning a stale price would post a buy with a wrong dollar figure, which puts
 * it in the wrong tier and pulls the wrong meme. A held buy is recoverable; a
 * wrong "💥 MASSIVE BUY" is not.
 */
export class PriceBook {
  readonly #quotes = new Map<PriceSourceName, Quote>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  set(source: PriceSourceName, price: number, atMs: number = this.#now()): void {
    if (!Number.isFinite(price) || price <= 0) return; // never let a junk tick in
    this.#quotes.set(source, { price, atMs });
  }

  /** Full reading, or null when everything is stale. */
  read(): Reading | null {
    const now = this.#now();
    const age = (s: PriceSourceName): number | null => {
      const q = this.#quotes.get(s);
      return q ? now - q.atMs : null;
    };

    const primaryAge = age('binance');
    const secondaryAge = age('coinbase');

    if (primaryAge !== null && primaryAge <= PRIMARY_STALE_MS) {
      return { price: (this.#quotes.get('binance') as Quote).price, source: 'binance', ageMs: primaryAge };
    }
    if (secondaryAge !== null && secondaryAge <= DEAD_MS) {
      return { price: (this.#quotes.get('coinbase') as Quote).price, source: 'coinbase', ageMs: secondaryAge };
    }
    if (primaryAge !== null && primaryAge <= DEAD_MS) {
      return { price: (this.#quotes.get('binance') as Quote).price, source: 'binance', ageMs: primaryAge };
    }
    return null;
  }

  solUsd(): number | null {
    return this.read()?.price ?? null;
  }

  ageMs(): number | null {
    return this.read()?.ageMs ?? null;
  }
}
