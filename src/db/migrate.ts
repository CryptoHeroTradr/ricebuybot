import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Logger } from '../ops/logger.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

/** `001_init.sql` -> version 1, name "init". Anything else is ignored. */
const FILE_RE = /^(\d+)_([a-z0-9_]+)\.sql$/;

export function migrationsDir(): string {
  return join(import.meta.dirname, 'migrations');
}

export function loadMigrations(dir: string = migrationsDir()): Migration[] {
  const migrations = readdirSync(dir)
    .map((f) => ({ f, m: FILE_RE.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
    .map(({ f, m }) => {
      const sql = readFileSync(join(dir, f), 'utf8');
      return {
        version: Number(m[1]),
        name: m[2] as string,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    })
    .sort((a, b) => a.version - b.version);

  const seen = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) throw new Error(`duplicate migration version ${m.version}`);
    seen.add(m.version);
  }
  return migrations;
}

/**
 * Apply pending migrations. Idempotent: already-applied versions are skipped, so
 * a boot on an up-to-date DB is a no-op.
 *
 * Each migration runs inside its own transaction, so a failure half-way through
 * leaves the DB at the last good version rather than in a torn state.
 *
 * An already-applied migration whose file has since CHANGED is a hard error. The
 * DB does not match what the code believes the schema to be, and silently
 * carrying on is how you get a corrupt production database.
 */
export function migrate(db: Database, log: Logger, dir: string = migrationsDir()): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Map<number, { name: string; checksum: string }>(
    db
      .prepare<[], { version: number; name: string; checksum: string }>(
        'SELECT version, name, checksum FROM schema_migrations',
      )
      .all()
      .map((r) => [r.version, { name: r.name, checksum: r.checksum }]),
  );

  const record = db.prepare<[number, string, string, number]>(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  );

  let count = 0;
  for (const m of loadMigrations(dir)) {
    const prior = applied.get(m.version);
    if (prior) {
      if (prior.checksum !== m.checksum) {
        throw new Error(
          `migration ${m.version}_${m.name}.sql was modified after it was applied ` +
            `(recorded checksum ${prior.checksum.slice(0, 12)}, file is ${m.checksum.slice(0, 12)}). ` +
            `Add a new migration instead of editing an applied one.`,
        );
      }
      continue;
    }

    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, m.checksum, Date.now());
    })();

    log.info({ version: m.version, name: m.name }, 'migration applied');
    count++;
  }

  return count;
}
