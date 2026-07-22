-- Phase 4: the ledger must be checked against the chain, on every buy.
--
-- Without this, Position % is a confident public lie: cost_usd/tokens_raw is built
-- only from buys the bot observed, while holdingsUsd comes from balanceAfterRaw,
-- which is exact and on-chain. For any wallet with history the bot never saw, the
-- two describe different quantities.
--
-- balanceAfterRaw arrives on every buy, so every buy is a reconciliation
-- checkpoint and this costs us nothing.

-- Last balanceAfterRaw seen from the chain. Exact. TEXT: bigint-safe.
ALTER TABLE positions ADD COLUMN onchain_raw TEXT NOT NULL DEFAULT '0';

-- Ledger tokens_raw agrees with the chain (to within 1 raw unit of dust).
ALTER TABLE positions ADD COLUMN reconciled INTEGER NOT NULL DEFAULT 0;

-- onchain_raw - tokens_raw, SIGNED. Nonzero => we are missing history.
--   drift > 0  chain holds more than we know about (unseen buys / airdrop)
--   drift < 0  we think they hold more than they do (transferred out / unseen sell)
ALTER TABLE positions ADD COLUMN drift_raw TEXT NOT NULL DEFAULT '0';

-- When the one-shot backfill last ran for this wallet. NULL = never.
-- Drives the 24h per-wallet cache: a wallet whose history we already walked must
-- not be re-walked on every buy.
ALTER TABLE positions ADD COLUMN backfilled_at INTEGER;

-- Find the wallets that still need a backfill.
CREATE INDEX idx_positions_unreconciled ON positions (reconciled, backfilled_at);
