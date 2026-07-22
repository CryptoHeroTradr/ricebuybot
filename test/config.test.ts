import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteRepo } from '../src/db/sqlite.js';
import { FsMediaPool } from '../src/media/media-pool.js';
import { requireDmOwner, requireGroupAdmin } from '../src/telegram/admin.js';
import { Wizards, WIZARD_TTL_MS } from '../src/telegram/wizard.js';
import { mediaStatsMessage, floorsSentence, whaleSentence } from '../src/telegram/settings.js';
import {
  base58Decode,
  validateFloors,
  validateInt,
  validateMintFormat,
  validateMintOnChain,
  validateUsd,
} from '../src/telegram/validate.js';
import { renderCard } from '../src/render/card.js';
import { createLogger } from '../src/ops/logger.js';
import type { Api } from 'grammy';
import type { ChatId, MediaItem, Mint, Signature, TokenMeta, Wallet } from '../src/core/types.js';
import type { MediaSource, PoolHealth } from '../src/media/index.js';
import type { PoolSnapshot } from '../src/media/source-local.js';

const log = createLogger('silent' as 'info', false);
const RICE = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as Mint;
const GROUP_A = -1001 as ChatId;
const GROUP_B = -1002 as ChatId;

// =============================================================================
// THE ADMIN GATE (INVARIANT 8)
// =============================================================================

describe('admin gate — verified at WRITE TIME, never cached', () => {
  const api = (status: string, calls: { n: number }): Api =>
    ({
      getChatMember: async () => {
        calls.n++;
        return { status } as never;
      },
    }) as unknown as Api;

  it('admits an administrator and a creator', async () => {
    for (const s of ['administrator', 'creator']) {
      expect((await requireGroupAdmin(api(s, { n: 0 }), GROUP_A, 7)).ok).toBe(true);
    }
  });

  it('refuses a plain member, with a human sentence', async () => {
    const v = await requireGroupAdmin(api('member', { n: 0 }), GROUP_A, 7);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.why).toBe('Only a group admin can change my settings.');
  });

  /**
   * The point of the invariant. A cache here is a privilege escalation with a TTL: the
   * whole reason you demote someone is that they stop being able to do admin things NOW.
   */
  it('asks Telegram EVERY time — three commands, three API calls', async () => {
    const calls = { n: 0 };
    const a = api('administrator', calls);
    await requireGroupAdmin(a, GROUP_A, 7);
    await requireGroupAdmin(a, GROUP_A, 7);
    await requireGroupAdmin(a, GROUP_A, 7);
    expect(calls.n).toBe(3);
  });

  it('an API failure is NOT permission — "I do not know" reads as "no"', async () => {
    const broken = { getChatMember: async () => Promise.reject(new Error('timeout')) } as unknown as Api;
    expect((await requireGroupAdmin(broken, GROUP_A, 7)).ok).toBe(false);
  });
});

// =============================================================================
// MINT VALIDATION
// =============================================================================

describe('mint validation names what is actually wrong', () => {
  it('accepts a real mint', () => {
    const v = validateMintFormat(RICE);
    expect(v.ok).toBe(true);
    expect(base58Decode(RICE)).toHaveLength(32);
  });

  it('spots an Ethereum address', () => {
    const v = validateMintFormat('0xdAC17F958D2ee523a2206206994597C13D831ec7');
    expect(v.ok === false && v.why).toMatch(/Ethereum/);
  });

  it('spots a transaction signature pasted instead of a mint', () => {
    // 64 bytes, not 32 — the single most common mis-paste from Solscan.
    const sig =
      '5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7';
    const v = validateMintFormat(sig);
    expect(v.ok === false && v.why).toMatch(/transaction signature/);
  });

  it('explains a base58-illegal character rather than saying "invalid"', () => {
    const v = validateMintFormat('2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpum0');
    expect(v.ok === false && v.why).toMatch(/base58 has no `0`/);
  });

  it('gives the length back when it is the wrong length', () => {
    const v = validateMintFormat('abc');
    expect(v.ok === false && v.why).toMatch(/32-44 base58 characters, and that one is 3/);
  });

  /**
   * The check that earns its keep. A well-formed key that is NOT a mint configures fine,
   * subscribes fine, and then posts nothing forever with no error anywhere — and the group
   * concludes the bot is broken.
   */
  it('rejects a well-formed key that is not a token', async () => {
    const chain = { supplyOf: async () => null };
    const v = await validateMintOnChain(RICE, chain);
    expect(v.ok === false && v.why).toMatch(/can't find that token/);
  });

  it('rejects a mint with zero supply', async () => {
    const chain = { supplyOf: async () => ({ amount: '0', decimals: 6 }) };
    const v = await validateMintOnChain(RICE, chain);
    expect(v.ok === false && v.why).toMatch(/supply of zero/);
  });

  it('an RPC failure is not "no such token"', async () => {
    const chain = {
      supplyOf: async () => {
        throw new Error('502');
      },
    };
    const v = await validateMintOnChain(RICE, chain);
    expect(v.ok === false && v.why).toMatch(/couldn't reach the chain/);
  });
});

// =============================================================================
// FLOORS
// =============================================================================

describe('/setfloors', () => {
  it('accepts strictly ascending floors', () => {
    const v = validateFloors('10', '250', '1000');
    expect(v.ok && v.value).toEqual({ regular: 10, big: 250, massive: 1000 });
  });

  /**
   * Not fussiness: the chain tests massive BEFORE big, so overlapping floors make a tier
   * unreachable — and the running bot would never complain. The group would simply stop
   * getting Massive cards and never learn why.
   */
  it('refuses floors that cross over, and explains the consequence', () => {
    const v = validateFloors('10', '1000', '250');
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.why).toMatch(/a tier can never fire/);
  });

  it('refuses equal floors — "strictly" ascending', () => {
    expect(validateFloors('10', '250', '250').ok).toBe(false);
  });

  it('strips $ and commas, because people paste them', () => {
    const v = validateFloors('$10', '$1,000', '$5,000');
    expect(v.ok && v.value.big).toBe(1000);
  });

  it('validates the numeric settings', () => {
    expect(validateUsd('abc', { min: 0, max: 10, label: 'X' }).ok).toBe(false);
    expect(validateInt('1.5', { min: 1, max: 100, label: 'X' }).ok).toBe(false);
    expect(validateInt('101', { min: 1, max: 100, label: 'The emoji cap' }).ok).toBe(false);
    expect(validateInt('100', { min: 1, max: 100, label: 'X' }).ok).toBe(true);
  });
});

// =============================================================================
// THE WIZARD
// =============================================================================

describe('/setup wizard', () => {
  it('is per (chat, user) — two admins do not overwrite each other', () => {
    const w = new Wizards();
    const a = w.start(GROUP_A, 1);
    const b = w.start(GROUP_A, 2);

    w.advance(a, 'media');

    expect(w.get(GROUP_A, 1)?.step).toBe('media');
    expect(w.get(GROUP_A, 2)?.step).toBe('contract'); // untouched
    expect(b.step).toBe('contract');
  });

  it('expires after 5 minutes of silence', () => {
    let now = 1_000;
    const w = new Wizards(() => now);
    w.start(GROUP_A, 1);

    now += WIZARD_TTL_MS - 1;
    expect(w.get(GROUP_A, 1)).not.toBeNull();

    now += 2;
    // Otherwise the bot reads someone's unrelated message an hour later as a mint address.
    expect(w.get(GROUP_A, 1)).toBeNull();
  });

  it('answering pushes the expiry out — the clock measures inactivity', () => {
    let now = 1_000;
    const w = new Wizards(() => now);
    const s = w.start(GROUP_A, 1);

    now += WIZARD_TTL_MS - 10;
    w.advance(s, 'media');
    now += WIZARD_TTL_MS - 10;

    expect(w.get(GROUP_A, 1)?.step).toBe('media');
  });

  it('/cancel drops it', () => {
    const w = new Wizards();
    w.start(GROUP_A, 1);
    expect(w.cancel(GROUP_A, 1)).toBe(true);
    expect(w.get(GROUP_A, 1)).toBeNull();
  });
});

// =============================================================================
// COPY
// =============================================================================

describe('what a group actually reads', () => {
  const ct = {
    minBuyUsd: 10,
    buyFloorBig: 250,
    buyFloorMassive: 1000,
    whaleHoldingsUsd: 10_000,
    whaleBasis: 'post' as const,
  };

  it('floors, in plain English', () => {
    expect(floorsSentence(ct as never)).toBe('Regular $10.00+ · Big $250.00+ · Massive $1,000+');
  });

  /**
   * The sentence that prevents a support conversation. A group reading "Whale = $10,000"
   * will assume a $10,000 BUY — exactly the ladder mental model the tier chain undoes.
   */
  it('spells out that whale is the SOL+USDC wallet value, not the token bag', () => {
    const s = whaleSentence(ct as never, 'RICE');
    expect(s).toContain('$10K+ in SOL and USDC');
    expect(s).toContain('no matter how small the buy');
    expect(s).not.toContain('$RICE'); // the token bag is no longer the signal
  });

  const health = (over: Partial<PoolHealth> = {}): PoolHealth => ({
    perTier: { regular: 48, big: 22, whale: 9, massive: 3 },
    total: 82,
    uploaded: 79,
    emptyTiers: [],
    unpublished: 0,
    ...over,
  });

  it('reports the counts and the upload progress', () => {
    const m = mediaStatsMessage('RICE', health(), true);
    expect(m).toContain('Regular 48 · Big 22 · Whale 9 · Massive 3 — 79/82 uploaded');
  });

  /**
   * An empty massive/ does NOT fail — it borrows whale art, and the card still says
   * MASSIVE. The degradation is invisible from outside the chat, so it has to be loud here.
   */
  it('calls out an empty tier explicitly', () => {
    const m = mediaStatsMessage('RICE', health({ perTier: { regular: 48, big: 22, whale: 9, massive: 0 }, emptyTiers: ['massive'] }), true);
    expect(m).toContain('*Massive is empty*');
    expect(m).toContain('borrow art');
  });

  /**
   * The generator writes this to a systemd journal nobody reads, while the curator stares
   * at their meme in the folder swearing the bot ignored it. It did.
   */
  it('surfaces UNPUBLISHED files — the ones the generator silently refused', () => {
    const m = mediaStatsMessage('RICE', health({ unpublished: 3 }), true);
    expect(m).toContain('*3 files unpublished*');
    expect(m).toContain('content-addressed');
    expect(m).toContain('tier fix');
  });

  /**
   * The stocked-pool-that-never-posts trap: a free chat whose row still says `pool` is
   * clamped to static/text by the gate, so the curator stocks four tiers, sees a healthy
   * pool here, and watches every card go out as text. Blaming the pool is the only
   * conclusion the old copy allowed — it read the raw column and said "pool is in use".
   */
  it('says the PLAN is why a stocked pool is unused — not "switch to pool"', () => {
    const m = mediaStatsMessage('RICE', health(), false, true);
    expect(m).toContain('free plan');
    expect(m).not.toContain('`/mediamode pool` to switch');
  });

  it('still tells a chat that simply is not on pool mode to switch', () => {
    const m = mediaStatsMessage('RICE', health(), false);
    expect(m).toContain('`/mediamode pool` to switch');
    expect(m).not.toContain('free plan');
  });

  it('says "no art yet" rather than pretending something is broken', () => {
    const m = mediaStatsMessage('RICE', health({ perTier: { regular: 0, big: 0, whale: 0, massive: 0 }, total: 0, uploaded: 0 }), true);
    expect(m).toContain('text-only cards');
    expect(m).toContain('nothing is broken');
  });
});

// =============================================================================
// THE MISSING chats ROW
// =============================================================================

describe('a group the bot never saw itself join', () => {
  /**
   * REGRESSION (found in production, on the very first /setup).
   *
   * The `chats` row is created by the `my_chat_member` handler — which only fires if the bot is
   * RUNNING when it is added. `bot.start({drop_pending_updates: true})` discards anything queued
   * while it was down, so a bot added during a deploy (or a crash loop) comes up already in the
   * group with no record of having joined.
   *
   * Every write below has a foreign key to `chats`. The result was /setup replying "Checking
   * that token on-chain…" and then dying, silently, on a FOREIGN KEY violation.
   */
  it('addChatToken FAILS without a chats row — which is what /setup hit', async () => {
    await repo.putToken(TOKEN(RICE, 'RICE'));

    await expect(repo.addChatToken(GROUP_A, RICE)).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('...so a command must ENSURE the row rather than assume it', async () => {
    // What ensureChat() does, and what makes the retry work.
    await repo.upsertChat({ chatId: GROUP_A, title: 'never saw the join', addedBy: null, paused: false });
    await repo.putToken(TOKEN(RICE, 'RICE'));

    await expect(repo.addChatToken(GROUP_A, RICE)).resolves.toBeTruthy();
    expect((await repo.getChat(GROUP_A))?.addedBy).toBeNull(); // we do not invent who added us
  });
});

// =============================================================================
// TWO GROUPS, TWO MINTS, ONE PROCESS
// =============================================================================

class FakeSource implements MediaSource {
  constructor(private items: { sha: string; tier: 'regular' | 'big' | 'whale' | 'massive'; mint: Mint }[]) {}
  async snapshot(mint: Mint): Promise<PoolSnapshot> {
    return {
      mint,
      entries: this.items
        .filter((i) => i.mint === mint)
        .map((i) => ({
          sha256: i.sha,
          tier: i.tier,
          relPath: `${mint}/${i.tier}/${i.sha}.gif`,
          kind: 'animation' as const,
          bytes: 10,
          addedAt: 1,
        })),
    };
  }
  async bytes(): Promise<Buffer | null> {
    return Buffer.from('x');
  }
  async unpublished(): Promise<number | null> {
    return 0;
  }
  async archived(): Promise<ReadonlySet<string>> {
    return new Set();
  }
}

let dir: string;
let repo: SqliteRepo;

const TOKEN = (mint: Mint, symbol: string): TokenMeta => ({
  mint,
  symbol,
  name: symbol,
  decimals: 6,
  supplyRaw: 1_000_000_000_000_000n,
  fetchedAtMs: 1,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-cfg-'));
  repo = new SqliteRepo(join(dir, 'test.db'), log);
  await repo.init();
});

afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('two groups, two mints, one bot process', () => {
  it('configure independently and never leak into each other', async () => {
    // Group A: $RICE, pool media, default-ish floors, 🍚
    await repo.upsertChat({ chatId: GROUP_A, title: 'A', addedBy: 1, paused: false });
    await repo.addChatToken(GROUP_A, RICE, {
      minBuyUsd: 10,
      buyFloorBig: 250,
      buyFloorMassive: 1000,
      whaleHoldingsUsd: 10_000,
      emoji: '🍚',
      mediaMode: 'pool',
    });

    // Group B: $BONK, STATIC media, its own floors, 🐶, a much lower whale bar
    await repo.upsertChat({ chatId: GROUP_B, title: 'B', addedBy: 2, paused: false });
    await repo.addChatToken(GROUP_B, BONK, {
      minBuyUsd: 5,
      buyFloorBig: 50,
      buyFloorMassive: 500,
      whaleHoldingsUsd: 1_000,
      emoji: '🐶',
      emojiStepUsd: 5,
      mediaMode: 'static',
      staticFileId: 'STATIC_BONK',
      staticKind: 'photo',
    });

    await repo.putToken(TOKEN(RICE, 'RICE'));
    await repo.putToken(TOKEN(BONK, 'BONK'));

    const source = new FakeSource([
      { sha: 'r1', tier: 'regular', mint: RICE },
      { sha: 'w1', tier: 'whale', mint: RICE },
    ]);
    const media = new FsMediaPool({ repo, source, log, mints: async () => [RICE, BONK], pollMs: 1e9 });
    await media.refresh();

    // Both mints are live off ONE process.
    expect([...(await repo.activeMints())].sort()).toEqual([RICE, BONK].sort());

    // --- the SAME buy is a different tier in each group -------------------------------
    // $100 buy, $2,000 held.
    const inA = await media.pick(RICE, GROUP_A, 100, 2_000);
    const inB = await media.pick(BONK, GROUP_B, 100, 2_000);

    expect(inA?.earnedTier).toBe('Regular'); // under A's $250 big floor, under A's $10k whale bar
    expect(inB?.earnedTier).toBe('Whale'); // over B's $1k HOLDINGS bar — holdings, not buy size

    // --- and each renders with its own emoji and its own media ------------------------
    const ctA = (await repo.getChatToken(GROUP_A, RICE))!;
    const ctB = (await repo.getChatToken(GROUP_B, BONK))!;

    const cardA = renderCard({
      signature: 's' as Signature,
      mint: RICE,
      buyer: 'w' as Wallet,
      token: TOKEN(RICE, 'RICE'),
      earnedTier: inA!.earnedTier,
      usedTier: inA!.usedTier,
      media: inA!.item,
      usdIn: 100,
      quoteAmount: 1,
      quoteSymbol: 'SOL',
      tokensOut: 1000,
      marketCapUsd: 1,
      whaleValueUsd: 2000,
      position: null,
      emoji: ctA.emoji,
      emojiCustomId: ctA.emojiCustomId,
      emojiStepUsd: ctA.emojiStepUsd,
      maxEmojis: ctA.maxEmojis,
      tierHeadlines: ctA.tierHeadlines,
      links: ctA.links,
    });

    const cardB = renderCard({
      signature: 's' as Signature,
      mint: BONK,
      buyer: 'w' as Wallet,
      token: TOKEN(BONK, 'BONK'),
      earnedTier: inB!.earnedTier,
      usedTier: inB!.usedTier,
      media: null,
      usdIn: 100,
      quoteAmount: 1,
      quoteSymbol: 'SOL',
      tokensOut: 1000,
      marketCapUsd: 1,
      whaleValueUsd: 2000,
      position: null,
      emoji: ctB.emoji,
      emojiCustomId: ctB.emojiCustomId,
      emojiStepUsd: ctB.emojiStepUsd,
      maxEmojis: ctB.maxEmojis,
      tierHeadlines: ctB.tierHeadlines,
      links: ctB.links,
    });

    expect(cardA.text).toContain('🍚 RICE Buy!');
    expect(cardA.text).toContain('🍚🍚🍚🍚🍚🍚🍚🍚🍚🍚'); // $100 / $10 step
    expect(cardA.text).not.toContain('🐶');

    expect(cardB.text).toContain('🐳 WHALE BUY!');
    expect(cardB.text).toContain('💰 Wallet'); // whale card, so the Holds line is there
    expect(cardB.text).toContain('🐶'); // B's emoji, at B's $5 step
    expect(cardB.text).not.toContain('🍚');

    // A is on pool media and got a real meme; B is static and uses its own file_id.
    expect(inA?.item?.sha256).toBe('r1');
    expect(ctB.staticFileId).toBe('STATIC_BONK');
  });

  it('pausing one group does not unsubscribe the other', async () => {
    await repo.upsertChat({ chatId: GROUP_A, title: 'A', addedBy: 1, paused: false });
    await repo.upsertChat({ chatId: GROUP_B, title: 'B', addedBy: 2, paused: false });
    await repo.addChatToken(GROUP_A, RICE);
    await repo.addChatToken(GROUP_B, RICE); // BOTH on the same mint

    await repo.setPaused(GROUP_A, true);

    // Still active: B is watching it. Unsubscribing here would kill B's feed.
    expect(await repo.activeMints()).toEqual([RICE]);

    await repo.setPaused(GROUP_B, true);
    expect(await repo.activeMints()).toEqual([]); // now nobody wants it
  });
});

// =============================================================================
// /preview — the acceptance cases, verbatim
// =============================================================================

describe('/preview', () => {
  it('25 / 0 -> Regular, 20 / 50000 -> WHALE with the Holds line, 5000 / 5000 -> Massive', async () => {
    await repo.upsertChat({ chatId: GROUP_A, title: 'A', addedBy: 1, paused: false });
    await repo.addChatToken(GROUP_A, RICE);
    await repo.putToken(TOKEN(RICE, 'RICE'));

    const source = new FakeSource([
      { sha: 'r1', tier: 'regular', mint: RICE },
      { sha: 'w1', tier: 'whale', mint: RICE },
      { sha: 'm1', tier: 'massive', mint: RICE },
    ]);
    const media = new FsMediaPool({ repo, source, log, mints: async () => [RICE], pollMs: 1e9 });
    await media.refresh();

    const ct = (await repo.getChatToken(GROUP_A, RICE))!;

    const preview = async (usdIn: number, holdingsUsd: number) => {
      const picked = (await media.pick(RICE, GROUP_A, usdIn, holdingsUsd))!;
      return renderCard({
        signature: 'preview' as Signature,
        mint: RICE,
        buyer: 'w' as Wallet,
        token: TOKEN(RICE, 'RICE'),
        earnedTier: picked.earnedTier,
        usedTier: picked.usedTier,
        media: picked.item,
        usdIn,
        quoteAmount: usdIn / 150,
        quoteSymbol: 'SOL',
        tokensOut: 1000,
        marketCapUsd: 1_000_000,
        whaleValueUsd: holdingsUsd,
        position: null,
        emoji: ct.emoji,
        emojiCustomId: ct.emojiCustomId,
        emojiStepUsd: ct.emojiStepUsd,
        maxEmojis: ct.maxEmojis,
        tierHeadlines: ct.tierHeadlines,
        links: ct.links,
      });
    };

    const regular = await preview(25, 0);
    expect(regular.text).toContain('🍚 RICE Buy!');
    expect(regular.text).not.toContain('Wallet');

    // The reason the second argument exists: you cannot otherwise test the whale path
    // without waiting for an actual whale.
    const whale = await preview(20, 50_000);
    expect(whale.text).toContain('🐳 WHALE BUY!');
    expect(whale.text).toContain('💰 Wallet $50K');

    const massive = await preview(5_000, 5_000);
    expect(massive.text).toContain('💥 MASSIVE BUY!');
    expect(massive.text).not.toContain('Wallet'); // massive is not whale
  });
});
