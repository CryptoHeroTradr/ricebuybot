# RiceBuybot — Operations

Everything you need to answer "is it working, and if not, why not" without reading the source.

```bash
systemctl status ricebuybot
journalctl -u ricebuybot -f                      # live
journalctl -u ricebuybot -o cat | jq 'select(.msg=="buy")'   # just the buys
curl -s localhost:3012/health | jq
```

---

## `/health`

`GET http://127.0.0.1:3012/health`. Bound to localhost — it is not, and must not be, public.

It reports **local state only**. It never calls Helius or Telegram: a health check a third
party can make fail is a health check that restarts you for somebody else's outage.

```json
{
  "ok": true,
  "uptime": 84213,
  "wsConnected": true,
  "activeMints": 2,
  "solUsd": 77.14,
  "lastBuyAgeSec": 43,
  "queueDepth": 0,
  "deliveredToday": 128,
  "mediaItems": 82,
  "mediaUploaded": 82,
  "mediaPending": 0
}
```

| Field | What it means | When to worry |
| --- | --- | --- |
| `ok` | the process is up and the snapshot was readable | `false` → something threw while reading state |
| `uptime` | seconds since boot | resetting repeatedly = a crash loop (check the watchdog) |
| `wsConnected` | the Helius Enhanced WebSocket is connected | **`false` for >120s and the watchdog kills the process on purpose.** See below. |
| `activeMints` | distinct mints across enabled, unpaused chats | `0` means nobody has configured a token — the bot is idle by definition, not broken |
| `solUsd` | latest SOL/USD | **`null` means both price feeds are stale.** SOL-quoted buys are being HELD (not lost). USDC-quoted buys still post. |
| `lastBuyAgeSec` | seconds since the last buy we posted | `null` = none yet. A large number on a busy token is the loudest possible signal that ingestion is dead — louder than `wsConnected`, because it is about outcomes. |
| `queueDepth` | messages waiting to send | steadily climbing = we are being rate-limited (see 429 below) |
| `deliveredToday` | cards actually sent since UTC midnight | |
| `mediaItems` | live memes across every active mint | |
| `mediaUploaded` | of those, how many Telegram already has a `file_id` for | |
| `mediaPending` | `mediaItems - mediaUploaded` | non-zero right after seeding is normal — the warm-up uploads one every 2s in the background |

---

## A normal buy

**Exactly one `info` line per buy.** Everything else is `debug`.

```json
{
  "level": "info",
  "time": 1784051448318,
  "svc": "ricebuybot",
  "sig": "5j7s6NiJS3JAkvgkoc18WVAsiSaci2px...",
  "mint": "2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump",
  "usd": 23.29,
  "holdingsUsd": 52400.12,
  "earnedTier": "Whale",
  "usedTier": "big",
  "mediaSha": "45f6149ad32bb535e27ed25aaecf8596bff6179c...",
  "chatsPosted": 2,
  "msg": "buy"
}
```

Read it like this:

- **`earnedTier` + `holdingsUsd` together answer "why did that fire as a whale?"** without you
  re-deriving anything. A $23 buy is a Whale because the wallet holds $52,400 — the tier is
  denominated in **holdings**, not buy size. That question is the single most common one this
  bot will ever generate, and it is answerable from one log line.
- **`usedTier` ≠ `earnedTier`** (here: Whale earned, big art used) means the `whale/` folder was
  empty and the card borrowed art from `big/`. **The headline still said WHALE.** This is normal
  and intended — but if you see it constantly, run `/mediastats` and stock that tier.
- `chatsPosted: 0` means every watching chat filtered it out on `min_buy_usd`.

Boot looks like:

```
ricebuybot starting  {"dryRun":false,"mediaSource":"local","defaultMint":"2wQq…"}
SOL/USD bootstrapped {"price":77.14,"source":"binance"}
ws connected         {"mints":2}
telegram commands registered
```

---

## The four failure modes

### 1. WebSocket down

**What you see:**

```
warn  ws error   {"err":"Unexpected server response: 401"}
warn  ws error   {"err":"Unexpected server response: 401"}
fatal websocket down past the limit — exiting so systemd can restart us clean.
      A silently-dead bot is worse than a crash loop.  {"downMs":120431}
```

`/health`: `"wsConnected": false`, and `lastBuyAgeSec` climbing forever.

**What it means.** `401` is a **dead or unpaid Helius key** — `transactionSubscribe` on
`atlas-mainnet` requires a paid plan. Other errors (`ECONNRESET`, timeouts) are ordinary and the
ingestor reconnects with backoff + jitter; you will see `ws connected` again within seconds.

**Why it exits rather than retrying forever.** The reconnect loop is already running, so 120s
down means the retries are *not working*. And a bot in that state looks **identical to a healthy
one from the outside**: the process is up, `/health` answers `200`, the logs are quiet, and no
buys are posted. That is the worst failure this system has, because nobody notices it. A crash
loop is noisy and gets fixed.

**Fix:** check the key with a *real* RPC method (`getHealth` answers `ok` **without a valid
key** — it is useless as a probe):

```bash
curl -sS -X POST "$HELIUS_RPC_URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getTokenSupply","params":["2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump"]}'
```

On restart, **gap recovery** pulls back the buys missed during the outage — up to 10 minutes'
worth. Anything older is deliberately skipped and logged.

---

### 2. SOL price stale

**What you see:**

```
warn  SOL/USD feed is stale on BOTH sources; holding SOL-quoted buys
info  buy held: SOL feed stale  {"signature":"…","heldCount":3}
...
info  SOL/USD feed recovered
```

`/health`: `"solUsd": null`.

**What it means.** Binance.US (primary) and Coinbase (secondary) are both >30s stale. SOL-quoted
buys **cannot be priced**, so they are **held in a bounded queue (200, evict-oldest)** — *not
dropped* — and flushed when the feed comes back.

**Note what still works:** **USDC/USDT-quoted buys post normally.** The staleness guard is scoped
to buys that actually need a SOL price. One dead websocket must not hold back buys it has no
bearing on.

**Usually this fixes itself.** If it does not, it is a network problem on the box, not a bug in
the bot. Nothing is lost unless the hold queue overflows (200 buys), which would require a very
long outage on a very busy token.

---

### 3. Telegram 429 (rate limited)

**What you see:**

```
warn  429 — backing off exactly as told  {"chatId":-1001…,"retryAfterSec":7,"attempt":1}
warn  dropping a stale buy — a late post is worse than none  {"ageMs":121004}
```

`/health`: `queueDepth` climbing.

**What it means.** Telegram throttles a bot's posts to a group at roughly **20/minute**. The
queue paces at 1 per 3s per chat and 25/s globally, and on a `429` it waits **exactly** the
`retry_after` Telegram gives — never a doubling ramp on top, which is how a 429 becomes a ban.

**A buy older than 120s is dropped, on purpose.** A card claiming "just now" about a
two-minute-old trade posts a price that is no longer true and makes every *other* card look
untrustworthy. Dropping is the correct outcome, not a degraded one.

**If a launch pump is the cause,** the burst detector should already have switched that mint to
digest mode (>20 qualifying buys in 60s → one aggregate message per minute):

```
info  digest posted (burst mode)  {"count":37,"totalUsd":8241.55,"tier":"Whale"}
```

Seeing sustained 429s *without* a digest line means the burst threshold is not being reached but
several groups are all being posted to at once. Consider `DAILY_SEND_CAP`, or fewer groups per
mint.

---

### 4. Empty media pool

**What you see:** nothing in the logs at all — and that is the point. A pool with no art is not
an error.

```json
{"msg":"buy","earnedTier":"Whale","usedTier":null,"mediaSha":null,"chatsPosted":1}
```

`usedTier: null` + `mediaSha: null` = the card went out as **text only**. **The buy still
posted.** Never fail a post because art is missing.

`/health`: `"mediaItems": 0`.

**What to check:** run `/mediastats` in the group. It will tell you, in order of severity:

- **`⚠️ Massive is empty`** — Massive buys are borrowing art from another tier. The headline still
  says MASSIVE, so *nobody but you will ever notice*. This is the most common silent
  degradation in the whole system.
- **`⏳ N not uploaded`** — the background warm-up is still running. Normal after seeding.
- **`⚠️ N files unpublished (not content-addressed)`** — **someone copied files into a tier
  folder by hand.** The generator refuses anything whose filename is not its content hash, and
  it only ever says so in a systemd journal nobody reads. Those files are on disk, invisible to
  the bot, and the curator is convinced the bot ignored them. It did.
  Fix on the box: `sudo rice-tier <tier> /srv/media/<mint>/<tier>/<file>`

---

## Routine checks

```bash
# Is it alive and posting?
curl -s localhost:3012/health | jq '{wsConnected, solUsd, lastBuyAgeSec, queueDepth}'

# The last 20 buys
journalctl -u ricebuybot -o cat | jq -c 'select(.msg=="buy") | {usd, earnedTier, usedTier, chatsPosted}' | tail -20

# Anything that went wrong today
journalctl -u ricebuybot --since today -p warning

# The manifest timer (media pool)
systemctl list-timers ricebuybot-manifest.timer ricebuybot-backup.timer

# Backups
ls -lt /var/lib/ricebuybot/backups/ | head
```

## Secrets

`INVARIANT 5`: no key, token or wallet ever enters a log line. Anything carrying a URL goes
through `scrubUrl()` first — the Helius key lives in the query string, and the key *name* is
innocent while the *value* is not.

If you ever see a key in the logs, that is a **bug**, and the key is now burned. Rotate it.
