#!/usr/bin/env bash
#
# 6Lets — give preview deployments their own D1 database.
#
#   cd ~/Documents/6Lets && bash tools/split-preview-db.sh
#
# Right now preview_database_id and database_id in wrangler.toml are the same
# uuid, so every preview/branch deploy reads and writes PRODUCTION player data,
# and an admin logged into a preview URL edits the live word list.
#
# This script:
#   1. Creates a D1 database named sixlets-db-preview (or reuses it if present)
#   2. Points preview_database_id at it in wrangler.toml (backup kept)
#   3. Applies schema.sql to it
#   4. Seeds it from seed.sql so preview is actually playable
#
# It never writes to the production database. Every destructive statement is
# gated on the target name containing "preview".
#
# Idempotent: safe to re-run.
#
set -u
set -o pipefail

PROD_DB_NAME="sixlets-db"
PREVIEW_DB_NAME="sixlets-db-preview"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
ok()   { printf '%s  PASS%s  %s\n' "$GRN" "$RST" "$1"; }
bad()  { printf '%s  FAIL%s  %s\n' "$RED" "$RST" "$1"; }
warn() { printf '%s  WARN%s  %s\n' "$YLW" "$RST" "$1"; }
hdr()  { printf '\n%s=== %s ===%s\n' "$BLD" "$1" "$RST"; }
die()  { bad "$1"; exit 1; }

# Pull a database's uuid out of `wrangler d1 list --json`, tolerating npm/npx
# notice lines mixed into stdout.
db_uuid() {
  npx --yes wrangler d1 list --json 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      const a = s.indexOf("["), b = s.lastIndexOf("]");
      if (a < 0 || b < 0) process.exit(1);
      try {
        const list = JSON.parse(s.slice(a, b + 1));
        const hit = list.find(d => d.name === process.argv[1]);
        if (hit) console.log(hit.uuid || hit.database_id || "");
      } catch (e) { process.exit(1); }
    });
  ' "$1"
}

# ================================================================ preflight ==
hdr "Preflight"

[ -f wrangler.toml ] || die "not in the 6Lets project root"
[ -f schema.sql ]    || die "schema.sql not found"
ok "project root ($(pwd))"

npx --yes wrangler whoami >/dev/null 2>&1 || die "not logged in — run: npx wrangler login"
ok "authenticated with Cloudflare"

CURRENT_PROD=$(grep -E '^[[:space:]]*database_id' wrangler.toml | head -n1 | cut -d'"' -f2)
CURRENT_PREVIEW=$(grep -E '^[[:space:]]*preview_database_id' wrangler.toml | head -n1 | cut -d'"' -f2)
[ -n "$CURRENT_PROD" ] || die "could not read database_id from wrangler.toml"
echo "        production database_id: $CURRENT_PROD"
echo "        preview_database_id:    ${CURRENT_PREVIEW:-<unset>}"

if [ -n "$CURRENT_PREVIEW" ] && [ "$CURRENT_PREVIEW" != "$CURRENT_PROD" ]; then
  ok "preview is already a separate database — nothing to split"
  echo "        Re-running the schema/seed steps against it anyway."
fi

# ============================================================ 1. create db ==
hdr "1. Preview database"

PREVIEW_ID=$(db_uuid "$PREVIEW_DB_NAME")

if [ -n "$PREVIEW_ID" ]; then
  ok "$PREVIEW_DB_NAME already exists ($PREVIEW_ID)"
else
  echo "  creating $PREVIEW_DB_NAME ..."
  npx --yes wrangler d1 create "$PREVIEW_DB_NAME" || die "d1 create failed"
  PREVIEW_ID=$(db_uuid "$PREVIEW_DB_NAME")
  [ -n "$PREVIEW_ID" ] || die "created the database but could not read its uuid back"
  ok "created $PREVIEW_DB_NAME ($PREVIEW_ID)"
fi

# Hard stop: never let the preview id equal the production id.
if [ "$PREVIEW_ID" = "$CURRENT_PROD" ]; then
  die "preview uuid matches production uuid — refusing to continue"
fi

# ========================================================= 2. wrangler.toml =
hdr "2. Point preview_database_id at it"

if [ "$CURRENT_PREVIEW" = "$PREVIEW_ID" ]; then
  ok "wrangler.toml already correct"
else
  cp wrangler.toml "wrangler.toml.bak.$(date +%Y%m%d%H%M%S)"
  ok "backed up wrangler.toml"

  if [ -n "$CURRENT_PREVIEW" ]; then
    sed -i -E "s|^([[:space:]]*preview_database_id[[:space:]]*=[[:space:]]*).*|\1\"$PREVIEW_ID\"|" wrangler.toml
  else
    sed -i -E "s|^([[:space:]]*database_id[[:space:]]*=.*)$|\1\npreview_database_id = \"$PREVIEW_ID\"|" wrangler.toml
  fi

  NEW_PREVIEW=$(grep -E '^[[:space:]]*preview_database_id' wrangler.toml | head -n1 | cut -d'"' -f2)
  NEW_PROD=$(grep -E '^[[:space:]]*database_id' wrangler.toml | head -n1 | cut -d'"' -f2)

  if [ "$NEW_PREVIEW" = "$PREVIEW_ID" ] && [ "$NEW_PROD" = "$CURRENT_PROD" ]; then
    ok "preview_database_id updated; production database_id untouched"
  else
    die "wrangler.toml edit did not apply cleanly — restore from the .bak file"
  fi
fi

# =============================================================== 3. schema ==
hdr "3. Apply schema.sql to the preview database"

case "$PREVIEW_DB_NAME" in
  *preview*) : ;;
  *) die "refusing to write to '$PREVIEW_DB_NAME' — name must contain 'preview'" ;;
esac

if npx --yes wrangler d1 execute "$PREVIEW_DB_NAME" --remote --file=./schema.sql --yes; then
  ok "schema applied to $PREVIEW_DB_NAME"
else
  die "schema failed on $PREVIEW_DB_NAME"
fi

# ================================================================= 4. seed ==
hdr "4. Seed the preview database with words"

if [ ! -f seed.sql ]; then
  warn "seed.sql not found — preview will fall back to the offline word (SODIUM)"
else
  # seed.sql opens with DELETE FROM DailyWords. That is fine here and only here:
  # the name check above guarantees we are pointed at the preview database.
  if npx --yes wrangler d1 execute "$PREVIEW_DB_NAME" --remote --file=./seed.sql --yes; then
    ok "seeded $PREVIEW_DB_NAME from seed.sql"
  else
    warn "seed failed — preview will work but has no words until you add some"
  fi
fi

# ================================================================== verify ==
hdr "Verify"

FINAL_PROD=$(grep -E '^[[:space:]]*database_id' wrangler.toml | head -n1 | cut -d'"' -f2)
FINAL_PREVIEW=$(grep -E '^[[:space:]]*preview_database_id' wrangler.toml | head -n1 | cut -d'"' -f2)

printf '        production: %s\n' "$FINAL_PROD"
printf '        preview:    %s\n' "$FINAL_PREVIEW"

if [ "$FINAL_PROD" = "$CURRENT_PROD" ]; then
  ok "production database_id unchanged"
else
  bad "production database_id CHANGED — restore wrangler.toml from the .bak file"
fi

if [ -n "$FINAL_PREVIEW" ] && [ "$FINAL_PREVIEW" != "$FINAL_PROD" ]; then
  ok "preview and production are now separate databases"
else
  bad "preview and production are still the same"
fi

echo "  word counts (preview vs production):"
npx --yes wrangler d1 execute "$PREVIEW_DB_NAME" --remote \
  --command "SELECT COUNT(*) AS preview_words FROM DailyWords;" 2>/dev/null | tail -n 6
npx --yes wrangler d1 execute "$PROD_DB_NAME" --remote \
  --command "SELECT COUNT(*) AS production_words FROM DailyWords;" 2>/dev/null | tail -n 6

cat <<'NEXT'

Next:

  bash tools/setup-and-verify.sh    # the preview/production advisory should
                                    # now read PASS

  npx wrangler pages deploy         # preview deploys now hit their own database

Commit wrangler.toml. The .bak file is a local safety copy — delete it once
you are happy, and do not commit it.
NEXT
