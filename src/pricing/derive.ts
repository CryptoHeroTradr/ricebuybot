import { toFloat, rawAmount } from '../core/money.js';
import type { Mint } from '../core/types.js';
import { priceOf, type PriceOfDeps, type QuoteAsset } from './quote.js';

/** Which side of the trade the whale test values. */
export type WhaleBasis = 'post' | 'pre';

export interface PricingInput {
  /** Quote leg, raw units of the QUOTE asset (lamports for SOL). */
  readonly quoteRaw: bigint;
  readonly quote: QuoteAsset;

  /** Traded token. */
  readonly mint: Mint;
  readonly tokensRaw: bigint;
  readonly decimals: number;
  readonly supplyRaw: bigint;

  /** Buyer's absolute holdings, straight from the transaction (see Phase 2). */
  readonly balanceBeforeRaw: bigint;
  readonly balanceAfterRaw: bigint;
}

export interface Pricing {
  /** USD value of the quote leg. */
  readonly usdIn: number;
  /** Trade-IMPLIED execution price: usdIn / tokens out. */
  readonly priceUsd: number;
  readonly marketCapUsd: number;
  /** The whale test. Valued at the SAME trade-implied price. */
  readonly holdingsUsd: number;
  /** Which quote asset priced this, for logs. */
  readonly quoteSymbol: string;
}

/**
 * Derive every USD figure for a buy, from ONE price.
 *
 * The critical property: `priceUsd` is trade-implied — it comes from this very
 * trade — and `marketCapUsd` and `holdingsUsd` are both derived from it. A buy and
 * the holdings it produces are therefore always valued consistently.
 *
 * Never substitute a different price source for holdings. If you price the buy at
 * the executed price but the holdings at some oracle mid-price, the two disagree,
 * and a wallet can appear to hold more (or less) than the trade it just made
 * implies. That inconsistency is what makes a whale call look fabricated.
 *
 * Returns null only when the quote asset cannot be priced (SOL feed stale for a
 * SOL-quoted buy). A stable-quoted buy is never held back by the SOL feed.
 */
export function derivePricing(
  input: PricingInput,
  deps: PriceOfDeps,
  whaleBasis: WhaleBasis = 'post',
): Pricing | null {
  const unit = priceOf(input.quote, deps);
  if (unit === null || !Number.isFinite(unit) || unit <= 0) return null;

  // Raw -> float happens HERE, once, at the boundary (INVARIANT 6).
  const quoteAmount = toFloat(rawAmount(input.quoteRaw, input.quote.decimals));
  const usdIn = quoteAmount * unit;

  const tokensOut = toFloat(rawAmount(input.tokensRaw, input.decimals));
  // A buy of zero tokens is not a buy. Guard the division rather than emit Infinity.
  if (!(tokensOut > 0)) return null;

  const priceUsd = usdIn / tokensOut;

  const supply = toFloat(rawAmount(input.supplyRaw, input.decimals));
  const marketCapUsd = priceUsd * supply;

  const basisRaw = whaleBasis === 'pre' ? input.balanceBeforeRaw : input.balanceAfterRaw;
  const holdingsUsd = priceUsd * toFloat(rawAmount(basisRaw, input.decimals));

  return { usdIn, priceUsd, marketCapUsd, holdingsUsd, quoteSymbol: input.quote.symbol };
}
