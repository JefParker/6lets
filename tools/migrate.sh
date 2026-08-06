#!/usr/bin/env bash
#
# 6Lets — apply a migration to D1, one statement at a time.
#
#   bash tools/migrate.sh migrations/0001_admin_auth_and_sessions.sql --remote
#   bash tools/migrate.sh migrations/0001_admin_auth_and_sessions.sql --remote --preview
#
# WHY NOT `wrangler d1 execute --file=...`?
#
# Because it does not work on this account. `--file` uploads through D1's bulk
# *import* endpoint (/d1/database/<id>/import), which on 2026-08-06 returned
# "Authentication error [code: 10000]" for every attempt, before and after a
# fresh `wrangler login`. The ordinary query endpoint accepted `--command` on
# the same token seconds later, both reads and DDL writes — so it is that one
# API surface being refused, not the token, the account, or the permissions.
#
# `wrangler whoami` is no help here and is actively misleading: it printed
# `d1 (write)` and "Super Administrator - All Privileges" throughout, because it
# reports the scopes recorded in the local config file at last login rather than
# what the token currently grants.
#
# So this script splits the file and sends each statement through the endpoint
# that does work. If `--file` starts working again, this becomes redundant —
# check by running it, not by reasoning about the token.
#
# SAFE TO RE-RUN, as long as the migration itself is: every statement in
# migrations/ is IF NOT EXISTS or otherwise idempotent, by convention.

set -u
set -o pipefail

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
ok()   { printf '%s  PASS%s  %s\n' "$GRN" "$RST" "$1"; }
warn() { printf '%s  WARN%s  %s\n' "$YLW" "$RST" "$1"; }
die()  { printf '%s  FAIL%s  %s\n' "$RED" "$RST" "$1"; exit 1; }

[ -f wrangler.toml ] || die "not in the 6Lets project root"

FILE="${1:-}"
[ -n "$FILE" ] || die "usage: bash tools/migrate.sh <file.sql> [--remote] [--preview]"
[ -f "$FILE" ] || die "no such file: $FILE"
shift

DB_NAME="sixlets-db"
REMOTE=""
PREVIEW=""
for arg in "$@"; do
  case "$arg" in
    --remote)  REMOTE="--remote" ;;
    # Selects the preview database by flag, not by name — there is no database
    # called "sixlets-db-preview" to address; preview is wired to this project
    # through preview_database_id in wrangler.toml.
    --preview) PREVIEW="--preview" ;;
    *) die "unknown option: $arg" ;;
  esac
done

if [ -z "$REMOTE" ]; then
  warn "no --remote: this will run against the LOCAL development database"
fi

echo
echo "  file:     $FILE"
echo "  database: ${DB_NAME} ${PREVIEW:+(preview) }${REMOTE:-(local)}"
printf '\n%sApply?%s [type yes to continue] ' "$BLD" "$RST"
read -r reply
[ "$reply" = "yes" ] || { echo "  aborted."; exit 1; }

# Strip `--` comments, flatten to one line, then split on `;`.
#
# This is only safe because migrations in this project contain no semicolons
# inside string literals — no statement separator hiding in a DEFAULT, a CHECK,
# or a seeded value. If you ever write one, this splitter will cut the statement
# in half and the failure will look like a syntax error in perfectly good SQL.
FAILED=0
COUNT=0
while IFS= read -r stmt; do
  COUNT=$((COUNT + 1))
  printf '\n%s>>> %.70s...%s\n' "$BLD" "$stmt" "$RST"
  if ! npx wrangler d1 execute "$DB_NAME" $REMOTE $PREVIEW --command="$stmt;"; then
    FAILED=1
    break
  fi
done < <(sed 's/--.*$//' "$FILE" | tr '\n' ' ' | tr ';' '\n' | grep -v '^[[:space:]]*$')

echo
if [ "$FAILED" = "1" ]; then
  die "statement $COUNT failed — fix it and re-run; earlier statements are idempotent.
        If this was error 10000 or 7403, try 'wrangler login'. Do not trust
        'wrangler whoami' to tell you whether that helped — it reports the
        scopes cached at last login, not what the token grants now."
fi

ok "applied $COUNT statements from $FILE"

cat <<NEXT

Verify, rather than assuming the command's exit code means the schema changed:

  npx wrangler d1 execute ${DB_NAME} ${REMOTE} ${PREVIEW} \\
    --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"

NEXT
