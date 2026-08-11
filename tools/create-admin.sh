#!/usr/bin/env bash
#
# 6Lets — create or re-password a dashboard admin.
#
#   cd ~/Documents/6Lets && bash tools/create-admin.sh <username> [--remote] [--preview]
#
# Prompts for the password; never takes it as an argument, because arguments
# land in shell history and in `ps` output for every other user on the box.
#
# The password is hashed locally with the same PBKDF2 parameters the worker
# verifies against (lib/auth.js), so no plaintext password is ever sent to D1
# or written to a file.
#
# You do NOT need this to get started: the first successful password login
# against an empty AdminUsers table seeds the account from DASHBOARD_USERNAME /
# DASHBOARD_PASSWORD automatically. Use this to add a second admin, or to change
# a password once that bootstrap has already run — after which the environment
# variables are inert and rotating them changes nothing.

set -u
set -o pipefail

. "$(dirname "$0")/lib.sh"

[ -f wrangler.toml ] || die "not in the 6Lets project root"
command -v node >/dev/null 2>&1 || die "node not found"

USERNAME="${1:-}"
[ -n "$USERNAME" ] || die "usage: bash tools/create-admin.sh <username> [--remote] [--preview]"
shift

# The username is interpolated into the SQL below, so constrain it rather than
# trusting quoting. A username containing an apostrophe would otherwise end the
# string literal early.
case "$USERNAME" in
  *[!A-Za-z0-9._-]*) die "username may contain only letters, digits, dot, underscore and hyphen" ;;
esac

DB_NAME=$(db_name)
[ -n "$DB_NAME" ] || die "could not read database_name from wrangler.toml"
REMOTE=""
PREVIEW=""
for arg in "$@"; do
  case "$arg" in
    --remote)  REMOTE="--remote" ;;
    # --preview points `d1 execute` at the database in preview_database_id in
    # wrangler.toml — that key reaches only this flag and `wrangler pages dev`.
    # Preview *deployments* bind theirs through [[env.preview.d1_databases]];
    # the two must name the same database (see wrangler.toml, CODE_REVIEW.md).
    --preview) PREVIEW="--preview" ;;
    *) die "unknown option: $arg" ;;
  esac
done

# Read twice, echo neither.
printf '%sPassword for "%s":%s ' "$BLD" "$USERNAME" "$RST"
read -rs PASSWORD; echo
printf '%sAgain:%s ' "$BLD" "$RST"
read -rs PASSWORD_CONFIRM; echo

[ -n "$PASSWORD" ] || die "empty password"
[ "$PASSWORD" = "$PASSWORD_CONFIRM" ] || die "passwords do not match"
[ "${#PASSWORD}" -ge 12 ] || die "use at least 12 characters — this is the door that stays open when a phone dies"

# Hash with the project's own function rather than a reimplementation here, so
# the two can never drift into producing formats the other cannot verify.
HASH=$(NEW_PASSWORD="$PASSWORD" node --input-type=module -e "
  const { hashPassword } = await import('./lib/auth.js');
  process.stdout.write(await hashPassword(process.env.NEW_PASSWORD));
") || die "could not hash the password"

USER_ID=$(node -e "process.stdout.write(crypto.randomUUID())")

# Upsert: creates the admin, or replaces the password hash if the username is
# already taken. Leaves any enrolled passkeys alone — they hang off user_id,
# which does not change here.
SQL="INSERT INTO AdminUsers (id, username, password_hash)
     VALUES ('${USER_ID}', '${USERNAME}', '${HASH}')
     ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash;"

echo
echo "  database: ${DB_NAME} ${PREVIEW:+(preview) }${REMOTE:-(local)}"
echo "  username: ${USERNAME}"
printf '\n%sApply?%s [type yes to continue] ' "$BLD" "$RST"
read -r reply
[ "$reply" = "yes" ] || { echo "  aborted."; exit 1; }

npx wrangler d1 execute "$DB_NAME" $REMOTE $PREVIEW --command="$SQL" || die "wrangler execute failed.
        If this was error 7403 (\"not authorized to access this service\"), run
        'wrangler login' — it reads like a billing problem and it is a stale
        OAuth token. 'wrangler whoami' will not tell you: it prints the scopes
        recorded at last login, not what the token grants now."

ok "admin '${USERNAME}' created or updated"

cat <<NEXT

Next:

  - Sign in with the password, then add a passkey from the dashboard.
  - Keep the password. A passkey lives on one device; if that device dies, the
    password is the only route back in that does not involve this script at
    exactly the wrong moment.
NEXT
