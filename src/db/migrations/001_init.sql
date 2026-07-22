-- RiceBuybot initial schema.
--
-- Raw chain amounts are TEXT, never REAL: a u64 token amount exceeds the 2^53
-- exact-integer range of a float, and REAL would silently round it. USD is REAL
-- because it is a derived display quantity (INVARIANT 6).
--
-- The literal defaults below (tier_thresholds, tier_headlines) and the tier
-- CHECK constraint MUST agree with src/core/tiers.ts. That agreement is pinned
-- by a test — if you edit one, the test tells you to edit the other.

CREATE TABLE chats (
  chat_id    INTEGER PRIMARY KEY,
  title      TEXT,
  added_by   INTEGER,
  paused     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE chat_tokens (
  id              INTEGER PRIMARY KEY,
  chat_id         INTEGER NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
  mint            TEXT NOT NULL,
  min_buy_usd     REAL NOT NULL DEFAULT 10,
  emoji           TEXT NOT NULL DEFAULT '🍚',
  emoji_custom_id TEXT,
  emoji_step_usd  REAL NOT NULL DEFAULT 10,
  max_emojis      INTEGER NOT NULL DEFAULT 100,
  media_mode      TEXT NOT NULL DEFAULT 'pool' CHECK (media_mode IN ('pool','static','none')),
  static_file_id  TEXT,
  static_kind     TEXT,
  -- JSON, ascending USD floors for [regular, big, whale, massive]
  tier_thresholds TEXT NOT NULL DEFAULT '[10,50,200,1000]',
  -- JSON, per-tier card headline. {SYM} substitutes the token symbol.
  tier_headlines  TEXT NOT NULL DEFAULT '["🍚 {SYM} Buy!","🍚 BIG {SYM} Buy!","🐳 WHALE BUY!","💥 MASSIVE BUY!"]',
  links_json      TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (chat_id, mint)
);

CREATE TABLE tokens (
  mint            TEXT PRIMARY KEY,
  symbol          TEXT,
  name            TEXT,
  decimals        INTEGER NOT NULL,
  supply_raw      TEXT NOT NULL,
  meta_updated_at INTEGER NOT NULL
);

-- sha256 is the PK deliberately: the same GIF under two filenames is ONE item,
-- and gets exactly ONE Telegram upload (INVARIANT 3).
CREATE TABLE media_items (
  sha256     TEXT PRIMARY KEY,
  mint       TEXT NOT NULL,
  tier       TEXT NOT NULL CHECK (tier IN ('regular','big','whale','massive')),
  rel_path   TEXT NOT NULL,          -- relative to MEDIA_ROOT
  kind       TEXT NOT NULL CHECK (kind IN ('photo','animation','video')),
  bytes      INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  -- File is gone from the pool, but the cached file_id may still be valid:
  -- Telegram keeps serving an uploaded file long after we lose the bytes.
  missing    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE media_file_ids (
  sha256      TEXT PRIMARY KEY REFERENCES media_items(sha256),
  file_id     TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL
);

-- Per (mint, chat, tier): two groups on the same mint rotate independently and
-- never sync up.
CREATE TABLE media_rotation (
  mint       TEXT NOT NULL,
  chat_id    INTEGER NOT NULL,
  tier       TEXT NOT NULL CHECK (tier IN ('regular','big','whale','massive')),
  bag        TEXT NOT NULL,          -- JSON array of sha256s remaining in the shuffled bag
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (mint, chat_id, tier)
);

CREATE TABLE buys (
  signature      TEXT NOT NULL,
  mint           TEXT NOT NULL,
  buyer          TEXT NOT NULL,
  quote_lamports TEXT NOT NULL,
  tokens_raw     TEXT NOT NULL,
  usd_in         REAL NOT NULL,
  price_usd      REAL NOT NULL,
  slot           INTEGER NOT NULL,
  block_time     INTEGER,
  PRIMARY KEY (signature, mint, buyer)
);

CREATE TABLE positions (
  mint             TEXT NOT NULL,
  buyer            TEXT NOT NULL,
  tokens_raw       TEXT NOT NULL DEFAULT '0',
  cost_usd         REAL NOT NULL DEFAULT 0,
  realized_pnl_usd REAL NOT NULL DEFAULT 0,
  backfilled       INTEGER NOT NULL DEFAULT 0,
  first_seen       INTEGER,
  updated_at       INTEGER,
  PRIMARY KEY (mint, buyer)
);

-- The idempotency ledger (INVARIANT 2). A read-then-write "have I sent this?"
-- double-posts under reconnect replay; the claim is a single atomic INSERT.
--
-- 'failed' is a TOMBSTONE, not an error record: its presence is what stops a
-- replay from hammering a dead chat, and what makes an orphan sweep permanent
-- (INVARIANT 9).
CREATE TABLE sends (
  signature   TEXT NOT NULL,
  chat_id     INTEGER NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('claimed','sent','failed')),
  message_id  INTEGER,               -- set only on 'sent'
  attempts    INTEGER NOT NULL DEFAULT 0,
  claimed_at  INTEGER NOT NULL,
  settled_at  INTEGER,
  fail_reason TEXT,
  PRIMARY KEY (signature, chat_id)
);

CREATE TABLE cursors (
  mint      TEXT PRIMARY KEY,
  last_slot INTEGER NOT NULL
);

CREATE INDEX idx_chat_tokens_mint ON chat_tokens (mint);
CREATE INDEX idx_buys_mint_slot   ON buys (mint, slot DESC);
CREATE INDEX idx_buys_buyer_mint  ON buys (buyer, mint);
CREATE INDEX idx_media_mint_tier  ON media_items (mint, tier);
CREATE INDEX idx_sends_state      ON sends (state);
