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

DROP TABLE media_items;
ALTER TABLE media_items_new RENAME TO media_items;

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
