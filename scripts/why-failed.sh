#!/usr/bin/env bash
#
# WHY DID THAT TRADE FAIL? — a READ-ONLY dump of everything that decides it.
#
# `/history` shows a failed execution's state and (absent) signature. The REASON lives in
# `executions.error`, and until you can see it, "failed —" and "the executor is in dry-run" and
# "the price impact was too high" all look identical. This prints the reason, plus the three
# pieces of state that explain most of them: the flags, the schedule, and the caps.
#
# READ-ONLY, TWICE OVER: sqlite3 is opened with -readonly against a `mode=ro` URI, so this cannot
# write, migrate or lock the live DB even if you run it while the bot is trading.
#
# Needs root (or the ricebuybot user) — the DB directory is 0700 ricebuybot:
#
#     sudo bash /home/deploy/ricebuybot-src/scripts/why-failed.sh [rows]
#
set -uo pipefail

DB="${DB_PATH:-/var/lib/ricebuybot/ricebuybot.db}"
ROWS="${1:-10}"
HEALTH_PORT="${HTTP_PORT:-3012}"

if [[ ! -r "$DB" ]]; then
  echo "cannot read $DB — run me with sudo (the DB dir is 0700 ricebuybot)" >&2
  exit 1
fi

q() { sqlite3 -readonly -cmd '.mode box' "file:${DB}?mode=ro" "$@"; }

echo "=============================================================================="
echo " FLAGS — is this bot even allowed to trade?"
echo "=============================================================================="
# From the running process, not the env file: what is LOADED is what matters.
if ! curl -fsS --max-time 5 "http://127.0.0.1:${HEALTH_PORT}/health"; then
  echo "(health endpoint unreachable — is the bot running?)"
fi
echo
# The env file is the other half: /health only learned to report these two flags in the same
# change that added this script, so on an older build the file is the only answer. ONLY these two
# names are ever read — nothing else in that file is printed, and neither of these is a secret.
ENV_FILE="${ENV_FILE:-/etc/ricebuybot/env}"
if [[ -r "$ENV_FILE" ]]; then
  echo "  from ${ENV_FILE}:"
  grep -E '^(AUTOTRADER|TRADE_LIVE)=' "$ENV_FILE" | sed 's/^/    /' || true
  grep -qE '^TRADE_LIVE=true' "$ENV_FILE" || echo "    TRADE_LIVE is NOT true -> every execution is marked failed 'dry-run'. THIS IS THE ANSWER."
fi
echo
echo "  autotrader:false -> no schedule ticks at all."
echo "  tradeLive:false  -> schedules tick and EVERY execution is marked failed 'dry-run'."
echo "                      The wallet is never touched. This is the most common cause of a"
echo "                      column of failures, and it is not a bug."
echo

echo "=============================================================================="
echo " LAST ${ROWS} EXECUTIONS — with the reason"
echo "=============================================================================="
q "
  SELECT datetime(planned_at/1000,'unixepoch') AS when_utc,
         schedule_id AS sched,
         state,
         printf('\$%.2f', COALESCE(usd_value,0)) AS usd,
         COALESCE(substr(signature,1,12)||'…','—') AS sig,
         COALESCE(error,'') AS error
  FROM executions ORDER BY planned_at DESC LIMIT ${ROWS};
"

echo
echo "=============================================================================="
echo " FAILURE REASONS, GROUPED — the shape of the problem"
echo "=============================================================================="
q "
  SELECT COALESCE(error,'(none)') AS error, COUNT(*) AS n,
         datetime(MAX(planned_at)/1000,'unixepoch') AS last_seen
  FROM executions WHERE state IN ('failed','UNKNOWN')
  GROUP BY error ORDER BY n DESC LIMIT 10;
"

echo
echo "=============================================================================="
echo " SCHEDULES — amount, interval, state, and why it halted if it did"
echo "=============================================================================="
q "
  SELECT id, user_id AS uid, substr(mint,1,6)||'…' AS mint, side,
         CASE WHEN amount_kind='percent_of_balance'
              THEN printf('%.2f%%', amount_raw/100.0)
              WHEN side='buy' THEN printf('%.6f SOL', amount_raw/1000000000.0)
              ELSE amount_raw||' tokens' END AS amount,
         amount_kind AS kind, interval_minutes AS every_min, slippage_bps AS slip_bps,
         state, COALESCE(halt_reason,'') AS halt_reason,
         datetime(next_run_at/1000,'unixepoch') AS next_run_utc
  FROM schedules ORDER BY id;
"

echo
echo "=============================================================================="
echo " CAPS — a buy is refused if it breaches any of these"
echo "=============================================================================="
q "
  SELECT user_id AS uid, substr(mint,1,6)||'…' AS mint,
         printf('\$%.2f', max_per_exec_usd) AS per_exec,
         printf('\$%.2f', max_per_day_usd) AS per_day,
         COALESCE(printf('\$%.2f', max_lifetime_usd),'—') AS lifetime,
         printf('%.6f SOL', CAST(min_sol_reserve_lamports AS REAL)/1000000000.0) AS sol_reserve
  FROM caps ORDER BY user_id;
"

echo
echo "=============================================================================="
echo " TRADER MODE — 'wallet' members never tick; only 'key' members trade custodially (locked=1 is revoked)"
echo "=============================================================================="
q "SELECT user_id AS uid, COALESCE(label,'') AS label, mode, locked FROM autotrader_users ORDER BY user_id;"

echo
echo "Next: prove a trade of that size would actually complete, without spending anything:"
echo "  sudo -E node /home/deploy/ricebuybot-src/scripts/probe-trade.ts --wallet <pubkey> --sol 0.01"
