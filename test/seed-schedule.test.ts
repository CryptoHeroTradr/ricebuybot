import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteRepo } from '../src/db/sqlite.ts';
import { createLogger } from '../src/ops/logger.ts';
import { SeedError, parseArgv, validateSeed, runSeed, assertSchema } from '../scripts/seed-schedule.ts';
import { collectSchedules } from '../scripts/list-schedules.ts';
import { deleteSchedule, DeleteError } from '../scripts/delete-schedule.ts';
import type { Mint } from '../src/core/types.ts';

const log = createLogger('silent' as 'info', false);
const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const MINT2 = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as Mint;
const USER = 4242;

/** Build the args Map validateSeed expects, from a plain object of good defaults + overrides. */
function args(over: Record<string, string | undefined> = {}): Map<string, string> {
  const base: Record<string, string> = {
    user: String(USER),
    mint: MINT,
    side: 'buy',
    amount: '100000000', // 0.1 SOL
    'interval-minutes': '60',
    'per-exec-usd': '25',
    'daily-usd': '100',
  };
  const merged = { ...base, ...over };
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) m.set(k, v);
  return m;
}

let dir: string;
let repo: SqliteRepo;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-seed-'));
  repo = new SqliteRepo(join(dir, 'test.db'), log);
  await repo.init();
  await repo.addAutotraderUser(USER, 'tester', 1);
});

afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================================
// THE GUARDS — the dry-run must not be the thing that discovers a missing one
// ===========================================================================================

describe('seed guards (refuse before the DB is touched)', () => {
  it('accepts a well-formed schedule', () => {
    const p = validateSeed(args());
    expect(p).toMatchObject({ userId: USER, side: 'buy', amountRaw: 100000000n, intervalMinutes: 60, perExecUsd: 25, dailyUsd: 100 });
  });

  it('REFUSES a sub-1-minute interval', () => {
    expect(() => validateSeed(args({ 'interval-minutes': '0' }))).toThrow(/at least 1/);
    // A fractional value is not an integer minute count.
    expect(() => validateSeed(args({ 'interval-minutes': '0.5' }))).toThrow(SeedError);
  });

  it('REFUSES a missing per-exec cap', () => {
    expect(() => validateSeed(args({ 'per-exec-usd': undefined }))).toThrow(/per-exec-usd is required/);
  });

  it('REFUSES a missing daily cap', () => {
    expect(() => validateSeed(args({ 'daily-usd': undefined }))).toThrow(/daily-usd is required/);
  });

  it('REFUSES a non-positive cap', () => {
    expect(() => validateSeed(args({ 'per-exec-usd': '0' }))).toThrow(/greater than zero/);
    expect(() => validateSeed(args({ 'daily-usd': '-5' }))).toThrow(/greater than zero/);
  });

  it('REFUSES a daily cap below the per-exec cap (unreachable)', () => {
    expect(() => validateSeed(args({ 'per-exec-usd': '100', 'daily-usd': '50' }))).toThrow(/could never be reached/);
  });

  it('REFUSES a bad side, a non-positive amount, and a short mint', () => {
    expect(() => validateSeed(args({ side: 'hodl' }))).toThrow(/side must be/);
    expect(() => validateSeed(args({ amount: '0' }))).toThrow(/greater than zero/);
    expect(() => validateSeed(args({ mint: 'too-short' }))).toThrow(/full base58 mint/);
  });

  it('REFUSES a percent_of_balance amount outside basis points', () => {
    expect(() => validateSeed(args({ 'amount-kind': 'percent_of_balance', amount: '20000' }))).toThrow(/basis points/);
    // …but accepts a sane bps value.
    expect(validateSeed(args({ 'amount-kind': 'percent_of_balance', amount: '2500' })).amountRaw).toBe(2500n);
  });

  it('defaults slippage, reserve, and first-run, and honours overrides', () => {
    expect(validateSeed(args())).toMatchObject({ slippageBps: 100, minReserveLamports: 20_000_000n, firstRunInMinutes: 0 });
    expect(validateSeed(args({ 'slippage-bps': '250', 'min-reserve-lamports': '30000000', 'first-run-in': '5' })))
      .toMatchObject({ slippageBps: 250, minReserveLamports: 30_000_000n, firstRunInMinutes: 5 });
  });
});

describe('the argv parser', () => {
  it('handles --key value, --key=value, and bare flags', () => {
    const m = parseArgv(['--user', '7', '--mint=abc', '--yes', '--side', 'buy']);
    expect(m.get('user')).toBe('7');
    expect(m.get('mint')).toBe('abc');
    expect(m.get('yes')).toBe('true');
    expect(m.get('side')).toBe('buy');
  });
});

// ===========================================================================================
// runSeed — caps land BEFORE the schedule; membership is required
// ===========================================================================================

describe('runSeed against the DB', () => {
  it('creates caps AND schedule, with next_run_at computed from now', async () => {
    const now = 1_700_000_000_000;
    const { scheduleId, schedule, caps } = await runSeed(repo, validateSeed(args({ 'first-run-in': '5' })), now);

    expect(scheduleId).toBeGreaterThan(0);
    expect(schedule.state).toBe('active');
    expect(schedule.nextRunAt).toBe(now + 5 * 60_000); // 5 minutes out
    expect(caps.maxPerExecUsd).toBe(25);
    expect(caps.maxPerDayUsd).toBe(100);

    // THE SAFETY PROPERTY: an active schedule always has a caps row. No un-capped tick is possible.
    expect(await repo.getCaps(USER, MINT)).not.toBeNull();
  });

  it('REFUSES a user who is not an autotrader member (no raw FK error)', async () => {
    await expect(runSeed(repo, validateSeed(args({ user: '9999' })), Date.now())).rejects.toThrow(/not an autotrader member/);
  });

  it('REFUSES a locked (revoked) member', async () => {
    await repo.setAutotraderLocked(USER, true);
    await expect(runSeed(repo, validateSeed(args()), Date.now())).rejects.toThrow(/locked/);
  });

  it('REFUSES a DB that is not migrated to Phase 13 rather than creating tables on prod', async () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'ricebuybot-bare-'));
    const bare = new SqliteRepo(join(bareDir, 'bare.db'), log); // constructed, NOT init()'d — no schema
    try {
      expect(() => assertSchema(bare)).toThrow(/not deployed/);
    } finally {
      await bare.close();
      rmSync(bareDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================================
// list + delete — the dry-run is cleanly reversible without SQL
// ===========================================================================================

describe('list and delete round-trip', () => {
  it('lists a seeded schedule with its executions', async () => {
    const { scheduleId } = await runSeed(repo, validateSeed(args()), Date.now());
    // Simulate a couple of ticks having run.
    const e1 = await repo.claimExecution(scheduleId, USER, 1);
    await repo.settleExecution(e1!, { state: 'failed', usdValue: 5, error: 'dry-run' });

    const views = collectSchedules(repo);
    expect(views).toHaveLength(1);
    expect(views[0]!.schedule.id).toBe(scheduleId);
    expect(views[0]!.executions).toHaveLength(1);
    expect(views[0]!.executions[0]!.error).toBe('dry-run');

    // The --user filter scopes correctly.
    expect(collectSchedules(repo, 9999)).toHaveLength(0);
    expect(collectSchedules(repo, USER)).toHaveLength(1);
  });

  it('deletes a schedule, its executions, and its orphaned caps', async () => {
    const { scheduleId } = await runSeed(repo, validateSeed(args()), Date.now());
    const e = await repo.claimExecution(scheduleId, USER, 1);
    await repo.settleExecution(e!, { state: 'failed', error: 'dry-run' });

    const res = await deleteSchedule(repo, scheduleId);
    expect(res.deletedExecutions).toBe(1);
    expect(res.deletedCaps).toBe(1); // last schedule for (user, mint) -> caps go too

    expect(await repo.getSchedule(scheduleId)).toBeNull();
    expect(await repo.getCaps(USER, MINT)).toBeNull();
    expect(repo.raw.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM executions').get()!.n).toBe(0);
  });

  it('KEEPS caps that another schedule on the same (user, mint) still uses', async () => {
    const a = await runSeed(repo, validateSeed(args()), Date.now());
    const b = await runSeed(repo, validateSeed(args()), Date.now()); // second schedule, same user+mint

    const res = await deleteSchedule(repo, a.scheduleId);
    expect(res.deletedCaps).toBe(0); // b still needs the caps
    expect(await repo.getCaps(USER, MINT)).not.toBeNull();

    // Deleting the last one finally removes them.
    const res2 = await deleteSchedule(repo, b.scheduleId);
    expect(res2.deletedCaps).toBe(1);
    expect(await repo.getCaps(USER, MINT)).toBeNull();
  });

  it('does not touch caps for a DIFFERENT mint', async () => {
    await runSeed(repo, validateSeed(args()), Date.now());
    const other = await runSeed(repo, validateSeed(args({ mint: MINT2 })), Date.now());

    await deleteSchedule(repo, other.scheduleId);
    expect(await repo.getCaps(USER, MINT)).not.toBeNull(); // untouched
    expect(await repo.getCaps(USER, MINT2)).toBeNull(); // its own caps went
  });

  it('throws on an unknown id', async () => {
    await expect(deleteSchedule(repo, 999)).rejects.toThrow(DeleteError);
  });
});
