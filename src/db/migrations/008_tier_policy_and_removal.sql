-- Phase 6. Two changes, and the first one is a change of MEANING, not of shape.
--
-- ============================================================================
-- 1. THE TIERS STOP BEING A LADDER.
-- ============================================================================
--
-- Until now a tier was picked by walking one ascending list of USD floors and
-- taking the highest one the BUY met: [regular 10, big 50, whale 200, massive 1000].
-- Whale was just "a slightly bigger buy than Big".
--
-- That is wrong about the thing the Whale tier exists to celebrate. A whale is not
-- someone who spent a lot today; it is someone who HOLDS a lot. A $20 buy from a
-- wallet sitting on $50,000 of the token is the single most interesting event the
-- bot can post — a big bag still accumulating — and the ladder called it "Regular"
-- and pulled a regular meme.
--
-- So tier selection becomes a PRIORITY CHAIN over two different quantities:
--
--   massive  if usd_in       >= buy_floor_massive     (default $1,000)
--   whale    if holdings_usd >= whale_holdings_usd    (default $10,000)  <- HOLDINGS
--   big      if usd_in       >= buy_floor_big         (default $250)
--   regular  otherwise
--
-- Massive outranks Whale deliberately: a $12,000 buy is a Massive buy even from a
-- whale's wallet. The event is the buy.
--
-- `tier_thresholds` CANNOT BE MIGRATED — it must be dropped.
--
-- It is a 4-element array of buy floors, and under the new model the THIRD element
-- has no successor: whale is no longer denominated in buy size at all. There is no
-- honest function from "whale buy floor = $200" to "whale holdings floor = $?",
-- because they measure different quantities. Carrying the number across would look
-- like data preservation while silently inventing a holdings policy nobody chose.
--
-- Per the abstention principle in CLAUDE.md: a migration that introduces a new claim
-- must not apply that claim to rows classified before the distinction existed. Every
-- existing row gets the new DEFAULTS, and an operator who had customised their floors
-- re-states them under the new model. (No chat has ever been onboarded — the bot is
-- not deployed until Phase 10 — so in practice this rewrites nothing but defaults.)
--
-- `min_buy_usd` is untouched and still filters at fan-out, before tiering.

CREATE TABLE chat_tokens_new (
  id                 INTEGER PRIMARY KEY,
  chat_id            INTEGER NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
  mint               TEXT NOT NULL,
  -- Buys below this never reach tier selection at all.
  min_buy_usd        REAL NOT NULL DEFAULT 10,
  emoji              TEXT NOT NULL DEFAULT '🍚',
  emoji_custom_id    TEXT,
  emoji_step_usd     REAL NOT NULL DEFAULT 10,
  max_emojis         INTEGER NOT NULL DEFAULT 100,
  media_mode         TEXT NOT NULL DEFAULT 'pool' CHECK (media_mode IN ('pool','static','none')),
  static_file_id     TEXT,
  static_kind        TEXT,

  -- The priority chain. Two of these are BUY size; one is HOLDINGS. That is the
  -- whole point, and it is why they are separate columns and not an array again.
  buy_floor_big      REAL NOT NULL DEFAULT 250,
  buy_floor_massive  REAL NOT NULL DEFAULT 1000,
  whale_holdings_usd REAL NOT NULL DEFAULT 10000,

  -- Headlines stay a 4-element array indexed like TIERS. The tier NAMES and their
  -- count are a schema constant (src/core/tiers.ts); only the copy is configurable.
  tier_headlines     TEXT NOT NULL DEFAULT '["🍚 {SYM} Buy!","🍚 BIG {SYM} Buy!","🐳 WHALE BUY!","💥 MASSIVE BUY!"]',
  links_json         TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  UNIQUE (chat_id, mint)
);

INSERT INTO chat_tokens_new (
  id, chat_id, mint, min_buy_usd, emoji, emoji_custom_id, emoji_step_usd, max_emojis,
  media_mode, static_file_id, static_kind, tier_headlines, links_json, enabled
)
SELECT
  id, chat_id, mint, min_buy_usd, emoji, emoji_custom_id, emoji_step_usd, max_emojis,
  media_mode, static_file_id, static_kind, tier_headlines, links_json, enabled
FROM chat_tokens;

DROP TABLE chat_tokens;
ALTER TABLE chat_tokens_new RENAME TO chat_tokens;

CREATE INDEX idx_chat_tokens_mint ON chat_tokens (mint);

-- ============================================================================
-- 2. `missing` AND `removed` ARE NOT THE SAME DISAPPEARANCE.
-- ============================================================================
--
-- Both look identical from the manifest's point of view: a sha256 that used to be
-- there and is not any more. The INTENT behind them is opposite, and the bot must
-- act on the intent, not on the symptom.
--
--   missing = 1        The file vanished and nobody meant it to. A tidied folder, a
--                      botched rsync, a full disk. KEEP SENDING IT: the cached
--                      file_id still works — Telegram serves an uploaded file long
--                      after we lose the bytes — so the art survives the accident.
--                      Silently losing a meme because someone reorganised a
--                      directory is a terrible failure mode.
--
--   removed_at != NULL An admin pressed 🗑 in a DM (Phase 8.5). They MEANT it.
--                      STOP SENDING IT IMMEDIATELY, and drop it from every rotation
--                      bag. The file_id still works, which is exactly why this has
--                      to be recorded explicitly: "we can still send it" must not be
--                      allowed to become "we do send it".
--
-- If these two collapsed into one flag, one of the two behaviours would be wrong,
-- and the wrong one is the one an admin explicitly asked for.
--
-- NULL, not 0: this is a TIMESTAMP, and "when" is worth keeping — it is the audit
-- trail for a destructive action taken from a chat window.
ALTER TABLE media_items ADD COLUMN removed_at INTEGER;

-- Rotation reads `WHERE mint = ? AND tier = ? AND removed_at IS NULL` on every refill.
CREATE INDEX idx_media_live ON media_items (mint, tier, removed_at);
