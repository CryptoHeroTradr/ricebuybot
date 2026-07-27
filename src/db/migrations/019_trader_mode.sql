-- Phase 7: PER-USER MODE, and the wallet-mode DCA attribution set.
--
-- The autotrader now has two modes, and the difference between them is WHO HOLDS THE KEY:
--
--   'wallet' (the DEFAULT for every new member) — the user runs DCA as Jupiter recurring orders
--            from their OWN wallet, via the Mini App / the site. The bot holds no key for them,
--            ticks no schedule for them, and signs nothing for them.
--   'key'    (opt-in only)                      — the phases 12-16 custodial scheduler, unchanged.
--
-- The mode lives on autotrader_users and NOWHERE else. Same reasoning as the allowlist itself
-- (INVARIANT 14): there is no plan, flag or config that can move a user into 'key' — only an
-- explicit switch by that user, with the custody warning and a typed acknowledgement.

-- --- the mode column ------------------------------------------------------------------------
--
-- DEFAULT 'wallet': a brand-new member is a wallet-mode member and the bot holds nothing of
-- theirs. Sending a key is opt-in, never the path of least resistance.
ALTER TABLE autotrader_users ADD COLUMN mode TEXT NOT NULL DEFAULT 'wallet'
  CHECK (mode IN ('wallet', 'key'));

-- --- the backfill, and why it is 'key' and not the column default ----------------------------
--
-- THE ABSTENTION PRINCIPLE, applied carefully. The rule is that a migration must never apply a
-- NEW claim to rows classified before the distinction existed. The new claim here is the
-- wallet-mode one: "the bot holds no key for this person and signs nothing for them."
--
-- Every row already in this table was created when custody was the ONLY thing membership meant:
-- these are the people who were added so the bot could hold a key and trade for them, some of
-- whom have a keystore on disk and live schedules right now. Letting the DEFAULT fall on them
-- would assert the new claim about exactly the users it is false for — and the consequences are
-- not cosmetic: their schedules would stop ticking, their /wallet surface would start refusing
-- them, and their key would sit in a keystore the bot now says it does not hold.
--
-- So 'key' here is not "assume the good case". It is the RECORD OF WHAT WAS TRUE when the row
-- was written. The default governs rows written from now on, where wallet mode really is the
-- truth by construction. Anyone in this backfill who wants out has an explicit, safe path:
-- /mode wallet, which refuses while a custodial schedule is still active.
UPDATE autotrader_users SET mode = 'key';

-- --- wallet-mode DCA attribution --------------------------------------------------------------
--
-- Phase 16 attributes a DCA buy by asking whether its signature has an `executions` row — i.e.
-- "was this one of OUR sends". A wallet-mode DCA has no execution row: Jupiter's recurring
-- program moved the user's own money from the user's own wallet, and the bot signed nothing.
--
-- This table is the OTHER half of the same attribution set. It is deliberately shaped like
-- `executions` is used at flush time — a side table the `buys` query joins to — so the aggregate
-- card, the window, the cursor, the claim key and the disclosure copy are all reached by the
-- exact Phase 16 path with nothing new bolted on.
--
-- A row is written at ingest time, and ONLY when both halves hold:
--   1. the buyer address belongs to an allowlisted, unlocked, wallet-mode member (proven by the
--      Phase 6 wallet-ownership signature that wrote `site_links`), AND
--   2. the transaction touched a Jupiter recurring-order program.
--
-- Condition 2 is what keeps a villager's MANUAL ape out of here. See src/ingest/recurring.ts.
CREATE TABLE IF NOT EXISTS wallet_dca_buys (
  signature TEXT NOT NULL,
  mint      TEXT NOT NULL,
  buyer     TEXT NOT NULL,
  -- The window this buy belongs to, in ms. Block time where the chain gave us one, else our
  -- observation time — decided ONCE at write time so the flush query stays a plain range scan
  -- and a replay can never re-bucket a buy into a different (already flushed) window.
  at        INTEGER NOT NULL,
  -- Same key as `buys` itself, so a gap-recovery replay of the same transaction collides with
  -- the row it already wrote instead of double-counting it into the aggregate.
  PRIMARY KEY (signature, mint, buyer)
);

CREATE INDEX IF NOT EXISTS idx_wallet_dca_buys_window ON wallet_dca_buys (mint, at);

-- No index is added for the address lookup itself: it reads site_links by wallet_pubkey, which
-- migration 018 already made UNIQUE, and joins autotrader_users by its primary key. That lookup
-- runs once per observed buy and is deliberately NOT cached — a revoked member's buys must stop
-- being attributed NOW, not at the end of some TTL. Same reasoning as the access gate.
