#!/usr/bin/env bash
#
# 6Lets — review, commit, and push to GitHub.
#
#   cd ~/Documents/6Lets && bash tools/commit-and-push.sh
#   cd ~/Documents/6Lets && bash tools/commit-and-push.sh "your commit message"
#
# Nothing is committed until you have seen the file list and typed "yes".
# Nothing is pushed until you confirm a second time.
#
# Refuses to proceed if:
#   - any staged file assigns a literal DASHBOARD_PASSWORD / SECRET_KEY
#   - .dev.vars or a wrangler.toml backup would be committed
#   - any client-side JS fails node --check
#
set -u
set -o pipefail

REMOTE="origin"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
ok()   { printf '%s  PASS%s  %s\n' "$GRN" "$RST" "$1"; }
bad()  { printf '%s  FAIL%s  %s\n' "$RED" "$RST" "$1"; }
warn() { printf '%s  WARN%s  %s\n' "$YLW" "$RST" "$1"; }
hdr()  { printf '\n%s=== %s ===%s\n' "$BLD" "$1" "$RST"; }
die()  { bad "$1"; exit 1; }

confirm() { # <prompt>
  printf '\n%s%s%s [type yes to continue] ' "$BLD" "$1" "$RST"
  read -r reply
  [ "$reply" = "yes" ] || { echo "  aborted."; exit 1; }
}

# ================================================================ preflight ==
hdr "Preflight"

[ -f wrangler.toml ] || die "not in the 6Lets project root"
command -v git >/dev/null 2>&1 || die "git not found"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git repository"
ok "project root ($(pwd))"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
ok "branch: $BRANCH"

git remote get-url "$REMOTE" >/dev/null 2>&1 || die "no remote named '$REMOTE'"
ok "remote: $(git remote get-url "$REMOTE")"

# A clean working tree is not the same as "nothing to do" — an earlier run may
# have committed and then had its push declined.
if [ -z "$(git status --porcelain)" ]; then
  UNPUSHED=0
  if git rev-parse --verify --quiet "$REMOTE/$BRANCH" >/dev/null; then
    UNPUSHED=$(git rev-list --count "$REMOTE/$BRANCH..$BRANCH" 2>/dev/null || echo 0)
  fi

  if [ "$UNPUSHED" = "0" ]; then
    ok "working tree clean, nothing unpushed — already up to date"
    exit 0
  fi

  warn "working tree is clean, but $UNPUSHED commit(s) have not been pushed"
  warn "skipping the commit steps and going straight to the push"
fi

# ============================================================ 1. JS SYNTAX ==
hdr "1. Parse check"

SYNTAX_OK=1
for f in public/script.js public/sw.js public/dictionary.js; do
  [ -f "$f" ] || continue
  if err=$(node --check "$f" 2>&1); then
    ok "parse  $f"
  else
    bad "parse  $f"
    printf '%s\n' "$err"
    SYNTAX_OK=0
  fi
done
[ "$SYNTAX_OK" = "1" ] || die "fix the syntax errors above before pushing"

# =============================================================== 2. STAGE ===
hdr "2. Stage everything"

git add -A
ok "staged"

# ============================================================== 3. SECRETS ==
hdr "3. Secret scan (staged content)"

# Matches a real literal assignment, e.g. DASHBOARD_PASSWORD='hunter2'.
#
# Anchored to the start of the line (allowing indentation) so that mentions of
# these names inside comments, echo strings, and grep patterns do not trip it --
# an assignment is a statement, and a statement begins a line.
#
# Deliberately does NOT match the indirection form DASHBOARD_PASSWORD="${...}",
# because the character class after the opening quote excludes '$'.
SECRET_RE="^[[:space:]]*(DASHBOARD_PASSWORD|SECRET_KEY|DASHBOARD_USERNAME)=[\"'][^\"'\$]"

if git grep --cached -nE "$SECRET_RE" -- . ':!*.md' ':!tools/commit-and-push.sh' 2>/dev/null; then
  echo
  die "a staged file assigns a literal credential (shown above).
        Move it to an environment variable and re-run.
        If this has already been pushed in an earlier commit, deleting it now
        does NOT remove it from history — rotate the credential instead."
fi
ok "no literal credentials staged"

for forbidden in .dev.vars; do
  if git diff --cached --name-only | grep -qx "$forbidden"; then
    die "$forbidden is staged — it must stay untracked (check .gitignore)"
  fi
done
ok ".dev.vars not staged"

if git diff --cached --name-only | grep -q '^wrangler\.toml\.bak\.'; then
  die "a wrangler.toml backup is staged — it is a local safety copy, not source"
fi
ok "no wrangler.toml backups staged"

# ========================================================= 4/5. COMMIT ======
if git diff --cached --quiet; then

warn "nothing new staged — keeping the existing commit(s)"

else

hdr "4. What will be committed"

git diff --cached --stat
echo
git diff --cached --name-status

confirm "Commit these changes?"

hdr "5. Commit"

if [ "$#" -ge 1 ] && [ -n "$1" ]; then
  git commit -m "$1" || die "commit failed"
else
  git commit -F - <<'MSG' || die "commit failed"
Fix silent result-write failure that emptied the leaderboard

POST /api/results upserts with ON CONFLICT(user_uuid, game_id). Production's
Results table has no UNIQUE constraint on that pair -- schema.sql declares one,
but inside CREATE TABLE IF NOT EXISTS, which is a no-op against the table that
already existed. The uniqueness came from idx_results_user_game, which
drop-redundant-indexes.sh removed on 2026-07-25 as "redundant with the
constraint".

With no valid conflict target every insert threw, returned 500, and recorded
nothing. syncResults() treats 5xx as retry-later and says nothing, so players
kept playing while both leaderboards sat empty for ~26 hours.

- schema.sql: declare idx_results_user_game as CREATE UNIQUE INDEX IF NOT
  EXISTS, so fresh databases and production converge. (Already recreated on
  production by hand.)
- tools/drop-redundant-indexes.sh, sql/drop-redundant-indexes.sql: retracted to
  no-ops that explain why and exit non-zero.
- public/script.js, index.html, style.css: count consecutive sync failures and
  show a banner above the leaderboard after 3, explaining that scores are safe
  on the device. A 4xx discards the queue, so it warns on first occurrence.
  Assets bumped to v42.
- tools/setup-and-verify.sh: read dashboard credentials from the environment
  instead of hardcoding them; add asserts for the index and the sync warning.
- CODE_REVIEW.md: correct the retracted entry, add an incident writeup.
MSG
fi
ok "committed"

fi  # end of the 4/5 commit block

# ================================================================= 6. PUSH ==
hdr "6. Push"

echo "  $BRANCH -> $REMOTE/$BRANCH"
if git rev-parse --verify --quiet "$REMOTE/$BRANCH" >/dev/null; then
  AHEAD=$(git rev-list --count "$REMOTE/$BRANCH..$BRANCH" 2>/dev/null || echo "?")
  echo "  commits to push: $AHEAD"
fi

warn "If Cloudflare Pages builds from this repo, pushing deploys to production."
warn "If it is a direct-upload project, run 'npx wrangler pages deploy' after."

confirm "Push to $REMOTE/$BRANCH?"

git push "$REMOTE" "$BRANCH" || die "push failed"
ok "pushed"

cat <<'NEXT'

Next:

  - Confirm the deploy picked up the new assets (service worker v42).
  - Play one game and check your score lands on the leaderboard.
  - Delete the local wrangler.toml.bak.* file once you are happy.
NEXT
