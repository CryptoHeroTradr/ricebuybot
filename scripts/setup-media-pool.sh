#!/usr/bin/env bash
#
# Provision the shared rice media pool — Phase 5a. Run on the VPS as root:
#
#   sudo bash scripts/setup-media-pool.sh                     # $RICE
#   sudo bash scripts/setup-media-pool.sh --mint <MINT>       # another tenant
#   sudo bash scripts/setup-media-pool.sh --no-nginx          # skip the vhost edits
#
# IDEMPOTENT. Safe to re-run: it re-applies ownership and permissions, reinstalls
# the pool tooling, and leaves the media itself alone.
#
# It does NOT touch one line of onegrainofrice or RiceDAO application code. The
# only thing it changes outside its own tree is a single `include` line in each
# vhost — backed up, `nginx -t`-tested, and rolled back on failure.
#
# WHY A DEDICATED `ricebuybot` USER — and it is not about the meme folder.
# Everything on this box runs as `deploy`, including two public-facing Next apps.
# If the bot ran as `deploy` too, then a path traversal or RCE in onegrainofrice
# would read the bot's .env: a Telegram token that can post to every group we
# ever onboard, and a paid Helius key. That is the blast radius this user cuts.
# The pool permissions below are the same fence, one folder over.
set -euo pipefail

MINT="2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump"
MEDIA_ROOT="/srv/media"
BOT_USER="ricebuybot"
TOOLS_DIR="/opt/ricebuybot-media"
DO_NGINX=1
# The vhosts that gain a read-only /media/ location. Both serve rice properties.
NGINX_SITES=("1grainofrice" "game.1grainofrice.com")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mint) MINT="$2"; shift 2 ;;
    --root) MEDIA_ROOT="$2"; shift 2 ;;
    --no-nginx) DO_NGINX=0; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "must run as root (it creates a user and writes /srv, /opt, /etc)" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
POOL="$MEDIA_ROOT/$MINT"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
say "dependencies"

if ! command -v ffprobe >/dev/null; then
  echo "installing ffmpeg (ffprobe reads dimensions, duration and audio tracks)"
  apt-get update -qq
  apt-get install -y -qq ffmpeg
fi
echo "ffprobe: $(ffprobe -version 2>/dev/null | head -1)"

# systemd cannot use a node that lives inside deploy's nvm. The units need a
# system node, and Phase 10's bot unit will need the same one.
if [[ ! -x /usr/bin/node ]]; then
  echo "installing Node 22 system-wide (systemd cannot reach deploy's nvm)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
NODE_MAJOR="$(/usr/bin/node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 22 ]] || { echo "need Node >= 22 at /usr/bin/node (found $NODE_MAJOR)" >&2; exit 1; }
echo "node: $(/usr/bin/node -v) at /usr/bin/node"

# ---------------------------------------------------------------------------
say "user"

if ! id -u "$BOT_USER" >/dev/null 2>&1; then
  useradd --system --shell /usr/sbin/nologin --home-dir /opt/ricebuybot --create-home "$BOT_USER"
  echo "created system user $BOT_USER"
else
  echo "$BOT_USER already exists"
fi
id "$BOT_USER"

# ---------------------------------------------------------------------------
say "pool"

# Ownership: the bot owns it, www-data (nginx) reads it, and `deploy` — the user
# running both websites — has NO access at all. The websites reach the pool over
# HTTP, exactly like every other client.
#
# setgid (2xxx) on every directory so that anything the bot creates inherits the
# group, and nginx can still read a meme dropped in months from now.
#
#   tiers     2750 ricebuybot:www-data   bot rwx, nginx r-x, everyone else nothing
#   _archive  2750 ricebuybot:ricebuybot nginx cannot even traverse it
#   _incoming 2750 ricebuybot:ricebuybot   "        "        "
#
# _archive and _incoming are denied in nginx too. This is the second lock on that
# door: if the nginx snippet is ever edited wrong, the filesystem still says no.
install -d -o "$BOT_USER" -g www-data -m 2750 "$MEDIA_ROOT"
install -d -o "$BOT_USER" -g www-data -m 2750 "$POOL"
for tier in regular big whale massive; do
  install -d -o "$BOT_USER" -g www-data -m 2750 "$POOL/$tier"
done
install -d -o "$BOT_USER" -g "$BOT_USER" -m 2750 "$POOL/_archive"
install -d -o "$BOT_USER" -g "$BOT_USER" -m 2750 "$MEDIA_ROOT/_incoming"
install -d -o "$BOT_USER" -g "$BOT_USER" -m 2750 "$MEDIA_ROOT/_incoming/$MINT"

# Re-assert on every run: a file dropped in by hand as root would otherwise be
# unreadable to nginx and unwritable by the bot.
chown -R "$BOT_USER":www-data "$POOL/regular" "$POOL/big" "$POOL/whale" "$POOL/massive"
find "$POOL" -type f -exec chmod 0640 {} +
find "$POOL/_archive" "$MEDIA_ROOT/_incoming" -exec chown "$BOT_USER":"$BOT_USER" {} +

find "$MEDIA_ROOT" -maxdepth 2 -type d -printf '%M %u:%g %p\n' | sort -k3

# ---------------------------------------------------------------------------
say "pool tooling"

# Owned by ROOT, not by the bot: the manifest job runs as ricebuybot and must not
# be able to rewrite the code it is about to execute.
#
# The REPO'S DIRECTORY SHAPE IS MIRRORED, not flattened. The scripts import the pool
# primitives as `../src/media/pool.ts`, so scripts/ and src/ must sit next to each
# other exactly as they do in the checkout or the import resolves outside $TOOLS_DIR
# and Node throws. Flattening these into one directory is what breaks it.
install -d -o root -g root -m 0755 "$TOOLS_DIR" "$TOOLS_DIR/scripts" "$TOOLS_DIR/src/media" "$TOOLS_DIR/src/core"
install -o root -g root -m 0755 "$REPO/scripts/build-manifest.ts" "$TOOLS_DIR/scripts/build-manifest.ts"
install -o root -g root -m 0755 "$REPO/scripts/tier.ts"           "$TOOLS_DIR/scripts/tier.ts"
install -o root -g root -m 0644 "$REPO/src/media/pool.ts"         "$TOOLS_DIR/src/media/pool.ts"
install -o root -g root -m 0644 "$REPO/src/core/tiers.ts"         "$TOOLS_DIR/src/core/tiers.ts"

# `rice-tier massive foo.gif` — the bulk curation path, from any sudoer.
cat > /usr/local/bin/rice-tier <<EOF
#!/usr/bin/env bash
# Move media into a tier (or into _archive) and regenerate the manifest.
# Runs as $BOT_USER, the only user that may write to the pool.
exec sudo -u $BOT_USER /usr/bin/node $TOOLS_DIR/scripts/tier.ts --root $MEDIA_ROOT --mint $MINT "\$@"
EOF
chmod 0755 /usr/local/bin/rice-tier
echo "installed $TOOLS_DIR/{scripts/{build-manifest,tier}.ts,src/{media/pool,core/tiers}.ts} and /usr/local/bin/rice-tier"

# ---------------------------------------------------------------------------
say "manifest timer"

sed "s|^Environment=MINT=.*|Environment=MINT=$MINT|" \
  "$REPO/deploy/systemd/ricebuybot-manifest.service" > /etc/systemd/system/ricebuybot-manifest.service
install -o root -g root -m 0644 \
  "$REPO/deploy/systemd/ricebuybot-manifest.timer" /etc/systemd/system/ricebuybot-manifest.timer
chmod 0644 /etc/systemd/system/ricebuybot-manifest.service

systemctl daemon-reload
systemctl enable --now ricebuybot-manifest.timer
systemctl start ricebuybot-manifest.service
systemctl list-timers --no-pager ricebuybot-manifest.timer | head -3

# ---------------------------------------------------------------------------
if [[ $DO_NGINX -eq 1 ]]; then
  say "nginx"

  # Repoint BOTH aliases (the exact-match manifest one and the prefix one) at this
  # pool, without touching what follows: `.../<mint>/;` and `.../<mint>/manifest.json;`
  # must each keep their own tail.
  sed "s|^\( *alias \)/srv/media/[^/]*|\1$POOL|" \
    "$REPO/deploy/nginx/ricebuybot-media.conf" > /etc/nginx/snippets/ricebuybot-media.conf
  grep -c "alias $POOL" /etc/nginx/snippets/ricebuybot-media.conf | grep -qx 2 ||
    { echo "snippet alias rewrite failed — expected 2 alias lines" >&2; exit 1; }
  chmod 0644 /etc/nginx/snippets/ricebuybot-media.conf

  STAMP="$(date +%Y%m%d-%H%M%S)"
  CHANGED=()

  for site in "${NGINX_SITES[@]}"; do
    vhost="/etc/nginx/sites-available/$site"
    [[ -f "$vhost" ]] || { echo "SKIP $site (no such vhost)"; continue; }

    if grep -q 'ricebuybot-media.conf' "$vhost"; then
      echo "$site already includes the snippet"
      continue
    fi

    cp -a "$vhost" "$vhost.bak-$STAMP"
    CHANGED+=("$vhost")

    # Insert the include immediately after the FIRST `server_name` line — i.e.
    # inside the real (TLS) server block, not the certbot redirect stub below it.
    # Purely additive: one line, no existing directive touched.
    awk '
      !done && /^[[:space:]]*server_name[[:space:]]/ {
        print
        print ""
        print "    # RiceBuybot media pool (Phase 5a) — read-only, additive."
        print "    include snippets/ricebuybot-media.conf;"
        done = 1
        next
      }
      { print }
    ' "$vhost.bak-$STAMP" > "$vhost"

    echo "added include to $site (backup: $vhost.bak-$STAMP)"
  done

  # Any failure here rolls BOTH vhosts back. We do not leave the rice sites in a
  # config that will not load: nothing in this phase is worth an outage.
  if ! nginx -t; then
    echo "nginx -t FAILED — rolling back" >&2
    for vhost in ${CHANGED+"${CHANGED[@]}"}; do
      cp -a "$vhost.bak-$STAMP" "$vhost"
    done
    rm -f /etc/nginx/snippets/ricebuybot-media.conf
    nginx -t && systemctl reload nginx
    exit 1
  fi
  systemctl reload nginx
  echo "nginx reloaded"
fi

# ---------------------------------------------------------------------------
say "done"
cat <<EOF
pool      $POOL
tiers     regular big whale massive   (+ _archive, excluded from the manifest)
drop zone $MEDIA_ROOT/_incoming/$MINT
manifest  $POOL/manifest.json   (systemd timer, every 5 min + on every tier move)

seed it:   cp *.gif $MEDIA_ROOT/_incoming/$MINT/ && rice-tier massive '*.gif'
           rice-tier massive ./banger.gif
retire:    rice-tier archive old.gif          # moved to _archive, never deleted
regen:     systemctl start ricebuybot-manifest.service

verify:    curl -sS https://1grainofrice.com/media/manifest.json | head
           curl -sSo /dev/null -w '%{http_code}\n' https://1grainofrice.com/media/_archive/
EOF
