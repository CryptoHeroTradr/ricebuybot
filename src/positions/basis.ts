/**
 * Weighted-average cost basis. PURE — no I/O, no clock.
 *
 * Quantities stay in raw integer units (INVARIANT 6). USD is a float, because it
 * is a derived display quantity, but it is only ever combined at this boundary.
 */

export interface BasisState {
  /** Raw token units the LEDGER believes this wallet holds. Never negative. */
  readonly tokensRaw: bigint;
  /** USD paid for the tokens the ledger believes are still held. Never negative. */
  readonly costUsd: number;
  readonly realizedPnlUsd: number;
}

export const EMPTY_BASIS: BasisState = { tokensRaw: 0n, costUsd: 0, realizedPnlUsd: 0 };

/** Raw units -> whole tokens. The one place this conversion happens for basis math. */
export function toWhole(raw: bigint, decimals: number): number {
  if (raw === 0n) return 0;
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const s = decimals === 0
    ? abs.toString()
    : `${abs / scale}.${(abs % scale).toString().padStart(decimals, '0')}`;
  const n = Number(s);
  return negative ? -n : n;
}

/**
 * Average cost in USD per WHOLE token.
 * Zero when the ledger holds nothing — a wallet with no tracked tokens has no basis.
 *
 * Takes only the two fields it uses, so a `Position` (whose `realizedPnlUsd` may be
 * NULL — see Phase 4.8) can be passed straight in. Realized PnL has no bearing on the
 * average cost of the tokens still held.
 */
export function avgCostUsd(state: Pick<BasisState, 'tokensRaw' | 'costUsd'>, decimals: number): number {
  const held = toWhole(state.tokensRaw, decimals);
  if (held <= 0) return 0;
  return state.costUsd / held;
}

export function applyBuy(state: BasisState, buy: { tokensRaw: bigint; usdIn: number }): BasisState {
  return {
    tokensRaw: state.tokensRaw + buy.tokensRaw,
    costUsd: state.costUsd + buy.usdIn,
    realizedPnlUsd: state.realizedPnlUsd,
  };
}

/**
 * A sell retires cost at the CURRENT weighted average, so the average basis of
 * the tokens that remain is unchanged.
 *
 * Everything floors at zero. A wallet can legitimately sell more than the ledger
 * knows about (the bot was added mid-life, or tokens arrived by transfer), and a
 * negative `tokensRaw` or `costUsd` would poison every later percentage. The floor
 * is a symptom, not a fix — `reconciled` is what actually tells you the ledger is
 * incomplete.
 */
export function applySell(
  state: BasisState,
  sell: { soldRaw: bigint; usdOut: number; decimals: number },
): BasisState {
  const avg = avgCostUsd(state, sell.decimals);
  const soldWhole = toWhole(sell.soldRaw, sell.decimals);
  const sellPriceUsd = soldWhole > 0 ? sell.usdOut / soldWhole : 0;

  const realized = state.realizedPnlUsd + (sellPriceUsd - avg) * soldWhole;
  const costOut = avg * soldWhole;

  const remaining = state.tokensRaw - sell.soldRaw;

  return {
    tokensRaw: remaining < 0n ? 0n : remaining,
    costUsd: Math.max(0, state.costUsd - costOut),
    realizedPnlUsd: realized,
  };
}

/** Tokens arriving by transfer are FREE. Quantity up, cost unchanged. */
export function applyTransferIn(state: BasisState, tokensRaw: bigint): BasisState {
  return { ...state, tokensRaw: state.tokensRaw + tokensRaw };
}

/**
 * Tokens leaving by transfer are a quantity-only reduction: retire cost at the
 * current average, but book NO realized PnL — nothing was sold, so nothing was
 * made or lost.
 */
export function applyTransferOut(state: BasisState, tokensRaw: bigint, decimals: number): BasisState {
  const avg = avgCostUsd(state, decimals);
  const outWhole = toWhole(tokensRaw, decimals);
  const remaining = state.tokensRaw - tokensRaw;

  return {
    tokensRaw: remaining < 0n ? 0n : remaining,
    costUsd: Math.max(0, state.costUsd - avg * outWhole),
    realizedPnlUsd: state.realizedPnlUsd,
  };
}
