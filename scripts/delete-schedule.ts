#!/usr/bin/env node
/**
 * Phase 13 — delete ONE schedule and its executions, cleanly and reversibly-by-hand-free.
 *
 *   sudo -u ricebuybot node /opt/ricebuybot/dist/scripts/delete-schedule.js <id> [--yes] [--db <path>]
 *
 * Run the BUILT script (dist), not the .ts — see seed-schedule.ts for why.
 *
 * The inverse of seed-schedule.ts: it makes the dry-run reversible without touching SQL. It
 * removes the schedule and its executions in one transaction, and — only if no OTHER schedule
 * uses the same (user, mint) — the caps row too, so a seed/delete round-trip leaves nothing
 * behind. Caps shared with another schedule are kept.
 *
 * It CONFIRMS first (unless --yes), printing exactly what will go, because this runs on prod.
 */
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { SqliteRepo } from '../src/db/sqlite.ts';
import { createLogger } from '../src/ops/logger.ts';
import type { Schedule } from '../src/trade/scheduler.ts';

const DEFAULT_DB = '/var/lib/ricebuybot/ricebuybot.db';

export class DeleteError extends Error {}

export interface DeleteResult {
  readonly schedule: Schedule;
  readonly deletedExecutions: number;
  readonly deletedCaps: number;
}

/**
 * Delete the schedule, its executions, and (iff orphaned) its caps — atomically. Throws
 * DeleteError if the id does not exist, so the caller can report cleanly.
 */
export async function deleteSchedule(repo: SqliteRepo, id: number): Promise<DeleteResult> {
  const schedule = await repo.getSchedule(id);
  if (!schedule) throw new DeleteError(`no schedule with id ${id}`);

  const run = repo.raw.transaction((): { deletedExecutions: number; deletedCaps: number } => {
    const deletedExecutions = repo.raw.prepare('DELETE FROM executions WHERE schedule_id = ?').run(id).changes;
    repo.raw.prepare('DELETE FROM schedules WHERE id = ?').run(id);

    // Caps are keyed (user_id, mint) and may back several schedules. Only remove them when this
    // was the last schedule for that pair — otherwise we would strip another schedule's guard.
    const others = repo.raw
      .prepare<[number, string], { n: number }>('SELECT COUNT(*) AS n FROM schedules WHERE user_id = ? AND mint = ?')
      .get(schedule.userId, schedule.mint);
    let deletedCaps = 0;
    if ((others?.n ?? 0) === 0) {
      deletedCaps = repo.raw.prepare('DELETE FROM caps WHERE user_id = ? AND mint = ?').run(schedule.userId, schedule.mint).changes;
    }
    return { deletedExecutions, deletedCaps };
  });

  const { deletedExecutions, deletedCaps } = run();
  return { schedule, deletedExecutions, deletedCaps };
}

function resolveDbPath(args: Map<string, string>): string {
  return args.get('db') ?? process.env.DB_PATH ?? DEFAULT_DB;
}

function parseArgv(argv: readonly string[]): { positionals: string[]; flags: Map<string, string> } {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a && a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) flags.set(body.slice(0, eq), body.slice(eq + 1));
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) { flags.set(body, next); i++; } else flags.set(body, 'true');
      }
    } else if (a !== undefined) {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

async function confirm(schedule: Schedule, execCount: number): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(
      `About to DELETE schedule #${schedule.id} (user ${schedule.userId}, ${schedule.side} ${schedule.mint}, ` +
        `${schedule.state}) and its ${execCount} execution(s). Type 'yes' to confirm: `,
    );
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgv(process.argv.slice(2));
  const idStr = positionals[0];
  if (idStr === undefined || flags.has('help')) {
    process.stdout.write('usage: delete-schedule.ts <id> [--yes] [--db <path>]\n');
    process.exit(idStr === undefined ? 1 : 0);
  }
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0) {
    process.stderr.write(`ERROR schedule id must be a positive integer, got "${idStr}"\n`);
    process.exit(1);
  }

  const dbPath = resolveDbPath(flags);
  process.stdout.write(`using DB: ${dbPath}\n`);
  const repo = new SqliteRepo(dbPath, createLogger((process.env.LOG_LEVEL ?? 'warn') as 'warn'));
  try {
    const schedule = await repo.getSchedule(id);
    if (!schedule) {
      process.stderr.write(`ERROR no schedule with id ${id}\n`);
      process.exit(1);
    }
    const execCount = repo.raw
      .prepare<[number], { n: number }>('SELECT COUNT(*) AS n FROM executions WHERE schedule_id = ?')
      .get(id)?.n ?? 0;

    const auto = flags.has('yes') || flags.has('y');
    if (!auto) {
      if (!stdin.isTTY) {
        process.stderr.write('refusing to delete without confirmation on a non-interactive stdin — pass --yes\n');
        process.exit(1);
      }
      if (!(await confirm(schedule, execCount))) {
        process.stdout.write('aborted — nothing deleted.\n');
        return;
      }
    }

    const result = await deleteSchedule(repo, id);
    process.stdout.write(
      `deleted schedule #${result.schedule.id}: ` +
        `${result.deletedExecutions} execution(s)` +
        `${result.deletedCaps > 0 ? ', and its caps (no other schedule used them)' : ', caps kept (shared or absent)'}.\n`,
    );
  } finally {
    await repo.close();
  }
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`\nERROR ${err instanceof DeleteError ? err.message : err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
