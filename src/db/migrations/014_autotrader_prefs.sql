-- Phase 15: per-user autotrader preferences.
--
-- The control panel shows ONE contract (mint) per user, and it must exist even before the user has
-- any schedules — a fresh member setting up needs a target to configure against. Schedules each
-- carry their own mint (so a contract change never silently retargets an existing schedule); this
-- row is the DEFAULT the next `/trade new` uses, and the contract the panel displays.
--
-- Scoped by user_id and nothing else (INVARIANT 14): one member's contract is not another's.
CREATE TABLE IF NOT EXISTS autotrader_prefs (
  user_id       INTEGER PRIMARY KEY REFERENCES autotrader_users(user_id),
  contract_mint TEXT    NOT NULL,
  updated_at    INTEGER NOT NULL
);
