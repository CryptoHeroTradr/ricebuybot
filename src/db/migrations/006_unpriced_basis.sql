-- Phase 4.7: tell a FREE RECEIPT apart from a PURCHASE WE CANNOT VALUE.
--
-- Since 4.6 both arrive as `transfer_in` with usd_value 0, and that conflation is a
-- lie waiting to be published:
--
--   * An AIRDROP has no counter-leg. It really was free. Zero cost is the TRUTH, the
--     wallet's entire bag is profit, and we should say so.
--   * An ARB — the wallet acquired the mint by giving up some non-registry token —
--     has a counter-leg we cannot price. The wallet PAID. Booking it at zero cost
--     manufactures a cost basis of nothing and renders a vast, confident, wrong
--     Position %. That is precisely what INVARIANT 10 exists to prevent.
--
-- We do NOT go and fetch a price for the counterparty token. A USD price for an
-- arbitrary SPL token is a guess wearing a decimal point, and dressing a guess up as
-- a percentage is the failure mode, not the fix. We ABSTAIN.
--
-- `unpriced` is set in the PARSER, at classification time — the only place where all
-- of a wallet's deltas for a transaction are in one hand. Downstream sees a row, not
-- a transaction, and could not recompute it.

ALTER TABLE swaps ADD COLUMN unpriced INTEGER NOT NULL DEFAULT 0;

-- DERIVED by the fold: true iff ANY swap row for this (mint, wallet) is unpriced.
-- One unvaluable leg poisons the weighted average, so it poisons the whole position.
--
-- Stored only because `positions` is a materialized view; it is never REMEMBERED —
-- the rebuild-from-swaps-alone test would catch it if it were.
ALTER TABLE positions ADD COLUMN basis_unpriced INTEGER NOT NULL DEFAULT 0;

-- EXISTING TRANSFER ROWS ABSTAIN.
--
-- Every transfer already in the log was classified BEFORE this distinction existed, so
-- we genuinely do not know whether it was a gift or a purchase — the counter-leg was
-- never recorded, and the row alone cannot tell us. `unpriced = 1` is therefore the
-- only honest value: it means "we cannot value this", and we cannot.
--
-- Getting this wrong is not academic. Phase 4.7 also starts RENDERING a reconciled
-- zero basis as "🎁 Free bag — 100% profit". Leaving these rows at 0 would take every
-- legacy arb — a wallet that PAID for its bag — and publish exactly that line about
-- it. The migration that introduces the free-bag line must not simultaneously hand it
-- a pile of wallets it is false about.
--
-- The cost of abstaining is small and self-healing: an affected wallet shows no
-- Position % until its next backfill re-walks its history through the one parser,
-- which sets the flag correctly and restores the line if it really was a gift.
-- Buys and sells are untouched: a registry quote leg is what made them buys and sells,
-- so they were always priceable.
UPDATE swaps SET unpriced = 1 WHERE kind IN ('transfer_in', 'transfer_out');
