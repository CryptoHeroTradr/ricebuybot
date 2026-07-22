#!/usr/bin/env bash
#
# Prove the deployment. Phase 10. Run as root on the VPS:
#
#   sudo bash scripts/verify-deploy.sh
#
# Every assertion here is about what the bot CAN and CANNOT do, and each deny check is paired
# with a positive control — "the bot cannot write to /etc" and "the bot cannot write ANYWHERE
# because the unit is broken" produce identical output, and only one of them is good news.
set -uo pipefail

BOT_USER=ricebuybot
WEB_USER=deploy
APP_DIR=/opt/ricebuybot
STATE_DIR=/var/lib/ricebuybot
MEDIA_ROOT=/srv/media
MINT="${MINT:-2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump}"
HTTP_PORT="${HTTP_PORT:-3012}"

[[ $EUID -eq 0 ]] || { echo "must run as root (it tests what OTHER users can do)" >&2; exit 1; }

PASS=0; FAIL=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

as_bot() { sudo -u "$BOT_USER" "$@" 2>/dev/null; }

# ---------------------------------------------------------------------------
step "the bot writes to EXACTLY two places"

# POSITIVE CONTROLS FIRST. Without these, every "cannot write" below is satisfied just as
# well by a unit that is completely broken.
#
# NOTE: the bot MUST be able to write to /srv/media. It is the sole writer to the pool
# (INVARIANT 4) and Phase 8.5's DM curation adds, moves and archives memes there. A
# read-only pool would make ➕ Add and 🗑 Remove fail at runtime.
if as_bot touch "$MEDIA_ROOT/$MINT/regular/.deploy-probe"; then
  ok "POSITIVE CONTROL: $BOT_USER CAN write to the media pool (it is the curator)"
  as_bot rm -f "$MEDIA_ROOT/$MINT/regular/.deploy-probe"
else
  bad "$BOT_USER CANNOT write to the pool — DM curation (add/remove) will fail at runtime"
fi

if as_bot touch "$STATE_DIR/.deploy-probe"; then
  ok "POSITIVE CONTROL: $BOT_USER CAN write its state dir (SQLite needs the DIR for -wal/-shm)"
  as_bot rm -f "$STATE_DIR/.deploy-probe"
else
  bad "$BOT_USER CANNOT write $STATE_DIR — the DB will not open"
fi

# --- and nowhere else -------------------------------------------------------------------
for path in /etc /usr/local/bin /opt "$APP_DIR" /home/deploy /srv; do
  if as_bot touch "$path/.deploy-probe"; then
    bad "$BOT_USER CAN write to $path — it must not"
    rm -f "$path/.deploy-probe"
  else
    ok "$BOT_USER cannot write to $path"
  fi
done

# The bot cannot rewrite its own code. (Belt and braces: ProtectSystem=strict makes the whole
# filesystem read-only to the SERVICE anyway, but the modes should not depend on that.)
as_bot test -r "$APP_DIR/dist/src/index.js" &&
  ok "$BOT_USER can READ its own code" ||
  bad "$BOT_USER cannot read its own code"

# ---------------------------------------------------------------------------
step "secrets"

if as_bot test -r /etc/ricebuybot/env; then
  ok "$BOT_USER can read its env file"
else
  bad "$BOT_USER cannot read /etc/ricebuybot/env"
fi

if sudo -u "$WEB_USER" cat /etc/ricebuybot/env >/dev/null 2>&1; then
  bad "$WEB_USER CAN READ THE BOT TOKEN. This is the entire reason the ricebuybot user exists."
else
  ok "$WEB_USER (runs both websites) CANNOT read the bot token or the Helius key"
fi

MODE="$(stat -c '%a %U:%G' /etc/ricebuybot/env 2>/dev/null || echo '?')"
[[ "$MODE" == "600 ricebuybot:ricebuybot" ]] &&
  ok "env file is 0600 ricebuybot:ricebuybot" ||
  bad "env file is '$MODE', expected '600 ricebuybot:ricebuybot'"

# ---------------------------------------------------------------------------
step "systemd"

systemctl is-enabled --quiet ricebuybot.service &&
  ok "ricebuybot.service is enabled" || bad "ricebuybot.service is not enabled"

if systemctl is-active --quiet ricebuybot.service; then
  ok "ricebuybot.service is running"
else
  bad "ricebuybot.service is NOT running — journalctl -u ricebuybot -n 50"
fi

# The hardening is only real if systemd agrees it is on.
for prop in ProtectSystem=strict NoNewPrivileges=yes PrivateTmp=yes; do
  key="${prop%%=*}"; want="${prop#*=}"
  got="$(systemctl show -p "$key" --value ricebuybot.service)"
  [[ "$got" == "$want" ]] && ok "$key=$got" || bad "$key is '$got', expected '$want'"
done

RW="$(systemctl show -p ReadWritePaths --value ricebuybot.service)"
grep -q "/srv/media" <<< "$RW" && grep -q "/var/lib/ricebuybot" <<< "$RW" &&
  ok "ReadWritePaths = $RW" ||
  bad "ReadWritePaths is '$RW'"

systemctl is-active --quiet ricebuybot-backup.timer &&
  ok "nightly backup timer is active" || bad "backup timer is not active"

# ---------------------------------------------------------------------------
step "health"

BODY="$(curl -sS -m 5 "http://127.0.0.1:$HTTP_PORT/health" 2>/dev/null || echo '')"
if [[ -z "$BODY" ]]; then
  bad "/health did not answer on 127.0.0.1:$HTTP_PORT"
else
  ok "/health answered"
  for field in ok uptime wsConnected activeMints solUsd queueDepth mediaItems mediaUploaded mediaPending; do
    grep -q "\"$field\"" <<< "$BODY" && ok "  /health has $field" || bad "  /health is missing $field"
  done
  echo "  $BODY"
fi

# It must NOT be reachable from outside. The health endpoint leaks operational detail.
if curl -sS -m 3 "http://$(hostname -I | awk '{print $1}'):$HTTP_PORT/health" >/dev/null 2>&1; then
  bad "/health is reachable on the PUBLIC interface — it must bind 127.0.0.1 only"
else
  ok "/health is not reachable from outside (127.0.0.1 only)"
fi

# ---------------------------------------------------------------------------
step "backup"

if systemctl start ricebuybot-backup.service 2>/dev/null; then
  LATEST="$(ls -1t "$STATE_DIR"/backups/ricebuybot-*.db 2>/dev/null | head -1)"
  if [[ -n "$LATEST" ]] && sqlite3 "$LATEST" 'PRAGMA integrity_check;' | grep -qx ok; then
    ok "a backup ran and passes integrity_check: $(basename "$LATEST")"
  else
    bad "backup produced nothing usable"
  fi
else
  bad "the backup unit failed to run"
fi

# ---------------------------------------------------------------------------
printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
