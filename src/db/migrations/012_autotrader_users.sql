-- Phase 12: the autotrader allowlist (INVARIANT 14).
--
-- Membership is HAND-ENTERED and nothing else grants it. There is deliberately no join to
-- `chat_plans`, no `plan` column and no flag on `chats`: if a paid tier could widen this
-- table, then buying a plan would buy the right to have the bot hold your keys, and that is
-- not a thing anyone should be able to buy by accident.
--
-- `locked` is the revocation state and it is NOT the same as absence. Removing a member sets
-- locked=1 and pauses their schedules; their keystore FILE stays on disk untouched, because
-- it is their key and revoking access is not authority to destroy it (INVARIANT 14).
-- Deletion is /trader purge, which is a different, louder, typed-confirmation act.
CREATE TABLE IF NOT EXISTS autotrader_users (
  user_id   INTEGER PRIMARY KEY,
  label     TEXT,
  added_by  INTEGER,
  added_at  INTEGER NOT NULL,
  -- Revoked-but-not-destroyed. A locked member is off the allowlist for every action.
  locked    INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  locked_at INTEGER
);

-- Audit trail for membership changes. Who added or removed whom, and when.
--
-- Kept separate from the table above so that a removal followed by a re-add does not erase
-- the fact that the removal happened. Access to other people's money is exactly the kind of
-- thing where "who granted this, and when" must survive the grant being revoked.
CREATE TABLE IF NOT EXISTS autotrader_access_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL,
  action    TEXT NOT NULL CHECK (action IN ('add', 'remove', 'purge')),
  actor     INTEGER,
  at        INTEGER NOT NULL,
  note      TEXT
);

CREATE INDEX IF NOT EXISTS idx_autotrader_access_log_user ON autotrader_access_log (user_id, at);
