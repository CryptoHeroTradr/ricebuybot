import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteRepo } from '../src/db/sqlite.ts';
import { createLogger } from '../src/ops/logger.ts';
import {
  Executor,
  SOL_MINT,
  signatureOf,
  type ExecutorConfig,
  type JupiterQuote,
  type SignatureStatus,
} from '../src/trade/executor.ts';
import type { PlannedTrade, Schedule, Side, AmountKind } from '../src/trade/scheduler.ts';
import type { Mint } from '../src/core/types.ts';

const log = createLogger('silent' as 'info', false);
const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const USER = 4242;
const PUBKEY = 'BuYeRwaLLetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SOL = 1_000_000_000n;

/** A byte-valid signed transaction: sigCount=1, 64 sig bytes, a v0 message with one account key.
 *  signatureOf() must be able to frame it. */
function fakeSignedTx(sigFill = 7): string {
  return Buffer.concat([
    Buffer.from([0x01]),
    Buffer.alloc(64, sigFill),
    Buffer.from([0x80, 0, 0, 0]),
    Buffer.from([0x01]),
    Buffer.alloc(32, 9),
  ]).toString('base64');
}
const SIGNED = fakeSignedTx();
const SIG = signatureOf(SIGNED);

// Fast config so the clock-driven confirm/resolve loops run in microseconds.
const CFG: Partial<ExecutorConfig> = {
  maxPerDayUsdCeiling: 1e9, // existing tests set their own caps; do not clamp them
  maxPriceImpactPct: 0.03,
  confirmTimeoutMs: 50,
  confirmPollMs: 10,
  resolveTimeoutMs: 120,
  resolvePollMs: 10,
  droppedAfterMs: 60,
};

let dir: string;
let repo: SqliteRepo;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-exec-'));
  repo = new SqliteRepo(join(dir, 'test.db'), log);
  await repo.init();
  await repo.addAutotraderUser(USER, 'tester', 1);
});
afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seedSchedule(over: Partial<{ side: Side; amountKind: AmountKind; amountRaw: bigint; slippageBps: number }> = {}): Promise<Schedule> {
  const id = await repo.createSchedule({
    userId: USER,
    mint: MINT,
    side: over.side ?? 'buy',
    amountRaw: over.amountRaw ?? SOL / 10n, // 0.1 SOL
    amountKind: over.amountKind ?? 'absolute',
    intervalMinutes: 60,
    slippageBps: over.slippageBps ?? 100,
    firstRunAt: 1_000_000,
  });
  await repo.setCaps({ userId: USER, mint: MINT, maxPerExecUsd: 1000, maxPerDayUsd: 10_000 });
  return (await repo.getSchedule(id))!;
}

async function claimedPlan(schedule: Schedule, usdValue = 15): Promise<PlannedTrade> {
  const executionId = (await repo.claimExecution(schedule.id, USER, schedule.nextRunAt))!;
  return { schedule, plannedAt: schedule.nextRunAt, usdValue, executionId };
}

interface Recorder {
  send: number;
  signAllowed: (readonly string[])[];
  quotes: { inputMint: string; outputMint: string; amount: bigint }[];
  balanceReads: { owner: string; mint: string }[];
  dms: { userId: number; text: string }[];
}

interface Overrides {
  sign?: (u: number, a: readonly string[], t: string) => Promise<string>;
  simulate?: () => Promise<{ err: unknown }>;
  send?: () => Promise<string>;
  signatureStatus?: () => Promise<SignatureStatus | null>;
  quote?: (p: { inputMint: string; outputMint: string; amount: bigint }) => Promise<JupiterQuote>;
  mintBalance?: (owner: string, mint: string) => Promise<bigint>;
  solBalance?: (owner: string) => Promise<bigint | null>;
  getTransaction?: () => Promise<unknown>;
  parseSwap?: unknown;
  solUsd?: number | null;
  ownerUserId?: number;
  tradingHealth?: () => { ok: true } | { ok: false; reason: string };
}

function mkExecutor(over: Overrides = {}): { executor: Executor; rec: Recorder; clock: { t: number } } {
  const clock = { t: 1_000_000 };
  const rec: Recorder = { send: 0, signAllowed: [], quotes: [], balanceReads: [], dms: [] };

  const executor = new Executor({
    repo,
    jupiter: {
      quote: async (p) => {
        rec.quotes.push({ inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount });
        return over.quote
          ? over.quote(p)
          : { inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount, outAmount: 12345n, priceImpactPct: 0.001, raw: {} };
      },
      buildSwap: async () => ({ swapTransaction: 'UNSIGNED' }),
    },
    signer: {
      sign: async (u, a, t) => {
        rec.signAllowed.push(a);
        return over.sign ? over.sign(u, a, t) : SIGNED;
      },
    },
    chain: {
      simulate: over.simulate ?? (async () => ({ err: null })),
      send: async () => {
        rec.send++;
        return over.send ? over.send() : SIG;
      },
      signatureStatus: over.signatureStatus ?? (async () => null),
      getTransaction: (over.getTransaction ?? (async () => ({}))) as never,
    },
    balances: {
      solBalance: async (owner) => (over.solBalance ? over.solBalance(owner) : 100n * SOL),
      mintBalance: async (owner, mint) => {
        rec.balanceReads.push({ owner, mint });
        return over.mintBalance ? over.mintBalance(owner, mint) : 0n;
      },
    },
    wallets: { pubkeyOf: () => PUBKEY },
    dm: { send: async (userId, text) => void rec.dms.push({ userId, text }) },
    log,
    solUsd: () => (over.solUsd === undefined ? 150 : over.solUsd),
    tradingHealth: over.tradingHealth,
    decimalsOf: async () => 6,
    ownerUserId: over.ownerUserId,
    config: CFG,
    now: () => clock.t,
    sleep: async (ms) => void (clock.t += ms),
    parseSwap: over.parseSwap as never,
  });
  return { executor, rec, clock };
}

const stateOf = (id: number) => repo.raw.prepare<[number], { state: string }>('SELECT state FROM executions WHERE id = ?').get(id)?.state;
const schedState = async (id: number) => (await repo.getSchedule(id))!.state;

// ===========================================================================================
// THE UNKNOWN PATH
// ===========================================================================================

describe('the UNKNOWN path', () => {
  it('a confirm timeout -> UNKNOWN, schedule halted, owner DMed, and NO second submit', async () => {
    // 'processed' forever: never confirms, never errors, never dropped -> stays ambiguous.
    const { executor, rec } = mkExecutor({ signatureStatus: async () => ({ confirmationStatus: 'processed', err: null, slot: 1 }) });
    const schedule = await seedSchedule();
    const plan = await claimedPlan(schedule);

    const outcome = await executor.execute(plan);
    await repo.settleExecution(plan.executionId, outcome); // the scheduler settles what execute returns
    await executor.lastPassiveResolution; // let the 15-min poller run to its (ambiguous) end

    expect(outcome.state).toBe('UNKNOWN');
    expect(outcome.signature).toBe(SIG);
    expect(rec.send).toBe(1); // submitted exactly once — never retried
    expect(await schedState(schedule.id)).toBe('halted');
    expect(stateOf(plan.executionId)).toBe('UNKNOWN'); // still ambiguous -> stays halted
    // The owner (the schedule's user) was told, with the signature.
    const dm = rec.dms.find((d) => d.userId === USER && d.text.includes(SIG));
    expect(dm).toBeTruthy();
    expect(dm!.text).toMatch(/solscan\.io\/tx\//);
  });

  it('passive resolution: a signature that confirms during the 15-minute poll flips to confirmed and unhalts', async () => {
    let n = 0;
    // Ambiguous through the confirm window; confirms later, during passive resolution.
    const status = async (): Promise<SignatureStatus> => {
      n++;
      return n >= 8 ? { confirmationStatus: 'finalized', err: null, slot: 5 } : { confirmationStatus: 'processed', err: null, slot: 1 };
    };
    const { executor } = mkExecutor({ signatureStatus: status, parseSwap: () => ({ event: { kind: 'buy', quoteRaw: 100n, tokensRaw: 200n } }) });
    const schedule = await seedSchedule();
    const plan = await claimedPlan(schedule);

    const outcome = await executor.execute(plan);
    await repo.settleExecution(plan.executionId, outcome);
    expect(outcome.state).toBe('UNKNOWN');
    expect(await schedState(schedule.id)).toBe('halted');

    await executor.lastPassiveResolution; // it confirms mid-poll

    expect(stateOf(plan.executionId)).toBe('confirmed');
    expect(await schedState(schedule.id)).toBe('active'); // unhalted
  });

  it('ambiguous after 15 minutes STAYS halted; /resolve is the only exit', async () => {
    const { executor } = mkExecutor({ signatureStatus: async () => ({ confirmationStatus: 'processed', err: null, slot: 1 }) });
    const schedule = await seedSchedule();
    const plan = await claimedPlan(schedule);
    await repo.settleExecution(plan.executionId, await executor.execute(plan));
    await executor.lastPassiveResolution;

    // Still halted, still UNKNOWN — never auto-resumed from ambiguity.
    expect(await schedState(schedule.id)).toBe('halted');
    expect(stateOf(plan.executionId)).toBe('UNKNOWN');

    // The human decides.
    const r = await executor.resolve(plan.executionId, 'confirmed');
    expect(r.ok).toBe(true);
    expect(stateOf(plan.executionId)).toBe('confirmed');
    expect(await schedState(schedule.id)).toBe('active');

    // /resolve is idempotent-safe: re-resolving a now-confirmed execution is refused.
    expect((await executor.resolve(plan.executionId, 'failed')).ok).toBe(false);
  });

  it('a dropped signature (absent from status AND getTransaction) resolves to failed and unhalts', async () => {
    // Absence PROVEN: null status AND getTransaction returns null -> genuinely never landed.
    const { executor } = mkExecutor({ signatureStatus: async () => null, getTransaction: async () => null });
    const schedule = await seedSchedule();
    const plan = await claimedPlan(schedule);
    await repo.settleExecution(plan.executionId, await executor.execute(plan));
    await executor.lastPassiveResolution;

    expect(stateOf(plan.executionId)).toBe('failed');
    expect(await schedState(schedule.id)).toBe('active');
  });

  it('CACHE MISS is not a drop: absent from the status cache but present via getTransaction -> CONFIRMED', async () => {
    // The status result is null forever (aged out of the bounded cache), but the transaction IS on
    // chain. Absence must be proven; getTransaction proves presence, so this must NEVER be dropped.
    const { executor } = mkExecutor({
      signatureStatus: async () => null,
      getTransaction: async () => ({}), // present on-chain
      parseSwap: () => ({ event: { kind: 'buy', quoteRaw: 10n, tokensRaw: 20n } }),
    });
    const schedule = await seedSchedule();
    const plan = await claimedPlan(schedule);
    await repo.settleExecution(plan.executionId, await executor.execute(plan));
    await executor.lastPassiveResolution;

    expect(stateOf(plan.executionId)).toBe('confirmed'); // NOT 'failed'
    expect(await schedState(schedule.id)).toBe('active'); // unhalted
  });
});

// ===========================================================================================
// GUARDS BEFORE MONEY MOVES
// ===========================================================================================

describe('guards that fire before anything is sent', () => {
  it('a quote with 5% price impact is rejected BEFORE signing', async () => {
    const { executor, rec } = mkExecutor({
      quote: async (p) => ({ inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount, outAmount: 1n, priceImpactPct: 0.05, raw: {} }),
    });
    const schedule = await seedSchedule();
    const plan = await claimedPlan(schedule);

    const outcome = await executor.execute(plan);
    expect(outcome.state).toBe('failed');
    expect(outcome.error).toMatch(/price impact 5\.00% exceeds max 3\.00%/);
    expect(rec.signAllowed).toHaveLength(0); // never signed
    expect(rec.send).toBe(0); // never sent
    expect(stateOf(plan.executionId)).toBe('claimed'); // no 'submitted' write
  });

  it('a simulation failure never reaches submit', async () => {
    const { executor, rec } = mkExecutor({ simulate: async () => ({ err: { InstructionError: [0, 'Custom'] } }) });
    const schedule = await seedSchedule();
    const plan = await claimedPlan(schedule);

    const outcome = await executor.execute(plan);
    expect(outcome.state).toBe('failed');
    expect(outcome.error).toMatch(/simulation failed/);
    expect(rec.send).toBe(0);
    expect(stateOf(plan.executionId)).toBe('claimed'); // never marked submitted
  });

  it('NO branch reaches send() without a successful sign(): a throwing signer -> zero sends, always', async () => {
    // The structural property that makes the mint guard unbypassable: send is downstream of sign on
    // every path. A signer that throws must yield zero sends and no 'submitted' write, whatever the
    // trade shape — buy, absolute sell, percent sell.
    const shapes: { label: string; side: Side; amountKind: AmountKind; amountRaw: bigint; balance?: bigint }[] = [
      { label: 'buy/absolute', side: 'buy', amountKind: 'absolute', amountRaw: SOL / 10n },
      { label: 'sell/absolute', side: 'sell', amountKind: 'absolute', amountRaw: 1000n },
      { label: 'sell/percent', side: 'sell', amountKind: 'percent_of_balance', amountRaw: 1000n, balance: 500n },
    ];
    for (const s of shapes) {
      const { executor, rec } = mkExecutor({
        sign: async () => {
          throw new Error(`guard rejected (${s.label})`);
        },
        mintBalance: async () => s.balance ?? 0n,
      });
      const schedule = await seedSchedule({ side: s.side, amountKind: s.amountKind, amountRaw: s.amountRaw });
      const plan = await claimedPlan(schedule);

      const outcome = await executor.execute(plan);
      expect(outcome.state, s.label).toBe('failed');
      expect(rec.send, `${s.label}: send must be zero`).toBe(0);
      expect(stateOf(plan.executionId), `${s.label}: no submitted write`).toBe('claimed');
    }
  });

  it('every transaction goes through the signer mint guard; a rejected mint stops BEFORE submit', async () => {
    const { executor, rec } = mkExecutor({
      // The signer's guard rejects a tx touching a non-configured mint. Modelled as sign() throwing.
      sign: async () => {
        throw new Error('foreign-mint: transaction touches a mint outside the allowlist');
      },
    });
    const schedule = await seedSchedule();
    const plan = await claimedPlan(schedule);

    const outcome = await executor.execute(plan);
    expect(outcome.state).toBe('failed');
    expect(outcome.error).toMatch(/signer\/guard rejected/);
    // It DID go through the signer, scoped to exactly the configured mint...
    expect(rec.signAllowed).toEqual([[MINT]]);
    // ...and the rejection stopped it before any send or 'submitted' write.
    expect(rec.send).toBe(0);
    expect(stateOf(plan.executionId)).toBe('claimed');
  });
});

// ===========================================================================================
// CONFIRMED AMOUNTS COME FROM THE CHAIN, NOT THE QUOTE
// ===========================================================================================

describe('confirmed amounts come from normalizeSwap on the real transaction', () => {
  it('records in_raw/out_raw from the parsed event, not the quote estimate', async () => {
    // Quote says inAmount 1e8 / outAmount 12345; the CHAIN says quoteRaw 99 / tokensRaw 88.
    const { executor } = mkExecutor({
      signatureStatus: async () => ({ confirmationStatus: 'confirmed', err: null, slot: 9 }),
      parseSwap: () => ({ event: { kind: 'buy', quoteRaw: 99n, tokensRaw: 88n } }),
    });
    const schedule = await seedSchedule();
    const plan = await claimedPlan(schedule);

    const outcome = await executor.execute(plan);
    expect(outcome.state).toBe('confirmed');
    expect(outcome.inRaw).toBe(99n); // SOL spent, from the chain
    expect(outcome.outRaw).toBe(88n); // tokens received, from the chain
    expect(outcome.inRaw).not.toBe(100_000_000n); // NOT the quote's inAmount
    expect(outcome.priceUsd).toBeCloseTo((99 / 1e9) * 150 / (88 / 1e6), 6);
  });
});

// ===========================================================================================
// SELL: percent_of_balance recomputes at execution, scoped to the configured mint, re-checks caps
// ===========================================================================================

describe('percent_of_balance sell', () => {
  it('reads ONLY the configured mint balance, recomputes the amount, and re-checks caps', async () => {
    // Wallet holds 500 of the configured mint (plus, in reality, four other tokens and two NFTs the
    // scoped read never touches). 10% -> sell 50. Recomputed USD then breaches the per-exec cap.
    await repo.setCaps({ userId: USER, mint: MINT, maxPerExecUsd: 50, maxPerDayUsd: 10_000 });
    const schedule = await seedSchedule({ side: 'sell', amountKind: 'percent_of_balance', amountRaw: 1000n }); // 1000 bps = 10%
    // seedSchedule reset caps to $1000; put the tight cap back.
    await repo.setCaps({ userId: USER, mint: MINT, maxPerExecUsd: 50, maxPerDayUsd: 10_000 });
    const plan = await claimedPlan(schedule, 5);

    const { executor, rec } = mkExecutor({
      mintBalance: async () => 500n,
      // 0.7 SOL out -> $105 at $150/SOL -> breaches the $50 per-exec cap.
      quote: async (p) => ({ inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount, outAmount: 700_000_000n, priceImpactPct: 0.001, raw: {} }),
    });

    const outcome = await executor.execute(plan);

    // Balance read was scoped to EXACTLY the configured mint — no heuristic, no other asset.
    expect(rec.balanceReads).toEqual([{ owner: PUBKEY, mint: MINT }]);
    // The amount quoted is 10% of the live balance, selling the configured mint for SOL.
    expect(rec.quotes[0]).toEqual({ inputMint: MINT, outputMint: SOL_MINT, amount: 50n });
    // Recomputed value re-checked against caps -> breach -> halt, no send.
    expect(outcome.state).toBe('failed');
    expect(outcome.error).toMatch(/per-exec cap/);
    expect(rec.send).toBe(0);
    expect(await schedState(schedule.id)).toBe('halted');
  });
});

// ===========================================================================================
// RATE / SANITY: three consecutive failures halt EVERYTHING
// ===========================================================================================

describe('the kill switch', () => {
  it('three consecutive non-confirmed executions halt every active schedule and DM the owner', async () => {
    const a = await seedSchedule();
    const bId = await repo.createSchedule({ userId: USER, mint: MINT, side: 'buy', amountRaw: SOL / 10n, amountKind: 'absolute', intervalMinutes: 60, firstRunAt: 2_000_000 });
    const OWNER = 777;
    const { executor, rec } = mkExecutor({ simulate: async () => ({ err: 'boom' }), ownerUserId: OWNER });

    for (let i = 0; i < 3; i++) {
      // A fresh claimed slot each iteration (distinct planned_at so each claim succeeds).
      const plannedAt = a.nextRunAt + i;
      const executionId = (await repo.claimExecution(a.id, USER, plannedAt))!;
      await executor.execute({ schedule: a, plannedAt, usdValue: 15, executionId });
    }

    // Every active schedule is halted, and the owner was paged.
    expect(await schedState(a.id)).toBe('halted');
    expect(await schedState(bId)).toBe('halted');
    expect(rec.dms.some((d) => d.userId === OWNER && /KILL SWITCH/.test(d.text))).toBe(true);
  });
});

// ===========================================================================================
// PHASE 16 — HARD LIMITS, enforced at execution against whatever the DB holds
// ===========================================================================================

describe('hard limits are enforced where money moves, not just at input', () => {
  it('the slippage passed to Jupiter never exceeds 1000 bps', async () => {
    let seenBps = -1;
    const schedule = await seedSchedule({ slippageBps: 5000 });
    const plan = await claimedPlan(schedule);
    const { executor } = mkExecutor({
      quote: async (p) => {
        seenBps = (p as { slippageBps?: number }).slippageBps ?? -1;
        return { inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount, outAmount: 1n, priceImpactPct: 0.001, raw: {} };
      },
    });
    await executor.execute(plan);
    expect(seenBps).toBe(1000); // clamped from 5000
  });

  it('a sub-1-minute interval is refused at execution (the DB CHECK is the other half)', async () => {
    // The migration's CHECK (interval_minutes > 0) blocks a bad WRITE — the two halves are
    // equivalent for integers. This asserts the executor's own guard on a corrupted-DB schedule
    // object, so the guard survives even if the constraint were ever dropped.
    const schedule = await seedSchedule();
    const plan = await claimedPlan({ ...schedule, intervalMinutes: 0 });
    const { executor, rec } = mkExecutor();
    const outcome = await executor.execute(plan);
    expect(outcome.state).toBe('failed');
    expect(outcome.error).toMatch(/hard minimum/);
    expect(rec.send).toBe(0);
  });

  it('the daily cap CANNOT be raised above the env ceiling — a bad DB write is clamped at execution', async () => {
    // DB says $10,000/day; the env ceiling is $200. A $250 buy must be refused by the ceiling,
    // not by the DB value.
    const schedule = await seedSchedule();
    await repo.setCaps({ userId: USER, mint: MINT, maxPerExecUsd: 1e9, maxPerDayUsd: 10_000 });
    const plan = await claimedPlan(schedule, 250); // $250 buy
    const { executor, rec } = mkExecutor({ solUsd: 150 });
    // Ceiling below the DB cap.
    (executor as unknown as { }); // executor uses CFG; override the ceiling for this test:
    const { executor: capped, rec: rec2 } = mkExecutorWithCeiling(200);
    const outcome = await capped.execute(plan);
    expect(outcome.state).toBe('failed');
    expect(outcome.error).toMatch(/24h cap/);
    expect(rec2.send).toBe(0);
    expect(await schedState(schedule.id)).toBe('halted');
    void rec; void executor;
  });

  it('the lifetime cap CANNOT be raised above the env ceiling — a bad DB write is clamped at execution', async () => {
    // DB says $1,000,000,000 lifetime; the env ceiling is $200. Prior spend is $150; a $100 buy
    // must be refused by the clamped $200 ceiling, not honoured against the DB value.
    const prior = await seedSchedule();
    const eid = await repo.claimExecution(prior.id, USER, 999_000);
    await repo.settleExecution(eid!, { state: 'confirmed', usdValue: 150 });

    const schedule = await seedSchedule();
    await repo.setCaps({ userId: USER, mint: MINT, maxPerExecUsd: 1e9, maxPerDayUsd: 1e9, maxLifetimeUsd: 1e9 });
    const plan = await claimedPlan(schedule, 100); // $100 buy; 150 + 100 = 250 > clamped 200
    const { executor: capped, rec } = mkExecutorWithCeiling(1e9, 200); // day ceiling high, lifetime ceiling $200
    const outcome = await capped.execute(plan);
    expect(outcome.state).toBe('failed');
    expect(outcome.error).toMatch(/lifetime budget/i);
    expect(rec.send).toBe(0);
    expect(await schedState(schedule.id)).toBe('halted');
  });

  it('a buy that would breach the SOL reserve is refused at execution (percent buys too)', async () => {
    const schedule = await seedSchedule({ amountRaw: SOL }); // spend 1 SOL
    await repo.setCaps({ userId: USER, mint: MINT, maxPerExecUsd: 1e9, maxPerDayUsd: 1e9, minSolReserveLamports: SOL / 50n }); // 0.02 SOL
    const plan = await claimedPlan(schedule);
    // Balance 1.01 SOL -> after a 1 SOL buy, 0.01 SOL left < 0.02 reserve.
    const { executor, rec } = mkExecutor({ solBalance: async () => SOL + SOL / 100n });
    const outcome = await executor.execute(plan);
    expect(outcome.state).toBe('failed');
    expect(outcome.error).toMatch(/reserve/);
    expect(rec.send).toBe(0);
  });

  it('the same buy fires when the balance leaves the reserve intact', async () => {
    const schedule = await seedSchedule({ amountRaw: SOL });
    await repo.setCaps({ userId: USER, mint: MINT, maxPerExecUsd: 1e9, maxPerDayUsd: 1e9, minSolReserveLamports: SOL / 50n });
    const plan = await claimedPlan(schedule);
    const { executor, rec } = mkExecutor({
      solBalance: async () => SOL + SOL / 2n, // 1.5 SOL -> 0.5 left, well above reserve
      signatureStatus: async () => ({ confirmationStatus: 'confirmed', err: null, slot: 1 }),
      parseSwap: () => ({ event: { kind: 'buy', quoteRaw: 1n, tokensRaw: 1n } }),
    });
    const outcome = await executor.execute(plan);
    expect(outcome.state).toBe('confirmed');
    expect(rec.send).toBe(1);
  });
});

/** A second executor factory that can set the env ceilings for the ceiling tests. */
function mkExecutorWithCeiling(ceiling: number, lifeCeiling = 1e9): { executor: Executor; rec: Recorder } {
  const base = mkExecutor();
  // Rebuild with a ceiling override.
  const rec: Recorder = { send: 0, signAllowed: [], quotes: [], balanceReads: [], dms: [] };
  const executor = new Executor({
    repo,
    jupiter: {
      quote: async (p) => ({ inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount, outAmount: 1n, priceImpactPct: 0.001, raw: {} }),
      buildSwap: async () => ({ swapTransaction: 'UNSIGNED' }),
    },
    signer: { sign: async () => SIGNED },
    chain: {
      simulate: async () => ({ err: null }),
      send: async () => { rec.send++; return SIG; },
      signatureStatus: async () => ({ confirmationStatus: 'confirmed', err: null, slot: 1 }),
      getTransaction: (async () => ({})) as never,
    },
    balances: { solBalance: async () => 100n * SOL, mintBalance: async () => 0n },
    wallets: { pubkeyOf: () => PUBKEY },
    dm: { send: async () => undefined },
    log,
    solUsd: () => 150,
    decimalsOf: async () => 6,
    config: { ...CFG, maxPerDayUsdCeiling: ceiling, maxLifetimeUsdCeiling: lifeCeiling },
    now: () => 1_000_000,
    sleep: async () => undefined,
    parseSwap: (() => ({ event: { kind: 'buy', quoteRaw: 1n, tokensRaw: 1n } })) as never,
  });
  void base;
  return { executor, rec };
}

// ===========================================================================================
// PHASE 16 — DEAD-MAN: do not trade blind
// ===========================================================================================

describe('the dead-man pauses execution rather than trading blind', () => {
  for (const reason of ['SOL price feed is stale', 'Helius is unreachable', 'Telegram is not reachable']) {
    it(`pauses when ${reason} — no quote, no sign, no send, schedule stays active`, async () => {
      const schedule = await seedSchedule();
      const plan = await claimedPlan(schedule);
      const { executor, rec } = mkExecutor({ tradingHealth: () => ({ ok: false, reason }) });
      const outcome = await executor.execute(plan);
      expect(outcome.state).toBe('failed');
      expect(outcome.error).toMatch(/dead-man/);
      expect(rec.quotes).toHaveLength(0); // never even priced it
      expect(rec.signAllowed).toHaveLength(0);
      expect(rec.send).toBe(0);
      expect(await schedState(schedule.id)).toBe('active'); // paused, NOT halted — it retries next slot
    });
  }

  it('a dead-man pause does NOT count toward the 3-failure kill switch (it is an outage, not a bug)', async () => {
    const a = await seedSchedule();
    const bId = await repo.createSchedule({ userId: USER, mint: MINT, side: 'buy', amountRaw: SOL / 10n, amountKind: 'absolute', intervalMinutes: 60, firstRunAt: 2_000_000 });
    const OWNER = 777;
    const { executor, rec } = mkExecutor({ tradingHealth: () => ({ ok: false, reason: 'Helius is unreachable' }), ownerUserId: OWNER });

    for (let i = 0; i < 5; i++) {
      const plannedAt = a.nextRunAt + i;
      const execId = (await repo.claimExecution(a.id, USER, plannedAt))!;
      await executor.execute({ schedule: a, plannedAt, usdValue: 15, executionId: execId });
    }
    // Five dead-man pauses in a row and NOTHING is halted, no owner page.
    expect(await schedState(a.id)).toBe('active');
    expect(await schedState(bId)).toBe('active');
    expect(rec.dms.some((d) => d.userId === OWNER)).toBe(false);
  });

  it('resumes trading the instant health returns', async () => {
    const schedule = await seedSchedule();
    let healthy = false;
    const { executor, rec } = mkExecutor({
      tradingHealth: () => (healthy ? { ok: true } : { ok: false, reason: 'SOL price feed is stale' }),
      signatureStatus: async () => ({ confirmationStatus: 'confirmed', err: null, slot: 1 }),
      parseSwap: () => ({ event: { kind: 'buy', quoteRaw: 1n, tokensRaw: 1n } }),
    });
    // While unhealthy: paused.
    expect((await executor.execute(await claimedPlan(schedule, 15))).state).toBe('failed');
    expect(rec.send).toBe(0);
    // Health returns; the very next slot trades.
    healthy = true;
    const plan2 = { schedule, plannedAt: schedule.nextRunAt + 1, usdValue: 15, executionId: (await repo.claimExecution(schedule.id, USER, schedule.nextRunAt + 1))! };
    expect((await executor.execute(plan2)).state).toBe('confirmed');
    expect(rec.send).toBe(1);
  });
});
