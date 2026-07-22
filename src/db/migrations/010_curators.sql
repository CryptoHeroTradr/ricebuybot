-- Phase 8.5. Who may put a meme on a group's buy card.
--
-- THIS IS THE SECURITY BOUNDARY OF THE DM FLOW. A stranger who finds the bot and DMs it
-- must not be able to add art to $RICE — a DM has no group around it to provide context,
-- no admins watching, and no obvious blast radius. The meme goes on the card of every group
-- tracking that mint, in front of everyone.
--
-- Authorization is DERIVED, not stored:
--
--   a user may curate a mint IFF they are a verified admin (getChatMember, AT ACTION TIME)
--   of some chat configured for that mint — or they are the bot owner.
--
-- This table is only for EXPLICIT grants: a community manager who is not a Telegram admin
-- of the group but is trusted to curate. It ADDS to the derived permission; it never
-- replaces the admin check, and it is never consulted as a cache of one.
--
-- A cache would be the bug. Admin status changes, and the whole point of demoting someone
-- is that they stop being able to act immediately. See INVARIANT 8.
CREATE TABLE curators (
  user_id    INTEGER NOT NULL,
  mint       TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  granted_by INTEGER,
  PRIMARY KEY (user_id, mint)
);

CREATE INDEX idx_curators_mint ON curators (mint);
