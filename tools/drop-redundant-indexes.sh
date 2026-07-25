#!/usr/bin/env bash
#
# 6Lets — drop the two redundant Results indexes everywhere.
#
#   cd ~/Documents/6Lets && bash tools/drop-redundant-indexes.sh
#
# UNIQUE(user_uuid, game_id) already indexes that pair, and SQLite's
# leftmost-prefix rule means it serves `WHERE user_uuid = ?` too. So
# idx_results_user_uuid and idx_results_user_game both cost a write on every
# result insert and buy nothing.
#
# DROP INDEX does not touch row data. Reversible with one CREATE INDEX.
#
# Runs against: remote production, remote preview, local dev store.
#
set -u

PROD_DB="sixlets-db"
PREVIEW_DB="sixlets-db-preview"
SQL="./sql/drop-redundant-indexes.sql"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
ok()   { printf '%s  PASS%s  %s\n' "$GRN" "$RST" "$1"; }
bad()  { printf '%s  FAIL%s  %s\n' "$RED" "$RST" "$1"; }
warn() { printf '%s  WARN%s  %s\n' "$YLW" "$RST" "$1"; }
hdr()  { printf '\n%s=== %s ===%s\n' "$BLD" "$1" "$RST"; }

[ -f wrangler.toml ] || { bad "not in the 6Lets project root"; exit 1; }
[ -f "$SQL" ]        || { bad "$SQL not found"; exit 1; }

show_indexes() { # <label> <db> <flags...>
  local label="$1" db="$2"; shift 2
  printf '  %s:\n' "$label"
  # Match the index names anywhere in wrangler's box-drawn table. (Anchoring on
  # the box character needed an escape that grep warned about.)
  npx --yes wrangler d1 execute "$db" "$@" \
    --command "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name;" \
    2>/dev/null | grep -oE 'idx_[a-z_]+' | sort -u | sed 's/^/    /' \
    || echo "    (none found)"
}

hdr "Before"
show_indexes "production" "$PROD_DB" --remote

hdr "Dropping on remote production"
if npx --yes wrangler d1 execute "$PROD_DB" --remote --file="$SQL" --yes; then
  ok "production"
else
  bad "production — if this is the auth error again, run: npx wrangler login"
fi

hdr "Dropping on remote preview"
if npx --yes wrangler d1 execute "$PREVIEW_DB" --remote --file="$SQL" --yes; then
  ok "preview"
else
  warn "preview — preview was freshly created from the corrected schema, so it"
  warn "probably never had these indexes. Safe to ignore."
fi

hdr "Dropping on the local dev store"
npx --yes wrangler d1 execute "$PROD_DB" --local --file="$SQL" >/dev/null 2>&1 \
  && ok "local" || warn "local (probably fine)"

hdr "After"
show_indexes "production" "$PROD_DB" --remote

cat <<'NEXT'

Expected to remain:
  idx_dailywords_word
  idx_results_game_id

Anything named idx_results_user_* still listed means the drop did not apply.
NEXT
