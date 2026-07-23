-- Phase 13: DCA schedules, per-user caps, and the executions ledger.
--
-- THIS PHASE DECIDES WHAT AND WHEN. It does not execute — Phase 14 does. Splitting them
-- is deliberate: a scheduling bug caught here costs a log line, not real money. The whole
-- surface runs in dry-run until a day of logs has been read.
--
-- EVERYTHING IS SCOPED BY user_id. A query in this phase that forgets its user_id filter is
-- not a style nit — it is one person's runaway schedule spending another person's money, or
-- one person seeing another's trades. `executions.user_id` is denormalised for exactly that
-- reason: the cap sums and the self-referential joins must filter by user without a join
-- back through `schedules`, so the filter can never be accidentally dropped in a join.

-- A recurring buy or sell. Owned by exactly one autotrader member; nothing widens that
-- (INVARIANT 14) — there is no plan column and no join to chat_plans, same as the allowlist.
CREATE TABLE IF NOT EXISTS schedules (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES autotrader_users(user_id),
  mint             TEXT    NOT NULL,
  side             TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),
  -- Raw integer amounts, stored as TEXT (INVARIANT 6: money is integers; SQLite REAL would
  -- round a u64 through a float). buy: lamports of SOL to spend. sell: raw token units to sell.
  amount_raw       TEXT    NOT NULL,
  amount_kind      TEXT    NOT NULL CHECK (amount_kind IN ('absolute', 'percent_of_balance')),
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes > 0),
  slippage_bps     INTEGER NOT NULL DEFAULT 100,
  state            TEXT    NOT NULL CHECK (state IN ('active', 'paused', 'halted')),
  -- Why a schedule stopped itself. Set with state='halted'; NULL otherwise. A halt is never
  -- silent — the owner is meant to be told and to act.
  halt_reason      TEXT,
  next_run_at      INTEGER NOT NULL,
  last_run_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- The tick scans active schedules by due time. Scoped-by-nothing on purpose: the tick serves
-- every user, and each ROW carries its own user_id — the per-user boundary is enforced at the
-- cap sums, not by hiding rows here.
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules (state, next_run_at);

-- PER-USER, PER-MINT caps. One person's runaway schedule must never consume another's headroom,
-- which is why the key is (user_id, mint) and every cap sum is filtered by user_id.
CREATE TABLE IF NOT EXISTS caps (
  user_id                  INTEGER NOT NULL,
  mint                     TEXT    NOT NULL,
  max_per_exec_usd         REAL    NOT NULL,
  max_per_day_usd          REAL    NOT NULL,
  -- Keep 0.02 SOL for fees, ALWAYS. A wallet with no SOL for fees is a wallet that cannot sell
  -- — so a buy that would drop the balance below this is skipped, never executed.
  min_sol_reserve_lamports TEXT    NOT NULL DEFAULT '20000000',
  PRIMARY KEY (user_id, mint)
);

-- THE LEDGER. Same shape and the same discipline as the `sends` table (INVARIANT 2): one
-- atomic claim per slot resolves every race — an overlapping tick or a restart replay — in
-- the storage engine, and `changes` tells us who owns it. A read-then-check would double-spend.
CREATE TABLE IF NOT EXISTS executions (
  id          INTEGER PRIMARY KEY,
  schedule_id INTEGER NOT NULL REFERENCES schedules(id),
  -- Denormalised deliberately (see the header): cap queries and the self-buy join both need
  -- the owner without a join back to schedules, so the user_id filter can never be dropped.
  user_id     INTEGER NOT NULL,
  planned_at  INTEGER NOT NULL,
  -- 'claimed'   -> this process owns the slot (set atomically, before anything is spent)
  -- 'submitted' -> a signature exists on-chain but is not yet confirmed (Phase 14)
  -- 'confirmed' -> settled
  -- 'failed'    -> did not happen; `error` says why. In Phase 13 every claim ends here as 'dry-run'.
  -- 'UNKNOWN'   -> outcome uncertain (INVARIANT 16): a submitted tx we could not resolve. Counts
  --                against the 24h cap because it MAY have spent, and is never retried.
  state       TEXT    NOT NULL CHECK (state IN ('claimed', 'submitted', 'confirmed', 'failed', 'UNKNOWN')),
  signature   TEXT,                 -- set at submit, BEFORE confirmation (Phase 14)
  in_raw      TEXT,
  out_raw     TEXT,
  price_usd   REAL,
  usd_value   REAL,
  error       TEXT,
  -- THE IDEMPOTENCY KEY: one execution per schedule per slot, ever. This is what makes the
  -- claim atomic and a double-fire impossible, exactly as (signature, chat_id) does for sends.
  UNIQUE (schedule_id, planned_at)
);

CREATE INDEX IF NOT EXISTS idx_executions_state      ON executions (state);
CREATE INDEX IF NOT EXISTS idx_executions_signature  ON executions (signature);
-- The rolling-24h cap sum filters by (user_id, planned_at). This index serves it directly.
CREATE INDEX IF NOT EXISTS idx_executions_user_time  ON executions (user_id, planned_at);
