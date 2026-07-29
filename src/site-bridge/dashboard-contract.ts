/**
 * THE CONTRACT for `POST /site/schedules` — the shape the website renders its autotrader dashboard
 * from, and the reason Phase C does not have to guess.
 *
 * THIS FILE HAS NO IMPORTS AND MUST KEEP NONE. It is the one file the site copies (or pins by git
 * ref) into its own tree, so anything it depended on would have to come along with it. Everything
 * here is a type or a plain constant; there is no runtime behaviour to drift between the two repos.
 *
 * TWO RULES THAT SHAPE EVERY FIELD BELOW.
 *
 * 1. ONLY THE LINKED USER'S OWN DATA. Every figure is read with the Telegram user id that the
 *    signing wallet resolved to at request time, through the same user-scoped repo reads the panel
 *    uses (`listSchedules(userId)`, `getCaps(userId, mint)`, `listExecutionsForUser(userId, …)`).
 *    There is no field here whose value depends on anybody else's rows.
 *
 * 2. NOTHING SECRET, EVER — and the omissions are deliberate, not oversights:
 *
 *    * NO CUSTODIAL PUBKEY. The Telegram panel shows the keystore's address; this does not. The
 *      bridge has no keystore access and is not being given any, and an address the bot derives
 *      from a key it holds is a fact about that key. The wallet the user PROVED they own comes
 *      back (`walletMode.linkedWallet`) — that one they just signed with, so telling them their
 *      own address discloses nothing.
 *    * NO WALLET BALANCES. The panel's SOL/token lines come from an RPC read against that
 *      custodial address, so they are downstream of the same thing.
 *    * NO passphrase, no key material, no unlock state, no bot token, no shared secret. A test
 *      greps every response this surface can produce for a field named like one.
 *
 * Money follows INVARIANT 6 across the wire: raw integer amounts are STRINGS (JSON has no bigint
 * and `Number` would round a u64), and every `…Usd` field is a display dollar figure, already a
 * float in the DB, never summed into anything on the site.
 */

/** How many recent executions the dashboard carries. The panel shows the last one per schedule;
 *  this is the site's history strip. Fixed here so the site can say "showing the last 10". */
export const SITE_EXECUTION_LIMIT = 10;

/** How many observed wallet-mode DCA fills come back, newest first. Mirrors the panel's list. */
export const SITE_WALLET_BUY_LIMIT = 5;

/** The window the digest figures cover. The daily DM's window, so the two agree. */
export const SITE_DIGEST_WINDOW_MS = 86_400_000;

export type SiteTraderMode = 'wallet' | 'key';
export type SiteScheduleState = 'active' | 'paused' | 'halted';
export type SiteSide = 'buy' | 'sell';
export type SiteAmountKind = 'absolute' | 'percent_of_balance';
export type SiteExecutionState = 'claimed' | 'submitted' | 'confirmed' | 'failed' | 'UNKNOWN';

/**
 * RULE A OVER THE WIRE — whether real money is at stake, and who holds the key.
 *
 * This is the field the site must render unmissably and first, exactly as the panel renders it on
 * line one and line two. A person managing money from a browser needs to know they are pointed at
 * a live wallet just as much as a person in a Telegram chat does, and the failure mode is the same
 * one RULE A was written for: **absence of a warning is not a signal**. Never infer the mode from
 * which controls happen to be present.
 *
 * Both a BOOLEAN and the bot's own SENTENCE come back. The boolean is what the site styles on (red
 * vs amber); the sentence is what it prints, so the wording cannot drift between the two surfaces
 * the way two independently-maintained copies of a warning always eventually do.
 */
export interface SiteBanner {
  /** TRADE_LIVE. `true` = real swaps with real money. */
  readonly tradeLive: boolean;
  /** Whether the bot holds a key that can spend this user's money. */
  readonly mode: SiteTraderMode;
  /** The panel's own first line, verbatim: "🔴 LIVE — real swaps" / "🟡 DRY RUN — …". */
  readonly text: string;
  /** The panel's own second line, verbatim: "🔑 KEY mode — …" / "🔐 WALLET mode — …". */
  readonly modeText: string;
}

export interface SiteCaps {
  readonly perExecUsd: number;
  readonly perDayUsd: number;
  /** null = no lifetime budget set. */
  readonly lifetimeUsd: number | null;
}

/** What has been spent against the caps above, on the same (user, mint) the caps are keyed by.
 *  CONFIRMED + UNKNOWN, the same rule the executor counts by — an UNKNOWN may have spent. */
export interface SiteSpend {
  readonly todayUsd: number;
  readonly lifetimeUsd: number;
}

export interface SiteExecution {
  readonly id: number;
  readonly scheduleId: number;
  readonly plannedAt: number;
  readonly state: SiteExecutionState;
  /** The on-chain signature — public data, and what a user needs to check the trade themselves. */
  readonly signature: string | null;
  /** Raw integer amounts as STRINGS (INVARIANT 6). null until settled. */
  readonly inRaw: string | null;
  readonly outRaw: string | null;
  readonly priceUsd: number | null;
  readonly usdValue: number | null;
  /** Why it failed, or why it is UNKNOWN. Operator-facing text; never carries a secret. */
  readonly error: string | null;
}

export interface SiteSchedule {
  readonly id: number;
  readonly mint: string;
  readonly side: SiteSide;
  readonly amountKind: SiteAmountKind;
  /** Raw integer amount as a STRING: lamports for a buy, token units for an absolute sell, or
   *  BASIS POINTS for `percent_of_balance` (1000 = 10%). */
  readonly amountRaw: string;
  readonly intervalMinutes: number;
  readonly slippageBps: number;
  readonly state: SiteScheduleState;
  /** Set iff `state === 'halted'`. Free text meant for a human — show it verbatim.
   *  A halt naming an UNKNOWN outcome cannot be cleared by resume: only `/resolve` in the bot. */
  readonly haltReason: string | null;
  readonly nextRunAt: number;
  readonly lastRunAt: number | null;
  /** Caps for THIS schedule's mint, and the spend against them. */
  readonly caps: SiteCaps | null;
  readonly spentTodayUsd: number;
  readonly spentLifetimeUsd: number;
  /** The most recent execution for this schedule — what the panel renders as "last … → … at HH:MM". */
  readonly lastExecution: SiteExecution | null;
}

/** The 24h figures behind the daily digest DM, unrendered. Same window, same counting rules, so a
 *  user reading the site and a user reading the DM see the same numbers.
 *
 *  The digest's wallet-balance line is deliberately ABSENT — it is an RPC read against the
 *  custodial address, which this surface does not disclose (see the header). */
export interface SiteDigest {
  readonly windowMs: number;
  readonly executions: number;
  readonly confirmed: number;
  readonly submitted: number;
  readonly unknown: number;
  readonly failed: number;
  /** CONFIRMED + UNKNOWN spend in the window — an UNKNOWN may have spent (INVARIANT 16). */
  readonly spentUsd: number;
  readonly avgTradeUsd: number;
  /** Mean executed price across priced executions, or null if none were priced. */
  readonly avgFillPriceUsd: number | null;
  /** How many settings the user changed in the window, from either surface. */
  readonly settingChanges: number;
  /** Schedules currently halted and waiting on the user. */
  readonly halted: readonly { readonly id: number; readonly haltReason: string | null }[];
}

/**
 * Present iff `banner.mode === 'wallet'`. In wallet mode the bot runs no schedule and holds no key,
 * so there is nothing custodial to show; what it CAN show is the wallet the user proved, and the
 * DCA fills it observed on-chain for that wallet.
 *
 * These are FILLS THE BOT SAW, not open Jupiter orders. The bot never asks Jupiter anything on
 * anyone's behalf — live order state belongs to the Mini App / the site's own Jupiter client, which
 * has the user's wallet connected. Showing a stale count here that looks authoritative is worse
 * than pointing at where the truth lives.
 */
export interface SiteWalletMode {
  readonly linkedWallet: string | null;
  readonly recentBuys: readonly {
    /** Raw token units as a STRING (INVARIANT 6). */
    readonly tokensRaw: string;
    readonly usdIn: number;
    readonly at: number;
  }[];
}

/**
 * THE RESPONSE. `POST /site/schedules` returns this, whatever the caller's state.
 *
 * `linked: false` is a full, valid answer, not an error: a proven wallet that no Telegram user has
 * linked gets the banner (so the site can still say LIVE or DRY RUN) and empty everything else.
 */
export interface SiteDashboard {
  readonly ok: true;
  readonly linked: boolean;
  readonly banner: SiteBanner;
  /** The user's configured contract, or the bot's default when they have never set one. null when
   *  unlinked. `symbol` falls back to the mint's first four characters, exactly as the panel does. */
  readonly contract: { readonly mint: string; readonly symbol: string } | null;
  readonly schedules: readonly SiteSchedule[];
  /** Caps for the CONTRACT mint (the ones the panel's cap line shows), and the spend against them. */
  readonly caps: SiteCaps | null;
  readonly spend: SiteSpend | null;
  /** Newest first, at most {@link SITE_EXECUTION_LIMIT}. */
  readonly executions: readonly SiteExecution[];
  readonly digest: SiteDigest | null;
  readonly walletMode: SiteWalletMode | null;
  /** THE BOT'S clock, in ms. Count down to `nextRunAt` against this, not against the browser's —
   *  a machine with a skewed clock would otherwise render "next in -3m" and look broken. */
  readonly serverTime: number;
}
