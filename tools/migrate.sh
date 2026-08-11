#!/usr/bin/env bash
#
# 6Lets — apply a migration file to D1.
#
#   bash tools/migrate.sh migrations/0001_admin_auth_and_sessions.sql --remote
#   bash tools/migrate.sh migrations/0001_admin_auth_and_sessions.sql --remote --preview
#   bash tools/migrate.sh migrations/0001_admin_auth_and_sessions.sql --remote --yes
#
# Prompts for confirmation when run from a terminal; non-interactive callers
# (deploy:safe from CI, a hook, a pipe) proceed unattended, and --yes skips the
# prompt anywhere.
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
# So this script sends the whole file as one `--command` through the endpoint
# that does work. Wrangler splits the command into statements with a real SQL
# parser, so `--` and `;` inside string literals survive, and the file goes up
# in a single submission rather than N independent partial applies. If `--file`
# starts working again, this becomes redundant — check by running it, not by
# reasoning about the token.
#
# SAFE TO RE-RUN, as long as the migration itself is: every statement in
# migrations/ is IF NOT EXISTS or otherwise idempotent, by convention.

set -u
set -o pipefail

. "$(dirname "$0")/lib.sh"

[ -f wrangler.toml ] || die "not in the 6Lets project root"

DB_NAME=$(db_name)
[ -n "$DB_NAME" ] || die "could not read database_name from wrangler.toml"

FILES=()
REMOTE=""
PREVIEW=""
ASSUME_YES=""
for arg in "$@"; do
  case "$arg" in
    --remote)  REMOTE="--remote" ;;
    # --preview points `d1 execute` at the database in preview_database_id in
    # wrangler.toml — that key reaches only this flag and `wrangler pages dev`.
    # Preview *deployments* bind their database separately, through
    # [[env.preview.d1_databases]]. The two must name the same database (see
    # wrangler.toml and CODE_REVIEW.md); this script relies on that staying
    # true.
    --preview) PREVIEW="--preview" ;;
    --yes)     ASSUME_YES=1 ;;
    --*)       die "unknown option: $arg" ;;
    *)         FILES+=("$arg") ;;
  esac
done

[ "${#FILES[@]}" -gt 0 ] || die "usage: bash tools/migrate.sh <file.sql> [more.sql ...] [--remote] [--preview] [--yes]"
for FILE in "${FILES[@]}"; do
  [ -r "$FILE" ] || die "cannot read: $FILE"
done

# The preview uuid lives in wrangler.toml twice — preview_database_id (what
# this flag targets) and [[env.preview.d1_databases]] (what preview deployments
# read) — kept equal only by hand. Refuse to migrate if they have drifted:
# migrating one database while deploys read the other is the exact failure
# CODE_REVIEW.md documents.
if [ -n "$PREVIEW" ]; then
  [ -n "$REMOTE" ] || die "--preview requires --remote — wrangler has no local preview database to target"
  EXEC_ID=$(sed -n 's/^[[:space:]]*preview_database_id[[:space:]]*=[[:space:]]*"\(.*\)".*$/\1/p' wrangler.toml | head -n1)
  DEPLOY_ID=$(sed -n 's/^[[:space:]]*database_id[[:space:]]*=[[:space:]]*"\(.*\)".*$/\1/p' wrangler.toml | tail -n1)
  [ -n "$EXEC_ID" ] || die "--preview: wrangler.toml has no preview_database_id — d1 execute would fall back to the production database"
  [ "$EXEC_ID" = "$DEPLOY_ID" ] || die "--preview: preview_database_id ($EXEC_ID) does not match the
        [[env.preview.d1_databases]] database_id ($DEPLOY_ID) — migrating one
        while deploys read the other helps nobody. Fix wrangler.toml first."
fi

if [ -z "$REMOTE" ]; then
  warn "no --remote: this will run against the LOCAL development database"
fi

echo
printf '  file:     %s\n' "${FILES[@]}"
echo "  database: ${DB_NAME} ${PREVIEW:+(preview) }${REMOTE:-(local)}"

if [ -z "$ASSUME_YES" ] && [ -t 0 ]; then
  printf '\n%sApply?%s [type yes to continue] ' "$BLD" "$RST"
  read -r reply
  [ "$reply" = "yes" ] || { echo "  aborted."; exit 1; }
fi

# </dev/null so wrangler can never read the terminal or a caller's piped stdin
# mid-run (an npx install prompt answered by whatever happens to be on stdin).
for FILE in "${FILES[@]}"; do
  SQL=$(cat "$FILE") || die "could not read $FILE"
  case "$SQL" in
    *[![:space:]]*) : ;;
    *) die "$FILE is empty — refusing to report an empty migration as applied" ;;
  esac

  printf '\n%s>>> %s%s\n' "$BLD" "$FILE" "$RST"
  if ! npx wrangler d1 execute "$DB_NAME" $REMOTE $PREVIEW --command="$SQL" </dev/null; then
    die "migration failed at $FILE — fix it and re-run; statements in
        migrations/ are idempotent by convention, so re-running is safe.
        If this was error 10000 or 7403, try 'wrangler login'. Do not trust
        'wrangler whoami' to tell you whether that helped — it reports the
        scopes cached at last login, not what the token grants now."
  fi
done

ok "applied: ${FILES[*]}"

cat <<NEXT

Verify, rather than assuming the command's exit code means the schema changed:

  npx wrangler d1 execute ${DB_NAME} ${REMOTE} ${PREVIEW} \\
    --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"

NEXT
