-- Site bridge (READ-ONLY): the ONLY new server state for the website<->bot link.
--
-- Maps a proven Telegram user to a proven wallet. It carries nothing sensitive on its own — no
-- key, no schedule, no balance — just the identity link the read endpoint needs to answer
-- "whose schedules is this wallet allowed to see". Everything the site returns is derived from
-- the EXISTING per-user schedule tables via this mapping; the bridge never writes a schedule.
--
-- Keyed both ways so the link is one-to-one and re-linking REPLACES rather than accumulates:
--   * PRIMARY KEY (telegram_user_id) — one Telegram user maps to exactly one wallet.
--   * UNIQUE (wallet_pubkey)         — one wallet maps to exactly one Telegram user.
-- linkSite() deletes any prior row for the incoming wallet first, so the newest proof wins and a
-- wallet can never be readable under two users.
CREATE TABLE IF NOT EXISTS site_links (
  telegram_user_id INTEGER PRIMARY KEY,
  wallet_pubkey    TEXT    NOT NULL UNIQUE,
  created_at       INTEGER NOT NULL
);
