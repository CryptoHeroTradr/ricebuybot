import type { ChatId, MediaItem, MediaKind, Mint } from '../core/types.js';
import type { TierFolder, TierName } from '../core/tiers.js';

export { FsMediaPool } from './media-pool.js';
export { LocalFsSource } from './source-local.js';
export { HttpManifestSource } from './source-http.js';
export { shuffle, refillBag } from './rotation.js';
export { resolveTierWithFallback } from './select.js';
export type { PoolSnapshot, PoolEntry } from './source-local.js';

/**
 * Where the pool's bytes and manifest come from.
 *
 * Two adapters, one interpretation — the same shape as `BaseIngestor`. The pool
 * itself, the diffing, the file_id cache, the rotation and the tier fallback are all
 * identical either way; only the transport differs, and it stops at this door.
 *
 * LOCAL IS THE DEFAULT AND THE ONE TO USE. The bot runs on the same VPS as the pool,
 * so it can hand Telegram the actual bytes — a 50MB upload ceiling. Handing Telegram
 * a URL instead caps you at 20MB, which throws away more than half the range for
 * nothing. HTTP exists for the day the bot lives somewhere else.
 */
export interface MediaSource {
  /** The current pool contents. Throws if the manifest cannot be read or is malformed. */
  snapshot(mint: Mint): Promise<import('./source-local.js').PoolSnapshot>;

  /**
   * The bytes, for a first-ever upload. Only ever called on a file_id cache MISS.
   * `null` means the bytes are gone — the item is `missing` and cannot be minted.
   */
  bytes(item: MediaItem): Promise<Buffer | null>;

  /**
   * How many files are SITTING IN A TIER FOLDER AND NOT IN THE MANIFEST.
   *
   * These are the memes the generator refused to publish because their filename is not
   * their content hash (see scripts/build-manifest.ts) — a file someone `cp`-ed in by
   * hand instead of using `tier`. They are on disk, they are invisible, and the ONLY
   * record of that today is a warning line in a systemd timer's journal that nobody
   * reads. Meanwhile the curator swears the bot "didn't add it".
   *
   * Surfacing it in /mediastats is the point: that is where the operator actually looks.
   *
   * `null` = cannot know (the HTTP source cannot list a remote directory).
   */
  unpublished(mint: Mint): Promise<number | null>;

  /**
   * The sha256s sitting in `_archive/`.
   *
   * THIS IS HOW A CLI ARCHIVE BECOMES A DELIBERATE REMOVAL.
   *
   * A file that leaves the manifest is, from the manifest's point of view, just gone — and the
   * refresh cannot tell an ACCIDENT (a tidied folder; keep sending it, the file_id still works)
   * from an INSTRUCTION (`rice-tier archive`; stop sending it, now). Those two want opposite
   * behaviour, and only the archive folder knows which happened.
   *
   * So: present in _archive == somebody meant it. It gets `removed_at`, exactly like the DM 🗑
   * button, and drops out of every rotation bag immediately.
   *
   * An empty set means "cannot know" (the HTTP source cannot list a remote directory), and the
   * caller must then leave `removed_at` alone rather than guess.
   */
  archived(mint: Mint): Promise<ReadonlySet<string>>;
}

/**
 * The seam to Telegram, so that `media/` never imports grammY.
 *
 * Phase 7 implements this over the Bot API. Phase 6 depends only on the shape,
 * which is what lets the whole pool — rotation, fallback, cache, diffing — be tested
 * with no network and no bot token.
 */
export interface MediaUploader {
  /**
   * Upload bytes to the VAULT and return the file_id Telegram mints for them.
   *
   * The vault (MEDIA_VAULT_CHAT_ID) is a private channel only the bot posts to. A
   * first-ever send therefore never uploads into a public group: no spinner, no
   * half-rendered card, no ten-second wait while a 40MB video streams in front of an
   * audience. The group gets a file_id, which is instant.
   */
  uploadToVault(kind: MediaKind, bytes: Buffer, filename: string): Promise<string>;
}

/**
 * The result of picking art for a buy.
 *
 * `earnedTier` and `usedTier` are SEPARATE and both are returned, because they
 * disagree exactly when it matters most. A whale buy into a pool whose `whale/`
 * folder is empty borrows a `big/` meme — and the card must STILL say
 * "🐳 WHALE BUY!". Phase 7 renders the headline from `earnedTier` and nothing else.
 *
 * Collapsing these two would mean a whale silently gets announced as a big buy
 * because a folder was empty. The art is a decoration; the tier is the fact.
 */
export interface PoolHealth {
  readonly perTier: Readonly<Record<TierFolder, number>>;
  readonly total: number;
  /** Items whose bytes Telegram has already seen — a send costs no upload. */
  readonly uploaded: number;
  /** Tiers with NO art. An empty tier silently borrows from a neighbour (see select.ts). */
  readonly emptyTiers: readonly TierFolder[];
  /** On disk, refused by the generator, invisible to the bot. `null` = cannot know (HTTP). */
  readonly unpublished: number | null;
}

export interface Pick {
  readonly earnedTier: TierName;
  /** The folder the art actually came from. Differs from earned when a tier is empty. */
  readonly usedTier: TierFolder | null;
  /** Null when the pool has no art at all — Phase 7 falls back to static, then to text. */
  readonly item: MediaItem | null;
}

/**
 * The media pool: `<MEDIA_ROOT>/<mint>/{regular,big,whale,massive}/`.
 *
 * INVARIANT 4: RiceBuybot owns the tree and is its sole writer — but NOT HERE. This is
 * the READ side. Curation writes go through `scripts/tier.ts` and, in Phase 8.5, the DM
 * flow. `MediaPool` has no write method and must never grow one.
 *
 * INVARIANT 3: Telegram file_ids are bot-specific and NON-PORTABLE. RiceBuybot holds
 * the original BYTES, uploads each item itself exactly once, and caches the file_id it
 * gets back, keyed by content sha256.
 */
export interface MediaPool {
  /**
   * Re-read the manifest and reconcile it against `media_items`, for every ACTIVE mint.
   * Safe to call repeatedly; polled every 60s and on SIGHUP.
   */
  refresh(): Promise<void>;

  /**
   * The same reconcile, for ONE named mint, active or not.
   *
   * Curation is deliberately allowed on mints `activeMints()` does not return — a paused
   * group still owns its art (auth.ts), and the owner seeds a pool before any group is
   * configured at all. `refresh()` cannot serve that flow: it iterates active mints, so on
   * exactly those mints it reconciles NOTHING, and the meme the curator just sent never
   * reaches `media_items`.
   *
   * Errors are the CALLER's to handle, unlike `refresh()` which swallows them per-mint to
   * protect the polling loop. A caller naming one mint is waiting on that mint's answer.
   */
  refreshMint(mint: Mint): Promise<void>;

  /**
   * Choose the tier and the art for a buy.
   *
   * Tier comes from the PRIORITY CHAIN (core/tiers.ts) — note that `holdingsUsd`, not
   * `usdIn`, is what makes a whale. Art comes from a shuffle bag per (mint, chat, tier),
   * so nothing repeats until that tier is exhausted, and two groups on the same mint
   * never march in lockstep.
   *
   * NEVER THROWS FOR WANT OF ART. An empty tier walks down the folder order, then up.
   * A pool with nothing in it at all returns `item: null` and the post still goes out.
   */
  pick(mint: Mint, chatId: ChatId, usdIn: number, whaleValueUsd: number): Promise<Pick | null>;

  /**
   * The Telegram file_id for an item, uploading the bytes ONCE on first use and caching
   * the result against `item.sha256`.
   *
   * The common case never uploads: media added through the DM flow arrives WITH a
   * file_id already (Telegram minted one when the admin sent it), so it is cached at
   * curation time and this is a straight DB read. The upload path exists for media
   * seeded from disk by the CLI.
   */
  fileIdFor(item: MediaItem): Promise<string | null>;

  /** How many live items per tier. For /health and ops visibility. */
  stats(mint: Mint): Promise<Readonly<Record<TierFolder, number>>>;

  /** Everything /mediastats needs to tell an operator the truth about their pool. */
  health(mint: Mint): Promise<PoolHealth>;

  /** Begin 60s polling and the background file_id warm-up. Never blocks startup. */
  start(): Promise<void>;
  stop(): void;
}
