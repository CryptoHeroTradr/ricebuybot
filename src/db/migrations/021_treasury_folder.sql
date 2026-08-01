-- Phase 17: the Treasury Buy Back card, and the `treasury/` media folder.
--
-- TREASURY IS NOT A FIFTH TIER, for the same reason `dca` is not (migration 015). The tiers are a
-- fixed 4-tuple (src/core/tiers.ts) on the axis of SIZE: regular < big < whale < massive. A
-- treasury buy back is identified by WHO BOUGHT — the project's own treasury wallet — which is a
-- different axis entirely, so `tier_thresholds`, `tier_headlines` and the priority chain all stay
-- exactly four. What widens, again, is only the set of FOLDERS media may live in.
--
-- SQLite cannot alter a CHECK constraint, so the two tables that name the folders are rebuilt. The
-- stray-folder hard error must still fire on anything that is neither a tier, `dca`, nor `treasury`.

-- --- media_items: allow the treasury folder ------------------------------------------------
--
-- FK-SAFE REBUILD, verbatim from 015 and for the reason spelled out there: media_items is the
-- PARENT of media_file_ids(sha256), the bot runs with `PRAGMA foreign_keys = ON`, and a plain
-- `DROP TABLE media_items` performs an implicit DELETE that orphans every cached file_id and throws
-- SQLITE_CONSTRAINT_FOREIGNKEY on a populated production DB (empty in CI, which is how it got out
-- the door the first time). Neither `foreign_keys = OFF` nor `defer_foreign_keys = ON` can help
-- inside the runner's per-migration transaction — see 015 for the proof. So the CHILD is rebuilt
-- alongside the parent and DROPPED FIRST, and the rebuilt child keeps its FK (INVARIANT 3).
CREATE TABLE media_items_new (
  sha256     TEXT PRIMARY KEY,
  mint       TEXT NOT NULL,
  tier       TEXT NOT NULL CHECK (tier IN ('regular','big','whale','massive','dca','treasury')),
  rel_path   TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('photo','animation','video')),
  bytes      INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  missing    INTEGER NOT NULL DEFAULT 0,
  removed_at INTEGER
);

INSERT INTO media_items_new (sha256, mint, tier, rel_path, kind, bytes, first_seen, missing, removed_at)
SELECT sha256, mint, tier, rel_path, kind, bytes, first_seen, missing, removed_at FROM media_items;

CREATE TABLE media_file_ids_new (
  sha256      TEXT PRIMARY KEY REFERENCES media_items_new(sha256),
  file_id     TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL
);

INSERT INTO media_file_ids_new (sha256, file_id, uploaded_at)
SELECT sha256, file_id, uploaded_at FROM media_file_ids;

DROP TABLE media_file_ids;   -- child first: it has no children of its own, so this orphans nobody
DROP TABLE media_items;      -- now unreferenced, so its implicit DELETE violates nothing
ALTER TABLE media_items_new RENAME TO media_items;         -- repoints child_new's FK by name
ALTER TABLE media_file_ids_new RENAME TO media_file_ids;

CREATE INDEX idx_media_mint_tier ON media_items (mint, tier);
CREATE INDEX idx_media_live      ON media_items (mint, tier, removed_at);

-- --- media_rotation: the treasury folder rotates on its OWN shuffle bag ----------------------
-- Bags key on (mint, chat_id, folder), so rotation needs no other change: `treasury` becomes
-- another folder value and gets its own bag, no repeat until exhausted. It never shares a bag with
-- a tier, which is what stops treasury art and organic art marching in lockstep.
CREATE TABLE media_rotation_new (
  mint       TEXT NOT NULL,
  chat_id    INTEGER NOT NULL,
  tier       TEXT NOT NULL CHECK (tier IN ('regular','big','whale','massive','dca','treasury')),
  bag        TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (mint, chat_id, tier)
);

INSERT INTO media_rotation_new (mint, chat_id, tier, bag, updated_at)
SELECT mint, chat_id, tier, bag, updated_at FROM media_rotation;

DROP TABLE media_rotation;
ALTER TABLE media_rotation_new RENAME TO media_rotation;
