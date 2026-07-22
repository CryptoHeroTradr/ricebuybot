/**
 * The four tiers are a SCHEMA CONSTANT, not configuration.
 *
 * The names and the count (always four) are fixed. Only the USD floors and the
 * headlines are per-chat configurable. These names are the canonical vocabulary:
 * use them in folder names, DB values, log lines, commands and docs.
 *
 * Never say "tier 3" in user-facing copy. Say "Whale".
 */

export const TIER_NAMES = ['Regular', 'Big', 'Whale', 'Massive'] as const;

export type TierName = (typeof TIER_NAMES)[number];

/** Folder under `<MEDIA_ROOT>/<mint>/` that holds this tier's curated memes. */
export type TierFolder = 'regular' | 'big' | 'whale' | 'massive';

export interface TierSpec {
  /** 1-based ordinal. Internal only — never render this to a user. */
  readonly index: 1 | 2 | 3 | 4;
  readonly name: TierName;
  readonly folder: TierFolder;
  readonly defaultHeadline: string;
}

export const TIERS: readonly [TierSpec, TierSpec, TierSpec, TierSpec] = [
  { index: 1, name: 'Regular', folder: 'regular', defaultHeadline: '🍚 {SYM} Buy!' },
  { index: 2, name: 'Big', folder: 'big', defaultHeadline: '🍚 BIG {SYM} Buy!' },
  { index: 3, name: 'Whale', folder: 'whale', defaultHeadline: '🐳 WHALE BUY!' },
  { index: 4, name: 'Massive', folder: 'massive', defaultHeadline: '💥 MASSIVE BUY!' },
] as const;

/** Tier folder names, in ascending order. The ONLY legal values of `media_items.tier`. */
export const TIER_FOLDERS: readonly TierFolder[] = Object.freeze(TIERS.map((t) => t.folder));

/** Per-tier headlines, the shape stored in `chat_tokens.tier_headlines`. */
export const DEFAULT_HEADLINES: readonly string[] = Object.freeze(TIERS.map((t) => t.defaultHeadline));

/** Substitute the token symbol into a headline template. `{SYM}` -> `RICE`. */
export function renderHeadline(template: string, symbol: string | null): string {
  return template.replaceAll('{SYM}', symbol ?? '');
}

export function isTierFolder(v: unknown): v is TierFolder {
  return typeof v === 'string' && (TIER_FOLDERS as readonly string[]).includes(v);
}

/**
 * The per-chat tier policy. THREE numbers, and one of them is not like the others.
 *
 * `whaleHoldingsUsd` is denominated in what the wallet HOLDS. The other two are
 * denominated in what it just SPENT. They are different quantities and they live in
 * different columns for that reason — the old single ascending array could not
 * express this, and quietly mis-tiered every accumulating whale.
 */
export interface TierPolicy {
  /** Buys below this never reach tier selection. Filtered at fan-out. */
  readonly minBuyUsd: number;
  readonly bigUsd: number;
  readonly massiveUsd: number;
  /** HOLDINGS, not buy size. The whole reason the chain is not a ladder. */
  readonly whaleHoldingsUsd: number;
}

export const DEFAULT_TIER_POLICY: TierPolicy = Object.freeze({
  minBuyUsd: 10,
  bigUsd: 250,
  massiveUsd: 1000,
  whaleHoldingsUsd: 10_000,
});

/**
 * Pick the tier for a buy. A PRIORITY CHAIN, top-down, first match wins — NOT a ladder.
 *
 *   1. massive   usdIn       >= massiveUsd          ($1,000)
 *   2. whale     holdingsUsd >= whaleHoldingsUsd    ($10,000)   <- HOLDINGS
 *   3. big       usdIn       >= bigUsd              ($250)
 *   4. regular   otherwise
 *
 * Returns null when the buy is below `minBuyUsd` — it should never have got here
 * (fan-out filters it), but a tier engine that can be asked about a $0.02 buy should
 * answer honestly rather than call it Regular.
 *
 * WHY THE ORDER IS THE DESIGN:
 *
 * - **Whale sits ABOVE big.** A $20 buy from a wallet holding $50,000 is a Whale buy.
 *   Under the old ladder it was "Regular" — the single most interesting event the bot
 *   can post (a big bag quietly accumulating) got a regular meme and no fanfare.
 *
 * - **Massive sits above whale, deliberately.** A $12,000 buy qualifies as both. It is
 *   posted as MASSIVE, because the event is the *buy*: a wallet moving that much size
 *   right now is the story, and it is the story whether or not they already held a bag.
 *
 * - **Big is checked AFTER whale**, so a chunky buy from a small holder ($340 buy, $600
 *   held) is Big and not Whale. Buy size alone never makes a whale. That is the whole
 *   distinction the tier is named for.
 *
 * `holdingsUsd` is priced on the SAME trade-implied price as the buy (see pricing/),
 * and on the pre- or post-trade balance according to WHALE_BASIS.
 */
export function pickTier(usdIn: number, whaleValueUsd: number, policy: TierPolicy): TierSpec | null {
  if (!Number.isFinite(usdIn) || usdIn < policy.minBuyUsd) return null;

  // whaleValueUsd is the buyer's LIQUID WALLET VALUE (SOL + USDC), not their bag of this token.
  // See pricing/wallet-value.ts for why it changed.
  const whaleValue = Number.isFinite(whaleValueUsd) ? whaleValueUsd : 0;

  if (usdIn >= policy.massiveUsd) return TIER_BY_NAME.Massive;
  if (whaleValue >= policy.whaleHoldingsUsd) return TIER_BY_NAME.Whale;
  if (usdIn >= policy.bigUsd) return TIER_BY_NAME.Big;
  return TIER_BY_NAME.Regular;
}

export const TIER_BY_NAME: Readonly<Record<TierName, TierSpec>> = Object.freeze(
  Object.fromEntries(TIERS.map((t) => [t.name, t])) as Record<TierName, TierSpec>,
);

export const TIER_BY_FOLDER: Readonly<Record<TierFolder, TierSpec>> = Object.freeze(
  Object.fromEntries(TIERS.map((t) => [t.folder, t])) as Record<TierFolder, TierSpec>,
);

export function isTierName(v: unknown): v is TierName {
  return typeof v === 'string' && (TIER_NAMES as readonly string[]).includes(v);
}

export function defaultHeadlines(): Record<TierName, string> {
  return Object.fromEntries(TIERS.map((t) => [t.name, t.defaultHeadline])) as Record<TierName, string>;
}
