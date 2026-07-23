#!/usr/bin/env node
/**
 * Phase 13 — list DCA schedules and their recent executions.
 *
 *   sudo -u ricebuybot node /opt/ricebuybot/dist/scripts/list-schedules.js [--user <id>] [--executions <n>] [--db <path>]
 *
 * Run the BUILT script (dist), not the .ts — see seed-schedule.ts for why.
 *
 * Read-only. Shows every schedule (or one user's) with its state, next_run_at, last_run_at, and
 * the last few executions — the readable half of "read a day of the dry-run off the logs".
 */
import { resolve } from 'node:path';

import { SqliteRepo } from '../src/db/sqlite.ts';
import { createLogger } from '../src/ops/logger.ts';

const DEFAULT_DB = '/var/lib/ricebuybot/ricebuybot.db';

interface ScheduleRowLite {
  id: number;
  user_id: number;
  mint: string;
  side: string;
  amount_raw: string;
  amount_kind: string;
  interval_minutes: number;
  slippage_bps: number;
  state: string;
  halt_reason: string | null;
  next_run_at: number;
  last_run_at: number | null;
}

interface ExecRowLite {
  id: number;
  planned_at: number;
  state: string;
  usd_value: number | null;
  signature: string | null;
  error: string | null;
}

export interface ScheduleView {
  readonly schedule: ScheduleRowLite;
  readonly executions: readonly ExecRowLite[];
}

/** Gather schedules (optionally for one user) with their most recent executions. */
export function collectSchedules(repo: SqliteRepo, userId?: number, execLimit = 5): ScheduleView[] {
  const schedules = userId === undefined
    ? repo.raw.prepare<[], ScheduleRowLite>('SELECT * FROM schedules ORDER BY id').all()
    : repo.raw.prepare<[number], ScheduleRowLite>('SELECT * FROM schedules WHERE user_id = ? ORDER BY id').all(userId);

  const recent = repo.raw.prepare<[number, number], ExecRowLite>(
    `SELECT id, planned_at, state, usd_value, signature, error
       FROM executions WHERE schedule_id = ? ORDER BY planned_at DESC LIMIT ?`,
  );

  return schedules.map((schedule) => ({ schedule, executions: recent.all(schedule.id, execLimit) }));
}

function ts(ms: number | null): string {
  return ms === null ? '—' : `${ms} (${new Date(ms).toISOString()})`;
}

function render(views: readonly ScheduleView[]): string {
  if (views.length === 0) return 'no schedules.\n';
  const lines: string[] = [];
  for (const { schedule: s, executions } of views) {
    lines.push(
      `#${s.id}  user ${s.user_id}  ${s.side} ${s.amount_raw} ${s.amount_kind}  every ${s.interval_minutes}m  ` +
        `[${s.state}${s.halt_reason ? `: ${s.halt_reason}` : ''}]`,
    );
    lines.push(`     mint         ${s.mint}`);
    lines.push(`     next_run_at  ${ts(s.next_run_at)}`);
    lines.push(`     last_run_at  ${ts(s.last_run_at)}`);
    if (executions.length === 0) {
      lines.push('     executions   (none yet)');
    } else {
      lines.push(`     executions   (${executions.length} most recent)`);
      for (const e of executions) {
        const usd = e.usd_value === null ? '' : `  $${e.usd_value}`;
        const detail = e.error ? `  err=${e.error}` : e.signature ? `  sig=${e.signature.slice(0, 12)}…` : '';
        lines.push(`        ${new Date(e.planned_at).toISOString()}  ${e.state}${usd}${detail}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function resolveDbPath(args: Map<string, string>): string {
  return args.get('db') ?? process.env.DB_PATH ?? DEFAULT_DB;
}

// A local copy of the tiny parser (kept self-contained, like the other scripts).
function parseArgv(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) continue;
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) out.set(body.slice(0, eq), body.slice(eq + 1));
    else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out.set(body, next); i++; } else out.set(body, 'true');
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgv(process.argv.slice(2));
  const dbPath = resolveDbPath(args);
  const userId = args.has('user') ? Number(args.get('user')) : undefined;
  const execLimit = args.has('executions') ? Number(args.get('executions')) : 5;

  const repo = new SqliteRepo(dbPath, createLogger((process.env.LOG_LEVEL ?? 'warn') as 'warn'));
  try {
    const hasTable = repo.raw
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='schedules'")
      .get();
    if (!hasTable) {
      process.stderr.write(`no \`schedules\` table in ${dbPath} — Phase 13 is not deployed here.\n`);
      process.exit(1);
    }
    process.stdout.write(`DB: ${dbPath}\n\n`);
    process.stdout.write(render(collectSchedules(repo, userId, execLimit)));
  } finally {
    await repo.close();
  }
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`\nERROR ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
