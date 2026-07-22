import { TIER_FOLDERS, type TierFolder } from '../core/tiers.js';

/**
 * Find a tier that actually HAS art, starting from the one the buy earned.
 *
 * NEVER FAIL A POST BECAUSE ART IS MISSING. A buy is a real event on the chain; a meme
 * is decoration. If the decoration is unavailable, the event still gets announced.
 *
 * The walk is DOWN first, then UP:
 *
 *   1. the earned tier
 *   2. downward:  massive -> whale -> big -> regular
 *   3. upward:    ...back the other way
 *
 * Down-first is deliberate. Borrowing DOWN means a whale buy shows a `big/` meme — a
 * slightly less special image for a very special buy, which reads as a stocking
 * problem. Borrowing UP means a $12 buy shows a `massive/` meme, which spends the
 * pool's best art — the hand-curated bangers that are the payoff of the whole feature —
 * on the most ordinary event there is. Down is the cheaper mistake, so we make it first.
 * Up is the last resort, and it is still better than posting nothing.
 *
 * The EARNED tier is not changed by any of this. It is returned separately and the
 * headline is rendered from it, so a whale that borrowed a big/ meme still says
 * "🐳 WHALE BUY!". See `Pick`.
 *
 * @param counts live item count per tier folder
 * @returns the folder to draw from, or null when the entire pool is empty
 */
export function resolveTierWithFallback(
  earned: TierFolder,
  counts: Readonly<Record<TierFolder, number>>,
): TierFolder | null {
  if ((counts[earned] ?? 0) > 0) return earned;

  const order = TIER_FOLDERS; // regular, big, whale, massive — ascending
  const at = order.indexOf(earned);

  // Down: towards regular.
  for (let i = at - 1; i >= 0; i--) {
    const tier = order[i] as TierFolder;
    if ((counts[tier] ?? 0) > 0) return tier;
  }
  // Up: towards massive. Last resort — this spends the good art on a small buy.
  for (let i = at + 1; i < order.length; i++) {
    const tier = order[i] as TierFolder;
    if ((counts[tier] ?? 0) > 0) return tier;
  }
  return null;
}
