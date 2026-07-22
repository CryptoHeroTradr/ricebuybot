import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TIER_POLICY, pickTier, type TierPolicy, type TierFolder } from '../src/core/tiers.js';
import { SqliteRepo } from '../src/db/sqlite.js';
import { FsMediaPool } from '../src/media/media-pool.js';
import { resolveTierWithFallback } from '../src/media/select.js';
import { popFromBag } from '../src/media/rotation.js';
import { derivePricing } from '../src/pricing/derive.js';
import { QUOTE_ASSETS, USDC_MINT } from '../src/pricing/quote.js';
import { createLogger } from '../src/ops/logger.js';
import type { MediaItem, MediaKind, Mint } from '../src/core/types.js';
import type { MediaSource, MediaUploader } from '../src/media/index.js';
import type { PoolSnapshot } from '../src/media/source-local.js';

const log = createLogger('silent' as 'info', false);
const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const CHAT = -1001 as never;
const CHAT_B = -1002 as never;

const P: TierPolicy = DEFAULT_TIER_POLICY;

// =============================================================================
// THE PRIORITY CHAIN
// =============================================================================

describe('tier selection is a PRIORITY CHAIN, not a ladder', () => {
  /**
   * The six worked examples, verbatim. The one that matters most is the fourth: a $20
   * buy from a wallet holding $50,000 is a WHALE. Under the old ascending ladder it was
   * "Regular" — the most interesting event the bot can post (a big bag quietly
   * accumulating) got a regular meme and no fanfare.
   */
  it.each([
    { usd: 23, held: 40, want: 'Regular', why: 'small buy, small bag' },
    { usd: 94, held: 200, want: 'Regular', why: 'under the $250 big floor' },
    { usd: 340, held: 600, want: 'Big', why: 'a chunky buy from a small holder is NOT a whale' },
    { usd: 20, held: 50_000, want: 'Whale', why: 'a big bag is still accumulating — holdings, not buy size' },
    { usd: 2_400, held: 2_400, want: 'Massive', why: 'over the massive floor' },
    { usd: 12_000, held: 12_000, want: 'Massive', why: 'qualifies as both; massive outranks whale' },
  ])('$$$usd buy, $$$held held -> $want ($why)', ({ usd, held, want }) => {
    expect(pickTier(usd, held, P)?.name).toBe(want);
  });

  it('is EXACT at every boundary — a cent decides the tier', () => {
    // big floor
    expect(pickTier(249.99, 0, P)?.name).toBe('Regular');
    expect(pickTier(250.0, 0, P)?.name).toBe('Big');
    // massive floor
    expect(pickTier(999.99, 0, P)?.name).toBe('Big');
    expect(pickTier(1_000.0, 0, P)?.name).toBe('Massive');
    // whale HOLDINGS floor — inclusive, like the others
    expect(pickTier(20, 9_999.99, P)?.name).toBe('Regular');
    expect(pickTier(20, 10_000.0, P)?.name).toBe('Whale');
  });

  it('massive outranks whale even for a wallet far over the holdings floor', () => {
    expect(pickTier(1_000, 5_000_000, P)?.name).toBe('Massive');
  });

  it('whale outranks big: a $300 buy from a $10k bag is a WHALE, not a Big', () => {
    // Order matters. If `big` were tested first this would read Big, and the tier
    // named for holding a bag would never fire for anyone who also bought a decent size.
    expect(pickTier(300, 10_000, P)?.name).toBe('Whale');
  });

  it('honours a per-chat policy, not just the defaults', () => {
    const strict: TierPolicy = { minBuyUsd: 50, bigUsd: 500, massiveUsd: 5_000, whaleHoldingsUsd: 100_000 };
    expect(pickTier(49, 0, strict)).toBeNull();
    expect(pickTier(499, 0, strict)?.name).toBe('Regular');
    expect(pickTier(500, 0, strict)?.name).toBe('Big');
    expect(pickTier(60, 99_999, strict)?.name).toBe('Regular');
    expect(pickTier(60, 100_000, strict)?.name).toBe('Whale');
  });
});

// =============================================================================
// WHALE_BASIS: pre vs post
// =============================================================================

describe('whale_basis decides whether the buy ITSELF can make you a whale', () => {
  /**
   * A wallet holding 9,700 tokens buys 500 more at $1 — crossing $10,000 with this very
   * trade. It ends the transaction a whale; it began it not being one.
   *
   *   post (default) -> holdings AFTER  = $10,200 -> WHALE
   *   pre            -> holdings BEFORE = $9,700  -> Big (the $500 buy clears the $250 floor)
   *
   * Both readings are defensible and the operator chooses. What must never happen is the
   * buy and the holdings being valued at DIFFERENT prices — so both come from one
   * trade-implied price (pricing/derive.ts), and the basis only chooses which balance.
   */
  const DEPS = { solUsd: 100, stableUsd: 1 };
  // The REGISTRY entry, not a hand-rolled literal: quote assets are data (Phase 2.5),
  // and inventing one here would test a quote asset the normalizer can never emit.
  const USDC = QUOTE_ASSETS[USDC_MINT]!;

  const priced = (basis: 'pre' | 'post') =>
    derivePricing(
      {
        mint: MINT,
        quote: USDC,
        quoteRaw: 500_000_000n, // $500 of USDC (6dp)
        tokensRaw: 500_000_000n, // 500 tokens (6dp) -> $1.00/token, trade-implied
        decimals: 6,
        supplyRaw: 1_000_000_000_000_000n,
        balanceBeforeRaw: 9_700_000_000n, // $9,700 — not a whale
        balanceAfterRaw: 10_200_000_000n, // $10,200 — a whale
      },
      DEPS,
      basis,
    )!;

  it('post: the buy itself pushes the wallet over the line -> WHALE', () => {
    const { usdIn, holdingsUsd } = priced('post');
    expect(usdIn).toBeCloseTo(500);
    expect(holdingsUsd).toBeCloseTo(10_200);
    expect(pickTier(usdIn, holdingsUsd, P)?.name).toBe('Whale');
  });

  it('pre: it was not a whale when the buy landed -> Big, on buy size alone', () => {
    const { usdIn, holdingsUsd } = priced('pre');
    expect(holdingsUsd).toBeCloseTo(9_700);
    expect(pickTier(usdIn, holdingsUsd, P)?.name).toBe('Big');
  });
});

// =============================================================================
// EMPTY-TIER FALLBACK
// =============================================================================

describe('empty-tier fallback — never fail a post because art is missing', () => {
  const counts = (o: Partial<Record<TierFolder, number>>): Record<TierFolder, number> => ({
    regular: 0,
    big: 0,
    whale: 0,
    massive: 0,
    ...o,
  });

  it('walks DOWN first: a whale with an empty whale/ borrows from big/', () => {
    expect(resolveTierWithFallback('whale', counts({ big: 3, regular: 9 }))).toBe('big');
  });

  it('keeps walking down: massive with only regular/ stocked lands on regular/', () => {
    expect(resolveTierWithFallback('massive', counts({ regular: 2 }))).toBe('regular');
  });

  it('walks UP only when there is nothing below — a regular buy may borrow a banger', () => {
    // Last resort: this spends the hand-curated massive art on an ordinary buy. Still
    // strictly better than posting no art at all.
    expect(resolveTierWithFallback('regular', counts({ massive: 1 }))).toBe('massive');
  });

  it('prefers DOWN over UP when both are available', () => {
    expect(resolveTierWithFallback('whale', counts({ big: 1, massive: 1 }))).toBe('big');
  });

  it('an entirely empty pool resolves to nothing — and the caller still posts', () => {
    expect(resolveTierWithFallback('whale', counts({}))).toBeNull();
  });
});

// =============================================================================
// ROTATION
// =============================================================================

describe('shuffle bag', () => {
  it('yields every meme exactly once before any repeat, then reshuffles', () => {
    const live = ['a', 'b', 'c', 'd', 'e'];
    let bag: readonly string[] = [];
    const firstCycle: string[] = [];

    for (let i = 0; i < live.length; i++) {
      const { sha256, rest } = popFromBag(bag, live);
      firstCycle.push(sha256 as string);
      bag = rest;
    }

    expect([...firstCycle].sort()).toEqual([...live].sort()); // every meme...
    expect(new Set(firstCycle).size).toBe(live.length); // ...exactly once
    expect(bag).toHaveLength(0);

    // Exhausted -> the next pop refills, so art keeps coming.
    const { sha256 } = popFromBag(bag, live);
    expect(live).toContain(sha256);
  });

  it('a removal makes the bag stale, and the removed meme never comes out again', () => {
    const bag = ['a', 'b', 'c'];
    const live = ['a', 'b']; // 'c' was removed by an admin
    const seen = new Set<string>();

    let cur: readonly string[] = bag;
    for (let i = 0; i < 20; i++) {
      const { sha256, rest } = popFromBag(cur, live);
      seen.add(sha256 as string);
      cur = rest;
    }
    expect(seen.has('c')).toBe(false);
  });

  it('a NEW meme does not reset the rotation mid-bag', () => {
    // Adding art must not re-show memes people just saw. The new meme joins the next
    // refill; only a REMOVAL invalidates a bag, because only a removal must take effect
    // immediately.
    const bag = ['a', 'b'];
    const live = ['a', 'b', 'c'];
    const { sha256, rest } = popFromBag(bag, live);
    expect(['a', 'b']).toContain(sha256);
    expect(rest).toHaveLength(1);
  });
});

// =============================================================================
// INTEGRATION — the pool, the DB, the bags and the cache together
// =============================================================================

interface FakeItem {
  sha: string;
  tier: TierFolder;
  kind: MediaKind;
}

function snapshotOf(items: readonly FakeItem[]): PoolSnapshot {
  return {
    mint: MINT,
    entries: items.map((i) => ({
      sha256: i.sha,
      tier: i.tier,
      relPath: `${MINT}/${i.tier}/${i.sha}.gif`,
      kind: i.kind,
      bytes: 1000,
      addedAt: 1,
    })),
  };
}

class FakeSource implements MediaSource {
  constructor(public items: FakeItem[]) {}
  async snapshot(): Promise<PoolSnapshot> {
    return snapshotOf(this.items);
  }
  async bytes(item: MediaItem): Promise<Buffer | null> {
    return this.items.some((i) => i.sha === item.sha256) ? Buffer.from(item.sha256) : null;
  }
  async unpublished(): Promise<number | null> {
    return 0;
  }
  async archived(): Promise<ReadonlySet<string>> {
    return new Set(this.archivedShas);
  }
  archivedShas: string[] = [];
}

class FakeUploader implements MediaUploader {
  uploads: string[] = [];
  async uploadToVault(_kind: MediaKind, bytes: Buffer): Promise<string> {
    const sha = bytes.toString();
    this.uploads.push(sha);
    return `file_id::${sha}`;
  }
}

let dir: string;
let repo: SqliteRepo;

const POOL: FakeItem[] = [
  ...Array.from({ length: 4 }, (_, i) => ({ sha: `reg${i}`, tier: 'regular' as TierFolder, kind: 'photo' as MediaKind })),
  ...Array.from({ length: 3 }, (_, i) => ({ sha: `big${i}`, tier: 'big' as TierFolder, kind: 'animation' as MediaKind })),
  ...Array.from({ length: 3 }, (_, i) => ({ sha: `whl${i}`, tier: 'whale' as TierFolder, kind: 'photo' as MediaKind })),
  ...Array.from({ length: 2 }, (_, i) => ({ sha: `mas${i}`, tier: 'massive' as TierFolder, kind: 'video' as MediaKind })),
];

async function makePool(items = POOL, uploader = new FakeUploader()) {
  const source = new FakeSource([...items]);
  const pool = new FsMediaPool({
    repo,
    source,
    uploader,
    log,
    mints: async () => [MINT],
    pollMs: 3_600_000,
    warmUpGapMs: 0,
  });
  await pool.refresh();
  return { pool, source, uploader };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-media-'));
  repo = new SqliteRepo(join(dir, 'test.db'), log);
  await repo.init();
  await repo.upsertChat({ chatId: CHAT, title: 'g', addedBy: 1, paused: false });
  await repo.upsertChat({ chatId: CHAT_B, title: 'h', addedBy: 1, paused: false });
  await repo.addChatToken(CHAT, MINT);
  await repo.addChatToken(CHAT_B, MINT);
});

afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('FsMediaPool', () => {
  it('reports earnedTier and usedTier SEPARATELY when the art is borrowed', async () => {
    // A whale buy into a pool with no whale art. The card must still say WHALE.
    const { pool } = await makePool(POOL.filter((i) => i.tier !== 'whale'));

    const picked = await pool.pick(MINT, CHAT, 20, 50_000);

    expect(picked?.earnedTier).toBe('Whale'); // the FACT about the buy
    expect(picked?.usedTier).toBe('big'); // the folder we could actually draw from
    expect(picked?.item?.tier).toBe('big');
  });

  it('an empty pool still returns the earned tier, with no art', async () => {
    const { pool } = await makePool([]);
    const picked = await pool.pick(MINT, CHAT, 12_000, 12_000);

    expect(picked?.earnedTier).toBe('Massive');
    expect(picked?.usedTier).toBeNull();
    expect(picked?.item).toBeNull(); // Phase 7: static_file_id, then a text-only card
  });

  it('keeps a vanished file in rotation, and its file_id', async () => {
    const { pool, source, uploader } = await makePool();
    const first = await pool.pick(MINT, CHAT, 20, 20);
    const sha = first!.item!.sha256;
    await pool.fileIdFor(first!.item!);

    // Somebody tidies the folder: the file leaves the manifest.
    source.items = source.items.filter((i) => i.sha !== sha);
    await pool.refresh();

    const item = (await repo.listMedia(MINT, 'regular')).find((i) => i.sha256 === sha);
    expect(item?.missing).toBe(true); // flagged...
    expect(await pool.fileIdFor(item!)).toBe(`file_id::${sha}`); // ...still sendable
    expect(uploader.uploads.filter((u) => u === sha)).toHaveLength(1); // and never re-uploaded
  });

  /**
   * REGRESSION (found in production). `rice-tier archive` moved the file out of its tier, so it
   * left the manifest — and the refresh marked it `missing`, which by design KEEPS it in
   * rotation (a missing file is an accident; its file_id still sends). The operator had
   * explicitly removed the meme and the bot kept posting it.
   *
   * Only the archive folder can tell the two disappearances apart.
   */
  it('a meme archived on DISK is treated as a deliberate removal, not an accident', async () => {
    const { pool, source } = await makePool();
    const doomed = (await repo.listMedia(MINT, 'regular'))[0]!;

    // Exactly what `rice-tier archive` does: out of the tier, into _archive.
    source.items = source.items.filter((i) => i.sha !== doomed.sha256);
    source.archivedShas = [doomed.sha256];
    await pool.refresh();

    const item = (await repo.listAllMedia(MINT)).find((i) => i.sha256 === doomed.sha256);
    expect(item?.removedAt).not.toBeNull(); // removed, NOT merely missing
    expect((await repo.listMedia(MINT, 'regular')).map((i) => i.sha256)).not.toContain(doomed.sha256);
  });

  it('an admin removal takes the meme out of rotation immediately', async () => {
    const { pool } = await makePool();
    const doomed = (await repo.listMedia(MINT, 'regular'))[0]!;

    await repo.markMediaRemoved([doomed.sha256], Date.now());

    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const p = await pool.pick(MINT, CHAT, 20, 20);
      if (p?.item) seen.add(p.item.sha256);
    }
    expect(seen.has(doomed.sha256)).toBe(false);
    expect(seen.size).toBe(3); // the other three regulars, and nothing else
  });

  it('bags are PER-CHAT: two groups on one mint do not march in lockstep', async () => {
    const { pool } = await makePool();

    // Drain chat A's regular bag completely.
    for (let i = 0; i < 4; i++) await pool.pick(MINT, CHAT, 20, 20);
    expect(await repo.getBag(MINT, CHAT, 'regular')).toHaveLength(0);

    // Chat B has not drawn at all.
    expect(await repo.getBag(MINT, CHAT_B, 'regular')).toBeNull();
  });

  it('uploads a disk-seeded meme exactly ONCE, and caches the file_id against its sha', async () => {
    const { pool, uploader } = await makePool();
    const item = (await repo.listMedia(MINT, 'massive'))[0]!;

    const a = await pool.fileIdFor(item);
    const b = await pool.fileIdFor(item);

    expect(a).toBe(b);
    expect(uploader.uploads).toEqual([item.sha256]); // one upload, not two
    expect(await repo.getFileId(item.sha256)).toBe(a);
  });

  it('media that arrives WITH a file_id is never uploaded at all', async () => {
    // The DM flow (Phase 8.5): Telegram already minted an id when the admin sent it.
    const { pool, uploader } = await makePool();
    const item = (await repo.listMedia(MINT, 'big'))[0]!;
    await repo.putFileId(item.sha256, 'BQACAgIAdm_supplied');

    expect(await pool.fileIdFor(item)).toBe('BQACAgIAdm_supplied');
    expect(uploader.uploads).toEqual([]);
  });

  it('a rejected file_id is dropped, re-uploaded once, and returned fresh', async () => {
    const { pool, uploader } = await makePool();
    const item = (await repo.listMedia(MINT, 'big'))[0]!;
    await repo.putFileId(item.sha256, 'STALE');

    const fresh = await pool.retryAfterRejection(item, new Error('Bad Request: wrong file identifier'));

    expect(fresh).toBe(`file_id::${item.sha256}`);
    expect(uploader.uploads).toEqual([item.sha256]);
    expect(await repo.getFileId(item.sha256)).toBe(fresh);
  });

  it('a malformed manifest changes NOTHING — it must not look like an empty pool', async () => {
    const { pool, source } = await makePool();
    const before = await pool.stats(MINT);

    source.snapshot = async () => {
      throw new Error('unexpected end of JSON input');
    };
    await pool.refresh(); // does not throw

    // A truncated write would otherwise mark every item missing and blank every bag —
    // one bad file taking away the bot's entire library.
    expect(await pool.stats(MINT)).toEqual(before);
    expect(await pool.pick(MINT, CHAT, 20, 20)).not.toBeNull();
  });

  /**
   * THE INTEGRATION ACCEPTANCE: 40 buys across all four tiers.
   */
  it('40 buys: tiers correct, no repeats within a tier cycle, one cache entry per sha', async () => {
    const { pool, uploader } = await makePool();

    const buys = [
      ...Array.from({ length: 10 }, () => ({ usd: 23, held: 40, want: 'Regular' })),
      ...Array.from({ length: 10 }, () => ({ usd: 340, held: 600, want: 'Big' })),
      ...Array.from({ length: 10 }, () => ({ usd: 20, held: 50_000, want: 'Whale' })),
      ...Array.from({ length: 10 }, () => ({ usd: 2_400, held: 2_400, want: 'Massive' })),
    ];

    const drawnByTier = new Map<string, string[]>();

    for (const b of buys) {
      const p = await pool.pick(MINT, CHAT, b.usd, b.held);
      expect(p?.earnedTier).toBe(b.want);
      expect(p?.usedTier).toBe(b.want.toLowerCase()); // every tier is stocked here
      const list = drawnByTier.get(b.want) ?? [];
      list.push(p!.item!.sha256);
      drawnByTier.set(b.want, list);
      await pool.fileIdFor(p!.item!);
    }

    // No repeat until the tier is exhausted: chunk each tier's draws by its stock size
    // and assert every chunk is a permutation with no duplicates.
    const stock: Record<string, number> = { Regular: 4, Big: 3, Whale: 3, Massive: 2 };
    for (const [tier, draws] of drawnByTier) {
      for (let i = 0; i + stock[tier]! <= draws.length; i += stock[tier]!) {
        const cycle = draws.slice(i, i + stock[tier]!);
        expect(new Set(cycle).size).toBe(cycle.length);
      }
    }

    // The cache holds exactly one entry per DISTINCT sha — never one per send.
    const distinct = new Set([...drawnByTier.values()].flat());
    const cached = repo.raw.prepare('SELECT COUNT(*) AS n FROM media_file_ids').get() as { n: number };
    expect(cached.n).toBe(distinct.size);
    expect(uploader.uploads).toHaveLength(distinct.size);
    expect(new Set(uploader.uploads).size).toBe(uploader.uploads.length); // no double upload
  });
});
