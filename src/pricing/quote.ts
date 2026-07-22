import type { Mint } from '../core/types.js';

/**
 * How a quote asset gets a USD price.
 *
 *   'sol'    -> ask the SOL/USD feed
 *   'stable' -> pegged, configurable (default 1.00)
 */
export type QuoteKind = 'sol' | 'stable';

export interface QuoteAsset {
  readonly mint: Mint;
  readonly symbol: string;
  readonly decimals: number;
  readonly kind: QuoteKind;
}

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

export const QUOTE_ASSETS: Readonly<Record<Mint, QuoteAsset>> = Object.freeze({
  [WSOL_MINT]: { mint: WSOL_MINT, symbol: 'SOL', decimals: 9, kind: 'sol' },
  [USDC_MINT]: { mint: USDC_MINT, symbol: 'USDC', decimals: 6, kind: 'stable' },
  [USDT_MINT]: { mint: USDT_MINT, symbol: 'USDT', decimals: 6, kind: 'stable' },
});

/** SOL and wSOL are the same asset for pricing; the normalizer nets them together. */
export const SOL_QUOTE = QUOTE_ASSETS[WSOL_MINT] as QuoteAsset;

export function quoteAssetFor(mint: Mint): QuoteAsset | null {
  return QUOTE_ASSETS[mint] ?? null;
}

export interface PriceOfDeps {
  /** Latest SOL/USD, or null when the feed is stale. */
  readonly solUsd: number | null;
  /** What a stablecoin is worth. Configurable — a depeg is not our problem to hide. */
  readonly stableUsd: number;
}

/**
 * USD price of ONE unit of the quote asset.
 *
 * Returns null only when the asset needs the SOL feed and the SOL feed is down.
 * A stable-quoted buy never returns null, which is the whole point: one dead
 * websocket must not hold back buys it has no bearing on.
 */
export function priceOf(asset: QuoteAsset, deps: PriceOfDeps): number | null {
  switch (asset.kind) {
    case 'sol':
      return deps.solUsd;
    case 'stable':
      return deps.stableUsd;
  }
}
