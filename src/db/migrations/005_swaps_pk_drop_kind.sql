-- Phase 4.6: the swaps PK becomes (signature, mint, wallet). `kind` leaves the key.
--
-- WHY: one transaction can move a wallet's balance of one mint in exactly one net
-- direction. `kind` is DERIVED from the sign of that net delta — it is descriptive,
-- not identifying.
--
-- Keeping it in the key made double-counting contingent on two code paths agreeing
-- about classification. If the live socket called a transaction a `buy` and the
-- backfill called the same transaction a `transfer_in`, the two rows had different
-- keys, INSERT OR IGNORE ignored nothing, and the wallet's tokens were counted TWICE
-- — silently, in the ledger that decides what Position % we publish.
--
-- That is not a property to test for. It is a property to DESIGN OUT. With `kind` out
-- of the key, the second write collides with the first no matter what either path
-- decided the transaction was. The hazard is structurally gone rather than merely
-- dormant, which is also why Phase 4.6 deletes the second parser outright: there is
-- now exactly one classifier, and the key no longer depends on it.
--
-- SQLite cannot alter a primary key, so the table is rebuilt.
--
-- COLLAPSING EXISTING DUPLICATES: any (signature, mint, wallet) group with more than
-- one row is a REAL double-count already sitting in the ledger. SqliteRepo logs every
-- such group, with its signatures, BEFORE this migration runs — they are not merged
-- silently. The winner is the `live` row if there is one (it is what the bot actually
-- saw and posted from), else the earliest by slot. Affected positions are recomputed
-- afterwards, from the collapsed log.

CREATE TABLE swaps_new (
  signature    TEXT NOT NULL,
  mint         TEXT NOT NULL,
  wallet       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('buy','sell','transfer_in','transfer_out')),
  tokens_raw   TEXT NOT NULL,
  quote_mint   TEXT,
  quote_raw    TEXT,
  quote_symbol TEXT,
  usd_value    REAL NOT NULL DEFAULT 0,
  balance_after_raw TEXT,
  slot         INTEGER NOT NULL,
  block_time   INTEGER,
  source       TEXT NOT NULL CHECK (source IN ('live','backfill')),

  -- `kind` is still stored — the fold switches on it — but it no longer IDENTIFIES.
  PRIMARY KEY (signature, mint, wallet)
);

INSERT INTO swaps_new
SELECT s.signature, s.mint, s.wallet, s.kind, s.tokens_raw,
       s.quote_mint, s.quote_raw, s.quote_symbol, s.usd_value,
       s.balance_after_raw, s.slot, s.block_time, s.source
  FROM swaps s
 WHERE s.rowid = (
   SELECT t.rowid
     FROM swaps t
    WHERE t.signature = s.signature AND t.mint = s.mint AND t.wallet = s.wallet
    -- live wins; then the earliest slot; then the earliest row. Total, so the
    -- collapse is deterministic rather than whatever the b-tree happened to yield.
    ORDER BY (t.source = 'live') DESC, t.slot ASC, t.rowid ASC
    LIMIT 1
 );

DROP TABLE swaps;
ALTER TABLE swaps_new RENAME TO swaps;

-- The old index went with the old table.
CREATE INDEX idx_swaps_mint_wallet_slot ON swaps (mint, wallet, slot);
