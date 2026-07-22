/**
 * BILLING PLANS. Phase 11. Pure data — no I/O.
 *
 * NOT "tier". `tier` already means Regular/Big/Whale/Massive everywhere in this codebase —
 * folder names, DB CHECK constraints, `media_items.tier`, `TierFolder`, 27 source files. A
 * `chats.tier` column meaning "free vs paid" would put two unrelated concepts one word apart
 * and guarantee that somebody, someday, reads the wrong one. This is a PLAN.
 *
 * THE CAPABILITY TABLE IS THE ONLY SOURCE OF TRUTH.
 *
 * Every gate in the codebase reads from `capabilities()`. Nothing anywhere else is allowed to
 * write `if (plan === 'free')` — because the moment a second place decides what free means,
 * the two disagree, and the way you find out is a free chat quietly using a paid feature (or a
 * paying customer being denied one). Adding a capability is one line here and a read at the
 * point of use.
 */
export type Plan = 'free' | 'paid';

export const PLANS: readonly Plan[] = ['free', 'paid'] as const;

export function isPlan(v: unknown): v is Plan {
  return typeof v === 'string' && (PLANS as readonly string[]).includes(v);
}

export interface Capabilities {
  /** How many mints one chat may track at once. */
  readonly maxMints: number;
  /** Premium/custom emoji in the ladder (a `custom_emoji` entity). */
  readonly customEmoji: boolean;
  /** The shared media pool, with tiered rotation. Free chats get static or nothing. */
  readonly mediaPool: boolean;
  /**
   * Delay before a card is sent, ms.
   *
   * The free plan posts 5 seconds late. This is the only "artificial" limit here, and it is
   * deliberately the mildest one that is still felt: in a chat watching for buys, being five
   * seconds behind the chart is noticeable and slightly annoying, and it costs a free group
   * nothing they had. It does not lose a single buy — the queue's staleness rule is 120s, so
   * a 5s delay is nowhere near it.
   */
  readonly postDelayMs: number;
  /** Custom keyboard buttons via /setlink. Free chats keep the three defaults. */
  readonly customLinks: boolean;
}

const FREE: Capabilities = Object.freeze({
  maxMints: 1,
  customEmoji: false,
  mediaPool: false,
  postDelayMs: 5_000,
  customLinks: false,
});

const PAID: Capabilities = Object.freeze({
  maxMints: 10,
  customEmoji: true,
  mediaPool: true,
  postDelayMs: 0,
  customLinks: true,
});

export function capabilities(plan: Plan): Capabilities {
  return plan === 'paid' ? PAID : FREE;
}

/**
 * The upsell copy, per capability.
 *
 * Kept HERE, next to the limits, so a limit and the sentence that explains it can never drift
 * apart — and so every one of them can be read at a glance by whoever is deciding whether the
 * free plan is too mean or too generous.
 *
 * The rule for the copy: say what they get, not what they are missing. A group that hits a
 * limit is a group that is USING the bot, which is exactly the moment to be gracious about it.
 */
export const UPSELL: Readonly<Record<keyof Capabilities, string>> = Object.freeze({
  maxMints: 'The free plan tracks one token per group. A paid plan tracks up to 10.',
  customEmoji: 'Custom and premium emoji are a paid feature. Your ladder still works with any standard emoji.',
  mediaPool:
    'The tiered meme pool — a different meme for every buy size, never repeating until the tier is exhausted — is a paid feature.\n\nOn the free plan you can still set ONE image for every buy: `/mediamode static` then `/setmedia`.',
  postDelayMs: 'Free posts arrive 5 seconds after the buy lands. Paid posts are instant.',
  customLinks:
    'Custom buttons are a paid feature. Your cards still get DexTools, DexScreener and a Buy button.',
});
