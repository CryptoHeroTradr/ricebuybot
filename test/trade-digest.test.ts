import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteRepo } from '../src/db/sqlite.ts';
import { createLogger } from '../src/ops/logger.ts';
import { buildDigest, DigestScheduler } from '../src/telegram/trade-digest.ts';
import type { ExecutionRecord } from '../src/trade/scheduler.ts';
import type { Mint } from '../src/core/types.ts';

const log = createLogger('silent' as 'info', false);
const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const A = 111;
const B = 222;
const C = 333;
const SOL = 1_000_000_000n;

// A fixed clock well past any hour boundary, so hourUtc:0 always fires.
const NOW = 1_720_000_000_000;

function exec(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: 1, scheduleId: 1, userId: A, plannedAt: NOW - 1000, state: 'confirmed',
    signature: 'sig', inRaw: null, outRaw: null, priceUsd: null, usdValue: null, error: null,
    ...over,
  };
}

// ===========================================================================================
// buildDigest — pure
// ===========================================================================================
describe('buildDigest', () => {
  it('returns null on a quiet day — no executions, no halts, no changes', () => {
    expect(buildDigest({ executions: [], settingChanges: 0, halted: [], solBalanceLamports: 5n * SOL })).toBeNull();
  });

  it('summarises executions with total spent and average', () => {
    const text = buildDigest({
      executions: [
        exec({ state: 'confirmed', usdValue: 20, priceUsd: 0.001 }),
        exec({ state: 'confirmed', usdValue: 40, priceUsd: 0.003 }),
      ],
      settingChanges: 0,
      halted: [],
      solBalanceLamports: null,
    });
    expect(text).toContain('2 execution(s)');
    expect(text).toContain('2 confirmed');
    expect(text).toContain('Spent $60.00');
    expect(text).toContain('avg $30.00/trade');
    expect(text).toContain('avg fill $0.002');
  });

  it('counts an UNKNOWN toward spend (it may have spent) and flags it', () => {
    const text = buildDigest({
      executions: [exec({ state: 'UNKNOWN', usdValue: 15 })],
      settingChanges: 0, halted: [], solBalanceLamports: null,
    })!;
    expect(text).toContain('⚠️ UNKNOWN');
    expect(text).toContain('Spent $15.00');
  });

  it('lists halted schedules with their reasons and a resume nudge', () => {
    const text = buildDigest({
      executions: [], settingChanges: 0,
      halted: [{ id: 7, haltReason: 'wallet changed' }, { id: 9, haltReason: null }],
      solBalanceLamports: null,
    })!;
    expect(text).toContain('2 schedule(s) HALTED');
    expect(text).toContain('#7 — wallet changed');
    expect(text).toContain('#9');
    expect(text).toContain('▶️ Resume');
  });

  it('shows the wallet balance when known, and omits the line when not', () => {
    const withBal = buildDigest({ executions: [exec({ usdValue: 1 })], settingChanges: 0, halted: [], solBalanceLamports: 2_500_000_000n })!;
    expect(withBal).toContain('Wallet: 2.500 SOL');
    const noBal = buildDigest({ executions: [exec({ usdValue: 1 })], settingChanges: 0, halted: [], solBalanceLamports: null })!;
    expect(noBal).not.toContain('Wallet:');
  });

  it('mentions setting changes and points at /history settings', () => {
    const text = buildDigest({ executions: [], settingChanges: 3, halted: [], solBalanceLamports: null })!;
    expect(text).toContain('3 setting change(s)');
    expect(text).toContain('/history settings');
  });
});

// ===========================================================================================
// DigestScheduler — one DM per member per day, idempotent across restarts
// ===========================================================================================
describe('DigestScheduler', () => {
  let dir: string;
  let repo: SqliteRepo;
  let sent: { userId: number; text: string }[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ricebuybot-digest-'));
    repo = new SqliteRepo(join(dir, 'test.db'), log);
    await repo.init();
    sent = [];
  });
  afterEach(async () => {
    await repo.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function make(over: Partial<Parameters<typeof DigestScheduler.prototype.constructor>[0]> = {}) {
    return new DigestScheduler({
      repo,
      pubkeyOf: () => null,
      getBalance: async () => null,
      send: async (userId, text) => void sent.push({ userId, text }),
      log,
      hourUtc: 0,
      now: () => NOW,
      ...over,
    });
  }

  async function confirmedExecutionFor(userId: number, plannedAt = NOW - 1000): Promise<void> {
    const id = await repo.createSchedule({
      userId, mint: MINT, side: 'buy', amountRaw: SOL / 20n, amountKind: 'absolute',
      intervalMinutes: 15, firstRunAt: plannedAt - 1000,
    });
    const eid = await repo.claimExecution(id, userId, plannedAt);
    await repo.settleExecution(eid!, { state: 'confirmed', signature: 'sig', usdValue: 25, priceUsd: 0.001 });
  }

  it('DMs a member with activity, and skips one with nothing to report', async () => {
    await repo.addAutotraderUser(A, 'alice', 1);
    await repo.addAutotraderUser(C, 'carol', 1); // no activity
    await confirmedExecutionFor(A);

    const n = await make().tick();
    expect(n).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.userId).toBe(A);
    expect(sent[0]!.text).toContain('Spent $25.00');
  });

  it('is idempotent within a day — a second tick sends nothing', async () => {
    await repo.addAutotraderUser(A, 'alice', 1);
    await confirmedExecutionFor(A);

    expect(await make().tick()).toBe(1);
    expect(await make().tick()).toBe(0); // same day, already sent
    expect(sent).toHaveLength(1);
  });

  it('sends again the NEXT day', async () => {
    await repo.addAutotraderUser(A, 'alice', 1);
    await confirmedExecutionFor(A);

    expect(await make().tick()).toBe(1);
    const tomorrow = NOW + 86_400_000;
    await confirmedExecutionFor(A, tomorrow - 500); // fresh activity inside tomorrow's window
    expect(await make({ now: () => tomorrow }).tick()).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it('skips a LOCKED (revoked) member entirely', async () => {
    await repo.addAutotraderUser(A, 'alice', 1);
    await confirmedExecutionFor(A);
    await repo.setAutotraderLocked(A, true);

    expect(await make().tick()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('does not fire before the configured hour', async () => {
    await repo.addAutotraderUser(A, 'alice', 1);
    await confirmedExecutionFor(A);

    // Pick an instant at 00:30 UTC and require hour >= 6.
    const midnightish = Math.floor(NOW / 86_400_000) * 86_400_000 + 30 * 60_000;
    expect(await make({ now: () => midnightish, hourUtc: 6 }).tick()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('includes the wallet balance when a pubkey and RPC are available', async () => {
    await repo.addAutotraderUser(A, 'alice', 1);
    await confirmedExecutionFor(A);

    await make({ pubkeyOf: () => 'PUBKEY', getBalance: async () => 3_000_000_000n }).tick();
    expect(sent[0]!.text).toContain('Wallet: 3.000 SOL');
  });
});
