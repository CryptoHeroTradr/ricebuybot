-- Phase 4.8: `realized_pnl_usd` becomes NULLABLE, and the schema enforces the abstention.
--
-- Today the column always holds a number, and for any wallet with an unpriced SELL leg
-- that number is quietly wrong. A `transfer_out` into a token we cannot value disposes
-- of tokens and books NO realized PnL for that leg — because the PnL is genuinely
-- unknowable — so the running total silently omits a piece it can never learn.
--
-- Nothing renders it today. That is a COMMENT, not a guarantee. A PnL line added to a
-- whale card six months from now will read a column that looks authoritative, is typed
-- as authoritative, and is wrong. `NOT NULL DEFAULT 0` is the type system asserting a
-- fact we do not have.
--
-- So the abstention moves out of the documentation and into the type: NULL means
-- "unknowable", every reader must handle it, and the compiler makes them. This is the
-- same lesson as the lying type predicate in TokenMetaCache — an invariant that
-- depends on everyone remembering a comment is not an invariant.
--
-- NULL iff any swap row for the (mint, wallet) is an UNPRICED SELL — i.e. it disposed
-- of the mint into something we cannot value. NOT merely "unpriced":
--
--   unpriced BUY  (arb IN)  -> corrupts the cost BASIS. Already vetoed by
--                              basis_unpriced. Realized PnL is untouched: nothing was
--                              sold, so nothing was realized.
--   unpriced SELL (arb OUT) -> corrupts realized PnL, and ONLY realized PnL.
--
-- Two different blindnesses. Do not conflate them; a wallet that arbed IN still has a
-- perfectly good realized-PnL figure from its ordinary sells, and we should keep it.
--
-- SQLite cannot drop a NOT NULL constraint, so the table is rebuilt. `positions` is a
-- MATERIALIZED VIEW (INVARIANT 11), so this is cheap and safe: the fold is the source
-- of truth and every value here is re-derivable from `swaps`. The refold that follows
-- is guarded by a marker in SqliteRepo#rebuildOnce.

CREATE TABLE positions_new (
  mint              TEXT NOT NULL,
  buyer             TEXT NOT NULL,
  tokens_raw        TEXT NOT NULL DEFAULT '0',
  cost_usd          REAL NOT NULL DEFAULT 0,

  -- NULL = UNKNOWABLE. Not zero. Not "we haven't computed it yet".
  realized_pnl_usd  REAL,

  backfilled        INTEGER NOT NULL DEFAULT 0,
  onchain_raw       TEXT NOT NULL DEFAULT '0',
  drift_raw         TEXT NOT NULL DEFAULT '0',
  reconciled        INTEGER NOT NULL DEFAULT 0,
  backfilled_at     INTEGER,
  history_truncated INTEGER NOT NULL DEFAULT 0,
  basis_unpriced    INTEGER NOT NULL DEFAULT 0,
  first_seen        INTEGER,
  updated_at        INTEGER,
  PRIMARY KEY (mint, buyer)
);

INSERT INTO positions_new (mint, buyer, tokens_raw, cost_usd, realized_pnl_usd, backfilled,
                           onchain_raw, drift_raw, reconciled, backfilled_at,
                           history_truncated, basis_unpriced, first_seen, updated_at)
SELECT mint, buyer, tokens_raw, cost_usd, realized_pnl_usd, backfilled,
       onchain_raw, drift_raw, reconciled, backfilled_at,
       history_truncated, basis_unpriced, first_seen, updated_at
  FROM positions;

DROP TABLE positions;
ALTER TABLE positions_new RENAME TO positions;

-- The index went with the old table.
CREATE INDEX idx_positions_unreconciled ON positions (reconciled, backfilled_at);

-- The values copied above are carried over verbatim, including any that OUGHT to be
-- NULL. They are not left that way: the refold recomputes every position from the swap
-- log and writes NULL wherever an unpriced sell exists.
--
-- Per the migration principle (see CLAUDE.md): a migration that introduces a new claim
-- must never apply that claim to rows classified before the distinction existed. Here
-- the new claim is "this number is trustworthy", and we do not assert it for a single
-- pre-existing row — we re-derive them all.
