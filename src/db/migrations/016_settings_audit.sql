-- Phase 16 (6): the settings audit trail, and the daily digest.
--
-- WHAT/FROM/TO/WHEN for every autotrader setting change a user makes. This is NOT the
-- membership log (autotrader_access_log, migration 012 — who was added/removed) and NOT the
-- executions table (what the bot DID with the money). It is the record of every knob a user
-- turned: an interval, a slippage, a cap, the contract, a pause/resume/delete.
--
-- Money and amounts are stored as TEXT exactly as they were shown to the user (a dollar
-- figure, a bps integer, a minute count, a base58 mint). This is a human-readable audit
-- surface, not a ledger the fold reads — INVARIANT 6 is about arithmetic on balances, and
-- nothing here is ever summed. from_value is NULL for a creation; to_value is NULL for a
-- deletion; both may be NULL for a bulk action (stop-all) that carries only a count.
--
-- Kept append-only and never updated. A setting changed back and forth leaves two rows, in
-- order, which is the whole point of an audit trail.
CREATE TABLE IF NOT EXISTS autotrader_settings_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  -- The knob. e.g. 'schedule.create', 'schedule.interval', 'schedule.slippage',
  -- 'schedule.amount', 'schedule.pause', 'schedule.resume', 'schedule.delete',
  -- 'stop_all', 'resume_all', 'caps', 'contract', 'wallet'.
  action      TEXT NOT NULL,
  -- The schedule this touched, when it touched one. NULL for account-wide changes (caps,
  -- contract, wallet, stop_all/resume_all).
  schedule_id INTEGER,
  -- The specific field, when one action changes more than one thing over time. NULL when the
  -- action names the field (a pause has no field).
  field       TEXT,
  from_value  TEXT,
  to_value    TEXT
);

CREATE INDEX IF NOT EXISTS idx_settings_audit_user ON autotrader_settings_audit (user_id, at);
