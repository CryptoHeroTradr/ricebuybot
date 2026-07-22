-- Phase 4.5: `positions` becomes a DERIVED FOLD over a durable swap log.
--
-- Before this, `positions` was a MUTATED ROW and two writers raced on it: the live
-- ingest path (read-modify-write inside a transaction) and the backfiller (walk a
-- wallet's history for seconds, then OVERWRITE the row with what it found). A live
-- buy landing mid-walk was clobbered — its tokens and its cost silently vanished
-- from the ledger.
--
-- The fix is not a lock. It is to STOP MUTATING. Every swap the bot learns about is
-- appended to a log keyed by (signature, mint, wallet, kind), and the position is
-- RECOMPUTED by folding that log through basis.ts. Two writers can no longer clobber
-- one another because neither writes state: they write FACTS, and the position is a
-- pure function of the facts. A live buy landing mid-walk has already inserted its
-- own row, so the fold simply picks it up. Nothing to clobber, nothing to abort, and
-- a hot wallet converges.
--
-- The PRIMARY KEY is what makes replay idempotent. INSERT OR IGNORE, always:
-- re-walking a wallet's history inserts nothing new and changes nothing.

CREATE TABLE swaps (
  signature    TEXT NOT NULL,
  mint         TEXT NOT NULL,
  wallet       TEXT NOT NULL,

  -- Direction lives HERE, not in the sign of tokens_raw. A TEXT bigint has no
  -- reliable sign, and the fold switches on `kind` anyway.
  kind         TEXT NOT NULL CHECK (kind IN ('buy','sell','transfer_in','transfer_out')),
  tokens_raw   TEXT NOT NULL,          -- always POSITIVE. TEXT: bigint-safe (INVARIANT 6).

  -- NULL for transfers. A transfer has no quote leg — that is what makes it a transfer.
  quote_mint   TEXT,
  quote_raw    TEXT,
  quote_symbol TEXT,

  -- 0 for transfers: they were FREE. Zero-cost tokens correctly drag avgCost down,
  -- so an airdrop can never become phantom profit.
  usd_value    REAL NOT NULL DEFAULT 0,

  -- The wallet's ABSOLUTE on-chain holding straight after this swap, when the
  -- transaction revealed it. This is what makes `positions` a TOTAL fold: without it,
  -- onchain_raw would be un-derivable and the ledger could not be rebuilt from the log
  -- alone. NULL only for rows seeded from `buys`, which never persisted it.
  balance_after_raw TEXT,

  slot         INTEGER NOT NULL,
  block_time   INTEGER,
  source       TEXT NOT NULL CHECK (source IN ('live','backfill')),

  PRIMARY KEY (signature, mint, wallet, kind)
);

-- The fold's only access path: every swap for one (mint, wallet), in slot order.
CREATE INDEX idx_swaps_mint_wallet_slot ON swaps (mint, wallet, slot);

-- Known-INCOMPLETE history: the backfill hit the 1000-signature cap, or a priced leg
-- would not resolve. Drift can read as zero on a truncated history while the cost
-- basis is still missing legs, so this vetoes reconciliation INDEPENDENTLY of drift.
-- Default 0 — "no known truncation" — which is right for a wallet we have watched
-- since its first token.
ALTER TABLE positions ADD COLUMN history_truncated INTEGER NOT NULL DEFAULT 0;

-- Seed the log from what we already persisted. `buys` only ever held BUYS, and only
-- ones observed live, so kind and source are both exact here rather than a guess.
--
-- SELLS WERE NEVER PERSISTED. Any position whose fold now disagrees with its old row
-- was therefore ALREADY WRONG — the sell that moved it was applied to a mutable row
-- and then forgotten. We log those at boot rather than papering over them; the
-- wallet's next buy reconciles it against the chain, which is the only authority that
-- was ever going to settle it.
INSERT OR IGNORE INTO swaps (signature, mint, wallet, kind, tokens_raw,
                             quote_mint, quote_raw, quote_symbol,
                             usd_value, balance_after_raw, slot, block_time, source)
SELECT signature, mint, buyer, 'buy', tokens_raw,
       quote_mint, quote_raw, quote_symbol,
       usd_in, NULL, slot, block_time, 'live'
  FROM buys;

-- The rebuild that follows this seed is a bigint fold, which SQLite cannot express:
-- SUM() over a TEXT u64 rounds through a float and loses the low bits (INVARIANT 6).
-- So it runs in code, at boot, exactly once — guarded by this marker. See
-- SqliteRepo#rebuildOnce.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
