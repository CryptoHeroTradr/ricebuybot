-- Phase 11. Billing plans.
--
-- `plan`, NOT `tier`. In this codebase `tier` means Regular/Big/Whale/Massive — folder names,
-- CHECK constraints, media_items.tier, 27 source files. A `chats.tier` column meaning "free vs
-- paid" would sit one word away from a completely unrelated concept and guarantee that someone
-- eventually reads the wrong one.
--
-- EXISTING CHATS BECOME 'free'.
--
-- This is the abstention principle (see CLAUDE.md) applied to money: a migration that
-- introduces a new claim must not hand that claim to rows that predate the distinction. There
-- is no evidence in any existing row that anybody paid for anything — there was nothing to pay
-- for — so defaulting them to 'paid' would silently gift every existing group the full feature
-- set forever, and nobody would ever notice, because gaining features is invisible.
--
-- Grandfathering, if you want it, is an OWNER DECISION made with /grant. It is not something a
-- schema migration gets to decide on your behalf.
ALTER TABLE chats ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'
  CHECK (plan IN ('free','paid'));

-- When the plan last changed, and who changed it. An owner granting a paid plan is a
-- commercial act; it should leave a trace.
ALTER TABLE chats ADD COLUMN plan_granted_at INTEGER;
ALTER TABLE chats ADD COLUMN plan_granted_by INTEGER;
