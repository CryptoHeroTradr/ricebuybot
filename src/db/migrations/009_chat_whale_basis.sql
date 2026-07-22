-- Phase 8. `whale_basis` becomes PER-CHAT.
--
-- It was a process-wide env var (WHALE_BASIS), which is fine for one deployment and wrong
-- for a multi-tenant bot: two groups on one process must be able to disagree about whether
-- the buy itself counts towards the bag that makes you a whale. One community wants "you
-- crossed $10k with this trade, welcome aboard" (post); another wants "you were already a
-- whale before you touched us" (pre). Neither is wrong, and neither gets to decide for the
-- other.
--
-- The env var stays as the DEFAULT for a newly-added token, so nothing changes for an
-- operator who never touches the command.
ALTER TABLE chat_tokens ADD COLUMN whale_basis TEXT NOT NULL DEFAULT 'post'
  CHECK (whale_basis IN ('pre','post'));
