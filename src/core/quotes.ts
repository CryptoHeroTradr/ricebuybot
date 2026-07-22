import type { Mint } from './types.js';

/**
 * The quote-asset registry. DATA, not branching.
 *
 * Adding a fourth quote asset must be a ONE-LINE addition to QUOTE_REGISTRY and
 * nothing else. If you find yourself writing `if (mint === ...)` anywhere
 * downstream of this file, you have broken the design — the whole point is that
 * the normalizer iterates the registry and never names an asset.
 */

export type QuotePriceSource = 'sol' | 'stable';

export interface QuoteAssetDef {
  readonly mint: Mint;
  readonly symbol: string;
  readonly decimals: number;
  readonly priceSource: QuotePriceSource;
}

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

/**
 * Native SOL and wSOL are the SAME asset. The chain reports them separately
 * (lamport balances vs an SPL token account), so the normalizer nets them
 * together under this one entry.
 */
export const QUOTE_REGISTRY: readonly QuoteAssetDef[] = Object.freeze([
  { mint: WSOL_MINT, symbol: 'SOL', decimals: 9, priceSource: 'sol' },
  { mint: USDC_MINT, symbol: 'USDC', decimals: 6, priceSource: 'stable' },
  { mint: USDT_MINT, symbol: 'USDT', decimals: 6, priceSource: 'stable' },
]);

export const QUOTE_BY_MINT: ReadonlyMap<Mint, QuoteAssetDef> = new Map(
  QUOTE_REGISTRY.map((q) => [q.mint, q]),
);

export function isQuoteMint(mint: Mint): boolean {
  return QUOTE_BY_MINT.has(mint);
}

export function quoteDef(mint: Mint): QuoteAssetDef | null {
  return QUOTE_BY_MINT.get(mint) ?? null;
}

/**
 * Reference SOL price used ONLY to rank competing quote legs when the live feed
 * has not produced a tick yet.
 *
 * It never prices a buy — pricing/ does that with the real feed. It exists so
 * that "which of these two negative balances is the dominant one" has an answer
 * during the first moments after boot. Ranking only needs relative magnitude, and
 * a leg has to be within ~2 orders of magnitude of another for this to matter at
 * all; when two legs are that close we emit a warning anyway.
 */
export const REFERENCE_SOL_USD = 150;

/**
 * Approximate USD value of a raw quote amount. Used for RANKING legs, and for the
 * 5% multi-asset warning threshold. Never rendered to a user.
 */
export function approxUsd(def: QuoteAssetDef, raw: bigint, solUsd: number | null): number {
  const unit = def.priceSource === 'sol' ? (solUsd ?? REFERENCE_SOL_USD) : 1;
  const abs = raw < 0n ? -raw : raw;
  // Ranking only; a float divide is fine and never feeds a posted figure.
  return (Number(abs) / 10 ** def.decimals) * unit;
}
