#!/usr/bin/env node
/**
 * Phase 13 — seed ONE DCA schedule and its caps into the live DB.
 *
 *   sudo -u ricebuybot node /opt/ricebuybot/dist/scripts/seed-schedule.js \
 *     --user 123456 --mint <MINT> --side buy --amount 100000000 --interval-minutes 60 \
 *     --per-exec-usd 25 --daily-usd 100
 *
 * Run the BUILT script (dist), not the .ts: it pulls in the full SqliteRepo, whose deep imports
 * use .js specifiers that Node's type-stripping cannot resolve to .ts on disk. Same as cards:dry.
 *
 * This is the tool for the Phase 13 dry-run day, so it has to be SAFE ON A PRODUCTION DATABASE.
 * Its guards refuse the two footguns before they reach the DB:
 *
 *   - an interval under 1 minute (the tick resolution is 10s; a sub-minute schedule is almost
 *     always a typo, and on real money in Phase 14 it is a wallet-draining one);
 *   - CAPS UNSET. A schedule with no caps row skips every cap check in the scheduler — the
 *     dry-run must not be the thing that discovers a missing guard. Both caps are required, and
 *     the caps row is written BEFORE the schedule is created, so the schedule is never active
 *     for even one tick without them.
 *
 * It uses the Phase 13 repo methods (setCaps / createSchedule) — the same path the eventual
 * /schedule command will — not hand-written SQL. It does NOT migrate: if the schema is not at
 * Phase 13 it refuses and tells you to deploy, rather than quietly creating tables on prod.
 */
import { resolve } from 'node:path';

import { SqliteRepo } from '../src/db/sqlite.ts';
import { createLogger } from '../src/ops/logger.ts';
import type { Caps, Schedule, Side, AmountKind } from '../src/trade/scheduler.ts';
import type { Mint } from '../src/core/types.ts';

const DEFAULT_DB = '/var/lib/ricebuybot/ricebuybot.db';
const DEFAULT_RESERVE_LAMPORTS = 20_000_000n; // 0.02 SOL — matches the caps migration default

export class SeedError extends Error {}

export interface ParsedSeed {
  readonly userId: number;
  readonly mint: Mint;
  readonly side: Side;
  readonly amountRaw: bigint;
  readonly amountKind: AmountKind;
  readonly intervalMinutes: number;
  readonly slippageBps: number;
  readonly perExecUsd: number;
  readonly dailyUsd: number;
  readonly minReserveLamports: bigint;
  readonly firstRunInMinutes: number;
}

/** Minimal `--key value` / `--key=value` / boolean-`--flag` parser. */
export function parseArgv(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) continue;
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      out.set(body.slice(0, eq), body.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.set(body, next);
        i++;
      } else {
        out.set(body, 'true'); // bare flag
      }
    }
  }
  return out;
}

function reqInt(args: Map<string, string>, key: string): number {
  const v = args.get(key);
  if (v === undefined) throw new SeedError(`--${key} is required`);
  const n = Number(v);
  if (!Number.isInteger(n)) throw new SeedError(`--${key} must be an integer, got "${v}"`);
  return n;
}

function reqNum(args: Map<string, string>, key: string): number {
  const v = args.get(key);
  if (v === undefined) throw new SeedError(`--${key} is required`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new SeedError(`--${key} must be a number, got "${v}"`);
  return n;
}

/**
 * Pure validation — every guard lives here so it can be tested without a DB. Throws SeedError
 * with an operator-readable message on the first violation.
 */
export function validateSeed(args: Map<string, string>): ParsedSeed {
  const userId = reqInt(args, 'user');
  if (userId <= 0) throw new SeedError(`--user must be a positive Telegram user id, got ${userId}`);

  const mint = (args.get('mint') ?? '') as Mint;
  if (mint.length < 32) throw new SeedError('--mint is required and must be a full base58 mint address');

  const side = args.get('side');
  if (side !== 'buy' && side !== 'sell') throw new SeedError(`--side must be 'buy' or 'sell', got "${side ?? ''}"`);

  const amountKind = (args.get('amount-kind') ?? 'absolute') as AmountKind;
  if (amountKind !== 'absolute' && amountKind !== 'percent_of_balance') {
    throw new SeedError(`--amount-kind must be 'absolute' or 'percent_of_balance', got "${amountKind}"`);
  }

  const amountStr = args.get('amount');
  if (amountStr === undefined) throw new SeedError('--amount is required (buy: lamports of SOL; sell: raw token units)');
  let amountRaw: bigint;
  try {
    amountRaw = BigInt(amountStr);
  } catch {
    throw new SeedError(`--amount must be an integer number of raw units, got "${amountStr}"`);
  }
  if (amountRaw <= 0n) throw new SeedError('--amount must be greater than zero');
  if (amountKind === 'percent_of_balance' && amountRaw > 10_000n) {
    throw new SeedError('--amount for percent_of_balance is in basis points (1..10000); got ' + amountStr);
  }

  // THE INTERVAL GUARD. Sub-minute is refused: the tick runs at 10s resolution, and a schedule
  // that fires many times a minute is a typo you do not want to find on real money in Phase 14.
  const intervalMinutes = reqInt(args, 'interval-minutes');
  if (intervalMinutes < 1) throw new SeedError(`--interval-minutes must be at least 1, got ${intervalMinutes}`);

  // THE CAPS GUARD. Both are required and must be positive — a schedule with no caps row skips
  // every cap check in the scheduler, and the dry-run must not be where that is discovered.
  const perExecUsd = reqNum(args, 'per-exec-usd');
  if (perExecUsd <= 0) throw new SeedError('--per-exec-usd must be greater than zero (caps are mandatory)');
  const dailyUsd = reqNum(args, 'daily-usd');
  if (dailyUsd <= 0) throw new SeedError('--daily-usd must be greater than zero (caps are mandatory)');
  if (dailyUsd < perExecUsd) throw new SeedError(`--daily-usd (${dailyUsd}) is below --per-exec-usd (${perExecUsd}); the daily cap could never be reached`);

  const slippageBps = args.has('slippage-bps') ? reqInt(args, 'slippage-bps') : 100;
  if (slippageBps < 0) throw new SeedError('--slippage-bps must not be negative');

  let minReserveLamports = DEFAULT_RESERVE_LAMPORTS;
  if (args.has('min-reserve-lamports')) {
    try {
      minReserveLamports = BigInt(args.get('min-reserve-lamports') as string);
    } catch {
      throw new SeedError('--min-reserve-lamports must be an integer number of lamports');
    }
    if (minReserveLamports < 0n) throw new SeedError('--min-reserve-lamports must not be negative');
  }

  const firstRunInMinutes = args.has('first-run-in') ? reqNum(args, 'first-run-in') : 0;
  if (firstRunInMinutes < 0) throw new SeedError('--first-run-in must not be negative');

  return {
    userId, mint, side, amountRaw, amountKind, intervalMinutes, slippageBps,
    perExecUsd, dailyUsd, minReserveLamports, firstRunInMinutes,
  };
}

/** Refuse to touch a DB that has not been migrated to Phase 13 — do not create tables on prod. */
export function assertSchema(repo: SqliteRepo): void {
  const table = repo.raw
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='schedules'")
    .get();
  if (!table) {
    throw new SeedError(
      'no `schedules` table in this DB — Phase 13 is not deployed here.\n' +
        '  Deploy first (sudo bash scripts/setup-bot.sh from the source checkout); this tool will NOT migrate prod.',
    );
  }
}

/**
 * Create the caps row, THEN the schedule. Order matters: the schedule is created active, and if
 * caps did not exist first it could be ticked once without them. Returns what landed.
 */
export async function runSeed(
  repo: SqliteRepo,
  p: ParsedSeed,
  now: number,
): Promise<{ scheduleId: number; schedule: Schedule; caps: Caps }> {
  assertSchema(repo);

  // The owner must be a real autotrader member (INVARIANT 14). A raw FK violation is a worse
  // error message than this, and a locked member cannot trade anyway.
  const member = await repo.getAutotraderUser(p.userId);
  if (!member) {
    throw new SeedError(`user ${p.userId} is not an autotrader member — add them with /trader before seeding (INVARIANT 14)`);
  }
  if (member.locked) {
    throw new SeedError(`user ${p.userId} is locked (access revoked) — cannot seed a schedule for them`);
  }

  const firstRunAt = now + Math.round(p.firstRunInMinutes * 60_000);

  // Caps first — never leave a window where the schedule is active without them.
  await repo.setCaps({
    userId: p.userId,
    mint: p.mint,
    maxPerExecUsd: p.perExecUsd,
    maxPerDayUsd: p.dailyUsd,
    minSolReserveLamports: p.minReserveLamports,
  });

  const scheduleId = await repo.createSchedule({
    userId: p.userId,
    mint: p.mint,
    side: p.side,
    amountRaw: p.amountRaw,
    amountKind: p.amountKind,
    intervalMinutes: p.intervalMinutes,
    slippageBps: p.slippageBps,
    firstRunAt,
    state: 'active',
  });

  const schedule = await repo.getSchedule(scheduleId);
  const caps = await repo.getCaps(p.userId, p.mint);
  if (!schedule || !caps) throw new SeedError('internal: schedule/caps not found immediately after creation');
  return { scheduleId, schedule, caps };
}

function resolveDbPath(args: Map<string, string>): string {
  return args.get('db') ?? process.env.DB_PATH ?? DEFAULT_DB;
}

const USAGE = `seed-schedule.ts — create one DCA schedule + caps (Phase 13)

Required:
  --user <id>              Telegram user id (must be an autotrader member)
  --mint <address>         SPL mint
  --side buy|sell
  --amount <raw>           buy: lamports of SOL to spend; sell: raw token units to sell
  --interval-minutes <n>   >= 1
  --per-exec-usd <n>       per-execution cap (> 0, mandatory)
  --daily-usd <n>          rolling-24h cap (> 0, mandatory, >= per-exec)

Optional:
  --amount-kind absolute|percent_of_balance   (default absolute; percent = basis points)
  --slippage-bps <n>            (default 100)
  --min-reserve-lamports <n>    (default 20000000 = 0.02 SOL)
  --first-run-in <minutes>      (default 0 = due on the next tick)
  --db <path>                   (default $DB_PATH or ${DEFAULT_DB})
`;

async function main(): Promise<void> {
  const args = parseArgv(process.argv.slice(2));
  if (args.has('help') || args.has('h')) {
    process.stdout.write(USAGE);
    return;
  }

  const parsed = validateSeed(args); // throws SeedError before any DB is opened
  const dbPath = resolveDbPath(args);
  process.stdout.write(`using DB: ${dbPath}\n`);

  const repo = new SqliteRepo(dbPath, createLogger((process.env.LOG_LEVEL ?? 'warn') as 'warn'));
  try {
    const { scheduleId, schedule, caps } = await runSeed(repo, parsed, Date.now());
    const sol = (lamports: bigint): string => `${(Number(lamports) / 1e9).toFixed(4)} SOL`;
    process.stdout.write(
      `\ncreated schedule #${scheduleId}\n` +
        `  user            ${schedule.userId}\n` +
        `  mint            ${schedule.mint}\n` +
        `  side            ${schedule.side}\n` +
        `  amount          ${schedule.amountRaw} ${schedule.amountKind}` +
        `${schedule.side === 'buy' && schedule.amountKind === 'absolute' ? ` (${sol(schedule.amountRaw)})` : ''}\n` +
        `  interval        ${schedule.intervalMinutes} min\n` +
        `  slippage        ${schedule.slippageBps} bps\n` +
        `  state           ${schedule.state}\n` +
        `  caps            per-exec $${caps.maxPerExecUsd}  |  24h $${caps.maxPerDayUsd}  |  reserve ${sol(caps.minSolReserveLamports)}\n` +
        `  next_run_at     ${schedule.nextRunAt}  (${new Date(schedule.nextRunAt).toISOString()})\n` +
        `                  first slot is due ${schedule.nextRunAt <= Date.now() ? 'on the next tick' : `in ~${Math.round((schedule.nextRunAt - Date.now()) / 60000)} min`}\n`,
    );
  } finally {
    await repo.close();
  }
}

// Only run when executed directly, not when imported by a test.
if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  main().catch((err: unknown) => {
    const msg = err instanceof SeedError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`\nERROR ${msg}\n`);
    process.exit(1);
  });
}
