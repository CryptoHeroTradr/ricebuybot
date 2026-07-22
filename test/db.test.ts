import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Database from 'better-sqlite3';

import { SqliteRepo, CLAIM_SQL, PRAGMAS } from '../src/db/sqlite.js';
import { migrate, migrationsDir, loadMigrations } from '../src/db/migrate.js';
import { DEFAULT_HEADLINES, DEFAULT_TIER_POLICY, TIER_FOLDERS } from '../src/core/tiers.js';
import { createLogger } from '../src/ops/logger.js';
import type { BuyRecord } from '../src/core/types.js';

const log = createLogger('silent' as 'info', false);

let dir: string;
let dbPath: string;
let repo: SqliteRepo;

async function openRepo(): Promise<SqliteRepo> {
  const r = new SqliteRepo(dbPath, log);
  await r.init();
  return r;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-test-'));
  dbPath = join(dir, 'test.db');
  repo = await openRepo();
});

afterEach(async () => {
  await repo.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

const SIG = '5xSigNaTuReAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump';
const BUYER = 'BuYeRwAlLeTaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CHAT = -1001234567890;

async function seedChat(chatId = CHAT, paused = false): Promise<void> {
  await repo.upsertChat({ chatId, title: 'Rice Fam', addedBy: 1, paused });
}

// --- schema constants agree with core/tiers.ts --------------------------------

describe('schema constants', () => {
  // The migration hardcodes these as SQL literals. If someone edits core/tiers.ts
  // without adding a migration, this test is what tells them.
  const sql = readFileSync(join(migrationsDir(), '001_init.sql'), 'utf8');

  it('CHECK constraint lists exactly the tier folders from core/tiers.ts', () => {
    const expected = TIER_FOLDERS.map((f) => `'${f}'`).join(',');
    expect(sql).toContain(`tier IN (${expected})`);
  });

  // The ladder (tier_thresholds) is gone as of migration 008 — whale is denominated in
  // HOLDINGS now, so a 4-element array of buy floors cannot express the policy. These
  // are the literals that replaced it, and they must not drift from core/tiers.ts.
  it('migration 008 tier-policy defaults match DEFAULT_TIER_POLICY', () => {
    const sql8 = readFileSync(join(migrationsDir(), '008_tier_policy_and_removal.sql'), 'utf8');
    expect(sql8).toContain(`buy_floor_big      REAL NOT NULL DEFAULT ${DEFAULT_TIER_POLICY.bigUsd}`);
    expect(sql8).toContain(`buy_floor_massive  REAL NOT NULL DEFAULT ${DEFAULT_TIER_POLICY.massiveUsd}`);
    expect(sql8).toContain(`whale_holdings_usd REAL NOT NULL DEFAULT ${DEFAULT_TIER_POLICY.whaleHoldingsUsd}`);
    expect(sql8).toContain(`min_buy_usd        REAL NOT NULL DEFAULT ${DEFAULT_TIER_POLICY.minBuyUsd}`);
  });

  it('tier_headlines default matches DEFAULT_HEADLINES', () => {
    expect(sql).toContain(`DEFAULT '${JSON.stringify(DEFAULT_HEADLINES)}'`);
  });

  it('rejects an out-of-vocabulary tier at the DB level, not just in TS', async () => {
    expect(() =>
      repo.raw
        .prepare(
          `INSERT INTO media_items (sha256, mint, tier, rel_path, kind, bytes, first_seen)
           VALUES ('x', 'm', 'tier3', 'a.gif', 'animation', 1, 1)`,
        )
        .run(),
    ).toThrow(/CHECK constraint/i);
  });
});

// --- migrations ---------------------------------------------------------------

describe('migrations', () => {
  it('applies once and is idempotent across reopens', async () => {
    const versions = () =>
      repo.raw.prepare<[], { version: number }>('SELECT version FROM schema_migrations ORDER BY version').all();

    const first = versions();
    expect(first.length).toBe(loadMigrations().length);
    expect(first.length).toBeGreaterThan(0);

    await repo.close();
    repo = await openRepo(); // re-run migrate() on an up-to-date DB
    expect(versions()).toEqual(first);

    await repo.init(); // and again on the same handle
    expect(versions()).toEqual(first);
  });

  it('sets the required pragmas', () => {
    expect(String(repo.raw.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(repo.raw.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    expect(repo.raw.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(PRAGMAS.some((p) => p.includes('busy_timeout'))).toBe(true);
  });

  it('refuses to run if an applied migration file was edited', async () => {
    // Simulate a tampered file by rewriting the recorded checksum.
    repo.raw.prepare("UPDATE schema_migrations SET checksum = 'deadbeef' WHERE version = 1").run();
    await expect(repo.init()).rejects.toThrow(/was modified after it was applied/);
  });
});

// --- activeMints --------------------------------------------------------------

describe('activeMints', () => {
  const OTHER = 'So11111111111111111111111111111111111111112';

  it('is the DISTINCT set of enabled watches on non-paused chats', async () => {
    await seedChat(-1001, false);
    await seedChat(-1002, false);
    await seedChat(-1003, true); // paused

    await repo.addChatToken(-1001, MINT);
    await repo.addChatToken(-1002, MINT); // same mint, two chats -> DISTINCT
    await repo.addChatToken(-1002, OTHER);
    await repo.addChatToken(-1003, 'PausedMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');

    expect(await repo.activeMints()).toEqual([MINT, OTHER].sort());
  });

  it('drops a mint when its last enabled watch is disabled', async () => {
    await seedChat();
    await repo.addChatToken(CHAT, MINT);
    expect(await repo.activeMints()).toEqual([MINT]);

    await repo.updateChatToken(CHAT, MINT, { enabled: false });
    expect(await repo.activeMints()).toEqual([]);
  });

  it('drops a mint when the chat is paused, and restores it on unpause', async () => {
    await seedChat();
    await repo.addChatToken(CHAT, MINT);

    await repo.setPaused(CHAT, true);
    expect(await repo.activeMints()).toEqual([]);
    expect(await repo.chatTokensForMint(MINT)).toEqual([]);

    await repo.setPaused(CHAT, false);
    expect(await repo.activeMints()).toEqual([MINT]);
    expect((await repo.chatTokensForMint(MINT)).length).toBe(1);
  });

  it('cascades chat_tokens when a chat is deleted', async () => {
    await seedChat();
    await repo.addChatToken(CHAT, MINT);
    await repo.deleteChat(CHAT);

    expect(await repo.listChatTokens(CHAT)).toEqual([]);
    expect(await repo.activeMints()).toEqual([]);
  });
});

// --- bigint round-trip --------------------------------------------------------

describe('bigint round-trip (INVARIANT 6)', () => {
  // u64 max. As a REAL this rounds to 18446744073709552000 — off by 1616.
  const U64_MAX = 18_446_744_073_709_551_615n;
  const AWKWARD = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2

  it('survives a u64 through buys and positions with zero precision loss', async () => {
    await seedChat();
    const buy: BuyRecord = {
      signature: SIG,
      mint: MINT,
      buyer: BUYER,
      quoteMint: 'So11111111111111111111111111111111111111112',
      quoteSymbol: 'SOL',
      quoteRaw: AWKWARD,
      tokensRaw: U64_MAX,
      usdIn: 1234.56,
      priceUsd: 0.0000001234,
      slot: 300_000_000,
      blockTime: 1_700_000_000,
    };

    await repo.recordBuy(buy);
    const row = repo.raw
      .prepare<[], { quote_raw: string; tokens_raw: string }>('SELECT * FROM buys')
      .get() as { quote_raw: string; tokens_raw: string };

    // Stored as TEXT, exactly.
    expect(row.tokens_raw).toBe('18446744073709551615');
    expect(BigInt(row.tokens_raw)).toBe(U64_MAX);
    expect(BigInt(row.quote_raw)).toBe(AWKWARD);

    // And a REAL round-trip would NOT have survived — proving TEXT is load-bearing.
    expect(BigInt(Math.round(Number(U64_MAX)))).not.toBe(U64_MAX);

    const pos = await repo.applyBuy(buy);
    expect(pos.tokensRaw).toBe(U64_MAX);

    const reread = await repo.getPosition(MINT, BUYER);
    expect(reread?.tokensRaw).toBe(U64_MAX);
  });

  it('accumulates positions in bigint across many buys', async () => {
    await seedChat();
    const mk = (sig: string, tokens: bigint, usd: number): BuyRecord => ({
      signature: sig,
      mint: MINT,
      buyer: BUYER,
      quoteMint: 'So11111111111111111111111111111111111111112',
      quoteSymbol: 'SOL',
      quoteRaw: 1n,
      tokensRaw: tokens,
      usdIn: usd,
      priceUsd: 1,
      slot: 1,
      blockTime: null,
    });

    await repo.applyBuy(mk('a', 10_000_000_000_000_000_001n, 100));
    const pos = await repo.applyBuy(mk('b', 2n, 50));

    expect(pos.tokensRaw).toBe(10_000_000_000_000_000_003n);
    expect(pos.costUsd).toBeCloseTo(150, 6);
  });

  it('supply_raw round-trips as bigint', async () => {
    await repo.putToken({
      mint: MINT,
      symbol: 'RICE',
      name: 'Rice',
      decimals: 6,
      supplyRaw: 999_999_999_999_999_999n,
      fetchedAtMs: 123,
    });
    expect((await repo.getToken(MINT))?.supplyRaw).toBe(999_999_999_999_999_999n);
  });

  it('clamps an oversized sell instead of going negative', async () => {
    await seedChat();
    await repo.applyBuy({
      signature: 'a',
      mint: MINT,
      buyer: BUYER,
      quoteMint: 'So11111111111111111111111111111111111111112',
      quoteSymbol: 'SOL',
      quoteRaw: 1n,
      tokensRaw: 100n,
      usdIn: 100,
      slot: 1,
      priceUsd: 1,
      blockTime: null,
    });

    // Sell more than we ever saw them buy (bot added mid-life). Quantities floor
    // at zero rather than going negative — a negative tokensRaw would poison every
    // later percentage.
    const pos = await repo.applySell(
      {
        signature: 'oversized-sell',
        mint: MINT,
        seller: BUYER,
        quoteMint: 'So11111111111111111111111111111111111111112',
        quoteSymbol: 'SOL',
        quoteRaw: 1n,
        tokensRaw: 500n,
        usdOut: 200,
        slot: 2,
        blockTime: null,
      },
      0,
    );
    expect(pos.tokensRaw).toBe(0n);
    expect(pos.costUsd).toBe(0);

    // Realized PnL is (sellPrice - avgCost) * soldTokens, per the Phase 4 formula:
    // sold 500 @ $0.40 against a $1.00 average = -$300.
    //
    // Note this is NOT the "$200 out - $100 in = +$100" a clamped calculation
    // would give. The 400 tokens we never saw bought get charged at the average of
    // the ones we did, which is a guess — and it is precisely why this wallet comes
    // out UNRECONCILED (drift != 0) and therefore never has a Position % rendered.
    // The floor keeps the ledger sane; reconciliation is what keeps us honest.
    expect(pos.realizedPnlUsd).toBeCloseTo(-300, 6);
    expect(pos.reconciled).toBe(false);
  });

  it('leaves the average basis unchanged by a partial sell', async () => {
    await seedChat();
    await repo.applyBuy({
      signature: 'a',
      mint: MINT,
      buyer: BUYER,
      quoteMint: 'So11111111111111111111111111111111111111112',
      quoteSymbol: 'SOL',
      quoteRaw: 1n,
      tokensRaw: 100n,
      usdIn: 100,
      slot: 1,
      priceUsd: 1,
      blockTime: null,
    });

    const pos = await repo.applySell(
      {
        signature: 'partial-sell',
        mint: MINT,
        seller: BUYER,
        quoteMint: 'So11111111111111111111111111111111111111112',
        quoteSymbol: 'SOL',
        quoteRaw: 1n,
        tokensRaw: 40n,
        usdOut: 80,
        slot: 2,
        blockTime: null,
      },
      0,
    ); // sold 40% for $80
    expect(pos.tokensRaw).toBe(60n);
    expect(pos.costUsd).toBeCloseTo(60, 6); // basis still $1/token
    expect(pos.realizedPnlUsd).toBeCloseTo(40, 6); // 80 - 40 retired
  });
});

// --- rotation bag -------------------------------------------------------------

describe('rotation bag', () => {
  it('round-trips a bag as JSON', async () => {
    const bag = ['aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32)];
    await repo.putBag(MINT, CHAT, 'whale', bag);
    expect(await repo.getBag(MINT, CHAT, 'whale')).toEqual(bag);
  });

  it('returns null for an untouched bag and handles an emptied one', async () => {
    expect(await repo.getBag(MINT, CHAT, 'regular')).toBeNull();
    await repo.putBag(MINT, CHAT, 'regular', []);
    expect(await repo.getBag(MINT, CHAT, 'regular')).toEqual([]); // empty != absent
  });

  it('keeps bags independent per (mint, chat, tier)', async () => {
    await repo.putBag(MINT, -1001, 'big', ['a']);
    await repo.putBag(MINT, -1002, 'big', ['b']);
    await repo.putBag(MINT, -1001, 'whale', ['c']);

    // Two groups on the SAME mint must never sync up.
    expect(await repo.getBag(MINT, -1001, 'big')).toEqual(['a']);
    expect(await repo.getBag(MINT, -1002, 'big')).toEqual(['b']);
    expect(await repo.getBag(MINT, -1001, 'whale')).toEqual(['c']);
  });

  it('survives a corrupt bag rather than crashing the bot', async () => {
    await repo.putBag(MINT, CHAT, 'big', ['a']);
    repo.raw.prepare("UPDATE media_rotation SET bag = '{not json' WHERE tier = 'big'").run();
    expect(await repo.getBag(MINT, CHAT, 'big')).toEqual([]);
  });
});

// --- media identity -----------------------------------------------------------

describe('media items', () => {
  const SHA = 'ab'.repeat(32);

  it('treats the same content under two filenames as ONE item', async () => {
    await repo.upsertMediaItem({ sha256: SHA, mint: MINT, tier: 'big', relPath: 'a.gif', kind: 'animation', bytes: 10 });
    await repo.upsertMediaItem({ sha256: SHA, mint: MINT, tier: 'big', relPath: 'b.gif', kind: 'animation', bytes: 10 });

    const items = await repo.listMedia(MINT, 'big');
    expect(items.length).toBe(1); // ONE item -> ONE Telegram upload
    expect(items[0]?.relPath).toBe('b.gif');
  });

  /**
   * `missing` and `removed` are the SAME disappearance from the manifest and the
   * OPPOSITE instruction. The DB has to tell them apart, or one of the two behaviours
   * is wrong — and the wrong one is the one an admin explicitly asked for.
   */
  it('a MISSING file stays in rotation — the accident is survivable', async () => {
    await repo.upsertMediaItem({ sha256: SHA, mint: MINT, tier: 'big', relPath: 'a.gif', kind: 'animation', bytes: 10 });
    await repo.putFileId(SHA, 'BQACAgIAxxx');

    await repo.markMediaMissing([SHA], true);

    // Somebody tidied a folder. The bytes are gone; the file_id still works, because
    // Telegram serves an uploaded file long after we lose the local copy. So we keep
    // posting it. Dropping it here would throw away working art for no reason.
    const live = await repo.listMedia(MINT, 'big');
    expect(live.map((i) => i.sha256)).toEqual([SHA]);
    expect(live[0]?.missing).toBe(true);
    expect(await repo.getFileId(SHA)).toBe('BQACAgIAxxx');
  });

  it('a REMOVED file leaves rotation immediately — an admin meant it', async () => {
    await repo.upsertMediaItem({ sha256: SHA, mint: MINT, tier: 'big', relPath: 'a.gif', kind: 'animation', bytes: 10 });
    await repo.putFileId(SHA, 'BQACAgIAxxx');

    await repo.markMediaRemoved([SHA], Date.now());

    expect(await repo.listMedia(MINT, 'big')).toEqual([]); // gone from every bag
    // The file_id is NOT discarded. That is precisely why removal has to be recorded:
    // "we still CAN send it" must never quietly become "we still DO send it".
    expect(await repo.getFileId(SHA)).toBe('BQACAgIAxxx');
  });

  it('a manifest refresh does NOT resurrect a removed item', async () => {
    await repo.upsertMediaItem({ sha256: SHA, mint: MINT, tier: 'big', relPath: 'a.gif', kind: 'animation', bytes: 10 });
    await repo.markMediaRemoved([SHA], Date.now());

    // Phase 8.5 removes in two steps (flag it, then move the bytes to _archive). A
    // refresh landing between them sees the file still sitting in its tier folder and
    // upserts it. That must NOT clear removed_at, or the race un-deletes the meme.
    await repo.upsertMediaItem({ sha256: SHA, mint: MINT, tier: 'big', relPath: 'a.gif', kind: 'animation', bytes: 10 });

    expect(await repo.listMedia(MINT, 'big')).toEqual([]);
  });

  it('un-removing is explicit, and puts it back', async () => {
    await repo.upsertMediaItem({ sha256: SHA, mint: MINT, tier: 'big', relPath: 'a.gif', kind: 'animation', bytes: 10 });
    await repo.markMediaRemoved([SHA], Date.now());
    await repo.markMediaRemoved([SHA], null);

    expect((await repo.listMedia(MINT, 'big')).map((i) => i.sha256)).toEqual([SHA]);
  });
});

// --- THE IDEMPOTENCY CHOKEPOINT ----------------------------------------------

describe('send claim lifecycle (INVARIANT 2)', () => {
  it('claims exactly once, and stays claimed across a reopened DB handle', async () => {
    expect(await repo.claimSend(SIG, CHAT)).toBe(true);
    expect(await repo.claimSend(SIG, CHAT)).toBe(false);

    await repo.close();
    repo = await openRepo(); // simulate a restart WITHOUT the boot sweep

    expect(await repo.claimSend(SIG, CHAT)).toBe(false);
  });

  it('scopes the claim to (signature, chat) — a second group still gets its post', async () => {
    expect(await repo.claimSend(SIG, -1001)).toBe(true);
    expect(await repo.claimSend(SIG, -1002)).toBe(true);
    expect(await repo.claimSend('other-sig', -1001)).toBe(true);
  });

  it('does not re-claim after markSent (the replay case)', async () => {
    expect(await repo.claimSend(SIG, CHAT)).toBe(true);
    await repo.markSent(SIG, CHAT, 4242);

    expect(await repo.claimSend(SIG, CHAT)).toBe(false);

    const row = repo.raw
      .prepare<[], { state: string; message_id: number }>('SELECT state, message_id FROM sends')
      .get();
    expect(row).toEqual({ state: 'sent', message_id: 4242 });
  });

  it('releaseSend permits a re-claim (retryable failure)', async () => {
    expect(await repo.claimSend(SIG, CHAT)).toBe(true);
    await repo.releaseSend(SIG, CHAT, '429 exhausted');

    expect(await repo.claimSend(SIG, CHAT)).toBe(true); // re-claimable
  });

  it('failSend does NOT permit a re-claim (permanent tombstone)', async () => {
    expect(await repo.claimSend(SIG, CHAT)).toBe(true);
    await repo.failSend(SIG, CHAT, '403 bot was kicked');

    expect(await repo.claimSend(SIG, CHAT)).toBe(false);

    await repo.close();
    repo = await openRepo();
    expect(await repo.claimSend(SIG, CHAT)).toBe(false); // still dead after restart
  });

  it('tombstones a replay against a dead chat without ever re-sending', async () => {
    await repo.failSend(SIG, CHAT, 'chat not found');
    // A reconnect replays the same buy 5 times. None of them may claim.
    for (let i = 0; i < 5; i++) expect(await repo.claimSend(SIG, CHAT)).toBe(false);

    const row = repo.raw.prepare<[], { state: string }>('SELECT state FROM sends').get();
    expect(row?.state).toBe('failed');
  });
});

// --- INVARIANT 9: orphan sweep ------------------------------------------------

describe('orphaned claim sweep (INVARIANT 9)', () => {
  it('sweeps a crashed claim to failed on boot, and never re-claims it', async () => {
    // Crash between claimSend and markSent: state='claimed', no message_id.
    expect(await repo.claimSend(SIG, CHAT)).toBe(true);
    await repo.close();

    repo = await openRepo();
    expect(await repo.sweepOrphanedClaims()).toBe(1);

    const row = repo.raw
      .prepare<[], { state: string; fail_reason: string; message_id: number | null }>(
        'SELECT state, fail_reason, message_id FROM sends',
      )
      .get();
    expect(row?.state).toBe('failed');
    expect(row?.fail_reason).toBe('orphaned');
    expect(row?.message_id).toBeNull();

    // The whole point: it is LOST, deliberately. Never resent.
    expect(await repo.claimSend(SIG, CHAT)).toBe(false);
  });

  it('leaves sent and failed rows alone', async () => {
    await repo.claimSend('sent-sig', CHAT);
    await repo.markSent('sent-sig', CHAT, 1);
    await repo.failSend('failed-sig', CHAT, 'kicked');
    await repo.claimSend('orphan-sig', CHAT); // the only orphan

    expect(await repo.sweepOrphanedClaims()).toBe(1);

    const states = repo.raw
      .prepare<[], { signature: string; state: string }>('SELECT signature, state FROM sends ORDER BY signature')
      .all();
    expect(states).toEqual([
      { signature: 'failed-sig', state: 'failed' },
      { signature: 'orphan-sig', state: 'failed' },
      { signature: 'sent-sig', state: 'sent' },
    ]);
  });

  it('is a no-op on a clean boot', async () => {
    expect(await repo.sweepOrphanedClaims()).toBe(0);
  });
});

// --- concurrency: PROVE exactly one winner ------------------------------------

const CORES = availableParallelism?.() ?? cpus().length;

/**
 * SKIPPED ON SINGLE-CORE MACHINES, because the harness cannot produce a
 * concurrent interleaving there.
 *
 * With one core the 8 barrier-released threads are scheduled ~500-1000us apart,
 * while the claim's critical section completes in ~150us. Each thread finishes
 * read-then-write inside its own timeslice, so the gap never straddles a context
 * switch and BOTH a correct and a broken CLAIM_SQL yield exactly one winner.
 *
 * Skipping is deliberate. An unconditional run, or a control relaxed until it
 * goes green, re-introduces a silent hole: the positive test would keep passing
 * whether or not the claim is atomic. Phase 13's executions table inherits this
 * exact claim pattern with real money behind it. A skipped test shows as SKIPPED
 * in the tally; a vacuously passing one shows as green.
 *
 * Do NOT widen the naive read->write gap to make the negative control pass. That
 * restores the CONTROL without restoring the COVERAGE.
 */
describe.skipIf(CORES < 2)('claim concurrency (requires >=2 cores)', () => {
  /**
   * better-sqlite3 is synchronous, so two Promises in one event loop would
   * serialise trivially and prove nothing. This runs the REAL claim statement
   * (imported, not retyped) from N genuine OS threads, each with its OWN
   * connection to the same file, released simultaneously via an Atomics barrier.
   *
   * That is the actual production race: several processes/reconnects claiming the
   * same buy at once.
   */
  const WORKER_SRC = `
    const { workerData, parentPort } = require('node:worker_threads');
    const Database = require('better-sqlite3');
    const db = new Database(workerData.dbPath);
    for (const p of workerData.pragmas) db.pragma(p.replace(/^PRAGMA\\s+/, ''));
    const stmt = db.prepare(workerData.sql);

    parentPort.postMessage({ ready: true });
    // Block this OS thread until the main thread opens the gate, so all threads
    // hit the claim at genuinely the same moment.
    Atomics.wait(workerData.gate, 0, 0);

    let won = false, error = null;
    try {
      won = stmt.run(workerData.sig, workerData.chatId, Date.now()).changes === 1;
    } catch (e) {
      error = String(e && e.message);
    }
    db.close();
    parentPort.postMessage({ won, error });
  `;

  async function race(n: number, sig: string): Promise<Array<{ won: boolean; error: string | null }>> {
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const ready: Array<Promise<void>> = [];
    const done: Array<Promise<{ won: boolean; error: string | null }>> = [];

    for (let i = 0; i < n; i++) {
      const w = new Worker(WORKER_SRC, {
        eval: true,
        workerData: { dbPath, sql: CLAIM_SQL, pragmas: [...PRAGMAS], sig, chatId: CHAT, gate },
      });

      let markReady!: () => void;
      let settle!: (v: { won: boolean; error: string | null }) => void;
      let fail!: (e: Error) => void;
      ready.push(new Promise<void>((res) => (markReady = res)));
      done.push(new Promise((res, rej) => ((settle = res), (fail = rej))));

      w.on('message', (m: { ready?: boolean; won?: boolean; error?: string | null }) => {
        if (m.ready) markReady();
        else settle({ won: m.won === true, error: m.error ?? null });
      });
      w.on('error', fail);
      w.on('exit', () => void 0);
    }

    // Every thread is parked on the barrier. Now release them all at once.
    await Promise.all(ready);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);

    return Promise.all(done);
  }

  it('lets exactly ONE of 8 racing threads win the claim', async () => {
    const results = await race(8, SIG);

    // No thread may fail: busy_timeout must make a loser WAIT and lose cleanly,
    // not error out with SQLITE_BUSY.
    expect(results.filter((r) => r.error !== null)).toEqual([]);

    // The assertion the whole ledger exists for.
    expect(results.filter((r) => r.won).length).toBe(1);
    expect(results.filter((r) => !r.won).length).toBe(7);

    // And exactly one row landed.
    const rows = repo.raw.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM sends').get();
    expect(rows?.n).toBe(1);
  }, 30_000);

  /**
   * NEGATIVE CONTROL. A green concurrency test proves nothing unless the harness
   * can actually catch the bug it is guarding against.
   *
   * This runs the NAIVE read-then-write ("have I sent this?") through the exact
   * same 8-thread barrier. It must DOUBLE-CLAIM — several threads read "no rows"
   * before any of them inserts. If this ever starts reporting one winner, the
   * barrier has stopped working and the test above has gone vacuous.
   */
  it('negative control: read-then-write DOES double-claim under the same race', async () => {
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const naive = `
      const { workerData, parentPort } = require('node:worker_threads');
      const Database = require('better-sqlite3');
      const db = new Database(workerData.dbPath);
      for (const p of workerData.pragmas) db.pragma(p.replace(/^PRAGMA\\s+/, ''));

      const read = db.prepare('SELECT 1 FROM sends WHERE signature = ? AND chat_id = ?');
      const write = db.prepare(
        "INSERT OR IGNORE INTO sends (signature, chat_id, state, attempts, claimed_at) VALUES (?, ?, 'claimed', 1, ?)"
      );

      parentPort.postMessage({ ready: true });
      Atomics.wait(workerData.gate, 0, 0);

      // The bug, verbatim: check, then act. The gap between them is the race.
      let won = false;
      const seen = read.get(workerData.sig, workerData.chatId);
      if (!seen) {
        write.run(workerData.sig, workerData.chatId, Date.now());
        won = true;   // "I did not see it, therefore I own it" — wrong.
      }
      db.close();
      parentPort.postMessage({ won, error: null });
    `;

    const ready: Array<Promise<void>> = [];
    const done: Array<Promise<{ won: boolean }>> = [];
    for (let i = 0; i < 8; i++) {
      const w = new Worker(naive, {
        eval: true,
        workerData: { dbPath, pragmas: [...PRAGMAS], sig: 'naive-sig', chatId: CHAT, gate },
      });
      let markReady!: () => void;
      let settle!: (v: { won: boolean }) => void;
      ready.push(new Promise<void>((res) => (markReady = res)));
      done.push(new Promise((res) => (settle = res)));
      w.on('message', (m: { ready?: boolean; won?: boolean }) => {
        if (m.ready) markReady();
        else settle({ won: m.won === true });
      });
    }

    await Promise.all(ready);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    const results = await Promise.all(done);

    // THIS is the double-post. More than one thread believes it owns the send.
    expect(results.filter((r) => r.won).length).toBeGreaterThan(1);
  }, 30_000);

  it('a racing swarm cannot resurrect a failed tombstone', async () => {
    await repo.failSend(SIG, CHAT, 'kicked');

    const results = await race(8, SIG);
    expect(results.filter((r) => r.error !== null)).toEqual([]);
    expect(results.filter((r) => r.won).length).toBe(0); // nobody wins a tombstoned send

    const row = repo.raw.prepare<[], { state: string }>('SELECT state FROM sends').get();
    expect(row?.state).toBe('failed');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// PHASE 4.6 MIGRATION — collapse the double-counts the old PK allowed in
// ---------------------------------------------------------------------------

describe('migration 005: narrowing the swaps PK', () => {
  const MINT4 = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump';
  const W4 = 'DoubleCountedWaLLetAAAAAAAAAAAAAAAAAAAAAAAA';
  const SOL4 = 'So11111111111111111111111111111111111111112';

  /** A DB stuck at migration 004 — i.e. still carrying `kind` in the swaps PK. */
  async function seedAtV4(): Promise<{ path: string; logs: Array<{ level: string; obj: unknown; msg: string }> }> {
    const v4dir = join(dir, 'migrations-v4');
    mkdirSync(v4dir, { recursive: true });
    for (const m of loadMigrations(migrationsDir())) {
      if (m.version <= 4) writeFileSync(join(v4dir, `${String(m.version).padStart(3, '0')}_${m.name}.sql`), m.sql);
    }

    const path = join(dir, 'v4.db');
    const raw = new Database(path);
    migrate(raw, log, v4dir);

    const ins = raw.prepare(
      `INSERT INTO swaps (signature, mint, wallet, kind, tokens_raw, quote_mint, quote_raw,
                          quote_symbol, usd_value, balance_after_raw, slot, block_time, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // THE DOUBLE-COUNT. One transaction, two rows, because the live socket called it a
    // buy and the backfill called it a transfer_in — and `kind` was in the key, so
    // INSERT OR IGNORE ignored nothing.
    ins.run('dupe-sig', MINT4, W4, 'buy', '1000000', SOL4, '1000000000', 'SOL', 100, '1000000', 10, null, 'live');
    ins.run('dupe-sig', MINT4, W4, 'transfer_in', '1000000', null, null, null, 0, '1000000', 10, null, 'backfill');

    // A clean, unrelated buy that must survive untouched.
    ins.run('clean-sig', MINT4, W4, 'buy', '500000', SOL4, '500000000', 'SOL', 50, '1500000', 20, null, 'live');

    // The position as the double-count left it: 2,500,000 tokens for $150, when the
    // wallet only ever acquired 1,500,000 for $150.
    raw
      .prepare(
        `INSERT INTO positions (mint, buyer, tokens_raw, cost_usd, realized_pnl_usd, backfilled,
                                onchain_raw, drift_raw, reconciled, backfilled_at, history_truncated,
                                first_seen, updated_at)
         VALUES (?, ?, '2500000', 150, 0, 0, '1500000', '-1000000', 0, NULL, 0, 1, 1)`,
      )
      .run(MINT4, W4);
    raw.close();

    const logs: Array<{ level: string; obj: unknown; msg: string }> = [];
    return { path, logs };
  }

  it('collapses the duplicate, logs the signature, and recomputes the position', async () => {
    const { path } = await seedAtV4();

    const logs: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
    const capturing = {
      ...log,
      level: 'info',
      info: (obj: Record<string, unknown>, msg: string) => logs.push({ level: 'info', obj, msg }),
      warn: (obj: Record<string, unknown>, msg: string) => logs.push({ level: 'warn', obj, msg }),
      error: (obj: Record<string, unknown>, msg: string) => logs.push({ level: 'error', obj, msg }),
      debug: () => {},
    } as unknown as typeof log;

    const r = new SqliteRepo(path, capturing);
    await r.init(); // applies 005

    // It said so, LOUDLY, and named the signature.
    const shouted = logs.find((l) => l.level === 'error' && l.msg.includes('DOUBLE-COUNTED'));
    expect(shouted).toBeDefined();
    expect(shouted!.obj['signature']).toBe('dupe-sig');
    expect(String(shouted!.obj['kinds'])).toContain('buy');
    expect(String(shouted!.obj['kinds'])).toContain('transfer_in');

    // ONE row for the duplicated signature. The `live` row won.
    const rows = await r.listSwaps(MINT4, W4);
    expect(rows.length).toBe(2); // dupe-sig (collapsed) + clean-sig
    const dupe = rows.filter((s) => s.signature === 'dupe-sig');
    expect(dupe.length).toBe(1);
    expect(dupe[0]!.kind).toBe('buy'); // source='live' wins over the backfill row
    expect(dupe[0]!.source).toBe('live');

    // …and the position is recomputed from the COLLAPSED log: 1,000,000 + 500,000.
    const pos = (await r.getPosition(MINT4, W4))!;
    expect(pos.tokensRaw).toBe(1_500_000n); // was 2,500,000 — the double-count is gone
    expect(pos.costUsd).toBeCloseTo(150, 6);

    // Which now agrees with the chain, so the wallet becomes renderable again.
    expect(pos.onchainRaw).toBe(1_500_000n);
    expect(pos.driftRaw).toBe(0n);
    expect(pos.reconciled).toBe(true);

    await r.close();
  });

  it('the new PK rejects a second row for the same transaction, whatever its kind', async () => {
    const swap = (kind: 'buy' | 'transfer_in', usd: number) => ({
      signature: 'same-tx',
      mint: MINT4,
      wallet: W4,
      kind,
      tokensRaw: 1_000_000n,
      quoteMint: kind === 'buy' ? SOL4 : null,
      quoteSymbol: kind === 'buy' ? 'SOL' : null,
      quoteRaw: kind === 'buy' ? 1_000_000_000n : null,
      usdValue: usd,
      balanceAfterRaw: 1_000_000n,
      slot: 10,
      blockTime: null,
      source: 'live' as const,
    });

    await repo.applySwap(swap('buy', 100), { decimals: 6 });
    const pos = await repo.applySwap(swap('transfer_in', 0), { decimals: 6 });

    expect((await repo.listSwaps(MINT4, W4)).length).toBe(1);
    expect(pos.tokensRaw).toBe(1_000_000n); // NOT 2,000,000
    expect(pos.costUsd).toBeCloseTo(100, 6);
  });
});

// ---------------------------------------------------------------------------
// PHASE 4.7 MIGRATION — a legacy transfer must ABSTAIN, not claim to be a gift
// ---------------------------------------------------------------------------

describe('migration 006: legacy transfers become unpriced', () => {
  const M6 = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump';
  const ARBER6 = 'LegacyArberAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const BUYER6 = 'LegacyBuyerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  /**
   * 4.7 starts RENDERING a reconciled zero basis as "🎁 Free bag — 100% profit".
   *
   * Every transfer row already in the log was classified before the gift/arb
   * distinction existed, so we cannot tell which it was. Leaving those at
   * `unpriced = 0` would take every legacy ARB — a wallet that PAID for its bag — and
   * publish that line about it. The migration that introduces the free-bag line must
   * not simultaneously hand it a pile of wallets it is false about.
   */
  it('abstains on a pre-4.7 transfer instead of calling it a free bag', async () => {
    const v5dir = join(dir, 'migrations-v5');
    mkdirSync(v5dir, { recursive: true });
    for (const m of loadMigrations(migrationsDir())) {
      if (m.version <= 5) writeFileSync(join(v5dir, `${String(m.version).padStart(3, '0')}_${m.name}.sql`), m.sql);
    }

    const path = join(dir, 'v5.db');
    const raw = new Database(path);
    migrate(raw, log, v5dir);

    const ins = raw.prepare(
      `INSERT INTO swaps (signature, mint, wallet, kind, tokens_raw, quote_mint, quote_raw,
                          quote_symbol, usd_value, balance_after_raw, slot, block_time, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Gift or arb? The row cannot tell us — the counter-leg was never recorded.
    ins.run('legacy-transfer', M6, ARBER6, 'transfer_in', '9000000', null, null, null, 0, '9000000', 10, null, 'backfill');
    // A plain buy. A registry quote leg made it a buy, so it was always priceable.
    ins.run('plain-buy', M6, BUYER6, 'buy', '1000000', 'So11111111111111111111111111111111111111112', '1000000000', 'SOL', 100, '1000000', 10, null, 'live');
    raw.close();

    const r = new SqliteRepo(path, log);
    await r.init(); // applies 006 and refolds

    const arber = (await r.getPosition(M6, ARBER6))!;
    expect(arber.basisUnpriced).toBe(true); // we do not know, so we do not say
    expect(arber.reconciled).toBe(false); // -> no Position %, and NO "free bag" line
    expect(arber.driftRaw).toBe(0n); // even though the tokens agree with the chain

    // Buys and sells are untouched: they always had a priceable quote leg.
    const buyer = (await r.getPosition(M6, BUYER6))!;
    expect(buyer.basisUnpriced).toBe(false);
    expect(buyer.reconciled).toBe(true);
    expect(buyer.costUsd).toBeCloseTo(100, 6);

    await r.close();
  });
});
