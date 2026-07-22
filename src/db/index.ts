import type {
  BuyRecord,
  Chat,
  ChatId,
  ChatToken,
  MediaItem,
  Mint,
  Position,
  SellRecord,
  Signature,
  SwapRecord,
  TokenMeta,
  Wallet,
} from '../core/types.js';
import type { TierFolder } from '../core/tiers.js';
import type { PositionDisagreement, RecomputeOpts } from './sqlite.js';

export type { Migration } from './migrate.js';
export { SqliteRepo, CLAIM_SQL, PRAGMAS } from './sqlite.js';
export type { PositionDisagreement, RecomputeOpts } from './sqlite.js';

/**
 * A media item as the scanner sees it on disk. `missing` is owned by the DB, and
 * `first_seen` is set on first insert and never moved afterwards — a re-synced
 * file is the same item, not a new one.
 */
export type MediaItemInput = Omit<MediaItem, 'missing' | 'removedAt' | 'firstSeen'> & {
  readonly firstSeen?: number;
};

/** Fields a group may change. Everything else is derived or immutable. */
export type ChatTokenPatch = Partial<
  Pick<
    ChatToken,
    | 'minBuyUsd'
    | 'emoji'
    | 'emojiCustomId'
    | 'emojiStepUsd'
    | 'maxEmojis'
    | 'mediaMode'
    | 'staticFileId'
    | 'staticKind'
    | 'buyFloorBig'
    | 'buyFloorMassive'
    | 'whaleHoldingsUsd'
    | 'whaleBasis'
    | 'tierHeadlines'
    | 'links'
    | 'enabled'
  >
>;

/**
 * Persistence seam. Phase 1 ships the SQLite implementation; the interface exists
 * so Postgres can be swapped in later without touching a caller.
 *
 * Async throughout even though better-sqlite3 is synchronous — that is what keeps
 * the Postgres seam real. Atomicity never depends on the async boundary; it is
 * enforced inside single SQL statements and transactions.
 */
export interface Repo {
  init(): Promise<void>;
  close(): Promise<void>;

  // --- Chats ---
  /**
   * NOTE the plan fields are NOT accepted here. A plan is granted (/grant) and never set as a
   * side effect of a chat being created or renamed — otherwise every `my_chat_member` update
   * would be a chance to silently reset somebody's billing.
   */
  upsertChat(
    chat: Omit<Chat, 'createdAt' | 'plan' | 'planGrantedAt' | 'planGrantedBy'> & { createdAt?: number },
  ): Promise<void>;
  getChat(chatId: ChatId): Promise<Chat | null>;
  /** Every chat the bot knows about. /use lists the ones the caller admins. */
  listChats(): Promise<readonly Chat[]>;
  setPaused(chatId: ChatId, paused: boolean): Promise<void>;

  /** Owner-only (/grant). Records who granted it and when — a plan change is a commercial act. */
  setPlan(chatId: ChatId, plan: import('../core/plans.js').Plan, grantedBy: number | null): Promise<void>;
  deleteChat(chatId: ChatId): Promise<void>;

  // --- Chat tokens (INVARIANT 8: writes require verified admin, re-checked at write time) ---
  addChatToken(chatId: ChatId, mint: Mint, patch?: ChatTokenPatch): Promise<ChatToken>;
  getChatToken(chatId: ChatId, mint: Mint): Promise<ChatToken | null>;
  listChatTokens(chatId: ChatId): Promise<readonly ChatToken[]>;
  updateChatToken(chatId: ChatId, mint: Mint, patch: ChatTokenPatch): Promise<ChatToken | null>;
  removeChatToken(chatId: ChatId, mint: Mint): Promise<void>;

  /**
   * DISTINCT mints across enabled chat_tokens on non-paused chats.
   * The single source of truth for what the ingestor subscribes to.
   */
  activeMints(): Promise<readonly Mint[]>;

  /** Every enabled watch for a mint, on non-paused chats. The fan-out list for a buy. */
  chatTokensForMint(mint: Mint): Promise<readonly ChatToken[]>;

  // --- Tokens ---
  getToken(mint: Mint): Promise<TokenMeta | null>;
  putToken(meta: TokenMeta): Promise<void>;

  // --- Media (INVARIANT 3: file_id cached against the CONTENT hash, per THIS bot) ---
  upsertMediaItem(item: MediaItemInput): Promise<void>;

  /** Live media for a tier: everything NOT removed. `missing` items ARE included. */
  listMedia(mint: Mint, tier: TierFolder): Promise<readonly MediaItem[]>;

  /** Every item this bot has ever seen for a mint, removed ones included. The diff base. */
  listAllMedia(mint: Mint): Promise<readonly MediaItem[]>;

  /**
   * The file vanished unexpectedly. Keep the row, keep the file_id, keep sending it.
   * See MediaItem.missing — this is an ACCIDENT, not an instruction.
   */
  markMediaMissing(shas: readonly string[], missing: boolean): Promise<void>;

  /**
   * An admin deleted it on purpose (Phase 8.5). Stop sending it, now.
   * `removedAt = null` un-removes — a mis-click is recoverable, like everything else
   * about a removal (the bytes go to _archive, never to /dev/null).
   */
  markMediaRemoved(shas: readonly string[], removedAt: number | null): Promise<void>;

  getFileId(sha256: string): Promise<string | null>;
  putFileId(sha256: string, fileId: string): Promise<void>;

  /** Telegram rejected the cached id ("wrong file identifier"). Forget it and re-upload. */
  deleteFileId(sha256: string): Promise<void>;

  /** Items with no cached file_id yet. The boot warm-up queue. Removed items excluded. */
  listMediaWithoutFileId(mint: Mint): Promise<readonly MediaItem[]>;

  // --- Rotation: shuffle bag per (mint, chat, tier) ---
  getBag(mint: Mint, chatId: ChatId, tier: TierFolder): Promise<readonly string[] | null>;
  putBag(mint: Mint, chatId: ChatId, tier: TierFolder, bag: readonly string[]): Promise<void>;

  // --- Curators (Phase 8.5). EXPLICIT grants only — never a cache of admin status. ---
  addCurator(userId: number, mint: Mint, grantedBy: number | null): Promise<void>;
  removeCurator(userId: number, mint: Mint): Promise<void>;
  /** Mints this user has been explicitly granted. Does NOT include mints they admin. */
  grantedMints(userId: number): Promise<readonly Mint[]>;

  /** Every chat configured for this mint, paused or not — the set to check admin against. */
  chatsForMint(mint: Mint): Promise<readonly ChatId[]>;

  // --- Buys & positions ---
  recordBuy(buy: BuyRecord): Promise<void>;
  hasBuy(signature: Signature, mint: Mint, buyer: Wallet): Promise<boolean>;
  getPosition(mint: Mint, buyer: Wallet): Promise<Position | null>;

  // --- The swap log: positions are a FOLD over it, never a mutated row ---------
  //
  // Phase 4.5. `positions` used to be read-modify-written by two racing callers —
  // live ingest and the backfiller — and the backfiller's walk took seconds, so a
  // live buy landing mid-walk was OVERWRITTEN and its tokens and cost vanished.
  //
  // Nothing here writes position state. It writes FACTS, and the position is a pure
  // fold over the facts. Concurrent writers cannot clobber one another because
  // neither of them holds any state to clobber.

  /**
   * THE ONE DOOR. Append a swap (INSERT OR IGNORE — the PK makes replay idempotent),
   * then recompute the position from the entire log.
   *
   * Live ingest, hold-queue flush, and backfill all come through here or through
   * `applySwaps`. There is no other way to move a position.
   */
  applySwap(swap: SwapRecord, opts?: RecomputeOpts): Promise<Position>;

  /** The same door, batched: insert a whole history walk, then recompute ONCE. */
  applySwaps(
    swaps: readonly SwapRecord[],
    opts: RecomputeOpts & { mint: Mint; wallet: Wallet },
  ): Promise<{ position: Position; inserted: number }>;

  /** Recompute from the log without adding to it. */
  recomputePosition(mint: Mint, wallet: Wallet, decimals?: number): Promise<Position>;

  listSwaps(mint: Mint, wallet: Wallet): Promise<readonly SwapRecord[]>;

  /**
   * Rebuild EVERY position from the log. The proof that `positions` is a
   * materialized view: drop it, run this, get every derived value back identical.
   * Returns the rows whose stored value disagreed with the fold.
   */
  rebuildPositions(): Promise<readonly PositionDisagreement[]>;

  /**
   * Adapter onto `applySwap` for the shape the ingest/pricing pipeline produces.
   * `chain.balanceAfterRaw` arrives free with every buy — that is what makes every
   * buy a reconciliation checkpoint, and it is now persisted in the log.
   */
  applyBuy(buy: BuyRecord, chain?: { balanceAfterRaw: bigint }, decimals?: number): Promise<Position>;

  /** Adapter onto `applySwap`. `usdOut` is what the seller RECEIVED. */
  applySell(sell: SellRecord, decimals: number, chain?: { balanceAfterRaw: bigint }): Promise<Position>;

  /** Wallets whose ledger disagrees with the chain and are due a backfill. */
  listUnreconciled(staleBeforeMs: number, limit?: number): Promise<readonly Position[]>;
  /** Record that a backfill ran — whether or not it achieved reconciliation. */
  markBackfilled(mint: Mint, buyer: Wallet, at: number): Promise<void>;

  // --- Sends: THE IDEMPOTENCY CHOKEPOINT (INVARIANT 2) ---

  /**
   * Atomically claim (signature, chatId). Returns true IFF this process now OWNS
   * the send and must perform it.
   *
   * False means someone already holds it — do nothing. Do not queue it, do not
   * retry it, do not log an error. False is the normal, expected outcome of a
   * reconnect replay.
   */
  claimSend(signature: Signature, chatId: ChatId): Promise<boolean>;

  markSent(signature: Signature, chatId: ChatId, messageId: number): Promise<void>;

  /**
   * RETRYABLE failure only (429 exhausted, network). Deletes the row so a future
   * replay can re-claim it.
   */
  releaseSend(signature: Signature, chatId: ChatId, reason: string): Promise<void>;

  /**
   * PERMANENT failure (403, kicked, chat not found). Writes a TOMBSTONE. Never
   * retried — its presence is what stops a replay hammering a dead chat.
   */
  failSend(signature: Signature, chatId: ChatId, reason: string): Promise<void>;

  /**
   * INVARIANT 9. Sweep every row still in 'claimed' to 'failed'. Called once at
   * boot. Returns the number swept — intentional, documented data loss.
   */
  sweepOrphanedClaims(reason?: string): Promise<number>;

  /** Cards actually delivered since UTC midnight. /health, and the optional daily cap. */
  deliveredToday(): Promise<number>;

  // --- Cursors ---
  getCursor(mint: Mint): Promise<number | null>;
  setCursor(mint: Mint, slot: number): Promise<void>;
}

/**
 * Phase 12. The autotrader allowlist (INVARIANT 14), kept as its own interface so `src/trade/`
 * depends on the four methods it needs rather than on all of `Repo`.
 */
export type { AutotraderAccessRepo, AutotraderMember, AccessAction } from '../trade/access.js';
