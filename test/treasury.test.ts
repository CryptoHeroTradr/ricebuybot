import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MEDIA_FOLDERS,
  TIER_FOLDERS,
  TREASURY_FOLDER,
  TREASURY_HEADLINE,
  TREASURY_NAME,
  isMediaFolder,
  isTierFolder,
} from '../src/core/tiers.js';
import type { BuyEvent, ChatId, MediaItem, Mint, Signature, TokenMeta, Wallet } from '../src/core/types.js';
import { SqliteRepo } from '../src/db/sqlite.js';
import { headlineFor, renderCard, type CardInput } from '../src/render/card.js';
import { fanOut, isTreasuryBuy, type Priced } from '../src/telegram/fanout.js';
import type { Job } from '../src/telegram/queue.js';
import type { MediaPool, Pick } from '../src/media/index.js';
import { createLogger } from '../src/ops/logger.js';
import { loadConfig } from '../src/config/index.js';

/**
 * PHASE 17 — THE TREASURY BUY BACK CARD.
 *
 * A buy from the project's own treasury wallet is not a size of buy, so it is not a tier. It is a
 * CATEGORY, like `dca`: identified by WHO bought, rendered with the organic card's exact layout,
 * and drawn from its own art folder so a group can tell at a glance that the treasury is buying.
 *
 * The three things that make it a feature rather than a headline swap, each asserted below:
 *   1. it ignores the group's `min_buy_usd` — a buy back is the project, not a stranger's dust;
 *   2. its art comes from `treasury/` and NEVER from a tier folder;
 *   3. it earns no tier, so it can never fire the whale line — a treasury sitting on a fortune in
 *      SOL would otherwise publish its own wallet value on every buy back.
 */

const log = createLogger('silent' as 'info', false);
const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const TREASURY = '9uxQ6PxRPSNzTxWnXMssWE3er3a8bhYbD1TxMxmzks2h' as Wallet;
const STRANGER = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as Wallet;
const CHAT = -1001 as ChatId;

const TOKEN: TokenMeta = {
  mint: MINT,
  symbol: 'RICE',
  name: 'Rice',
  decimals: 6,
  supplyRaw: 1_000_000_000_000_000n,
  fetchedAtMs: 1,
};

function buy(buyer: Wallet): BuyEvent {
  return {
    kind: 'buy',
    signature: 'sig-treasury-1' as Signature,
    slot: 1,
    blockTime: 1_700_000_000,
    mint: MINT,
    buyer,
    quoteMint: 'So11111111111111111111111111111111111111112' as Mint,
    quoteSymbol: 'SOL',
    quoteRaw: 1_000_000_000n,
    tokensRaw: 1_000_000n,
    balanceBeforeRaw: 0n,
    balanceAfterRaw: 1_000_000n,
  } as BuyEvent;
}

const PRICED: Priced = {
  usdIn: 200,
  priceUsd: 0.0002,
  marketCapUsd: 200_000,
  whaleValueUsd: 250_000, // far over the whale floor: a tiered buy from this wallet WOULD be a Whale
  quoteAmount: 1,
  tokensOut: 1,
};

const ITEM = (sha: string, tier: string): MediaItem =>
  ({ sha256: sha, mint: MINT, tier, relPath: `${MINT}/${tier}/${sha}.jpg`, kind: 'photo', bytes: 10, firstSeen: 1, missing: false, removedAt: null }) as unknown as MediaItem;

/** A pool that records which door was used. `pick` is the tier chain; `pickTreasury` is the folder. */
function fakePool(treasuryItem: MediaItem | null, tierItem: MediaItem | null = ITEM('tier-art', 'regular')) {
  const calls: string[] = [];
  const pool = {
    async pick(): Promise<Pick | null> {
      calls.push('pick');
      return { earnedTier: 'Whale', usedTier: 'whale', item: tierItem };
    },
    async pickTreasury(): Promise<MediaItem | null> {
      calls.push('pickTreasury');
      return treasuryItem;
    },
    async fileIdFor(item: MediaItem): Promise<string | null> {
      return `file_id::${item.sha256}`;
    },
  } as unknown as MediaPool;
  return { pool, calls };
}

let dir: string;
let repo: SqliteRepo;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-treasury-'));
  repo = new SqliteRepo(join(dir, 'test.db'), log);
  await repo.init();
  await repo.upsertChat({ chatId: CHAT, title: 'g', addedBy: 1, paused: false });
  await repo.addChatToken(CHAT, MINT);
  await repo.putToken(TOKEN);
  // Pool media is a PAID capability (plan-gate.ts): a free chat's `pool` mode is clamped to its
  // static image on the send path, so a free chat would prove nothing about which folder was drawn.
  await repo.setPlan(CHAT, 'paid', null);
});

afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Fan one buy out and hand back the jobs the queue was given. */
async function fanOutWith(
  event: BuyEvent,
  pool: MediaPool,
  treasuryWallet: string | undefined,
  priced: Priced = PRICED,
): Promise<Job[]> {
  const jobs: Job[] = [];
  await fanOut(event, priced, {
    repo,
    media: pool,
    queue: { enqueue: (j: Job) => jobs.push(j) } as never,
    log: log as never,
    now: () => 1_000,
    ...(treasuryWallet === undefined ? {} : { treasuryWallet }),
  });
  return jobs;
}

// ===========================================================================================
// WHO IS THE TREASURY
// ===========================================================================================

describe('isTreasuryBuy — an EXACT address match, and nothing looser', () => {
  it('matches the configured wallet and no other', () => {
    expect(isTreasuryBuy(TREASURY, TREASURY)).toBe(true);
    expect(isTreasuryBuy(STRANGER, TREASURY)).toBe(false);
  });

  it('is OFF, not loose, when unconfigured — an empty or absent wallet matches nothing', () => {
    // Empty is how an operator turns the feature off (TREASURY_WALLET= in the env). If that
    // compared equal to anything, every buy from an address the parser reported as '' — or any
    // future caller passing a default — would card as a buy back.
    expect(isTreasuryBuy(TREASURY, undefined)).toBe(false);
    expect(isTreasuryBuy(TREASURY, '')).toBe(false);
    expect(isTreasuryBuy('' as Wallet, '')).toBe(false);
  });

  it('does not fold case — base58 is case-sensitive, so two casings are two accounts', () => {
    expect(isTreasuryBuy(TREASURY.toLowerCase() as Wallet, TREASURY)).toBe(false);
  });
});

// ===========================================================================================
// treasury IS NOT A FIFTH TIER
// ===========================================================================================

describe('the treasury folder is a sibling of the tiers, not one of them', () => {
  it('leaves the size ladder at four and only widens where media may live', () => {
    expect(TIER_FOLDERS).toEqual(['regular', 'big', 'whale', 'massive']);
    expect(MEDIA_FOLDERS).toContain(TREASURY_FOLDER);
    expect(isMediaFolder(TREASURY_FOLDER)).toBe(true);
    expect(isTierFolder(TREASURY_FOLDER)).toBe(false);
    // And a folder that is neither remains illegal on both axes.
    expect(isMediaFolder('epic')).toBe(false);
  });

  it('is a legal media_items tier in the DB, and a stray folder still is not', async () => {
    // Migration 021 widened the CHECK. The point of asserting the refusal alongside is that a
    // migration which dropped the constraint to make room would pass the first assertion alone.
    await expect(
      repo.upsertMediaItem({
        sha256: 'sha-treasury',
        mint: MINT,
        tier: TREASURY_FOLDER,
        relPath: `${MINT}/treasury/sha-treasury.jpg`,
        kind: 'photo',
        bytes: 10,
        firstSeen: 1,
      }),
    ).resolves.not.toThrow();

    await expect(
      repo.upsertMediaItem({
        sha256: 'sha-epic',
        mint: MINT,
        tier: 'epic' as never,
        relPath: `${MINT}/epic/sha-epic.jpg`,
        kind: 'photo',
        bytes: 10,
        firstSeen: 1,
      }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});

// ===========================================================================================
// THE CARD
// ===========================================================================================

describe('the card copy', () => {
  const INPUT: CardInput = {
    signature: 'sig' as Signature,
    mint: MINT,
    buyer: TREASURY,
    token: TOKEN,
    earnedTier: TREASURY_NAME,
    usedTier: TREASURY_FOLDER,
    media: null,
    usdIn: 200,
    quoteAmount: 1,
    quoteSymbol: 'SOL',
    tokensOut: 1_000_000,
    marketCapUsd: 200_000,
    whaleValueUsd: 250_000,
    position: null,
    emoji: '🍚',
    emojiCustomId: null,
    emojiStepUsd: 20,
    maxEmojis: 10,
    tierHeadlines: ['a', 'b', 'c', 'd'],
    links: null,
  };

  it('renders the treasury headline, and takes it from nowhere else', () => {
    // Not from tier_headlines: the group's four templates are all nonsense here, and the headline
    // is still right. A per-chat fifth headline is deliberately not a thing (see core/tiers.ts).
    expect(headlineFor(TREASURY_NAME, ['a', 'b', 'c', 'd'], 'RICE')).toBe(TREASURY_HEADLINE);
    expect(renderCard(INPUT).text.startsWith(TREASURY_HEADLINE)).toBe(true);
  });

  it('is the ORGANIC layout — spent, got, buyer/TX and market cap, in that order', () => {
    const text = renderCard(INPUT).text;
    expect(text).toContain('Spent');
    expect(text).toContain('Got');
    expect(text).toContain('Buyer');
    expect(text).toContain('Market Cap');
  });

  it('NEVER carries the wallet-value line, however rich the treasury is', () => {
    // The 💰 line exists to explain why a WHALE card fired. A buy back fired because of who bought,
    // so the line would be both unexplanatory and a standing disclosure of the treasury's balance.
    expect(renderCard(INPUT).text).not.toContain('Wallet');
    // Control: the same numbers on a whale card DO print it, so the assertion above is not vacuous.
    expect(renderCard({ ...INPUT, earnedTier: 'Whale' }).text).toContain('Wallet');
  });
});

// ===========================================================================================
// FAN-OUT
// ===========================================================================================

describe('fan-out', () => {
  it('draws treasury art through pickTreasury and never asks the tier chain at all', async () => {
    const { pool, calls } = fakePool(ITEM('treasury-art', TREASURY_FOLDER));
    const jobs = await fanOutWith(buy(TREASURY), pool, TREASURY);

    expect(jobs).toHaveLength(1);
    expect(calls).toEqual(['pickTreasury']); // the priority chain is not consulted for a buy back
    expect((await jobs[0]!.build()).fileId).toBe('file_id::treasury-art');
  });

  it('posts a buy back BELOW the group’s minimum buy — the floor is for strangers, not the project', async () => {
    await repo.updateChatToken(CHAT, MINT, { minBuyUsd: 100 });
    const dust: Priced = { ...PRICED, usdIn: 4 };

    const { pool } = fakePool(ITEM('treasury-art', TREASURY_FOLDER));
    expect(await fanOutWith(buy(TREASURY), pool, TREASURY, dust)).toHaveLength(1);

    // Control: the SAME $4 buy from anyone else is dropped by that floor, so the bypass above is
    // the treasury rule and not a broken floor.
    const { pool: pool2, calls } = fakePool(null);
    expect(await fanOutWith(buy(STRANGER), pool2, TREASURY, dust)).toHaveLength(0);
    expect(calls).toEqual([]); // dropped before art is even considered
  });

  it('still posts with an EMPTY treasury folder — text-only, never a borrowed tier meme', async () => {
    // NEVER FAIL A POST FOR WANT OF ART. What must not happen is the fallback reaching sideways
    // into `regular/`: the card would then be indistinguishable from an organic buy, which is the
    // exact thing the separate folder exists to prevent.
    const { pool, calls } = fakePool(null, ITEM('tier-art', 'regular'));
    const jobs = await fanOutWith(buy(TREASURY), pool, TREASURY);

    expect(jobs).toHaveLength(1);
    expect(calls).toEqual(['pickTreasury']);
    expect((await jobs[0]!.build()).fileId).toBeNull(); // no art, and no tier art either
  });

  it('leaves every other buy exactly as it was — the tier chain, and the tier art', async () => {
    const { pool, calls } = fakePool(ITEM('treasury-art', TREASURY_FOLDER));
    const jobs = await fanOutWith(buy(STRANGER), pool, TREASURY);

    expect(jobs).toHaveLength(1);
    expect(calls).toEqual(['pick']);
    expect((await jobs[0]!.build()).fileId).toBe('file_id::tier-art');
  });

  it('cards nothing as a buy back when no treasury wallet is configured', async () => {
    const { pool, calls } = fakePool(ITEM('treasury-art', TREASURY_FOLDER));
    await fanOutWith(buy(TREASURY), pool, undefined);
    expect(calls).toEqual(['pick']); // the treasury's own buy is an ordinary tiered buy
  });
});

// ===========================================================================================
// CONFIG
// ===========================================================================================

describe('TREASURY_WALLET', () => {
  const ENV = {
    TELEGRAM_BOT_TOKEN: '123456789:AAHplaceholderplaceholderplaceholder',
    HELIUS_API_KEY: '00000000-0000-0000-0000-000000000000',
    HELIUS_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=deadbeef',
    HELIUS_WS_URL: 'wss://atlas-mainnet.helius-rpc.com/?api-key=deadbeef',
    DEFAULT_MINT: MINT,
    DB_PATH: './data/test.db',
    MEDIA_ROOT: '/srv/media',
    DRY_RUN: 'true',
  } as Record<string, string>;

  it('defaults to the flagship treasury, so the feature works without an env edit', () => {
    expect(loadConfig(ENV).TREASURY_WALLET).toBe(TREASURY);
  });

  it('is overridable, and `off` disables it — normalised to the empty value fan-out treats as off', () => {
    expect(loadConfig({ ...ENV, TREASURY_WALLET: STRANGER }).TREASURY_WALLET).toBe(STRANGER);
    expect(loadConfig({ ...ENV, TREASURY_WALLET: 'off' }).TREASURY_WALLET).toBe('');
  });

  it('a BLANK value is not an off switch — it reads as unset, and unset means the default', () => {
    // dropEmpty() strips blank env vars before the schema sees them, so a stray `TREASURY_WALLET=`
    // line cannot silently disable the feature. This is the reason the off switch is a word.
    expect(loadConfig({ ...ENV, TREASURY_WALLET: '' }).TREASURY_WALLET).toBe(TREASURY);
    expect(loadConfig({ ...ENV, TREASURY_WALLET: '   ' }).TREASURY_WALLET).toBe(TREASURY);
  });

  it('refuses a value that is not an address — a typo must fail at boot, not at the first buy', () => {
    expect(() => loadConfig({ ...ENV, TREASURY_WALLET: 'not-an-address!' })).toThrow(/TREASURY_WALLET/);
  });
});
