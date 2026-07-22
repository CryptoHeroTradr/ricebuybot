#!/usr/bin/env bash
#
# Nightly SQLite backup. WAL-SAFE.
#
#   /opt/ricebuybot/scripts/backup-db.sh
#
# USE `.backup`, NEVER `cp`.
#
# The DB runs in WAL mode, so at any moment the committed state is spread across
# ricebuybot.db AND ricebuybot.db-wal. Copying the .db file alone gives you a file that is
# missing every transaction since the last checkpoint — and it does not LOOK broken. It
# opens, it queries, it is simply missing the most recent buys, sends and file_ids. You find
# out on the day you restore it, which is the worst possible day to find out.
#
# `sqlite3 .backup` uses the online backup API: it takes a consistent snapshot of the whole
# database, WAL included, while the bot keeps writing.
set -euo pipefail

DB="${DB_PATH:-/var/lib/ricebuybot/ricebuybot.db}"
DEST="${BACKUP_DIR:-/var/lib/ricebuybot/backups}"
KEEP="${KEEP:-7}"

[[ -f "$DB" ]] || { echo "no database at $DB" >&2; exit 1; }

mkdir -p "$DEST"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/ricebuybot-$STAMP.db"

# .backup, not .dump: a binary snapshot restores by copying a file back, with no replay of a
# multi-megabyte SQL script and no chance of a partial restore.
sqlite3 "$DB" ".backup '$OUT'"

# Prove it. A backup nobody has verified is a hope, not a backup — and integrity_check on a
# 5MB file costs milliseconds.
if ! sqlite3 "$OUT" 'PRAGMA integrity_check;' | grep -qx 'ok'; then
  echo "BACKUP FAILED INTEGRITY CHECK: $OUT" >&2
  rm -f "$OUT"
  exit 1
fi

ROWS="$(sqlite3 "$OUT" 'SELECT COUNT(*) FROM sends;' 2>/dev/null || echo '?')"
SIZE="$(du -h "$OUT" | cut -f1)"
echo "backup ok: $OUT ($SIZE, ${ROWS} sends)"

# Keep the newest N. Deleting the OLDEST is the only safe direction to prune in.
mapfile -t OLD < <(ls -1t "$DEST"/ricebuybot-*.db 2>/dev/null | tail -n +$((KEEP + 1)))
for f in ${OLD+"${OLD[@]}"}; do
  echo "pruning $f"
  rm -f "$f"
done
