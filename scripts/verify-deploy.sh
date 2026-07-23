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
step "deployed version"

# Everything above proves the deployment is SAFE and ALIVE — and a bot running old code passes
# every one of those checks while shipping none of the behaviour you deployed for. A stale deploy
# (setup-bot.sh run from the wrong copy, so its self-rsync was a no-op) is invisible here unless we
# look at the CODE VERSION. So look at it.
DIST_MIG_DIR="$APP_DIR/dist/src/db/migrations"
DIST_MAX="$(ls "$DIST_MIG_DIR" 2>/dev/null | grep -oP '^[0-9]+' | sort -n | tail -1 || true)"
DB_PATH="$(grep -oP '^DB_PATH=\K.*' /etc/ricebuybot/env 2>/dev/null || echo "$STATE_DIR/ricebuybot.db")"
DB_MAX="$(as_bot sqlite3 "$DB_PATH" 'SELECT MAX(version) FROM schema_migrations;' 2>/dev/null || true)"

if [[ -z "$DIST_MAX" ]]; then
  bad "no migrations found in $DIST_MIG_DIR — is dist even built?"
elif [[ -z "$DB_MAX" ]]; then
  bad "could not read schema_migrations from $DB_PATH"
else
  echo "  highest migration shipped in dist: $DIST_MAX;  highest applied in the live DB: $DB_MAX"

  # migrate() runs at boot, so every migration that SHIPPED must be APPLIED. A gap means the code
  # shipped but the DB did not migrate to it — a half-deploy that runs new code on an old schema.
  [[ "$DB_MAX" == "$DIST_MAX" ]] &&
    ok "the live DB is migrated to the shipped version ($DB_MAX)" ||
    bad "shipped migration is $DIST_MAX but the DB is at $DB_MAX — the DB did not migrate to the deployed code"

  # THE INTENT CHECK — the one that would have caught the Phase-11-instead-of-13 deploy.
  #
  # This script cannot know which phase you MEANT to ship, and the self-check above cannot either:
  # a stale deploy has dist and DB agreeing at the OLD version, so it passes. Only YOU know the
  # target. Pass EXPECT_MIGRATION=<n> and a stale deploy becomes a hard failure here.
  if [[ -n "${EXPECT_MIGRATION:-}" ]]; then
    { [[ "$DIST_MAX" -ge "$EXPECT_MIGRATION" ]] && [[ "$DB_MAX" -ge "$EXPECT_MIGRATION" ]]; } &&
      ok "deploy meets EXPECT_MIGRATION=$EXPECT_MIGRATION (shipped $DIST_MAX, applied $DB_MAX)" ||
      bad "EXPECT_MIGRATION=$EXPECT_MIGRATION but shipped=$DIST_MAX applied=$DB_MAX — STALE deploy, old code is live"
  else
    echo "  (set EXPECT_MIGRATION=<n> to FAIL this step on a stale deploy — e.g. EXPECT_MIGRATION=13)"
  fi
fi

# --- PROVENANCE: which SOURCE COMMIT is live -------------------------------------------------
#
# The migration checks only move when a deploy changes the SCHEMA. Phase 14 adds an executor and
# may add NO migration — a stale deploy of it would pass every check above in silence. The commit
# marker is invariant to what the deploy contained: it records the exact source HEAD the bytes
# came from, written by setup-bot.sh at rsync time.
MARKER="$APP_DIR/DEPLOYED_COMMIT"
if [[ -r "$MARKER" ]]; then
  DEPLOYED_COMMIT="$(head -1 "$MARKER")"
  DEPLOYED_AT="$(grep -oP '^deployed_at=\K.*' "$MARKER" 2>/dev/null || true)"
  echo "  deployed commit: ${DEPLOYED_COMMIT}${DEPLOYED_AT:+  (at $DEPLOYED_AT)}"
  case "$DEPLOYED_COMMIT" in
    unknown) bad "DEPLOYED_COMMIT is 'unknown' — deployed from a non-git tree; provenance unverifiable" ;;
    *-dirty) bad "DEPLOYED_COMMIT is $DEPLOYED_COMMIT — deployed from a DIRTY tree; bytes match no commit" ;;
    *)       ok "deployed from a clean commit ($DEPLOYED_COMMIT)" ;;
  esac
  # EXPECT_COMMIT catches a stale deploy that changed no migration. EXACT match on the full sha —
  # a prefix match would let a "<sha>-dirty" marker pass against the clean sha, which must not.
  if [[ -n "${EXPECT_COMMIT:-}" ]]; then
    [[ "$DEPLOYED_COMMIT" == "$EXPECT_COMMIT" ]] &&
      ok "deploy matches EXPECT_COMMIT=$EXPECT_COMMIT" ||
      bad "EXPECT_COMMIT=$EXPECT_COMMIT but the live tree is $DEPLOYED_COMMIT — STALE or wrong deploy"
  else
    echo "  (set EXPECT_COMMIT=<full-sha> to FAIL on a stale deploy that changed no migration)"
  fi
else
  bad "no $MARKER — deployed by a setup-bot.sh too old to record provenance, or never deployed"
fi

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
