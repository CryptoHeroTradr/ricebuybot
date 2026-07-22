import { pct } from './format.js';

/**
 * THE RENDER RULE. Pure.
 *
 * NEVER show a Position % from an unreconciled ledger. Being publicly wrong about
 * a whale's PnL is far worse than saying nothing — a missing line is invisible, a
 * wrong "+2%" on a wallet that is up 900% is a screenshot.
 *
 * `holdingsUsd` is NOT gated by any of this: it comes straight from the chain
 * (`balanceAfterRaw`) and is always exact, reconciled or not.
 */

export interface PositionView {
  readonly reconciled: boolean;
  /** Ledger tokens held AFTER this buy. */
  readonly tokensRaw: bigint;
  /** The wallet's on-chain balance BEFORE this buy. 0 = they held nothing. */
  readonly balanceBeforeRaw: bigint;
  /** Weighted-average cost, USD per whole token. 0 when there is no basis. */
  readonly avgCostUsd: number;
  /** Trade-implied execution price of THIS buy, USD per whole token. */
  readonly priceUsd: number;
  /** Has the ledger ever seen this wallet before this buy? */
  readonly hasPriorHistory: boolean;
}

export type PositionLine =
  | { readonly kind: 'new-holder'; readonly text: string }
  | { readonly kind: 'returning'; readonly text: string }
  | { readonly kind: 'position'; readonly text: string; readonly pctChange: number }
  /**
   * Reconciled, and every token in the bag arrived FREE. The cost basis is genuinely
   * zero (Phase 4.7).
   *
   * This line is only safe to print because `basis_unpriced` keeps arbs out of it. An
   * arb also has a zero cost basis, but its zero is a hole in our knowledge, not a
   * fact about the world; it never reaches here, because it never reconciles.
   *
   * IT CARRIES NO NUMBER (Phase 4.8).
   *
   * This line occupies the SAME SLOT on the card as `Position +128%`. Anything
   * numeric here is read on the same scale as that — so "100%" invites a reader to
   * compare it against 128% and conclude the free bag did WORSE. It did infinitely
   * better: a return against a zero basis is UNDEFINED, not 100%.
   *
   * Two incommensurable quantities must never share a slot. State the fact — there is
   * no cost basis — and let the absence of a figure be the figure.
   */
  | { readonly kind: 'free'; readonly text: string }
  /** Known wallet, ledger does not agree with the chain. Say NOTHING. */
  | { readonly kind: 'omitted'; readonly text: null };

export function positionLine(v: PositionView): PositionLine {
  // Held nothing on-chain before this buy. The chain is unambiguous here, so this
  // is safe to state regardless of what the ledger thinks.
  if (v.balanceBeforeRaw === 0n) {
    return v.hasPriorHistory
      ? { kind: 'returning', text: '🔁 Returning' } // fully exited, now re-entering
      : { kind: 'new-holder', text: '🆕 New Holder' };
  }

  // They held tokens before this buy, but our cost basis does not describe that bag —
  // either we are missing legs (drift, truncated history) or we have them all and
  // cannot value one (an arb into an unvaluable token). Any percentage computed here
  // would be arithmetic on a quantity we do not actually know. Say NOTHING.
  if (!v.reconciled) return { kind: 'omitted', text: null };

  if (v.tokensRaw <= 0n) return { kind: 'omitted', text: null };

  // Reconciled with a zero basis: every token was free, and we KNOW it was free (an
  // unpriceable basis would not have reconciled). No number — see PositionLine.
  if (!(v.avgCostUsd > 0)) return { kind: 'free', text: '🎁 Free bag — no cost basis' };

  const pctChange = ((v.priceUsd - v.avgCostUsd) / v.avgCostUsd) * 100;
  return { kind: 'position', text: `Position ${pct(pctChange)}`, pctChange };
}
