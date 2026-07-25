#!/usr/bin/env bash
#
# 6Lets — create and seed the LOCAL D1 database used by `wrangler pages dev`.
#
#   cd ~/Documents/6Lets && bash tools/init-local-db.sh
#
# `pages dev` runs against a miniflare SQLite store on disk, not your remote
# database. That store is keyed by the database id in wrangler.toml — so
# repointing preview_database_id gave you a fresh, empty one, and every endpoint
# that touches D1 started returning 500 while login/logout (which don't) kept
# working.
#
# Wrangler is inconsistent about whether `--local` alone targets database_id or
# preview_database_id, so this tries both and reports which one took.
#
# Touches nothing remote. Every command here is --local.
#
set -u

DB_NAME="sixlets-db"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
ok()   { printf '%s  PASS%s  %s\n' "$GRN" "$RST" "$1"; }
bad()  { printf '%s  FAIL%s  %s\n' "$RED" "$RST" "$1"; }
warn() { printf '%s  WARN%s  %s\n' "$YLW" "$RST" "$1"; }
hdr()  { printf '\n%s=== %s ===%s\n' "$BLD" "$1" "$RST"; }

[ -f wrangler.toml ] || { bad "not in the 6Lets project root"; exit 1; }

# Apply schema + seed with a given flag set, then confirm the tables answer.
try_variant() { # <label> <extra flags...>
  local label="$1"; shift
  local flags=("$@")

  printf '\n  trying: wrangler d1 execute %s --local %s\n' "$DB_NAME" "${flags[*]:-}"

  npx --yes wrangler d1 execute "$DB_NAME" --local "${flags[@]}" --file=./schema.sql >/dev/null 2>&1 || return 1
  npx --yes wrangler d1 execute "$DB_NAME" --local "${flags[@]}" --file=./seed.sql   >/dev/null 2>&1 || return 1

  local out
  out=$(npx --yes wrangler d1 execute "$DB_NAME" --local "${flags[@]}" \
          --command "SELECT COUNT(*) AS words FROM DailyWords;" 2>&1) || return 1

  # A working store reports a non-zero word count.
  if printf '%s' "$out" | grep -qE '[1-9][0-9]*'; then
    printf '%s\n' "$out" | tail -n 8
    ok "$label"
    return 0
  fi
  return 1
}

hdr "Initialise local D1"

DONE=0

if try_variant "seeded the preview-keyed local store (--local --preview)" --preview; then
  DONE=1
elif try_variant "seeded the default local store (--local)"; then
  DONE=1
fi

if [ "$DONE" = "0" ]; then
  bad "could not seed either local store"
  echo
  echo "  Run this to see the real error:"
  echo "    npx wrangler d1 execute $DB_NAME --local --preview --file=./schema.sql"
  exit 1
fi

# Belt and braces: seed the other store too, so it does not matter which one
# pages dev picks up. Both are local-only.
hdr "Mirroring to the other local store (harmless if redundant)"
npx --yes wrangler d1 execute "$DB_NAME" --local --file=./schema.sql >/dev/null 2>&1 \
  && npx --yes wrangler d1 execute "$DB_NAME" --local --file=./seed.sql >/dev/null 2>&1 \
  && ok "default local store also seeded" || warn "default local store not seeded (probably fine)"

npx --yes wrangler d1 execute "$DB_NAME" --local --preview --file=./schema.sql >/dev/null 2>&1 \
  && npx --yes wrangler d1 execute "$DB_NAME" --local --preview --file=./seed.sql >/dev/null 2>&1 \
  && ok "preview local store also seeded" || warn "preview local store not seeded (probably fine)"

cat <<'NEXT'

Now restart the dev server and reload with a clean slate:

  npx wrangler pages dev --port 8791

In the browser at http://localhost:8791 —
  DevTools -> Application -> Storage -> Clear site data   (once, first)
  then hard reload.

What you should see in the wrangler log:
  GET /api/words   200      <- not 500
  GET /api/user    200
and the board should show a real word, not SODIUM.

If anything still 500s, the wrangler console now prints the underlying
error above the request line. Paste that.
NEXT
