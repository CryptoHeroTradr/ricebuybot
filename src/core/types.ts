/**
 * Domain types. NO I/O in this module — it must stay importable from anywhere,
 * including tests, without touching the network, the disk, or the clock.
 */

import type { RawAmount } from './money.js';
import type { TierFolder, TierName } from './tiers.js';

/** Base58 mint address. */
export type Mint = string;
/** Base58 wallet address. */
export type Wallet = string;
/** Base58 transaction signature. Unique per swap; half of the send idempotency key. */
export type Signature = string;
/** Telegram chat id. Negative for groups/supergroups. */
export type ChatId = number;

/** Which asset the swap was quoted in. Determines how we derive USD. */
export type QuoteAsset = 'SOL' | 'USDC' | 'USDT' | 'OTHER';

/**
 * A detected swap, produced by balance-delta parsing.
 *
 * INVARIANT 1: this is DEX-agnostic. It is derived from pre/post token balance
 * deltas only. It carries no DEX identity because we never decode one.
 */
export interface SwapEventBase {
  readonly signature: Signature;
  readonly slot: number;
  /** Block time, SECONDS since epoch (as the chain reports it). Null if absent. */
  readonly blockTime: number | null;
  readonly mint: Mint;

  /**
   * The DOMINANT quote leg — the single asset the buyer actually paid with.
   *
   * Not a sum of every asset that moved: ATA rent and fee dust would be counted
   * as spend, and that corrupts priceUsd, which feeds market cap AND the whale
   * test. One bad line item poisons three numbers.
   *
   * Native SOL and wSOL are netted together and reported as the wSOL mint.
   */
  readonly quoteMint: Mint;
  readonly quoteSymbol: string;
  /** Raw units OF THE QUOTE ASSET (lamports for SOL, 6dp for USDC). Always positive. */
  readonly quoteRaw: bigint;

  /** Tokens moved, raw units. Always positive. */
  readonly tokensRaw: bigint;
  /**
   * The wallet's ABSOLUTE holding of this mint, before and after the trade,
   * summed over every token account of theirs the transaction touched.
   *
   * Read straight out of the transaction — no extra RPC call, and NOT derived
   * from the positions ledger. The ledger only knows buys this bot has seen, so
   * a long-standing whale it has never seen would read as ~zero: exactly the
   * wallet you most need to catch.
   *
   * Guaranteed: balanceAfterRaw - balanceBeforeRaw === ±tokensRaw.
   *
   * KNOWN LIMITATION: a holder keeping this mint in a SECOND token account that
   * this transaction does not touch will under-report. Rare, accepted, and
   * cheaper than an RPC round-trip on every single buy.
   */
  readonly balanceBeforeRaw: bigint;
  readonly balanceAfterRaw: bigint;
}

export interface BuyEvent extends SwapEventBase {
  readonly kind: 'buy';
  readonly buyer: Wallet;
}

/** Sells feed cost basis (Phase 4). They are NEVER posted to Telegram. */
export interface SellEvent extends SwapEventBase {
  readonly kind: 'sell';
  readonly seller: Wallet;
}

export type SwapEvent = BuyEvent | SellEvent;

/**
 * Tokens moved with NO quote leg on either side (Phase 4.6).
 *
 * A transfer is a real, classified event — it simply is not a buy. It used to be
 * reported as `null`, which forced the backfiller to carry a SECOND parser just to
 * see the airdrops and outbound sends that `normalizeSwap` was throwing away. Two
 * parsers means two classifications, and two classifications of one transaction is
 * how a wallet double-counts.
 *
 * One parser, two filters: the LIVE path drops these on the floor (they are never
 * posted), and the BACKFILL path keeps them — a transfer is precisely the thing that
 * makes a wallet unreconciled.
 *
 * No quote asset, and `usd_value` 0: they were FREE.
 */
export interface TransferEvent {
  readonly kind: 'transfer';
  readonly signature: Signature;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly mint: Mint;
  readonly wallet: Wallet;
  readonly direction: 'in' | 'out';
  /** Always POSITIVE. `direction` carries the sign. */
  readonly tokensRaw: bigint;
  readonly balanceBeforeRaw: bigint;
  readonly balanceAfterRaw: bigint;

  /**
   * The wallet MOVED A NON-REGISTRY TOKEN on the other side of this (Phase 4.7).
   *
   * A transfer with no counter-leg is a genuine FREE receipt — an airdrop — and
   * `usd_value = 0` is not an approximation, it is the truth. A transfer WITH a
   * counter-leg in some token we cannot price is an entirely different animal: the
   * wallet **paid for these tokens**, in an asset we have no USD figure for.
   *
   * Booking that at zero cost is what turns an arb into phantom profit. So we mark it
   * and ABSTAIN — see INVARIANT 13. We do not go looking for a price for the
   * counterparty token: a price for an arbitrary SPL token is a guess wearing a
   * decimal point, and a confident wrong percentage is exactly what INVARIANT 10
   * forbids.
   */
  readonly unpriced: boolean;
}

/** Everything `normalizeSwap` can classify. Null means it touched no wallet's mint. */
export type NormalizedEvent = BuyEvent | SellEvent | TransferEvent;

/** A Telegram group the bot has been added to. */
export interface Chat {
  readonly chatId: ChatId;
  readonly title: string | null;
  /** Telegram user id of whoever added the bot. */
  readonly addedBy: number | null;
  /** Paused chats keep their config but post nothing and drop out of activeMints(). */
  readonly paused: boolean;
  readonly createdAt: number;
  /**
   * Billing plan (Phase 11). NOT the media tier — see core/plans.ts for why the word matters.
   * What it actually permits is decided by `capabilities(plan)` and nowhere else.
   */
  readonly plan: import('./plans.js').Plan;
  readonly planGrantedAt: number | null;
  readonly planGrantedBy: number | null;
}

export type MediaMode = 'pool' | 'static' | 'none';

/**
 * One (chat, mint) watch. A chat may track several mints; each gets its own
 * thresholds, emoji ladder and media.
 *
 * Writes require verified admin (INVARIANT 8).
 */
export interface ChatToken {
  readonly id: number;
  readonly chatId: ChatId;
  readonly mint: Mint;
  /** Buys below this are dropped entirely, before tiering. */
  readonly minBuyUsd: number;
  /** Emoji repeated proportionally to buy size. */
  readonly emoji: string;
  /** Telegram custom emoji id, when the group uses a premium emoji. */
  readonly emojiCustomId: string | null;
  /** USD per emoji step in the ladder. */
  readonly emojiStepUsd: number;
  readonly maxEmojis: number;
  readonly mediaMode: MediaMode;
  /** Used when mediaMode='static'. A file_id THIS bot owns (INVARIANT 3). */
  readonly staticFileId: string | null;
  readonly staticKind: MediaKind | null;
  /**
   * The tier PRIORITY CHAIN (see core/tiers.ts). `whaleHoldingsUsd` is denominated in
   * what the wallet HOLDS; the two floors are what it SPENT. Different quantities, so
   * they are separate fields and not the old 4-element ladder array.
   */
  readonly buyFloorBig: number;
  readonly buyFloorMassive: number;
  readonly whaleHoldingsUsd: number;
  /**
   * Measure holdings BEFORE or AFTER the buy (Phase 8). Per-chat: two groups on one
   * process may legitimately disagree about whether the buy itself can make you a whale.
   */
  readonly whaleBasis: 'pre' | 'post';
  /** Headline template per tier, indexed like TIERS. `{SYM}` substitutes the symbol. */
  readonly tierHeadlines: readonly string[];
  /** Arbitrary chart/socials links rendered as buttons. */
  readonly links: Readonly<Record<string, string>> | null;
  readonly enabled: boolean;
}

/** Cached SPL mint metadata. Supply is refreshed on a TTL (5 min). */
export interface TokenMeta {
  readonly mint: Mint;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly decimals: number;
  /** Total supply in raw units. Market cap = toFloat(supply) * priceUsd. */
  readonly supplyRaw: bigint;
  readonly fetchedAtMs: number;
}

/**
 * Weighted-average cost basis for one (mint, wallet), maintained locally.
 *
 * A buy increases `tokensRaw` and `costUsd`. A sell decreases `tokensRaw` and
 * retires cost at the current average, so the average is unchanged by sells.
 */
export interface Position {
  readonly mint: Mint;
  readonly buyer: Wallet;
  /**
   * Net tokens the LEDGER believes are held — built only from swaps this bot
   * observed. Compare with `onchainRaw` before trusting anything derived from it.
   */
  readonly tokensRaw: bigint;
  /** Total USD paid for the tokens the ledger believes are still held. */
  readonly costUsd: number;
  /**
   * Booked profit/loss from sells, at the weighted-average basis.
   *
   * **NULL means UNKNOWABLE** (Phase 4.8), not zero and not "not computed yet". The
   * wallet disposed of the mint into an asset we cannot value (an unpriced SELL — a
   * `transfer_out` against a non-registry token), so this total is missing a piece it
   * can never learn.
   *
   * Nullable so that the COMPILER makes you handle it. A `NOT NULL DEFAULT 0` column
   * here is the type system asserting a fact we do not have, and the first PnL line
   * anyone adds to a whale card would read it, believe it, and publish it.
   *
   * An unpriced BUY does NOT null this: it corrupts the cost basis (see
   * `basisUnpriced`) but nothing was sold, so nothing was realized. Two different
   * blindnesses — do not conflate them.
   */
  readonly realizedPnlUsd: number | null;
  /** True when the basis was seeded from Helius history rather than observed live. */
  readonly backfilled: boolean;

  // --- reconciliation (Phase 4) ---
  /** Last `balanceAfterRaw` seen from the chain. Exact. */
  readonly onchainRaw: bigint;
  /** `onchainRaw - tokensRaw`, signed. Nonzero => we are missing history. */
  readonly driftRaw: bigint;
  /**
   * The ledger agrees with the chain. ONLY when this is true may a Position %
   * be rendered — see render/position.ts.
   */
  readonly reconciled: boolean;
  /** When the one-shot backfill last ran. Null = never. Drives the 24h cache. */
  readonly backfilledAt: number | null;

  /**
   * The swap log for this wallet is KNOWN to be incomplete — the backfill hit the
   * 1000-signature cap, or a priced leg would not resolve.
   *
   * This vetoes `reconciled` INDEPENDENTLY of drift. Drift can read as zero on a
   * truncated history (the missing swaps happened to net out) while the cost basis
   * is still missing legs, and a Position % computed from a half-basis is exactly
   * the confident public lie INVARIANT 10 exists to prevent.
   */
  readonly historyTruncated: boolean;

  /**
   * At least one swap in this wallet's log has an UNPRICEABLE leg (Phase 4.7) — it
   * acquired or disposed of the mint against a token we cannot value.
   *
   * Also vetoes `reconciled`, and deliberately kept SEPARATE from `historyTruncated`.
   * They are two different kinds of blindness and you want to know which one you have:
   * truncated means *we do not have all the legs*; unpriced means *we have all the
   * legs and cannot value one of them*. Collapsing them into one boolean throws away
   * the only information that tells you whether a backfill would even help.
   *
   * DERIVED by the fold — true iff any swap row has `unpriced = 1`. Never remembered.
   */
  readonly basisUnpriced: boolean;

  readonly firstSeen: number | null;
  readonly updatedAt: number | null;
}

/** A buy as persisted. Raw chain amounts are bigint here, TEXT in SQLite. */
export interface BuyRecord {
  readonly signature: Signature;
  readonly mint: Mint;
  readonly buyer: Wallet;
  /** The dominant quote leg, in its own raw units. */
  readonly quoteMint: Mint;
  readonly quoteSymbol: string;
  readonly quoteRaw: bigint;
  readonly tokensRaw: bigint;
  readonly usdIn: number;
  readonly priceUsd: number;
  readonly slot: number;
  readonly blockTime: number | null;
}

/** A sell as persisted. Mirror of BuyRecord; `usdOut` is what they RECEIVED. */
export interface SellRecord {
  readonly signature: Signature;
  readonly mint: Mint;
  readonly seller: Wallet;
  readonly quoteMint: Mint;
  readonly quoteSymbol: string;
  readonly quoteRaw: bigint;
  readonly tokensRaw: bigint;
  readonly usdOut: number;
  readonly slot: number;
  readonly blockTime: number | null;
}

// --- The swap log (Phase 4.5) ------------------------------------------------

/**
 * Direction is carried by `kind`, never by the sign of `tokensRaw` — which is
 * always positive. A TEXT bigint has no reliable sign, and the fold switches on
 * kind anyway.
 *
 * Transfers are here and buys/sells are not enough: an airdrop recipient's ledger
 * under-counts and a wallet that sent tokens out over-counts, and neither is
 * visible to the normalizer (which returns null on transfers, by design). They
 * enter the log only via backfill — which is exactly why an unreconciled wallet
 * must trigger one.
 */
export type SwapKind = 'buy' | 'sell' | 'transfer_in' | 'transfer_out';

/** Where we learned of this swap. Never affects the fold — audit only. */
export type SwapSource = 'live' | 'backfill';

/**
 * One immutable FACT in the durable swap log.
 *
 * `positions` is a pure fold over these. Nothing else may move a position.
 */
export interface SwapRecord {
  readonly signature: Signature;
  readonly mint: Mint;
  readonly wallet: Wallet;
  readonly kind: SwapKind;
  /** Always POSITIVE. `kind` carries the direction. */
  readonly tokensRaw: bigint;

  /** Null for transfers — a transfer has no quote leg. */
  readonly quoteMint: Mint | null;
  readonly quoteSymbol: string | null;
  readonly quoteRaw: bigint | null;

  /** 0 for transfers. TRUE zero when `unpriced` is false; otherwise a value we can't know. */
  readonly usdValue: number;

  /**
   * `usdValue` is not merely zero — it is UNKNOWABLE (Phase 4.7). The wallet paid, or
   * was paid, in a token we cannot value. Any position containing one of these rows
   * has an unpriceable basis and shows no Position %.
   */
  readonly unpriced: boolean;

  /**
   * The wallet's absolute on-chain holding straight after this swap, when the
   * transaction revealed it. Null when unknown.
   *
   * This is what makes `positions` a TOTAL fold: `onchainRaw` is the newest of
   * these by slot, so the whole ledger — reconciliation included — rebuilds from
   * the log alone.
   */
  readonly balanceAfterRaw: bigint | null;

  readonly slot: number;
  readonly blockTime: number | null;
  readonly source: SwapSource;
}

/** State machine of the send idempotency ledger. See INVARIANT 2 and INVARIANT 9. */
export type SendState = 'claimed' | 'sent' | 'failed';

/** Media kind, as Telegram distinguishes them. Drives which send method we call. */
export type MediaKind = 'photo' | 'video' | 'animation';

/**
 * One meme in the pool.
 *
 * INVARIANT 3: `sha256` of the file CONTENT is the cache key for the Telegram
 * file_id. file_ids are bot-specific and non-portable, so RiceBuybot uploads the
 * bytes itself, once, and caches what Telegram hands back against this hash.
 *
 * INVARIANT 4: `path` is READ-ONLY to this process.
 */
export interface MediaItem {
  /** Lowercase hex sha256 of the file bytes. Stable across renames and re-syncs. */
  readonly sha256: string;
  readonly mint: Mint;
  readonly tier: TierFolder;
  /** Path relative to MEDIA_ROOT. Never written to. */
  readonly relPath: string;
  readonly kind: MediaKind;
  readonly bytes: number;
  readonly firstSeen: number;
  /**
   * The file vanished from the pool and NOBODY MEANT IT TO — a tidied folder, a
   * botched rsync, a full disk.
   *
   * It STAYS IN ROTATION. The cached file_id still works (Telegram serves an
   * uploaded file long after we lose the bytes), so the art survives the accident.
   * Quietly losing memes because someone reorganised a directory is a bad failure
   * mode, and it is one we can simply decline to have.
   */
  readonly missing: boolean;
  /**
   * An admin deleted this on purpose, in a DM (Phase 8.5). Ms since epoch; null
   * means "not removed".
   *
   * STOP SENDING IT, IMMEDIATELY. Dropped from every rotation bag on the next refill.
   *
   * This is NOT `missing`, and collapsing the two loses the only thing that matters:
   * both are "gone from the manifest", but one is an accident to be survived and the
   * other is an instruction to be obeyed. The file_id still works — which is exactly
   * why the intent has to be recorded, or "we still CAN send it" silently becomes
   * "we still DO send it", and the 🗑 button is a lie.
   */
  readonly removedAt: number | null;
}

/** A fully-resolved post, ready for the renderer. No I/O left to do. */
export interface BuyPost {
  readonly event: BuyEvent;
  readonly chatId: ChatId;
  readonly tier: TierName;
  readonly headline: string;
  readonly emoji: string;
  readonly token: TokenMeta;
  readonly marketCapUsd: number | null;
  /** Buy size as a % of the wallet's post-trade position. Null when unknown. */
  readonly positionPct: number | null;
  /** True when this wallet had no prior position in this mint. */
  readonly isNewHolder: boolean;
  readonly media: MediaItem | null;
}
