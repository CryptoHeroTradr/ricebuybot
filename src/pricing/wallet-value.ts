import type { Logger } from '../ops/logger.js';
import { toFloat, rawAmount } from '../core/money.js';
import { USDC_MINT, WSOL_MINT } from './quote.js';

/**
 * THE WHALE TEST, redefined (Phase 11.x).
 *
 * A whale is no longer "holds ≥ $X of the token being bought." It is now "the buyer's liquid
 * wallet value — SOL + USDC — is ≥ $X." Two reasons this is a better signal:
 *
 *  1. It cannot be gamed by a thin trade. The old figure valued the buyer's bag at the
 *     TRADE-IMPLIED price of their own buy, so a tiny buy at a manipulated price produced a
 *     fabricated "holds $50K". SOL and USDC are valued at real market feeds.
 *  2. It measures whether this is a serious, moneyed wallet — not whether the token happens to
 *     be worth a lot in a self-reported price.
 *
 * THE COST, stated honestly: USDC lives in a token account the buy does not touch, so — unlike
 * the old figure, which arrived free inside the transaction — this needs an RPC read of the
 * buyer's balances. One `getBalance` + one `getTokenAccountsByOwner` per posted buy, cached per
 * wallet so a repeat buyer does not pay it twice.
 *
 * The balance is CURRENT (post-buy). On a SOL-quoted buy that slightly undercounts, because the
 * buyer just spent SOL — accepted, and it errs towards NOT calling a marginal wallet a whale,
 * which is the safe direction (a missed whale is invisible; a fabricated one is a screenshot).
 */
export interface WalletValueRpc {
  getBalance(pubkey: string): Promise<bigint | null>;
  getTokenBalances(owner: string, mints: readonly string[]): Promise<Map<string, bigint>>;
}

export interface WalletValueDeps {
  readonly rpc: WalletValueRpc;
  /** Live SOL/USD, or null when the feed is down. */
  readonly solUsd: () => number | null;
  /** What a USDC unit is worth (STABLE_USD). */
  readonly stableUsd: number;
  readonly log: Logger;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

const TTL_MS = 60_000;
const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

export class WalletValue {
  readonly #rpc: WalletValueRpc;
  readonly #solUsd: () => number | null;
  readonly #stableUsd: number;
  readonly #log: Logger;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, { usd: number; at: number }>();

  constructor(deps: WalletValueDeps) {
    this.#rpc = deps.rpc;
    this.#solUsd = deps.solUsd;
    this.#stableUsd = deps.stableUsd;
    this.#log = deps.log;
    this.#ttlMs = deps.ttlMs ?? TTL_MS;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * The buyer's SOL + USDC value in USD. Returns 0 — i.e. NOT a whale — on any failure, which is
   * the safe default: we would rather miss a whale than fabricate one.
   */
  async valueOf(owner: string): Promise<number> {
    const hit = this.#cache.get(owner);
    if (hit && this.#now() - hit.at < this.#ttlMs) return hit.usd;

    const [lamports, tokens] = await Promise.all([
      this.#rpc.getBalance(owner),
      this.#rpc.getTokenBalances(owner, [USDC_MINT, WSOL_MINT]),
    ]);

    // SOL held natively AND as wSOL both count as "solana".
    const solRaw = (lamports ?? 0n) + (tokens.get(WSOL_MINT) ?? 0n);
    const usdcRaw = tokens.get(USDC_MINT) ?? 0n;

    const sol = toFloat(rawAmount(solRaw, SOL_DECIMALS));
    const usdc = toFloat(rawAmount(usdcRaw, USDC_DECIMALS));

    const solUsd = this.#solUsd();
    if (solUsd === null && solRaw > 0n) {
      // The SOL feed is down. We can still value the USDC leg exactly; the SOL leg is unpriceable
      // right now, so this wallet may read as smaller than it is and miss the whale tier for the
      // duration of the outage. Non-fatal, and it recovers when the feed does.
      this.#log.warn({ owner }, 'SOL feed down — whale value counts USDC only for this buy');
    }

    const usd = sol * (solUsd ?? 0) + usdc * this.#stableUsd;
    this.#cache.set(owner, { usd, at: this.#now() });
    return usd;
  }
}
