import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate, migrationsDir, loadMigrations } from '../src/db/migrate.js';
import { createLogger } from '../src/ops/logger.js';

const log = createLogger('silent' as 'info', false);

/**
 * THE TEST THAT WOULD HAVE CAUGHT THE 015 PROD CRASH.
 *
 * Migrations were only ever exercised against FRESH, empty schemas — which is exactly why 015
 * (rebuild media_items via create-new / copy / DROP / rename) passed CI yet crashed production. In
 * prod, media_file_ids holds real cached Telegram file_ids that reference media_items(sha256); under
 * `PRAGMA foreign_keys = ON` the DROP implicitly deletes those parent rows and throws
 * SQLITE_CONSTRAINT_FOREIGNKEY. Empty in CI, populated in prod.
 *
 * This test stages the PRODUCTION condition — a DB at migration 14 with a populated file_id cache —
 * then applies 15-18. It fails with SQLITE_CONSTRAINT_FOREIGNKEY if the `PRAGMA defer_foreign_keys`
 * line is missing from 015, and passes with it (the fix defers FK checks to COMMIT, by which point
 * media_items has been recreated with the same sha256 rows so every child resolves).
 */
describe('migrations apply against a POPULATED file_id cache (prod condition, not just a fresh schema)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ricebuybot-migfk-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A directory holding only the migrations up to `maxVersion`, to stage a DB at that version. */
  function subsetDir(maxVersion: number): string {
    const d = join(root, `migrations-to-${maxVersion}`);
    mkdirSync(d, { recursive: true });
    for (const m of loadMigrations()) {
      if (m.version <= maxVersion) {
        writeFileSync(join(d, `${String(m.version).padStart(3, '0')}_${m.name}.sql`), m.sql);
      }
    }
    return d;
  }

  it('applies 15-18 without orphaning media_file_ids, reaching 18 with the cached file_id intact', () => {
    const db = new Database(join(root, 'test.db'));
    db.pragma('foreign_keys = ON'); // the bot opens the DB with FKs ON — reproduce that here

    // 1. Stage the live DB's state: migrated to 14.
    migrate(db, log, subsetDir(14));
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 14 });

    // 2. The production condition CI never had: a media_items row AND a matching media_file_ids row
    //    (a real cached Telegram file_id pointing at it).
    db.prepare(
      'INSERT INTO media_items (sha256, mint, tier, rel_path, kind, bytes, first_seen) VALUES (?,?,?,?,?,?,?)',
    ).run('sha-parent', 'MintAddr', 'regular', 'regular/x.jpg', 'photo', 123, 1000);
    db.prepare('INSERT INTO media_file_ids (sha256, file_id, uploaded_at) VALUES (?,?,?)').run(
      'sha-parent',
      'telegram-file-id-abc',
      1000,
    );

    // 3. Apply the full set — 015's media_items rebuild runs here (the statement that crashed prod).
    expect(() => migrate(db, log, migrationsDir())).not.toThrow();

    // 4. Everything after 14 applied; the DB reached the LATEST migration on disk.
    //
    // Derived, not a literal. This assertion used to read `{ v: 18 }`, which meant every later
    // phase broke a test about foreign keys — a failure that says nothing about what it guards and
    // trains you to edit the number. What is actually under test is that the whole remaining set
    // applies against a populated file_id cache, and that is what this now says.
    const latest = Math.max(...loadMigrations().map((m) => m.version));
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: latest });

    // 5. The cached file_id survived, its parent intact, and no FK is left dangling.
    expect(db.prepare('SELECT file_id FROM media_file_ids WHERE sha256 = ?').get('sha-parent')).toEqual({
      file_id: 'telegram-file-id-abc',
    });
    expect(db.prepare('SELECT sha256 FROM media_items WHERE sha256 = ?').get('sha-parent')).toEqual({
      sha256: 'sha-parent',
    });
    expect(db.pragma('foreign_key_check')).toEqual([]); // no orphans anywhere in the DB

    // 6. The FK must SURVIVE the rebuild (INVARIANT 3): a file_id with no parent media_items row is
    //    still rejected. If the rebuild had dropped the constraint to ease the migration, this insert
    //    would succeed — so this assertion is what proves the constraint is still there.
    expect(() =>
      db.prepare('INSERT INTO media_file_ids (sha256, file_id, uploaded_at) VALUES (?,?,?)').run(
        'sha-with-no-parent',
        'orphan-file-id',
        2000,
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);

    db.close();
  });
});
