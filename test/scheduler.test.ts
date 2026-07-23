import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteRepo } from '../src/db/sqlite.js';
import {
  Scheduler,
  dryRunExecutor,
  type Executor,
  type ExecutionOutcome,
  type Schedule,
  type SlotOutcome,
  type TradeValuer,
} from '../src/trade/scheduler.js';
import type { Mint } from '../src/core/types.js';
import type { Logger } from '../src/ops/logger.js';

const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const USER = 4242;
const MIN = 60_000;
const SOL = 1_000_000_000n; // lamports per SOL

// A capturing logger: the acceptance criteria about "one gap log line" and "a readable day of
// intended trades" are about LOGS, so we record them rather than route to a silent sink.
interface Line {
  level: string;
  obj: Record<string, unknown>;
  msg: string;
}
function capturingLog(lines: Line[]): Logger {
  const push = (level: string) => (obj: unknown, msg?: string) =>
    lines.push({ level, obj: (obj ?? {}) as Record<string, unknown>, msg: msg ?? '' });
  const log = {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    fatal: push('fatal'),
    trace: push('trace'),
    child: () => log,
  };
  return log as unknown as Logger;
}

/** A clock the test moves by hand. Nothing in these tests touches the wall clock. */
function clock(start: number): { now: () => number; set: (t: number) => void; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, set: (v) => (t = v), advance: (ms) => void (t += ms) };
}

/** A valuer whose price and balance the test dictates. `yield_` forces an await so two ticks
 *  genuinely interleave around the atomic claim. */
function valuer(opts: {
  usd?: number | null;
  balance?: bigint | null;
  yield_?: boolean;
}): TradeValuer {
  return {
    usdValueOf: async () => {
      if (opts.yield_) await Promise.resolve();
      return opts.usd === undefined ? 1 : opts.usd;
    },
    solBalanceLamports: async () => (opts.balance === undefined ? null : opts.balance),
  };
}

let dir: string;
let repo: SqliteRepo;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-sched-'));
  repo = new SqliteRepo(join(dir, 'test.db'), createSilentRepoLog());
  await repo.init();
  // schedules.user_id REFERENCES autotrader_users — the owner must exist (foreign_keys = ON).
  await repo.addAutotraderUser(USER, 'tester', 1);
});

afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

// The repo's own logging is noise here; only the scheduler's logs are under test.
function createSilentRepoLog(): Logger {
  return capturingLog([]);
}

function countExecutions(): number {
  return repo.raw.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM executions').get()?.n ?? 0;
}

async function seed(overrides: Partial<Parameters<SqliteRepo['createSchedule']>[0]> = {}): Promise<number> {
  return repo.createSchedule({
    userId: USER,
    mint: MINT,
    side: 'buy',
    amountRaw: SOL / 10n, // 0.1 SOL
    amountKind: 'absolute',
    intervalMinutes: 5,
    firstRunAt: 1_000_000,
    ...overrides,
  });
}

// ===========================================================================================
// 1. TWO OVERLAPPING TICKS CLAIM THE SAME SLOT — EXACTLY ONE WINS
// ===========================================================================================

describe('the atomic slot claim (INVARIANT 2, reused for real money)', () => {
  it('a second claim of the same slot returns null — the row is the idempotency key', async () => {
    const id = await seed();
    const first = await repo.claimExecution(id, USER, 1_000_000);
    const second = await repo.claimExecution(id, USER, 1_000_000);
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // ON CONFLICT DO NOTHING — same discipline as claimSend
    expect(countExecutions()).toBe(1);
  });

  it('two overlapping ticks fire the slot exactly once', async () => {
    const id = await seed();
    const c = clock(1_000_000);
    // Two independent Scheduler instances over ONE repo — two overlapping timers, or the
    // process-restart overlap. The valuer yields so both get past `dueSchedules` before either
    // claims, forcing the race through the atomic INSERT.
    const mk = (): Scheduler =>
      new Scheduler({ repo, valuer: valuer({ usd: 1, yield_: true }), execute: confirmExecutor(), log: capturingLog([]), now: c.now });
    const a = mk();
    const b = mk();

    const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
    const all = [...ra, ...rb];

    expect(all.filter((o) => o.kind === 'fired')).toHaveLength(1);
    expect(all.filter((o) => o.kind === 'claim-lost')).toHaveLength(1);
    expect(countExecutions()).toBe(1); // exactly one row landed
    const sched = await repo.getSchedule(id);
    expect(sched?.nextRunAt).toBe(1_000_000 + 5 * MIN); // advanced from planned, once
  });
});

// ===========================================================================================
// 2. MISSED SLOTS DO NOT BACKFILL
// ===========================================================================================

describe('missed slots do not backfill (the most dangerous behaviour on the surface)', () => {
  it('a 3-hour downtime on a 5-minute schedule fires ZERO catch-up trades and logs one gap', async () => {
    const id = await seed({ firstRunAt: 1_000_000, intervalMinutes: 5 });
    const lines: Line[] = [];
    // The bot was down 3 hours; next_run_at is 180 minutes in the past.
    const c = clock(1_000_000 + 180 * MIN);
    const s = new Scheduler({ repo, valuer: valuer({ usd: 1 }), execute: confirmExecutor(), log: capturingLog(lines), now: c.now });

    const outcomes = await s.tick();

    // ZERO catch-up executions — not 36, not 1.
    expect(countExecutions()).toBe(0);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.kind).toBe('gap-skipped');

    // Exactly one gap log line.
    const gapLines = lines.filter((l) => /MISSED SLOTS/.test(l.msg));
    expect(gapLines).toHaveLength(1);

    // And it jumped to a FUTURE slot, aligned to the original cadence (no drift).
    const sched = await repo.getSchedule(id);
    expect(sched!.nextRunAt).toBeGreaterThan(c.now());
    expect((sched!.nextRunAt - 1_000_000) % (5 * MIN)).toBe(0);
    expect(sched!.state).toBe('active'); // a gap is not a halt; it resumes
  });

  it('a slot due within its own window still fires — a gap is only a MISSED window', async () => {
    await seed({ firstRunAt: 1_000_000, intervalMinutes: 5 });
    const c = clock(1_000_000 + 30_000); // 30s late, still inside the 5-minute window
    const s = new Scheduler({ repo, valuer: valuer({ usd: 1 }), execute: confirmExecutor(), log: capturingLog([]), now: c.now });

    const outcomes = await s.tick();
    expect(outcomes[0]!.kind).toBe('fired');
    expect(countExecutions()).toBe(1);
  });
});

// ===========================================================================================
// 3. next_run_at ADVANCES FROM PLANNED, NOT ACTUAL — NO DRIFT
// ===========================================================================================

describe('the schedule does not drift', () => {
  it('100 slow ticks advance next_run_at from the planned time, not from now', async () => {
    const interval = 5;
    const id = await seed({ firstRunAt: 1_000_000, intervalMinutes: interval });
    // No caps row -> cap checks are skipped, so every in-window slot simply fires.
    const c = clock(1_000_000);
    const firedAt: number[] = [];
    const exec: Executor = async (plan) => {
      firedAt.push(plan.plannedAt);
      return { state: 'confirmed', usdValue: 1 };
    };
    const s = new Scheduler({ repo, valuer: valuer({ usd: 1 }), execute: exec, log: capturingLog([]), now: c.now });

    for (let i = 0; i < 100; i++) {
      // Each tick lands LATE inside its window — a few seconds of compounding latency that a
      // now-based schedule would accumulate into drift.
      c.set(1_000_000 + i * interval * MIN + (3_000 + (i % 7) * 1_000));
      await s.tick();
    }

    // Every fire happened at its exact planned time, and the pointer is exactly 100 intervals
    // on from the start — zero drift after 100 late ticks.
    expect(firedAt).toHaveLength(100);
    for (let i = 0; i < 100; i++) expect(firedAt[i]).toBe(1_000_000 + i * interval * MIN);
    const sched = await repo.getSchedule(id);
    expect(sched!.nextRunAt).toBe(1_000_000 + 100 * interval * MIN);
  });
});

// ===========================================================================================
// 4. CAP BREACH HALTS WITH A REASON AND DOES NOT CLAIM
// ===========================================================================================

describe('cap breaches halt, and never claim', () => {
  it('a per-execution cap breach halts with a reason and writes no execution', async () => {
    const id = await seed();
    await repo.setCaps({ userId: USER, mint: MINT, maxPerExecUsd: 10, maxPerDayUsd: 10_000 });
    const c = clock(1_000_000);
    const s = new Scheduler({ repo, valuer: valuer({ usd: 100 }), execute: confirmExecutor(), log: capturingLog([]), now: c.now });

    const outcomes = await s.tick();

    expect(outcomes[0]!.kind).toBe('cap-halted');
    expect(countExecutions()).toBe(0); // cap check is BEFORE the claim
    const sched = await repo.getSchedule(id);
    expect(sched!.state).toBe('halted');
    expect(sched!.haltReason).toMatch(/per-exec cap/);
  });

  it('a rolling-24h cap breach halts — and it counts THIS user only', async () => {
    const id = await seed();
    await repo.setCaps({ userId: USER, mint: MINT, maxPerExecUsd: 1_000, maxPerDayUsd: 50 });
    // $45 already spent today by this user on this mint.
    const priorId = await repo.claimExecution(id, USER, 900_000);
    await repo.settleExecution(priorId!, { state: 'confirmed', usdValue: 45 });
    // Another USER's spend must NOT count against this user's headroom.
    await repo.addAutotraderUser(9999, 'other', 1);
    const otherSched = await repo.createSchedule({
      userId: 9999, mint: MINT, side: 'buy', amountRaw: SOL, amountKind: 'absolute', intervalMinutes: 5, firstRunAt: 900_000,
    });
    const otherExec = await repo.claimExecution(otherSched, 9999, 900_000);
    await repo.settleExecution(otherExec!, { state: 'confirmed', usdValue: 10_000 });

    const c = clock(1_000_000);
    const s = new Scheduler({ repo, valuer: valuer({ usd: 10 }), execute: confirmExecutor(), log: capturingLog([]), now: c.now });
    const outcomes = await s.tick();

    // 45 + 10 = 55 > 50 -> halt. The other user's 10_000 is invisible to this check.
    const halted = outcomes.find((o) => o.plannedAt === 1_000_000);
    expect(halted!.kind).toBe('cap-halted');
    const sched = await repo.getSchedule(id);
    expect(sched!.state).toBe('halted');
    expect(sched!.haltReason).toMatch(/24h cap/);
  });

  it('an UNKNOWN prior execution counts against the 24h cap (it MAY have spent)', async () => {
    const id = await seed();
    await repo.setCaps({ userId: USER, mint: MINT, maxPerExecUsd: 1_000, maxPerDayUsd: 50 });
    const priorId = await repo.claimExecution(id, USER, 900_000);
    await repo.settleExecution(priorId!, { state: 'UNKNOWN', usdValue: 45 }); // outcome uncertain
    const c = clock(1_000_000);
    const s = new Scheduler({ repo, valuer: valuer({ usd: 10 }), execute: confirmExecutor(), log: capturingLog([]), now: c.now });

    const outcomes = await s.tick();
    expect(outcomes.find((o) => o.plannedAt === 1_000_000)!.kind).toBe('cap-halted');
  });
});

// ===========================================================================================
// 5. A BUY THAT WOULD BREACH THE SOL RESERVE IS SKIPPED, NOT EXECUTED
// ===========================================================================================

describe('the SOL reserve is never spent', () => {
  it('a buy that would drop SOL below the reserve is skipped, not executed, and stays active', async () => {
    const id = await seed({ side: 'buy', amountRaw: SOL, amountKind: 'absolute' }); // spend 1 SOL
    // Reserve 0.02 SOL, balance 1.01 SOL -> 1.01 - 1.00 = 0.01 SOL left < 0.02 reserve.
    await repo.setCaps({ userId: USER, mint: MINT, maxPerExecUsd: 1e9, maxPerDayUsd: 1e9, minSolReserveLamports: SOL / 50n });
    const c = clock(1_000_000);
    const s = new Scheduler({ repo, valuer: valuer({ usd: 1, balance: SOL + SOL / 100n }), execute: confirmExecutor(), log: capturingLog([]), now: c.now });

    const outcomes = await s.tick();

    expect(outcomes[0]!.kind).toBe('reserve-skipped');
    expect(countExecutions()).toBe(0); // skipped BEFORE the claim
    const sched = await repo.getSchedule(id);
    expect(sched!.state).toBe('active'); // transient: retries next slot, does not halt
    expect(sched!.nextRunAt).toBe(1_000_000 + 5 * MIN); // advanced so it doesn't spin
  });

  it('the same buy fires when the balance leaves the reserve intact', async () => {
    await seed({ side: 'buy', amountRaw: SOL, amountKind: 'absolute' });
    await repo.setCaps({ userId: USER, mint: MINT, maxPerExecUsd: 1e9, maxPerDayUsd: 1e9, minSolReserveLamports: SOL / 50n });
    const c = clock(1_000_000);
    // Balance 1.5 SOL -> 0.5 SOL left, well above the 0.02 reserve.
    const s = new Scheduler({ repo, valuer: valuer({ usd: 1, balance: SOL + SOL / 2n }), execute: confirmExecutor(), log: capturingLog([]), now: c.now });

    const outcomes = await s.tick();
    expect(outcomes[0]!.kind).toBe('fired');
    expect(countExecutions()).toBe(1);
  });
});

// ===========================================================================================
// 6. DRY_RUN PRODUCES A READABLE DAY OF INTENDED TRADES AND TOUCHES NOTHING
// ===========================================================================================

describe('the dry-run day', () => {
  it('marks every claimed slot failed/dry-run, logs each intended trade, and spends nothing', async () => {
    const id = await seed({ firstRunAt: 1_000_000, intervalMinutes: 60 }); // hourly
    await repo.setCaps({ userId: USER, mint: MINT, maxPerExecUsd: 1e9, maxPerDayUsd: 1e9 });
    const lines: Line[] = [];
    const c = clock(1_000_000);
    // The REAL Phase 13 executor. Note there is no chain client injected anywhere — "touches
    // nothing" is structural, not merely asserted.
    // Balance well above the reserve, so the buy-side reserve check passes and each slot fires.
    const s = new Scheduler({ repo, valuer: valuer({ usd: 7.5, balance: 100n * SOL }), execute: dryRunExecutor(capturingLog(lines)), log: capturingLog(lines), now: c.now });

    // A full day: 24 hourly slots.
    for (let i = 0; i < 24; i++) {
      c.set(1_000_000 + i * 60 * MIN + 4_000);
      await s.tick();
    }

    // 24 executions, every one a dry-run tombstone — nothing submitted, nothing confirmed.
    const rows = repo.raw
      .prepare<[], { state: string; error: string | null; usd_value: number | null; signature: string | null }>(
        'SELECT state, error, usd_value, signature FROM executions ORDER BY planned_at',
      )
      .all();
    expect(rows).toHaveLength(24);
    for (const r of rows) {
      expect(r.state).toBe('failed');
      expect(r.error).toBe('dry-run');
      expect(r.signature).toBeNull(); // nothing was ever submitted on-chain
      expect(r.usd_value).toBe(7.5); // the intended value is still recorded, for the reader
    }

    // The day is READABLE: one "intended trade" log line per slot, carrying side/amount/value.
    const intended = lines.filter((l) => /DRY-RUN intended trade/.test(l.msg));
    expect(intended).toHaveLength(24);
    expect(intended[0]!.obj).toMatchObject({ side: 'buy', usdValue: 7.5, mint: MINT });

    const sched = await repo.getSchedule(id);
    expect(sched!.nextRunAt).toBe(1_000_000 + 24 * 60 * MIN); // no drift across the day
  });
});

// ===========================================================================================
// SCHEDULES SURVIVE RESTART — the boot log proves it
// ===========================================================================================

describe('schedules survive restart', () => {
  it('logActiveOnBoot lists every active schedule and its next_run_at', async () => {
    await seed({ firstRunAt: 5_000_000 });
    await seed({ firstRunAt: 6_000_000, side: 'sell', amountRaw: 1000n });
    // A halted schedule is NOT active and must not appear.
    const halted = await seed({ firstRunAt: 7_000_000 });
    await repo.haltSchedule(halted, 'test', 1_000_000);

    const lines: Line[] = [];
    const s = new Scheduler({ repo, valuer: valuer({}), execute: dryRunExecutor(capturingLog([])), log: capturingLog(lines), now: () => 1_000_000 });
    await s.logActiveOnBoot();

    const perSchedule = lines.filter((l) => l.msg === 'autotrader scheduler: schedule active');
    expect(perSchedule).toHaveLength(2);
    expect(perSchedule.map((l) => l.obj.nextRunAt).sort()).toEqual([5_000_000, 6_000_000]);
    const summary = lines.find((l) => /active schedules restored/.test(l.msg));
    expect(summary!.obj.count).toBe(2);
  });
});

/** An executor that reports a confirmed on-chain fill — used to drive the scheduling machinery
 *  in tests that are about scheduling, not about the Phase 13 dry-run marking. */
function confirmExecutor(): Executor {
  return async (plan): Promise<ExecutionOutcome> => ({ state: 'confirmed', usdValue: plan.usdValue });
}

// Keep the imported Schedule/SlotOutcome types referenced for readers of this file.
export type _Schedule = Schedule;
export type _SlotOutcome = SlotOutcome;
