#!/usr/bin/env bash
#
# Phase 5b acceptance — drive the pool through each state so the carousel can be
# observed in a real browser at each one. Run on the VPS as root:
#
#   sudo bash scripts/verify-5b.sh
#
# ONE command. It seeds the pool, hides the manifest, restores it, and cleans up
# — pausing at each state until the browser check for that state has run. The
# pauses are a handshake on /tmp files (world-writable), so the operator driving
# the browser needs no privileges at all.
#
# TEARDOWN IS CONDITIONAL ON PASSING.
#
#   all checks pass -> the test art is archived and the pool goes back to how it was.
#   ANY check fails -> the pool is left EXACTLY as it is, and the script says so.
#
# A green run should not leave litter; a red run must not destroy the evidence. The
# earlier version tore down unconditionally, so the setgid bug had to be reconstructed
# from an nginx error log after the artefacts were already gone.
#
# The manifest is always restored either way — a pool with no manifest is not a
# diagnostic state, it is just a broken site.
#
# Safe to interrupt (Ctrl-C). `--clean` removes preserved test art afterwards.
set -uo pipefail

MINT="${MINT:-2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump}"
MEDIA_ROOT="${MEDIA_ROOT:-/srv/media}"
POOL="$MEDIA_ROOT/$MINT"
BOT_USER=ricebuybot
INCOMING="$MEDIA_ROOT/_incoming/$MINT"
WAIT_MAX=600   # 10 min per handshake, then give up and clean up.

[[ $EUID -eq 0 ]] || { echo "must run as root (it writes the pool as $BOT_USER)" >&2; exit 1; }

FAIL=0
state() { echo "$1" > /tmp/5b-state; chmod 666 /tmp/5b-state 2>/dev/null; printf '\n\033[1m>> STATE: %s\033[0m  (waiting for the browser check…)\n' "$1"; }
say()   { printf '   %s\n' "$1"; }
bad()   { printf '   \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }

# Wait for the observer to say "I have looked at it".
#
# The observer writes the WORD "FAIL" into the flag file if the browser check for
# that state did not pass. The browser half of this acceptance happens outside this
# script, so without that channel the script would tear down a broken pool while
# cheerfully believing everything was fine — which is exactly what it did last time.
await() {
  local flag="/tmp/5b-go$1" waited=0
  while [[ ! -f "$flag" ]]; do
    sleep 2; waited=$((waited+2))
    if [[ $waited -ge $WAIT_MAX ]]; then
      bad "no browser check after ${WAIT_MAX}s — treating as a failure and PRESERVING the pool"
      return 1
    fi
  done
  if grep -qi FAIL "$flag"; then
    bad "browser check FAILED at state $(cat /tmp/5b-state 2>/dev/null)"
    return 1
  fi
  say "browser check passed."
}

# TEARDOWN IS CONDITIONAL ON PASSING. This is the whole lesson of the setgid bug:
# the previous version archived its test art unconditionally, so by the time anyone
# looked, the failing artefacts were gone and the bug had to be reconstructed from an
# nginx error log instead of read off a tally. A failed run must leave the crime scene
# exactly as it is.
cleanup() {
  # The manifest always comes back — a pool with no manifest is not a diagnostic
  # state, it is just a broken site.
  [[ -f "$POOL/manifest.json.hidden" ]] && mv "$POOL/manifest.json.hidden" "$POOL/manifest.json"

  if [[ $FAIL -gt 0 ]]; then
    printf '\n\033[1;31m== %d CHECK(S) FAILED — the pool has been LEFT EXACTLY AS IT IS\033[0m\n' "$FAIL"
    say "Nothing was archived, nothing was removed. Inspect it:"
    say ""
    say "  ls -l $POOL/{regular,big,whale,massive}/"
    say "  cat $POOL/manifest.json"
    say "  tail -20 /var/log/nginx/error.log"
    say ""
    say "The test art still in the pool: ${SHAS:-<none seeded>}"
    say "When you are done, clean up with:  sudo bash scripts/verify-5b.sh --clean"
    rm -f /tmp/5b-state /tmp/5b-go1 /tmp/5b-go2 /tmp/5b-go3
    return
  fi

  printf '\n\033[1m== all checks passed — putting the pool back exactly as we found it\033[0m\n'
  purge
  say "pool back to $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["count"])' "$POOL/manifest.json") items."
  say "test art is in _archive (never deleted). Remove it by hand if you want it gone."
}

# Retire the test art. It moves to _archive — never unlinked, per invariant 4.
purge() {
  for sha in ${SHAS:-}; do
    for tier in regular big whale massive; do
      [[ -f "$POOL/$tier/$sha" ]] && sudo -u "$BOT_USER" mv "$POOL/$tier/$sha" "$POOL/_archive/$sha"
    done
  done
  sudo -u "$BOT_USER" rm -f "$INCOMING"/pool-*.png "$INCOMING"/pool-*.gif 2>/dev/null
  sudo -u "$BOT_USER" /usr/bin/node /opt/ricebuybot-media/scripts/build-manifest.ts \
    --root "$MEDIA_ROOT" --mint "$MINT" --quiet
  rm -f /tmp/5b-state /tmp/5b-go1 /tmp/5b-go2 /tmp/5b-go3
}

# `--clean` is the way back from a preserved failure: it removes whatever test art
# is still lying around, without running any of the checks.
if [[ "${1:-}" == "--clean" ]]; then
  SHAS="$(python3 - "$POOL/manifest.json" <<'PY' 2>/dev/null
import json, sys
m = json.load(open(sys.argv[1]))
print(" ".join(i["rel_path"].split("/")[-1] for i in m["items"] if i.get("label","").startswith("pool-")))
PY
)"
  purge
  echo "cleaned. pool: $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["count"])' "$POOL/manifest.json") items"
  exit 0
fi

trap cleanup EXIT

rm -f /tmp/5b-go1 /tmp/5b-go2 /tmp/5b-go3

# ---------------------------------------------------------------------------
printf '\033[1m== seeding three memes into the pool\033[0m\n'

# Real, distinct images. ffmpeg is already installed (the manifest generator
# needs ffprobe), so the pool gets genuine art rather than fabricated bytes.
ffmpeg -y -loglevel error -f lavfi -i "color=c=#C8102E:s=480x360:d=1"  -frames:v 1 "$INCOMING/pool-red.png"
ffmpeg -y -loglevel error -f lavfi -i "color=c=#046A38:s=480x360:d=1" -frames:v 1 "$INCOMING/pool-green.png"
ffmpeg -y -loglevel error -f lavfi -i "color=c=#FFB81C:s=480x360:d=2" -r 5 "$INCOMING/pool-gold.gif"
chown "$BOT_USER":"$BOT_USER" "$INCOMING"/pool-*.png "$INCOMING"/pool-*.gif

rice-tier massive pool-red.png   | sed 's/^/   /'
rice-tier whale   pool-green.png | sed 's/^/   /'
rice-tier regular pool-gold.gif  | sed 's/^/   /'

SHAS="$(python3 - "$POOL/manifest.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
print(" ".join(i["rel_path"].split("/")[-1] for i in m["items"]))
PY
)"
say "manifest now: $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["count"])' "$POOL/manifest.json") items"
python3 - "$POOL/manifest.json" <<'PY'
import json, sys
for i in json.load(open(sys.argv[1]))["items"]:
    print(f'   {i["tier"]:8} {i["label"]:16} /media/{"/".join(i["rel_path"].split("/")[1:])}')
PY

state "SEEDED"
await 1 || exit 1

# ---------------------------------------------------------------------------
printf '\n\033[1m== killing the manifest (the site must NOT go blank)\033[0m\n'
mv "$POOL/manifest.json" "$POOL/manifest.json.hidden"
say "manifest.json renamed away; the media files are all still there and still served."
GONE="$(curl -sS -o /dev/null -w '%{http_code}' https://1grainofrice.com/media/manifest.json)"
[[ "$GONE" == 404 ]] && say "manifest now 404s, as intended." || bad "manifest returned $GONE after being hidden, expected 404"

state "MANIFEST_GONE"
await 2 || exit 1

# ---------------------------------------------------------------------------
printf '\n\033[1m== restoring the manifest\033[0m\n'
mv "$POOL/manifest.json.hidden" "$POOL/manifest.json"
BACK="$(curl -sS -o /dev/null -w '%{http_code}' https://1grainofrice.com/media/manifest.json)"
[[ "$BACK" == 200 ]] && say "manifest is back (200)." || bad "manifest returned $BACK after restore, expected 200"

state "RESTORED"
await 3 || exit 1

printf '\n\033[1mall states observed. %d failure(s).\033[0m\n' "$FAIL"
