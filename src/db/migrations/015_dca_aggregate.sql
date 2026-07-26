-- Phase 16: the DCA aggregate card, and the `dca/` media folder.
--
-- DCA IS NOT A FIFTH TIER. The tiers are a fixed 4-tuple (src/core/tiers.ts) on the axis of SIZE:
-- regular < big < whale < massive. `dca` is a sibling of that whole set on a different axis —
-- CATEGORY, not size — so `tier_thresholds`, `tier_headlines` and the priority chain all stay
-- exactly four. What widens is only the set of FOLDERS media may live in.
--
-- SQLite cannot alter a CHECK constraint, so the two tables that name the four folders are rebuilt.
-- The stray-folder hard error must still fire on anything that is neither a tier nor `dca`.

-- --- media_items: allow the dca folder -----------------------------------------------------
--
-- FK-SAFE REBUILD. media_items is a PARENT: media_file_ids(sha256) (001_init) references
-- media_items(sha256) with the default ON DELETE NO ACTION. The bot opens the DB with
-- `PRAGMA foreign_keys = ON`, and under that a `DROP TABLE media_items` first performs an implicit
-- DELETE of its rows — which orphans every media_file_ids row that references them and throws
-- SQLITE_CONSTRAINT_FOREIGNKEY. That child is empty in CI (why this passed there) but populated in
-- production (a cache of Telegram file_ids keyed by content sha256 — INVARIANT 3), which is why the
-- deploy failed.
--
-- `PRAGMA foreign_keys = OFF` cannot help: it is a no-op inside the runner's per-migration
-- transaction. `PRAGMA defer_foreign_keys = ON` cannot either: DROP's implicit DELETE increments the
-- deferred-violation counter, the later RENAME (which restores the rows) never decrements it, and
-- COMMIT checks that counter, not the actual data — so it throws even though the final state is
-- consistent (a fresh `PRAGMA foreign_key_check` at that point reports zero violations). Proven.
--
-- So we rebuild the CHILD alongside the parent and DROP THE CHILD FIRST: once media_file_ids is gone,
-- nothing references media_items and its drop orphans nobody. All of this stays within
-- foreign_keys = ON, touches only this migration, and the rebuilt media_file_ids KEEPS its FK to
-- media_items(sha256) — INVARIANT 3 — so a file_id with no parent item is still rejected afterward.
CREATE TABLE media_items_new (
  sha256     TEXT PRIMARY KEY,
  mint       TEXT NOT NULL,
  tier       TEXT NOT NULL CHECK (tier IN ('regular','big','whale','massive','dca')),
  rel_path   TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('photo','animation','video')),
  bytes      INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  missing    INTEGER NOT NULL DEFAULT 0,
  removed_at INTEGER
);

INSERT INTO media_items_new (sha256, mint, tier, rel_path, kind, bytes, first_seen, missing, removed_at)
SELECT sha256, mint, tier, rel_path, kind, bytes, first_seen, missing, removed_at FROM media_items;

-- Rebuild the child so it references media_items_new; copy every cached file_id across intact. Its FK
-- must survive the migration (INVARIANT 3), so the constraint is reproduced verbatim from 001_init.
CREATE TABLE media_file_ids_new (
  sha256      TEXT PRIMARY KEY REFERENCES media_items_new(sha256),
  file_id     TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL
);

INSERT INTO media_file_ids_new (sha256, file_id, uploaded_at)
SELECT sha256, file_id, uploaded_at FROM media_file_ids;

DROP TABLE media_file_ids;   -- child first: it has no children of its own, so this orphans nobody
DROP TABLE media_items;      -- now unreferenced, so its implicit DELETE violates nothing
ALTER TABLE media_items_new RENAME TO media_items;         -- repoints child_new's FK to `media_items` by name
ALTER TABLE media_file_ids_new RENAME TO media_file_ids;

CREATE INDEX idx_media_mint_tier ON media_items (mint, tier);
CREATE INDEX idx_media_live      ON media_items (mint, tier, removed_at);

-- --- media_rotation: the dca folder rotates on its OWN shuffle bag --------------------------
-- Bags already key on (mint, chat_id, folder), so rotation needs no other change: `dca` simply
-- becomes another folder value and gets its own bag, no repeat until exhausted.
CREATE TABLE media_rotation_new (
  mint       TEXT NOT NULL,
  chat_id    INTEGER NOT NULL,
  tier       TEXT NOT NULL CHECK (tier IN ('regular','big','whale','massive','dca')),
  bag        TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (mint, chat_id, tier)
);

INSERT INTO media_rotation_new (mint, chat_id, tier, bag, updated_at)
SELECT mint, chat_id, tier, bag, updated_at FROM media_rotation;

DROP TABLE media_rotation;
ALTER TABLE media_rotation_new RENAME TO media_rotation;

-- --- per-chat DCA disclosure settings -------------------------------------------------------
--
-- The window is a WALL-CLOCK TUMBLING window aligned to the hour (:00 and :30 at the default 30),
-- not a rolling one that starts at the first buy: a rolling window drifts, and nobody can tell when
-- the next card is due. OWNER-ONLY to set (/dcawindow) — this is the owner's program, not a
-- per-group knob.
ALTER TABLE chat_tokens ADD COLUMN dca_window_minutes INTEGER NOT NULL DEFAULT 30;

-- 'aggregate' (default) = one rolled-up card per window. 'off' = DCA buys never post at all —
-- honest, but tells the group nothing. There is deliberately no third option: a per-buy DCA card
-- is the thing this phase exists to prevent.
ALTER TABLE chat_tokens ADD COLUMN dca_display TEXT NOT NULL DEFAULT 'aggregate'
  CHECK (dca_display IN ('aggregate','off'));

-- --- the flush cursor -----------------------------------------------------------------------
--
-- One row per (chat_id, mint): the last window we have already flushed. The aggregate itself is
-- rebuilt from the `buys` table at flush time (a query, never an in-memory buffer — a buffer loses
-- everything it holds on restart, silently), and this cursor is what stops a flush double-counting
-- or skipping a window across restarts.
CREATE TABLE IF NOT EXISTS dca_cursor (
  chat_id           INTEGER NOT NULL,
  mint              TEXT    NOT NULL,
  last_window_start INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (chat_id, mint)
);
