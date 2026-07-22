-- Phase 2.5: buys are no longer necessarily SOL-quoted.
--
-- quote_lamports assumed one asset. A Jupiter swap paid from a USDC balance is an
-- ordinary user action, and those buys were being silently eaten. Replace the one
-- column with the three that describe any quote asset.
--
-- SQLite cannot rename/retype a column inside a PK-bearing table cleanly, so we
-- rebuild. Existing rows are all SOL-quoted by construction (that was the only
-- thing the old normalizer could emit), so backfilling them as SOL is exact, not
-- a guess.

CREATE TABLE buys_new (
  signature    TEXT NOT NULL,
  mint         TEXT NOT NULL,
  buyer        TEXT NOT NULL,
  quote_mint   TEXT NOT NULL,
  quote_symbol TEXT NOT NULL,
  quote_raw    TEXT NOT NULL,          -- raw units OF THE QUOTE ASSET. TEXT: bigint-safe.
  tokens_raw   TEXT NOT NULL,
  usd_in       REAL NOT NULL,
  price_usd    REAL NOT NULL,
  slot         INTEGER NOT NULL,
  block_time   INTEGER,
  PRIMARY KEY (signature, mint, buyer)
);

INSERT INTO buys_new (signature, mint, buyer, quote_mint, quote_symbol, quote_raw,
                      tokens_raw, usd_in, price_usd, slot, block_time)
SELECT signature, mint, buyer,
       'So11111111111111111111111111111111111111112', 'SOL', quote_lamports,
       tokens_raw, usd_in, price_usd, slot, block_time
  FROM buys;

DROP TABLE buys;
ALTER TABLE buys_new RENAME TO buys;

-- The old indexes went with the old table.
CREATE INDEX idx_buys_mint_slot  ON buys (mint, slot DESC);
CREATE INDEX idx_buys_buyer_mint ON buys (buyer, mint);
