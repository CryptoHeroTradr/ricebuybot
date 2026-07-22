import type { Logger } from 'pino';

import type { ChatId, MediaItem, Mint } from '../core/types.js';
import { TIER_BY_FOLDER, TIER_FOLDERS, pickTier, type TierFolder, type TierPolicy } from '../core/tiers.js';
import type { Repo } from '../db/index.js';
import type { MediaPool, MediaSource, MediaUploader, Pick, PoolHealth } from './index.js';
import { popFromBag } from './rotation.js';
import { resolveTierWithFallback } from './select.js';

export interface FsMediaPoolOpts {
  readonly repo: Repo;
  readonly source: MediaSource;
  /** Absent in DRY_RUN: nothing can be uploaded, and nothing needs to be. */
  readonly uploader?: MediaUploader;
  readonly log: Logger;
  /** Mints to poll. In practice `repo.activeMints()`, refreshed by the caller. */
  readonly mints: () => Promise<readonly Mint[]>;
  readonly pollMs?: number;
  /** Gap between warm-up uploads. Telegram will not thank you for a burst. */
  readonly warmUpGapMs?: number;
}

const POLL_MS = 60_000;
const WARM_UP_GAP_MS = 2_000;

/** Telegram's way of saying "that file_id is not one of mine any more". */
function isBadFileId(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return (
    msg.includes('wrong file identifier') ||
    msg.includes('wrong remote file id') ||
    msg.includes('file_id') ||
    msg.includes('wrong url')
  );
}

export class FsMediaPool implements MediaPool {
  readonly #repo: Repo;
  readonly #source: MediaSource;
  readonly #uploader: MediaUploader | undefined;
  readonly #log: Logger;
  readonly #mints: () => Promise<readonly Mint[]>;
  readonly #pollMs: number;
  readonly #warmUpGapMs: number;

  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  /** Warm-up runs in the background and must never be started twice. */
  #warming = false;

  constructor(opts: FsMediaPoolOpts) {
    this.#repo = opts.repo;
    this.#source = opts.source;
    this.#uploader = opts.uploader;
    this.#log = opts.log.child({ mod: 'media' });
    this.#mints = opts.mints;
    this.#pollMs = opts.pollMs ?? POLL_MS;
    this.#warmUpGapMs = opts.warmUpGapMs ?? WARM_UP_GAP_MS;
  }

  // -------------------------------------------------------------------------
  // refresh
  // -------------------------------------------------------------------------

  /**
   * Reconcile the manifest against `media_items`, for every active mint.
   *
   * A manifest that will not parse is an ERROR and this returns having changed nothing.
   * That is the important case: a truncated or malformed manifest looks exactly like an
   * empty pool, and an empty pool would mark every item missing and blank every rotation
   * bag. One bad write must not be able to take the bot's art away. We keep the last
   * good state and post from it.
   */
  async refresh(): Promise<void> {
    for (const mint of await this.#mints()) {
      try {
        await this.#refreshMint(mint);
      } catch (err) {
        // Keep the previous state. Loudly, because a pool that has stopped updating is
        // a pool that will quietly serve last week's memes forever.
        this.#log.error({ mint, err: (err as Error).message }, 'media refresh failed — keeping last known pool');
      }
    }
  }

  /** One mint, active or not. See the interface: curation runs on mints `refresh()` skips. */
  async refreshMint(mint: Mint): Promise<void> {
    await this.#refreshMint(mint);
  }

  async #refreshMint(mint: Mint): Promise<void> {
    const snapshot = await this.#source.snapshot(mint);
    const known = await this.#repo.listAllMedia(mint);

    const inManifest = new Set(snapshot.entries.map((e) => e.sha256));
    const knownBySha = new Map(known.map((k) => [k.sha256, k]));

    let added = 0;
    for (const entry of snapshot.entries) {
      const prior = knownBySha.get(entry.sha256);
      // first_seen is set once and never moved: a re-tiered or renamed file is the SAME
      // item at a new path, not a new one. Identity is the content (invariant 3).
      await this.#repo.upsertMediaItem({
        sha256: entry.sha256,
        mint,
        tier: entry.tier,
        relPath: entry.relPath,
        kind: entry.kind,
        bytes: entry.bytes,
        firstSeen: prior?.firstSeen ?? entry.addedAt,
      });
      if (!prior) added++;
    }

    // Vanished: in the DB, not in the manifest.
    //
    // KEEP THE ROW AND KEEP THE FILE_ID. Telegram serves an uploaded file long after we
    // lose the local bytes, so a meme that fell out of the folder still posts perfectly.
    // Deleting the row here would throw away working art because somebody tidied a
    // directory — and it would throw away the file_id, which we could never mint again
    // without the bytes we just lost.
    //
    // An item an admin REMOVED is also absent from the manifest, and is left alone: its
    // removed_at already stops it being posted, and it is not "missing" — nothing went
    // wrong.
    // WHICH KIND OF DISAPPEARANCE IS THIS?
    //
    // Gone from the manifest AND sitting in _archive => somebody archived it on purpose
    // (`rice-tier archive`). That is an INSTRUCTION: removed_at, out of every bag, now — exactly
    // what the DM 🗑 button does. Without this, a CLI archive only ever read as `missing`, and a
    // missing item STAYS in rotation (its file_id still works), so the meme kept being posted
    // after an operator had explicitly taken it out of the pool.
    const archived = await this.#source.archived(mint);
    const deliberatelyRemoved = known.filter(
      (k) => !inManifest.has(k.sha256) && k.removedAt === null && archived.has(k.sha256),
    );
    if (deliberatelyRemoved.length > 0) {
      await this.#repo.markMediaRemoved(
        deliberatelyRemoved.map((k) => k.sha256),
        Date.now(),
      );
      this.#log.info(
        { mint, count: deliberatelyRemoved.length },
        'media archived on disk — removed from every rotation bag',
      );
    }

    // Gone from the manifest and NOT in _archive => an accident. Keep it: the cached file_id
    // still sends, and losing art because someone tidied a directory is a bad failure mode.
    const vanished = known.filter(
      (k) => !inManifest.has(k.sha256) && k.removedAt === null && !k.missing && !archived.has(k.sha256),
    );
    const returned = known.filter((k) => inManifest.has(k.sha256) && k.missing);

    if (vanished.length > 0) {
      await this.#repo.markMediaMissing(
        vanished.map((v) => v.sha256),
        true,
      );
      this.#log.warn(
        { mint, count: vanished.length },
        'media vanished from the pool — kept, and still sendable from the cached file_id',
      );
    }
    if (returned.length > 0) {
      await this.#repo.markMediaMissing(
        returned.map((v) => v.sha256),
        false,
      );
    }
    if (added > 0) this.#log.info({ mint, added }, 'new media in the pool');
  }

  // -------------------------------------------------------------------------
  // pick
  // -------------------------------------------------------------------------

  async #policyFor(mint: Mint, chatId: ChatId): Promise<TierPolicy | null> {
    const ct = await this.#repo.getChatToken(chatId, mint);
    if (!ct) return null;
    return {
      minBuyUsd: ct.minBuyUsd,
      bigUsd: ct.buyFloorBig,
      massiveUsd: ct.buyFloorMassive,
      whaleHoldingsUsd: ct.whaleHoldingsUsd,
    };
  }

  async pick(mint: Mint, chatId: ChatId, usdIn: number, whaleValueUsd: number): Promise<Pick | null> {
    const policy = await this.#policyFor(mint, chatId);
    if (!policy) return null;

    // THE PRIORITY CHAIN, not a ladder. holdingsUsd is what makes a whale.
    const earned = pickTier(usdIn, whaleValueUsd, policy);
    if (!earned) return null; // below min_buy_usd — should have been filtered at fan-out

    const live = await this.#liveByTier(mint);
    const counts = Object.fromEntries(
      TIER_FOLDERS.map((t) => [t, (live.get(t) ?? []).length]),
    ) as Record<TierFolder, number>;

    const usedTier = resolveTierWithFallback(earned.folder, counts);

    // No art anywhere. The post STILL GOES OUT — Phase 7 falls through to the chat's
    // static_file_id and then to a text-only card. The earned tier is reported either
    // way, because the headline is a fact about the buy, not about the folder.
    if (usedTier === null) return { earnedTier: earned.name, usedTier: null, item: null };

    const item = await this.#popFor(mint, chatId, usedTier, live.get(usedTier) ?? []);
    return { earnedTier: earned.name, usedTier, item };
  }

  /** Live (= not removed; missing INCLUDED) items, grouped by tier. */
  async #liveByTier(mint: Mint): Promise<Map<TierFolder, readonly MediaItem[]>> {
    const out = new Map<TierFolder, readonly MediaItem[]>();
    for (const tier of TIER_FOLDERS) out.set(tier, await this.#repo.listMedia(mint, tier));
    return out;
  }

  /** Pop one sha from the (mint, chat, tier) bag, refilling and persisting the remainder. */
  async #popFor(
    mint: Mint,
    chatId: ChatId,
    tier: TierFolder,
    live: readonly MediaItem[],
  ): Promise<MediaItem | null> {
    if (live.length === 0) return null;

    const bag = (await this.#repo.getBag(mint, chatId, tier)) ?? [];
    const { sha256, rest } = popFromBag(
      bag,
      live.map((i) => i.sha256),
    );
    if (sha256 === null) return null;

    await this.#repo.putBag(mint, chatId, tier, rest);
    return live.find((i) => i.sha256 === sha256) ?? null;
  }

  // -------------------------------------------------------------------------
  // file_id cache
  // -------------------------------------------------------------------------

  /**
   * The file_id for an item — the hot path, and it almost never uploads.
   *
   * Media curated through a DM (Phase 8.5) ALREADY has a file_id: Telegram minted one
   * when the admin sent the meme, and curation stores it against the sha256 there and
   * then. So the common case is a single indexed SELECT. The upload path below exists
   * for media seeded from disk by `tier.ts`, which Telegram has never seen.
   */
  async fileIdFor(item: MediaItem): Promise<string | null> {
    const cached = await this.#repo.getFileId(item.sha256);
    if (cached) return cached;
    return this.#mint(item);
  }

  /**
   * Upload the bytes ONCE, to the vault, and cache what Telegram hands back.
   *
   * The vault is a private channel only the bot posts to. Uploading THERE rather than
   * into the destination group means a first-ever send is never slow and never
   * half-rendered in front of an audience: the group is handed a file_id, which is
   * instant, and nobody watches a 40MB video crawl in.
   */
  async #mint(item: MediaItem): Promise<string | null> {
    if (!this.#uploader) return null; // DRY_RUN: nothing to send to, nothing to mint.

    const bytes = await this.#source.bytes(item);
    if (bytes === null) {
      // The bytes are gone AND we have no file_id: this item is unusable. Flag it so it
      // leaves rotation on the next refill rather than being drawn again and again.
      await this.#repo.markMediaMissing([item.sha256], true);
      this.#log.warn({ sha256: item.sha256 }, 'no bytes and no file_id — item unusable');
      return null;
    }

    const filename = item.relPath.split('/').pop() ?? item.sha256;
    const fileId = await this.#uploader.uploadToVault(item.kind, bytes, filename);
    await this.#repo.putFileId(item.sha256, fileId);
    return fileId;
  }

  /**
   * Telegram rejected a cached file_id. Forget it, re-upload ONCE, and hand back the new
   * one. If that fails too, the item is marked missing and the caller pops a different
   * meme — a buy is never lost to a bad cache entry.
   *
   * Phase 7 calls this from its send path, which is the only place that can see the
   * rejection. Keeping the retry HERE means the cache is the only thing that knows how
   * to repair the cache.
   */
  async retryAfterRejection(item: MediaItem, err: unknown): Promise<string | null> {
    if (!isBadFileId(err)) throw err;

    this.#log.warn({ sha256: item.sha256 }, 'telegram rejected the cached file_id — re-uploading once');
    await this.#repo.deleteFileId(item.sha256);

    try {
      const fresh = await this.#mint(item);
      if (fresh) return fresh;
    } catch (again) {
      this.#log.error({ sha256: item.sha256, err: (again as Error).message }, 're-upload failed');
    }

    await this.#repo.markMediaMissing([item.sha256], true);
    return null;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async stats(mint: Mint): Promise<Readonly<Record<TierFolder, number>>> {
    const live = await this.#liveByTier(mint);
    return Object.fromEntries(TIER_FOLDERS.map((t) => [t, (live.get(t) ?? []).length])) as Record<
      TierFolder,
      number
    >;
  }

  async health(mint: Mint): Promise<PoolHealth> {
    const live = await this.#liveByTier(mint);
    const perTier = Object.fromEntries(
      TIER_FOLDERS.map((t) => [t, (live.get(t) ?? []).length]),
    ) as Record<TierFolder, number>;

    const all = [...live.values()].flat();
    let uploaded = 0;
    for (const item of all) {
      if (await this.#repo.getFileId(item.sha256)) uploaded++;
    }

    return {
      perTier,
      total: all.length,
      uploaded,
      emptyTiers: TIER_FOLDERS.filter((t) => perTier[t] === 0),
      unpublished: await this.#source.unpublished(mint).catch(() => null),
    };
  }

  /**
   * Poll every 60s. The FIRST refresh is awaited so the bot starts with a populated
   * pool; everything after that is a timer, and the warm-up is fire-and-forget.
   */
  async start(): Promise<void> {
    await this.refresh();

    this.#timer = setInterval(() => {
      void this.refresh();
    }, this.#pollMs);
    this.#timer.unref(); // a poll timer must never hold the process open

    void this.#warmUp();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** SIGHUP: an operator wants the pool re-read NOW, without waiting out the poll. */
  async onSighup(): Promise<void> {
    this.#log.info('SIGHUP — refreshing the media pool');
    await this.refresh();
  }

  /**
   * Upload anything that has no file_id yet, ONE EVERY 2 SECONDS, in the background.
   *
   * NEVER BLOCKS STARTUP. A pool seeded with fifty memes from the CLI would otherwise
   * hold the bot down for a minute and a half before it could post its first buy — and
   * the first buy is the one people are waiting for. The buys that land during warm-up
   * mint their file_id on demand instead; the warm-up is an optimisation, not a
   * precondition.
   */
  async #warmUp(): Promise<void> {
    if (this.#warming || !this.#uploader) return;
    this.#warming = true;

    try {
      for (const mint of await this.#mints()) {
        const pending = await this.#repo.listMediaWithoutFileId(mint);
        if (pending.length === 0) continue;

        this.#log.info({ mint, count: pending.length }, 'warming the file_id cache in the background');
        for (const item of pending) {
          if (this.#stopped) return;
          try {
            await this.#mint(item);
          } catch (err) {
            this.#log.warn({ sha256: item.sha256, err: (err as Error).message }, 'warm-up upload failed');
          }
          await new Promise((r) => setTimeout(r, this.#warmUpGapMs));
        }
      }
    } finally {
      this.#warming = false;
    }
  }
}

export { TIER_BY_FOLDER };
