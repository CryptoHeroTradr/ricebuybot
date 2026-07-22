# RiceBuybot

Self-hosted, multi-tenant Telegram buy bot for Solana SPL tokens. Posts a card in your group
every time someone buys your token — with a tiered meme, the buy size, the buyer's position
and the market cap.

Flagship deployment is **$RICE** (`2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump`), but every
group configures its own mint, media, thresholds and emoji.

Node 22 · TypeScript (ESM, strict) · pnpm · SQLite · systemd. **No telemetry.**

---

## Contents

- [Quick start](#quick-start)
- [Deployment (VPS)](#deployment-vps)
- [Environment variables](#environment-variables)
- [The media vault channel](#the-media-vault-channel--read-this-one)
- [Onboarding a new group](#onboarding-a-new-group)
- [Adding media to a tier](#adding-media-to-a-tier)
- [Rotating the Helius key](#rotating-the-helius-key)
- [Backup and restore](#backup-and-restore)
- [Operations](#operations)

---

## Quick start

```bash
git clone <repo> && cd RiceBuybot
pnpm install
cp .env.example .env      # fill it in
pnpm build
pnpm test                 # 384 tests
DRY_RUN=true pnpm start   # renders cards to stdout, sends nothing
```

`DRY_RUN=true` is the only safe way to test message formatting against live chain data. It
renders every card to stdout — including the earned tier, the tier the art actually came
from, and the media sha256 — and sends nothing.

---

## Deployment (VPS)

Two scripts, in this order. Both are idempotent; re-run them after every deploy.

```bash
# 1. The media pool (creates the ricebuybot user, /srv/media, nginx, the manifest timer)
sudo bash scripts/setup-media-pool.sh

# 2. The bot itself (env file, /var/lib/ricebuybot, build, systemd units)
sudo bash scripts/setup-bot.sh

# 3. Fill in the secrets, then start
sudo -e /etc/ricebuybot/env
sudo systemctl start ricebuybot
journalctl -u ricebuybot -f

# 4. Prove it
sudo bash scripts/verify-deploy.sh
```

### It runs under systemd, not pm2

Everything else on the box runs under `deploy`'s pm2. RiceBuybot deliberately does not.

**The reason is the token, not tidiness.** `deploy` runs two public-facing Next.js apps. If
the bot ran as `deploy`, a path traversal or RCE in either website would hand an attacker a
Telegram bot token that can post to *every group we ever onboard*, plus a paid RPC key. So
the bot runs as its own `ricebuybot` user, and `/etc/ricebuybot/env` is `0600
ricebuybot:ricebuybot` — `deploy` cannot read it.

`pm2.config.cjs` remains, for **local development only**.

### What the bot can and cannot touch

The unit sets `ProtectSystem=strict`, so the entire filesystem is read-only to the bot except
two paths:

| Path | Why |
| --- | --- |
| `/srv/media` | the meme pool. The bot **is** the curator — DM curation writes memes here. |
| `/var/lib/ricebuybot` | the SQLite DB (and its `-wal`/`-shm` files, hence the *directory*). |

It cannot write to `/etc`, `/opt`, `/usr`, the websites' trees, or **its own code**.
`scripts/verify-deploy.sh` proves all of it, with positive controls.

### Port

**3012**, bound to `127.0.0.1`. Not 3011 — a Next.js app already listens on `*:3011`, and
binding it fails with `EADDRINUSE`. `setup-bot.sh` checks the port is free before installing;
it does not assume.

---

## Environment variables

Set in `/etc/ricebuybot/env` (production) or `.env` (local). Boot validates every one of them
and reports **all** problems at once.

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | — | From @BotFather. |
| `HELIUS_API_KEY` | yes | — | |
| `HELIUS_RPC_URL` | yes | — | Key is in the query string — never logged (see `scrubUrl`). |
| `HELIUS_WS_URL` | yes | — | Enhanced WebSocket (`atlas-mainnet`). Needs a paid plan. |
| `DEFAULT_MINT` | yes | — | Watched even with no groups, so a fresh install shows signs of life. |
| `DB_PATH` | yes | — | `/var/lib/ricebuybot/ricebuybot.db` in production. |
| `MEDIA_ROOT` | yes | — | `/srv/media`. |
| `MEDIA_SOURCE` | no | `local` | `local` uploads bytes (**50MB** ceiling). `http` sends a URL (**20MB**). Use `local`. |
| `MEDIA_MANIFEST_URL` | if `http` | — | |
| `MEDIA_VAULT_CHAT_ID` | unless `DRY_RUN` | — | **[Read this.](#the-media-vault-channel--read-this-one)** |
| `OWNER_USER_ID` | no | — | Your Telegram user id. May curate every mint. |
| `HTTP_PORT` | no | `3012` | `/health`, on `127.0.0.1`. |
| `LOG_LEVEL` | no | `info` | |
| `STABLE_USD` | no | `1.0` | What a USDC/USDT quote is worth. A depeg is real; we do not hide it. |
| `WHALE_BASIS` | no | `post` | Default for new chats. Per-chat via `/whalebasis`. |
| `DAILY_SEND_CAP` | no | *off* | Optional per-chat daily card cap. |
| `INGEST_MODE` | no | `ws` | `webhook` is the fallback adapter. |
| `WEBHOOK_SECRET` | if webhook | — | Min 16 chars. The endpoint is public — treat it as a password. |
| `BACKFILL_POSITIONS` | no | `true` | Seed cost basis from Helius history. |
| `DRY_RUN` | no | `false` | Render to stdout, send nothing. |

---

## The media vault channel — READ THIS ONE

`MEDIA_VAULT_CHAT_ID` is a **private Telegram channel that only the bot posts to**. When a
meme is seeded from disk (via `tier`, not via DM), the bot uploads the bytes there once and
keeps the `file_id` Telegram hands back.

**Setup:**

1. Create a **private channel** in Telegram (not a group).
2. Add the bot as an **administrator** with "Post Messages".
3. Get its id: forward any message from the channel to `@userinfobot`, or read it out of the
   bot's logs. It looks like `-1001234567890`.
4. Put it in `/etc/ricebuybot/env` as `MEDIA_VAULT_CHAT_ID`.

### ⚠️ Losing this channel means re-uploading every media item

Telegram `file_id`s are **bot-specific and non-portable**, and they are the whole reason the
uploads happen at all. The bot caches each one against the file's sha256, so a meme is
uploaded **exactly once, ever**, and every subsequent send of it is instant and free.

If you **delete the channel, remove the bot from it, or change `MEDIA_VAULT_CHAT_ID`**:

- the cached `file_id`s in `media_file_ids` **keep working** — Telegram serves an uploaded
  file long after you lose the channel, so nothing breaks *today*;
- but the first time a meme needs a **new** upload (a fresh file seeded from disk, or a
  `file_id` Telegram rejects), there is nowhere to upload it to, and that meme cannot be sent;
- and if you ever lose `media_file_ids` **as well** (a lost DB with no backup), every meme in
  the pool must be re-uploaded from scratch, one every 2 seconds, in the background.

**Do not delete that channel. Do not remove the bot from it. Do not change the id casually.**

Media added through the **DM curation flow** never touches the vault at all — Telegram already
minted a `file_id` when the curator sent the file, and the bot keeps it. The vault is only for
disk-seeded media.

---

## Onboarding a new group

1. **Add the bot to the group.**
2. **Promote it to admin.** (It needs to post; it does not need any other permission.)
3. An admin runs **`/setup`** — a five-step wizard: contract → media mode → minimum buy →
   emoji → emoji step.

Then, any time:

| Command | |
| --- | --- |
| `/settings` | the whole config, in plain English |
| `/setca <mint>` | point at a different token (validated on-chain; subscribes live, no restart) |
| `/setmin <usd>` | don't post buys under this |
| `/setfloors <regular> <big> <massive>` | the three **buy-size** floors, strictly ascending |
| `/setwhale <usd>` | the **holdings** floor that makes someone a whale (default $10,000) |
| `/whalebasis pre\|post` | measure holdings before or after the buy |
| `/setemoji 🍚` | unicode, or a custom/premium emoji |
| `/setstep <usd>` · `/setmaxemoji <n>` | the emoji ladder |
| `/setheadline whale 🐳 A WHALE APPEARS` | `{SYM}` becomes the token symbol |
| `/mediamode pool\|static\|none` · `/setmedia` | |
| `/mediastats` | per-tier counts, upload progress, and **unpublished** files |
| `/setlink <label> <url>` | keyboard buttons |
| `/preview [usd] [holdings]` | render a fake buy — **`/preview 20 50000` is how you test the whale card without waiting for a whale** |
| `/pause` · `/resume` · `/reset` | |

**Whale is about what they HOLD, not what they spent.** A $20 buy from a wallet sitting on
$50,000 of the token is a whale; a $340 buy from a $600 holder is not. That is the whole point
of the tier, and `/setwhale` says so in words when you set it.

---

## Adding media to a tier

Two paths. **Neither requires SSH for ongoing curation.**

### From a DM (the normal way)

DM the bot **`/media`** → tier board → tap a tier → **➕ Add** → forward memes → **`/done`**.

Only a **verified admin of a group configured for that mint** can do this, re-checked against
Telegram on every action. Removals move the file to `_archive/` — never deleted — and drop it
from every group's rotation *immediately*, and from the website carousel on its next read.

### From the box (bulk seeding the first fifty)

```bash
sudo cp *.gif /srv/media/_incoming/<MINT>/
sudo rice-tier massive /srv/media/_incoming/<MINT>/*.gif
sudo rice-tier archive <sha256>.gif     # retire one
sudo rice-tier whale <sha256>.gif --move   # re-tier one
```

Files are renamed to `<sha256>.<ext>` on the way in. That is what lets nginx serve the pool
with a one-year immutable cache: a URL can never come to mean different bytes.

**A file copied into a tier folder by hand is invisible to the bot** — the generator refuses
anything that is not content-addressed. `/mediastats` tells you when that has happened.

---

## Rotating the Helius key

The original key was published and is burned. Assume any key you paste anywhere will end up
in a screenshot.

```bash
# 1. Mint a new key at helius.dev, then:
sudo -e /etc/ricebuybot/env
#    HELIUS_API_KEY=<new>
#    HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<new>
#    HELIUS_WS_URL=wss://atlas-mainnet.helius-rpc.com/?api-key=<new>

sudo systemctl restart ricebuybot
journalctl -u ricebuybot -n 30 | grep -i "ws connected"

# 2. Revoke the old key in the Helius dashboard.
```

**`getHealth` is not a liveness check.** Helius answers `{"result":"ok"}` to `getHealth`
*without a valid key*. To actually test a key, call a real method:

```bash
curl -sS -X POST "$HELIUS_RPC_URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getTokenSupply","params":["2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump"]}'
# a working key returns a supply. A dead one returns {"error":{"code":-32401,...}}
```

The WebSocket (`atlas-mainnet`, `transactionSubscribe`) needs a **paid** Helius plan. On a free
plan it answers `401` and the bot posts nothing while looking perfectly healthy — which is why
the watchdog exits after 120s of a down socket rather than sitting there.

---

## Backup and restore

Nightly, via `ricebuybot-backup.timer`. Keeps 7. Verified with `PRAGMA integrity_check` on
every run — a backup nobody has checked is a hope, not a backup.

```bash
sudo systemctl start ricebuybot-backup     # run one now
ls -lt /var/lib/ricebuybot/backups/
```

### It uses `sqlite3 .backup`, never `cp`

The DB runs in **WAL mode**, so the committed state lives across `ricebuybot.db` *and*
`ricebuybot.db-wal`. Copying the `.db` file while the bot is running gives you a file that is
**missing every transaction since the last checkpoint** — and it does not look broken. It
opens. It queries. It is simply wrong.

Measured, on a live DB with an uncheckpointed WAL:

```
cp ricebuybot.db backup.db   ->  "no such table: sends"    (500 rows lost)
sqlite3 .backup              ->  500 rows, integrity_check ok
```

### Restore

```bash
sudo systemctl stop ricebuybot
sudo -u ricebuybot cp /var/lib/ricebuybot/backups/ricebuybot-<STAMP>.db \
                      /var/lib/ricebuybot/ricebuybot.db
sudo -u ricebuybot rm -f /var/lib/ricebuybot/ricebuybot.db-wal \
                         /var/lib/ricebuybot/ricebuybot.db-shm
sudo systemctl start ricebuybot
```

**What you lose by restoring an old DB:** the `sends` ledger (so a buy already posted could be
posted again — but only if it is still within the 120s staleness window, which after a restore
it will not be), recent cost basis (rebuilt by backfill), and — the one that stings —
`media_file_ids`, which means every meme gets re-uploaded to the vault, one every 2 seconds,
in the background. Nothing breaks; it is just slow and chatty for a while.

---

## Operations

See **[OPERATIONS.md](OPERATIONS.md)** — every `/health` field, what a normal log line looks
like, and the four failure modes with exactly what each one looks like in the logs.

## Zero telemetry

The only hosts this process contacts: `api.telegram.org`, Helius, Binance.US, Coinbase, and —
only if `MEDIA_SOURCE=http` — the media host. Nothing else, in our code or in any transitive
dependency.

```bash
pnpm audit:network
```

Greps the entire **production** dependency tree (63 packages) and fails on any known telemetry
SDK. Current result: **0 telemetry references**.
