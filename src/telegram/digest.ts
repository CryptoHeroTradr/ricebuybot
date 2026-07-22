import { TIERS, type TierName } from '../core/tiers.js';
import type { Mint } from '../core/types.js';
import { usd } from '../render/format.js';

/**
 * FLOOD CONTROL. Phase 9.
 *
 * A launch pump is 200 buys in a minute. Posting a card for each of them does three bad
 * things at once: it rate-limits the bot into oblivion (Telegram allows roughly 20 posts a
 * minute to a group), it buries the chat so nobody can talk in the middle of the event they
 * came for, and it drops the tail of the burst on the floor anyway once the 120s staleness
 * rule kicks in.
 *
 * So above a threshold we switch to a DIGEST: one aggregate message per window, until the
 * rate drops back. Nothing is lost — every buy is still ingested, priced, folded into cost
 * basis and recorded. Only the POSTING is aggregated.
 */

export const BURST_THRESHOLD = 20;
export const WINDOW_MS = 60_000;

export interface BurstBuy {
  readonly usdIn: number;
  readonly tier: TierName;
  readonly at: number;
}

export interface Digest {
  readonly count: number;
  readonly totalUsd: number;
  readonly topUsd: number;
  /**
   * The HIGHEST TIER seen in the window — NOT the tier of the largest buy.
   *
   * This is the whole reason the digest knows about tiers at all. A whale making a $20 add
   * inside a burst is still a whale: the tier is holdings-based, so their $20 outranks
   * somebody else's $900. Taking the tier from the biggest buy would quietly re-introduce
   * the ladder the whole design exists to kill — the digest would say "BIG" and show big art
   * for a window that contained a whale.
   */
  readonly tier: TierName;
}

const rank = (t: TierName): number => TIERS.findIndex((x) => x.name === t);

/**
 * Per-mint sliding window. Counts QUALIFYING buys — ones that passed a chat's floor and
 * would have been posted. Buys nobody was going to see cannot cause a flood.
 */
export class BurstDetector {
  readonly #windows = new Map<Mint, BurstBuy[]>();
  readonly #now: () => number;
  readonly #threshold: number;
  readonly #windowMs: number;

  constructor(opts: { now?: () => number; threshold?: number; windowMs?: number } = {}) {
    this.#now = opts.now ?? Date.now;
    this.#threshold = opts.threshold ?? BURST_THRESHOLD;
    this.#windowMs = opts.windowMs ?? WINDOW_MS;
  }

  /** Record a qualifying buy and say whether this mint is now in a burst. */
  record(mint: Mint, buy: Omit<BurstBuy, 'at'>): boolean {
    const at = this.#now();
    const w = this.#prune(mint, at);
    w.push({ ...buy, at });
    return w.length > this.#threshold;
  }

  /** Is this mint bursting right now, without recording anything? */
  bursting(mint: Mint): boolean {
    return this.#prune(mint, this.#now()).length > this.#threshold;
  }

  /**
   * Take everything in the window and clear it. The digest covers exactly what it drains, so
   * a buy is counted in exactly one digest — never dropped, never double-counted.
   */
  drain(mint: Mint): Digest | null {
    const w = this.#prune(mint, this.#now());
    if (w.length === 0) return null;
    this.#windows.set(mint, []);

    let totalUsd = 0;
    let topUsd = 0;
    let tier: TierName = 'Regular';

    for (const b of w) {
      totalUsd += b.usdIn;
      if (b.usdIn > topUsd) topUsd = b.usdIn;
      if (rank(b.tier) > rank(tier)) tier = b.tier; // HIGHEST tier, not the biggest buy
    }

    return { count: w.length, totalUsd, topUsd, tier };
  }

  #prune(mint: Mint, at: number): BurstBuy[] {
    const w = (this.#windows.get(mint) ?? []).filter((b) => at - b.at < this.#windowMs);
    this.#windows.set(mint, w);
    return w;
  }
}

/** "14 buys · $2,481 total · top buy $612" */
export function digestText(symbol: string, d: Digest, headline: string): string {
  return [headline, '', `${d.count} buys · ${usd(d.totalUsd)} total · top buy ${usd(d.topUsd)}`, `$${symbol}`].join(
    '\n',
  );
}

/**
 * OPTIONAL per-chat daily send cap. Default OFF.
 *
 * Off by default on purpose: a cap that silently stops posting is indistinguishable, from
 * inside the group, from a bot that has broken. It exists for the operator who explicitly
 * wants it, and it says so in the log when it bites.
 */
export class DailyCap {
  readonly #counts = new Map<string, { day: number; n: number }>();
  readonly #now: () => number;

  constructor(private readonly limit: number | null, now: () => number = Date.now) {
    this.#now = now;
  }

  /** True when this chat may still post today. Always true when the cap is off. */
  allow(chatId: number): boolean {
    if (this.limit === null || this.limit <= 0) return true;

    const day = Math.floor(this.#now() / 86_400_000);
    const cur = this.#counts.get(String(chatId));

    if (!cur || cur.day !== day) {
      this.#counts.set(String(chatId), { day, n: 1 });
      return true;
    }
    if (cur.n >= this.limit) return false;
    cur.n++;
    return true;
  }
}
