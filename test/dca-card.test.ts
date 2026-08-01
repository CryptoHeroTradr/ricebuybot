import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteRepo } from '../src/db/sqlite.ts';
import { createLogger } from '../src/ops/logger.ts';
import { aggregateByWallet, renderDcaCard, wholeGrains, shortWallet } from '../src/render/dca-card.ts';
import {
  windowStartFor,
  lastClosedWindowStart,
  windowEnd,
  normalizeWindowMinutes,
  dcaClaimKey,
  DEFAULT_DCA_WINDOW_MINUTES,
} from '../src/telegram/dca-window.ts';
import { MEDIA_FOLDERS, TIER_FOLDERS, isMediaFolder, isTierFolder } from '../src/core/tiers.ts';
import { DEFAULT_LINKS } from '../src/core/links.ts';
import type { Mint } from '../src/core/types.ts';

const log = createLogger('silent' as 'info', false);
const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const CREATOR = 'CreatorFeeWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const W1 = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const W2 = '9aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abcdEf';
const DEC = 6;

// ===========================================================================================
// THE CARD — one line per wallet, summed, sorted, whole grains, deliberately sparse
// ===========================================================================================

describe('the DCA aggregate card', () => {
  it('six buys from three wallets produce ONE card with THREE lines, summed and sorted desc', () => {
    // Two buys each, deliberately out of order and interleaved.
    const rows = [
      { buyer: W1, tokensRaw: 100_000_000_000n }, // 100,000
      { buyer: CREATOR, tokensRaw: 200_000_000_000n }, // 200,000
      { buyer: W2, tokensRaw: 40_000_000_000n }, // 40,000
      { buyer: W1, tokensRaw: 22_410_000_000n }, // 22,410  -> W1 total 122,410
      { buyer: CREATOR, tokensRaw: 40_000_000_000n }, // -> CREATOR total 240,000
      { buyer: W2, tokensRaw: 44_203_000_000n }, // -> W2 total 84,203
    ];
    const lines = aggregateByWallet(rows);

    expect(lines).toHaveLength(3); // one line PER WALLET, not per transaction
    expect(lines.map((l) => l.wallet)).toEqual([CREATOR, W1, W2]); // biggest DCA leads
    expect(lines.map((l) => l.tokensRaw)).toEqual([240_000_000_000n, 122_410_000_000n, 84_203_000_000n]);

    const card = renderDcaCard({ mint: MINT, decimals: DEC, lines, creatorFeeWallet: CREATOR, links: DEFAULT_LINKS });
    const body = card.text.split('\n').filter(Boolean);
    expect(body[0]).toBe('🌾 DCA Buys');
    expect(body[1]).toBe('Creator Fee DCA bought 240,000 grains');
    expect(body[2]).toBe('7xKX…9fPq DCA bought 122,410 grains'.replace('7xKX…9fPq', shortWallet(W1)));
    expect(body[3]).toContain('84,203 grains');
    expect(body).toHaveLength(4); // header + exactly three wallet lines
  });

  it('WHOLE GRAINS ONLY — floored, never rounded up, no decimals anywhere', () => {
    // 122,410.483927 grains. Rounding would say 122,410 here but 122,411 at .5+ — and claiming
    // more grains than were bought is the one direction this card must never go.
    expect(wholeGrains(122_410_483_927n, DEC)).toBe('122,410');
    expect(wholeGrains(122_410_999_999n, DEC)).toBe('122,410'); // .999999 still floors DOWN
    expect(wholeGrains(999_999n, DEC)).toBe('0'); // less than one whole grain is zero, not "1"

    const card = renderDcaCard({
      mint: MINT, decimals: DEC, links: DEFAULT_LINKS,
      lines: [{ wallet: W1, tokensRaw: 122_410_999_999n }],
    });
    expect(card.text).toContain('122,410 grains');
    expect(card.text).not.toMatch(/\d\.\d/); // no decimal point anywhere on the card
  });

  it('CREATOR_FEE_WALLET renders as "Creator Fee"; every other wallet is a truncated solscan link', () => {
    const card = renderDcaCard({
      mint: MINT, decimals: DEC, creatorFeeWallet: CREATOR, links: DEFAULT_LINKS,
      lines: [{ wallet: CREATOR, tokensRaw: 1_000_000n }, { wallet: W1, tokensRaw: 1n }],
    });
    expect(card.text).toContain('Creator Fee DCA bought');
    expect(card.text).not.toContain(shortWallet(CREATOR)); // the creator is named, not addressed

    // The other wallet: truncated address, linked to solscan, and NO name or villager label.
    expect(card.text).toContain(shortWallet(W1));
    const link = card.entities.find((e) => e.type === 'text_link');
    expect(link).toBeTruthy();
    expect((link as { url: string }).url).toBe(`https://solscan.io/account/${W1}`);
    expect(card.text).not.toMatch(/villager|farmer|whale|holder/i);
  });

  it('is DELIBERATELY SPARSE — no market cap, USD, position or new/returning line', () => {
    const card = renderDcaCard({
      mint: MINT, decimals: DEC, links: DEFAULT_LINKS,
      lines: [{ wallet: W1, tokensRaw: 5_000_000_000n }, { wallet: W2, tokensRaw: 1_000_000_000n }],
    });
    for (const forbidden of [/\$/, /market\s*cap/i, /position/i, /new holder/i, /returning/i, /%/]) {
      expect(card.text, `must not contain ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it('keeps the full button row but drops per-buy links, which have no single value here', () => {
    const withPerBuy = { ...DEFAULT_LINKS, TX: 'https://solscan.io/tx/{signature}', Buyer: 'https://solscan.io/account/{buyer}' };
    const card = renderDcaCard({ mint: MINT, decimals: DEC, links: withPerBuy, lines: [{ wallet: W1, tokensRaw: 1n }] });
    const labels = card.keyboard.flat().map((b) => b.text);

    expect(labels).toContain('DexT');
    expect(labels).toContain('Screener');
    expect(labels).toContain('Buy');
    expect(labels).not.toContain('TX'); // several signatures behind this card — no single one is true
    expect(labels).not.toContain('Buyer');
    for (const b of card.keyboard.flat()) expect(b.url).not.toMatch(/\{buyer\}|\{signature\}/);
  });
});

// ===========================================================================================
// THE WINDOW — wall-clock tumbling, aligned to the hour
// ===========================================================================================

describe('the DCA window', () => {
  const HOUR = new Date('2026-07-24T14:00:00.000Z').getTime();

  it('is tumbling and aligned to the hour — :00 and :30 at the default 30', () => {
    expect(DEFAULT_DCA_WINDOW_MINUTES).toBe(30);
    expect(windowStartFor(HOUR + 60_000, 30)).toBe(HOUR); // 14:01 -> 14:00
    expect(windowStartFor(HOUR + 29 * 60_000, 30)).toBe(HOUR); // 14:29 -> 14:00
    expect(windowStartFor(HOUR + 30 * 60_000, 30)).toBe(HOUR + 30 * 60_000); // 14:30 -> 14:30
    expect(windowStartFor(HOUR + 59 * 60_000, 30)).toBe(HOUR + 30 * 60_000);
    // Every boundary lands on :00 or :30 UTC, never drifting with the first buy.
    for (const m of [0, 7, 22, 31, 45, 59]) {
      const start = windowStartFor(HOUR + m * 60_000, 30);
      expect(new Date(start).getUTCMinutes() % 30).toBe(0);
      expect(new Date(start).getUTCSeconds()).toBe(0);
    }
  });

  it('only ever flushes a CLOSED window', () => {
    const now = HOUR + 40 * 60_000; // 14:40, mid-window
    const closed = lastClosedWindowStart(now, 30);
    expect(closed).toBe(HOUR); // 14:00–14:30, done
    expect(windowEnd(closed, 30)).toBe(HOUR + 30 * 60_000);
    expect(windowEnd(closed, 30)).toBeLessThanOrEqual(now); // never a partial card
  });

  it('changing 30 -> 10 takes effect on the next boundary, with no restart', () => {
    // The window is a pure function of (clock, minutes): swap the minutes and the next boundary is
    // simply the new one. Nothing is cached, so nothing needs restarting.
    expect(windowStartFor(HOUR + 25 * 60_000, 30)).toBe(HOUR);
    expect(windowStartFor(HOUR + 25 * 60_000, 10)).toBe(HOUR + 20 * 60_000);
  });

  it('enforces the 1..1440 bounds', () => {
    expect(normalizeWindowMinutes(30)).toBe(30);
    expect(normalizeWindowMinutes(1)).toBe(1);
    expect(normalizeWindowMinutes(1440)).toBe(1440);
    expect(normalizeWindowMinutes(0)).toBeNull();
    expect(normalizeWindowMinutes(1441)).toBeNull();
    expect(normalizeWindowMinutes(2.5)).toBeNull();
  });

  it('the claim key is (mint, window_start) — not a signature', () => {
    expect(dcaClaimKey(MINT, HOUR)).toBe(`dca:${MINT}:${HOUR}`);
    expect(dcaClaimKey(MINT, HOUR)).not.toBe(dcaClaimKey(MINT, HOUR + 1));
  });
});

// ===========================================================================================
// ATTRIBUTION — the race Phase 14's record-before-send exists to win
// ===========================================================================================

describe('DCA attribution from the buys table', () => {
  let dir: string;
  let repo: SqliteRepo;
  const USER = 4242;
  const HOUR = new Date('2026-07-24T14:00:00.000Z').getTime();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ricebuybot-dca-'));
    repo = new SqliteRepo(join(dir, 't.db'), log);
    await repo.init();
    await repo.addAutotraderUser(USER, 'trader', 1);
  });
  afterEach(async () => {
    await repo.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function scheduleId(): Promise<number> {
    return repo.createSchedule({
      userId: USER, mint: MINT, side: 'buy', amountRaw: 50_000_000n, amountKind: 'absolute',
      intervalMinutes: 15, firstRunAt: HOUR,
    });
  }

  async function recordBuy(sig: string, buyer: string, tokensRaw: bigint, usdIn: number): Promise<void> {
    await repo.recordBuy({
      signature: sig as never, mint: MINT, buyer: buyer as never,
      quoteMint: 'So11111111111111111111111111111111111111112' as never, quoteSymbol: 'SOL',
      quoteRaw: 50_000_000n, tokensRaw, usdIn, priceUsd: 0.0001, slot: 1, blockTime: null,
    });
  }

  it('counts a DCA buy whose execution is still SUBMITTED or UNKNOWN — it never leaks organic', async () => {
    const sched = await scheduleId();
    for (const [i, state] of (['submitted', 'UNKNOWN'] as const).entries()) {
      const plannedAt = HOUR + i * 60_000;
      const execId = (await repo.claimExecution(sched, USER, plannedAt))!;
      const sig = `sig-${state}`;
      // Phase 14 records the signature BEFORE sending — this is that row, pre-confirmation.
      await repo.settleExecution(execId, { state, signature: sig });
      await recordBuy(sig, W1, 10_000_000n, 5);

      // Attributed as DCA despite never being 'confirmed'.
      expect(await repo.isDcaSignature(sig), `${state} must attribute as DCA`).toBe(true);
    }
    const rows = await repo.dcaBuysInWindow(MINT, HOUR, HOUR + 30 * 60_000);
    expect(rows).toHaveLength(2); // both states counted toward the card
  });

  it('an ORGANIC buy is not attributed to DCA', async () => {
    await recordBuy('organic-sig', W2, 999_000_000n, 250);
    expect(await repo.isDcaSignature('organic-sig')).toBe(false);
    expect(await repo.dcaBuysInWindow(MINT, HOUR, HOUR + 30 * 60_000)).toHaveLength(0);
  });

  it('a $5 DCA buy counts even though min_buy_usd is $10 — the window IS the throttle', async () => {
    const sched = await scheduleId();
    const execId = (await repo.claimExecution(sched, USER, HOUR + 5_000))!;
    await repo.settleExecution(execId, { state: 'confirmed', signature: 'small-sig' });
    await recordBuy('small-sig', W1, 3_000_000n, 5); // $5, under a $10 floor

    const rows = await repo.dcaBuysInWindow(MINT, HOUR, HOUR + 30 * 60_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokensRaw).toBe(3_000_000n);
  });

  it('the aggregate is REBUILT FROM THE TABLE, so a restart loses nothing', async () => {
    const sched = await scheduleId();
    for (let i = 0; i < 3; i++) {
      const execId = (await repo.claimExecution(sched, USER, HOUR + i * 60_000))!;
      await repo.settleExecution(execId, { state: 'confirmed', signature: `s${i}` });
      await recordBuy(`s${i}`, i === 2 ? W2 : W1, 1_000_000n, 5);
    }
    await repo.close(); // simulate a restart mid-window: nothing was held in memory

    repo = new SqliteRepo(join(dir, 't.db'), log);
    await repo.init();
    const lines = aggregateByWallet(await repo.dcaBuysInWindow(MINT, HOUR, HOUR + 30 * 60_000));
    expect(lines).toHaveLength(2);
    expect(lines[0]!.tokensRaw).toBe(2_000_000n); // W1's two buys survived the restart
  });

  it('sums with BigInt, not SQL SUM — a u64 keeps its low bits (INVARIANT 6)', async () => {
    const sched = await scheduleId();
    // Two amounts whose sum is beyond float53: SQL SUM() would silently drop the low bits.
    const a = 9_007_199_254_740_993n;
    const b = 9_007_199_254_740_995n;
    for (const [i, amt] of [a, b].entries()) {
      const execId = (await repo.claimExecution(sched, USER, HOUR + i * 60_000))!;
      await repo.settleExecution(execId, { state: 'confirmed', signature: `big${i}` });
      await recordBuy(`big${i}`, W1, amt, 5);
    }
    const lines = aggregateByWallet(await repo.dcaBuysInWindow(MINT, HOUR, HOUR + 30 * 60_000));
    expect(lines[0]!.tokensRaw).toBe(a + b); // exact, to the last unit
  });

  it('an EMPTY window aggregates to nothing (the caller posts no card)', async () => {
    const rows = await repo.dcaBuysInWindow(MINT, HOUR, HOUR + 30 * 60_000);
    expect(rows).toHaveLength(0);
    expect(aggregateByWallet(rows)).toEqual([]);
  });

  it('the cursor advances so a window is never flushed twice or skipped', async () => {
    const CHAT = -1001 as never;
    expect(await repo.getDcaCursor(CHAT, MINT)).toBeNull();
    await repo.setDcaCursor(CHAT, MINT, HOUR);
    expect(await repo.getDcaCursor(CHAT, MINT)).toBe(HOUR);
    await repo.setDcaCursor(CHAT, MINT, HOUR + 30 * 60_000);
    expect(await repo.getDcaCursor(CHAT, MINT)).toBe(HOUR + 30 * 60_000);
  });

  it('the (chat, window) claim makes a mid-flush restart safe — the second claim loses', async () => {
    const CHAT = -1001 as never;
    await repo.upsertChat({ chatId: CHAT, title: 'g', addedBy: 1, paused: false });
    const key = dcaClaimKey(MINT, HOUR) as never;
    expect(await repo.claimSend(key, CHAT)).toBe(true); // first flush owns the window
    expect(await repo.claimSend(key, CHAT)).toBe(false); // a restart mid-flush cannot double-post
  });
});

// ===========================================================================================
// dca IS NOT A FIFTH TIER
// ===========================================================================================

describe('the dca folder is a sibling of the tiers, not one of them', () => {
  it('TIER_FOLDERS stays four; MEDIA_FOLDERS is every place media may live', () => {
    expect(TIER_FOLDERS).toEqual(['regular', 'big', 'whale', 'massive']);
    // The category folders sit AFTER the four tiers and are appended, never inserted: `dca` and
    // `treasury` are siblings of the ladder, and the ladder itself has not moved.
    expect(MEDIA_FOLDERS).toEqual(['regular', 'big', 'whale', 'massive', 'dca', 'treasury']);
    // dca is a media folder but NOT a tier — the size ladder is still four-way.
    expect(isMediaFolder('dca')).toBe(true);
    expect(isTierFolder('dca')).toBe(false);
    // And a folder that is neither remains illegal on both axes.
    expect(isMediaFolder('epic')).toBe(false);
    expect(isTierFolder('epic')).toBe(false);
  });
});
