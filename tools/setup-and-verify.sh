#!/usr/bin/env bash
#
# 6Lets — post-review setup and verification.
#
#   cd ~/Documents/6Lets && bash tools/setup-and-verify.sh
#
# Idempotent: safe to re-run. Nothing here is destructive to player data —
# the only DB statements are CREATE TABLE/INDEX IF NOT EXISTS.
#
# Steps:
#   1. Preflight (tools present, right directory)
#   2. Syntax-check every JS file and validate the JSON
#   3. Regression asserts for each review fix
#   4. Remove the unused puppeteer dependency
#   5. Write .dev.vars for local development
#   6. Push DASHBOARD_USERNAME / DASHBOARD_PASSWORD / SECRET_KEY to Pages
#   7. Apply schema.sql (adds the three new indexes) to the remote D1
#
set -u
set -o pipefail

# ---------------------------------------------------------------- config ----
# If your Cloudflare Pages project is named something other than this, change
# it here (check with: npx wrangler pages project list).
PAGES_PROJECT="sixlets-pwa"
D1_DATABASE="sixlets-db"

DASHBOARD_USERNAME='JParker'
DASHBOARD_PASSWORD='GdPC5BxFF2clHJl*'

# --------------------------------------------------------------- plumbing ---
PASS=0; FAIL=0; SKIP=0
RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'

ok()   { printf '%s  PASS%s  %s\n' "$GRN" "$RST" "$1"; PASS=$((PASS+1)); }
bad()  { printf '%s  FAIL%s  %s\n' "$RED" "$RST" "$1"; FAIL=$((FAIL+1)); }
skip() { printf '%s  SKIP%s  %s\n' "$YLW" "$RST" "$1"; SKIP=$((SKIP+1)); }
hdr()  { printf '\n%s=== %s ===%s\n' "$BLD" "$1" "$RST"; }

TMPDIR_ESM="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_ESM"' EXIT

# ================================================================= 1. PRE ===
hdr "1. Preflight"

if [ ! -f wrangler.toml ] || [ ! -d functions ] || [ ! -d public ]; then
  printf '%sNot in the 6Lets project root.%s  cd there first, then re-run.\n' "$RED" "$RST"
  exit 1
fi
ok "project root looks right ($(pwd))"

for tool in node npm npx; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "$tool present ($("$tool" --version 2>&1 | head -n1))"
  else
    bad "$tool NOT FOUND — install Node.js and re-run"
    exit 1
  fi
done

# ============================================================== 2. SYNTAX ===
hdr "2. Syntax and JSON validation"

# Browser-side classic scripts: plain parse.
for f in public/script.js public/sw.js public/dictionary.js; do
  if [ ! -f "$f" ]; then bad "$f missing"; continue; fi
  if err=$(node --check "$f" 2>&1); then ok "parse  $f"; else bad "parse  $f"; printf '%s\n' "$err"; fi
done

# Worker/lib files are ES modules. node --check only treats a file as ESM if it
# ends in .mjs, so copy each to a temp .mjs before checking.
ESM_FILES=$(find functions lib -name '*.js' -type f 2>/dev/null | sort)
if [ -z "$ESM_FILES" ]; then
  bad "found no files under functions/ or lib/"
else
  while IFS= read -r f; do
    cp "$f" "$TMPDIR_ESM/check.mjs"
    if err=$(node --check "$TMPDIR_ESM/check.mjs" 2>&1); then
      ok "parse  $f"
    else
      bad "parse  $f"
      printf '%s\n' "$err" | sed "s|$TMPDIR_ESM/check.mjs|$f|g"
    fi
  done <<< "$ESM_FILES"
fi

for f in public/manifest.json package.json; do
  if node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" 2>/dev/null; then
    ok "json   $f"
  else
    bad "json   $f is not valid JSON"
  fi
done

# Verify every relative import resolves to a real file.
hdr "2b. Import resolution"
while IFS= read -r f; do
  d=$(dirname "$f")
  grep -oE "from '(\.\./|\./)[^']+'" "$f" 2>/dev/null | sed "s/from '//; s/'$//" | while IFS= read -r spec; do
    [ -z "$spec" ] && continue
    if [ -f "$d/$spec" ]; then ok "import $f -> $spec"; else bad "import $f -> $spec (NOT FOUND)"; fi
  done
done <<< "$ESM_FILES"

# ============================================================ 3. ASSERTS ====
hdr "3. Regression asserts (each review fix is present)"

assert_grep() { # <description> <pattern> <file>
  if grep -qE -- "$2" "$3" 2>/dev/null; then ok "$1"; else bad "$1"; fi
}

# Drop comment-only lines before asserting absence. The fixes are documented in
# comments that quote the very patterns being banned ("hour12: false is
# deliberately NOT used"), which otherwise reports a false FAIL.
code_only() { grep -vE '^[[:space:]]*(//|--|\*|/\*|<!--)' "$1" 2>/dev/null; }

assert_no_grep() { # <description> <pattern> <file>
  if code_only "$3" | grep -qE -- "$2"; then bad "$1"; else ok "$1"; fi
}

assert_no_grep "no hour12:false in client (midnight rollover)"  "hour12: *false"            public/script.js
assert_no_grep "no hour12:false in lib (midnight rollover)"     "hour12: *false"            lib/puzzle.js
assert_grep    "client uses hourCycle h23"                      "hourCycle: *'h23'"         public/script.js
assert_grep    "lib uses hourCycle h23"                         "hourCycle: *'h23'"         lib/puzzle.js
assert_grep    "admin leaderboard builds nodes, not innerHTML"  "leaderboard-name'"         public/script.js
assert_no_grep "admin leaderboard has no name interpolation"    'leaderboard-name">\$\{'    public/script.js
assert_grep    "display_name is length/char validated"          "MAX_DISPLAY_NAME_LENGTH"   functions/api/user.js
assert_grep    "auth cookie is Secure"                          "HttpOnly; Secure"          lib/auth.js
assert_grep    "SECRET_KEY absence throws"                      "SECRET_KEY is not configured" lib/auth.js
assert_grep    "logout endpoint exists"                         "clearedSessionCookie"      functions/api/dashboard/logout.js
assert_grep    "client calls logout endpoint"                   "api/dashboard/logout"      public/script.js
assert_grep    "/api/words returns 500 on error"                "status: 500"               functions/api/words.js
assert_grep    "empty word list does not clobber cache"         "keeping cached words"      public/script.js
assert_grep    "results.js range-checks records"                "isValidRecord"             functions/api/results.js
assert_grep    "results.js drops unknown game_ids"              "knownGameIds"              functions/api/results.js
assert_grep    "sync queue is capped"                           "MAX_PENDING_SYNC"          public/script.js
assert_grep    "streak recovery is anchored"                    "anchorPuzzle"              public/script.js
assert_grep    "flip-reveal input lock"                         "isRevealing"               public/script.js
assert_grep    "interrupted game resolver"                      "resolveInterruptedGame"    public/script.js
assert_grep    "pagehide pauses the timer"                      "pagehide"                  public/script.js
assert_grep    "Player ID switch clears real keys"              "clearAllGameStateKeys"     public/script.js
assert_no_grep "no bogus 6lets_gameState key"                   "'6lets_gameState'"         public/script.js
assert_grep    "old per-puzzle keys are pruned"                 "pruneOldStorageKeys"       public/script.js
assert_grep    "word repeat-check excludes self"                "id != \?"                  functions/api/dashboard/words.js
assert_grep    "admin words dictionary-checked"                 "not in the word list"      public/script.js
assert_grep    "schema is non-destructive"                      "CREATE TABLE IF NOT EXISTS" schema.sql
assert_no_grep "no DROP TABLE in schema.sql"                    "DROP TABLE"                schema.sql
assert_grep    "security headers present"                       "Content-Security-Policy"   public/_headers
assert_grep    "og tags present"                                "og:image"                  public/index.html
assert_no_grep "viewport allows zoom"                           "user-scalable=no"          public/index.html

# Service worker cache version must match the asset version in index.html.
SW_V=$(grep -oE "6lets-cache-v[0-9]+" public/sw.js | head -n1)
HTML_V=$(grep -oE "script\.js\?v=[0-9]+" public/index.html | head -n1)
printf '        (service worker %s, html %s)\n' "${SW_V:-none}" "${HTML_V:-none}"

hdr "3b. Advisories (not failures)"

DB_ID=$(grep -E '^[[:space:]]*database_id' wrangler.toml | head -n1 | cut -d'"' -f2)
PREVIEW_ID=$(grep -E '^[[:space:]]*preview_database_id' wrangler.toml | head -n1 | cut -d'"' -f2)
if [ -n "$DB_ID" ] && [ "$DB_ID" = "$PREVIEW_ID" ]; then
  printf '%s  WARN%s  preview_database_id == database_id in wrangler.toml.\n' "$YLW" "$RST"
  echo   '        Every preview/branch deploy reads and writes PRODUCTION player'
  echo   '        data, and an admin logged into a preview URL edits the live'
  echo   '        word list. To separate them:'
  echo   '          npx wrangler d1 create sixlets-db-preview'
  echo   '        then put the new id in preview_database_id and apply schema.sql'
  echo   '        to it with --preview.'
else
  ok "preview and production D1 databases are distinct"
fi

# ============================================================ 4. PUPPETEER ==
hdr "4. Remove unused puppeteer dependency"

if node -e "process.exit(require('./package.json').dependencies?.puppeteer?0:1)" 2>/dev/null; then
  echo "  removing puppeteer (frees ~300MB of Chromium from installs)..."
  if npm uninstall puppeteer; then
    ok "puppeteer removed; package.json + package-lock.json updated"
  else
    bad "npm uninstall puppeteer failed — remove it by hand"
  fi
else
  ok "puppeteer already absent from dependencies"
fi

# ============================================================ 5. DEV VARS ===
hdr "5. Local dev secrets (.dev.vars)"

if [ -f .dev.vars ] && grep -q "SECRET_KEY" .dev.vars 2>/dev/null; then
  ok ".dev.vars already has SECRET_KEY — leaving it alone"
  LOCAL_SECRET=$(grep '^SECRET_KEY=' .dev.vars | head -n1 | cut -d= -f2- | tr -d '"')
else
  if command -v openssl >/dev/null 2>&1; then
    LOCAL_SECRET=$(openssl rand -base64 32)
  else
    LOCAL_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
  fi
  {
    echo "DASHBOARD_USERNAME=\"$DASHBOARD_USERNAME\""
    echo "DASHBOARD_PASSWORD=\"$DASHBOARD_PASSWORD\""
    echo "SECRET_KEY=\"$LOCAL_SECRET\""
  } > .dev.vars
  ok ".dev.vars written (gitignored)"
fi

# ============================================================= 6. SECRETS ===
hdr "6. Push secrets to Cloudflare Pages"

if ! npx --yes wrangler whoami >/dev/null 2>&1; then
  skip "not logged in to Cloudflare — run 'npx wrangler login' then re-run this script"
  SECRETS_DONE=0
else
  ok "authenticated with Cloudflare"
  echo "  project: $PAGES_PROJECT"
  SECRETS_DONE=1

  # Reuse the same secret locally and remotely so tokens work in both.
  put_secret() { # <name> <value>
    if printf '%s' "$2" | npx --yes wrangler pages secret put "$1" \
         --project-name="$PAGES_PROJECT" >/dev/null 2>&1; then
      ok "secret set: $1"
    else
      bad "secret FAILED: $1 (check the project name above)"
      SECRETS_DONE=0
    fi
  }

  put_secret DASHBOARD_USERNAME "$DASHBOARD_USERNAME"
  put_secret DASHBOARD_PASSWORD "$DASHBOARD_PASSWORD"
  put_secret SECRET_KEY         "$LOCAL_SECRET"
fi

# ============================================================== 7. SCHEMA ===
hdr "7. Apply schema.sql to remote D1 (adds indexes; non-destructive)"

if [ "${SECRETS_DONE:-0}" = "0" ] && ! npx --yes wrangler whoami >/dev/null 2>&1; then
  skip "not authenticated — skipping D1 step"
else
  if npx --yes wrangler d1 execute "$D1_DATABASE" --remote --file=./schema.sql --yes; then
    ok "schema applied to $D1_DATABASE"
  else
    bad "d1 execute failed — check the database name in wrangler.toml"
  fi
fi

# =============================================================== SUMMARY ====
hdr "Summary"
printf '  %spassed: %d%s   %sfailed: %d%s   %sskipped: %d%s\n\n' \
  "$GRN" "$PASS" "$RST" "$RED" "$FAIL" "$RST" "$YLW" "$SKIP" "$RST"

if [ "$FAIL" -eq 0 ]; then
  printf '%sAll checks passed.%s\n\n' "$GRN" "$RST"
else
  printf '%s%d check(s) failed — paste the output above.%s\n\n' "$RED" "$FAIL" "$RST"
fi

cat <<'NEXT'
Next, by hand:

  npx wrangler pages dev            # then play one full game at localhost
                                    # log in to the admin dashboard as JParker
                                    # save a word, log out, confirm you are out

  npx wrangler pages deploy         # when you are happy

Note: everyone with an existing admin session is logged out on deploy —
the cookie now carries Secure and a username claim, so old tokens are void.
NEXT
