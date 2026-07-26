-- Lifetime spend cap for the autotrader, alongside the existing per-exec and per-24h caps.
--
-- NULLABLE on purpose: NULL means "no lifetime cap" — the unchanged behaviour for every
-- existing caps row and for anyone who never sets one. Only a row with a non-null value is
-- ever checked. Like the daily cap, the value stored here is CLAMPED to an env ceiling at
-- check time (a bad DB write must not raise the real limit), so this column is an input to
-- the guard, never the guard's own bound.
ALTER TABLE caps ADD COLUMN max_lifetime_usd REAL; -- NULL = no lifetime cap
