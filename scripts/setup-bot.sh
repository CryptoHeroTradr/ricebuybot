#!/usr/bin/env bash
#
# Provision the BOT on the VPS. Phase 10. Run as root:
#
#   sudo bash scripts/setup-bot.sh
#
# IDEMPOTENT. Re-run it after every deploy — it re-installs the units, re-asserts the
# permissions, and leaves the DB and the media alone.
#
# It assumes the MEDIA POOL is already provisioned (scripts/setup-media-pool.sh, Phase 5a) —
# that is where the `ricebuybot` user and /srv/media come from.
set -euo pipefail

BOT_USER=ricebuybot
APP_DIR=/opt/ricebuybot
STATE_DIR=/var/lib/ricebuybot
ENV_DIR=/etc/ricebuybot
HTTP_PORT="${HTTP_PORT:-3012}"

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
say "preflight"

id -u "$BOT_USER" >/dev/null 2>&1 || {
  echo "user $BOT_USER does not exist — run scripts/setup-media-pool.sh first" >&2
  exit 1
}
[[ -x /usr/bin/node ]] || { echo "no system node at /usr/bin/node — run setup-media-pool.sh" >&2; exit 1; }
command -v sqlite3 >/dev/null || { apt-get update -qq && apt-get install -y -qq sqlite3; }

# THE PORT. Verify it is free BEFORE we bind it.
#
# 3011 was the documented default and it is TAKEN — a Next.js app listens on *:3011, which
# includes 127.0.0.1:3011, so the bot would die on boot with EADDRINUSE. Check, do not assume.
#
# BUT: on a REDEPLOY the port is held by US. A check that refuses to run because the thing it
# is deploying is already running makes the first install work and every subsequent one
# impossible. So tolerate the port iff the process holding it belongs to OUR service — verified
# through the pid's cgroup, not by trusting the port number or the process name, either of
# which anything could claim.
PORT_PID="$(ss -ltnp 2>/dev/null | grep ":${HTTP_PORT} " | grep -oP 'pid=\K[0-9]+' | head -1 || true)"

if [[ -n "$PORT_PID" ]]; then
  if grep -qa 'ricebuybot\.service' "/proc/$PORT_PID/cgroup" 2>/dev/null; then
    echo "port ${HTTP_PORT} is held by our own ricebuybot.service (pid $PORT_PID) — redeploy, fine"
    systemctl stop ricebuybot
    echo "stopped ricebuybot for the redeploy"
  else
    echo "PORT ${HTTP_PORT} IS IN USE BY SOMETHING THAT IS NOT US:" >&2
    ss -ltnp | grep ":${HTTP_PORT} " >&2
    echo "Pick another and pass HTTP_PORT=<n>. Do not bind a port somebody else owns." >&2
    exit 1
  fi
else
  echo "port ${HTTP_PORT} is free"
fi

# ---------------------------------------------------------------------------
say "directories"

# The APP is owned by root and READ-ONLY to the bot. The bot cannot rewrite its own code —
# and ProtectSystem=strict in the unit means it could not even if the mode said otherwise.
install -d -o root -g root -m 0755 "$APP_DIR"

# State: the SQLite DB and its backups. The DIRECTORY must be writable, not just the file —
# WAL mode creates .db-wal and .db-shm alongside it.
install -d -o "$BOT_USER" -g "$BOT_USER" -m 0750 "$STATE_DIR"
install -d -o "$BOT_USER" -g "$BOT_USER" -m 0750 "$STATE_DIR/backups"

# The secrets. 0600, owned by the bot. `deploy` — which runs two public-facing Next apps —
# cannot read this file, and that is the entire reason the ricebuybot user exists.
install -d -o root -g root -m 0755 "$ENV_DIR"

if [[ ! -f "$ENV_DIR/env" ]]; then
  install -o "$BOT_USER" -g "$BOT_USER" -m 0600 /dev/null "$ENV_DIR/env"
  cat > "$ENV_DIR/env" <<EOF
# RiceBuybot. 0600 ricebuybot:ricebuybot. NEVER commit this file.
TELEGRAM_BOT_TOKEN=
HELIUS_API_KEY=
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=
HELIUS_WS_URL=wss://atlas-mainnet.helius-rpc.com/?api-key=
DEFAULT_MINT=2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump

DB_PATH=$STATE_DIR/ricebuybot.db
MEDIA_ROOT=/srv/media
MEDIA_SOURCE=local

# The private channel the bot uploads disk-seeded media into ONCE, to mint file_ids.
# LOSING THIS CHANNEL MEANS RE-UPLOADING EVERY MEDIA ITEM. See README.
MEDIA_VAULT_CHAT_ID=

# Your Telegram user id. May curate every mint.
OWNER_USER_ID=

HTTP_PORT=$HTTP_PORT
LOG_LEVEL=info
DRY_RUN=false
EOF
  chown "$BOT_USER":"$BOT_USER" "$ENV_DIR/env"
  chmod 0600 "$ENV_DIR/env"
  echo "created $ENV_DIR/env — FILL IT IN before starting the service"
else
  chown "$BOT_USER":"$BOT_USER" "$ENV_DIR/env"
  chmod 0600 "$ENV_DIR/env"
  echo "$ENV_DIR/env already exists (permissions re-asserted)"
fi

# ---------------------------------------------------------------------------
say "application"

# rsync from the checkout, minus the things that must not ship.
rsync -a --delete \
  --exclude .git --exclude node_modules --exclude data --exclude .env \
  "$REPO/" "$APP_DIR/"

chown -R root:root "$APP_DIR"
chmod +x "$APP_DIR/scripts/backup-db.sh"

# Build as root, in place. Production deps only afterwards.
cd "$APP_DIR"
sudo -u root env HOME=/root corepack pnpm install --frozen-lockfile >/dev/null 2>&1 ||
  sudo -u root env HOME=/root npx --yes pnpm@9 install --frozen-lockfile
sudo -u root env HOME=/root npx --yes pnpm@9 build

[[ -f "$APP_DIR/dist/src/index.js" ]] || { echo "build produced no dist/src/index.js" >&2; exit 1; }
echo "built $APP_DIR/dist/src/index.js"

# ---------------------------------------------------------------------------
say "systemd"

install -o root -g root -m 0644 "$REPO/deploy/systemd/ricebuybot.service" /etc/systemd/system/ricebuybot.service
install -o root -g root -m 0644 "$REPO/deploy/systemd/ricebuybot-backup.service" /etc/systemd/system/ricebuybot-backup.service
install -o root -g root -m 0644 "$REPO/deploy/systemd/ricebuybot-backup.timer" /etc/systemd/system/ricebuybot-backup.timer

systemctl daemon-reload
systemctl enable ricebuybot.service >/dev/null
systemctl enable --now ricebuybot-backup.timer >/dev/null
echo "units installed; backup timer enabled"

# If we stopped it for the redeploy, bring it back. A deploy script that leaves the service down
# is a deploy script that causes the outage it was meant to avoid.
if [[ -s /etc/ricebuybot/env ]] && grep -q '^TELEGRAM_BOT_TOKEN=.\+' /etc/ricebuybot/env; then
  systemctl restart ricebuybot
  sleep 3
  echo "ricebuybot: $(systemctl is-active ricebuybot)"
fi

# ---------------------------------------------------------------------------
say "done"
cat <<EOF
1. Fill in $ENV_DIR/env   (bot token, Helius key, MEDIA_VAULT_CHAT_ID, OWNER_USER_ID)
2. systemctl start ricebuybot
3. journalctl -u ricebuybot -f
4. curl -s localhost:$HTTP_PORT/health | jq

Verify the deployment:  sudo bash $APP_DIR/scripts/verify-deploy.sh
EOF
