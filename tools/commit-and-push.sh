#!/usr/bin/env bash
#
# 6Lets — review, commit, and push to GitHub.
#
#   cd ~/Documents/6Lets && bash tools/commit-and-push.sh "your commit message"
#   cd ~/Documents/6Lets && bash tools/commit-and-push.sh   # prompts for one
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

# lib/ and functions/ are ES modules, so they need --input-type=module: plain
# `node --check` parses them as CommonJS and reports every `import` as a syntax
# error. These went unchecked entirely until now, which is how a change to
# functions/api/dashboard/leaderboard.js reached production without ever being
# parsed.
while IFS= read -r f; do
  [ -f "$f" ] || continue
  if err=$(node --check --input-type=module < "$f" 2>&1); then
    ok "parse  $f"
  else
    bad "parse  $f"
    printf '%s\n' "$err"
    SYNTAX_OK=0
  fi
done < <(find lib functions -name '*.js' -type f 2>/dev/null | sort)

[ "$SYNTAX_OK" = "1" ] || die "fix the syntax errors above before pushing"

# ================================================================ 1b. TESTS ==
hdr "1b. Tests"

# The passkey ceremony and the sliding-window arithmetic are both things whose
# failure mode is silence — a signature that never verifies, an expiry that
# quietly outlives its ceiling. Neither shows up by clicking around.
#
# Not piped through tail: the interesting part of a failure is the assertion
# message, and trimming the output to fit the terminal is how it gets lost.
if node --test --experimental-sqlite "test/**/*.test.mjs"; then
  ok "node --test test/"
else
  die "tests failed — see above"
fi

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

# No canned fallback message. This used to hold the full text of one specific
# past commit, which every later run silently reused -- a commit message that
# confidently describes work the commit does not contain is worse than none.
if [ "$#" -ge 1 ] && [ -n "$1" ]; then
  git commit -m "$1" || die "commit failed"
else
  printf '\n%sNo commit message given. Type a one-line summary:%s\n> ' "$BLD" "$RST"
  read -r msg
  [ -n "$msg" ] || die "empty commit message -- nothing committed"
  git commit -m "$msg" || die "commit failed"
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

# Read the version out of sw.js rather than hardcoding it -- a stale number here
# tells you to look for the wrong cache and makes a failed deploy look fine.
SW_V=$(grep -oE "6lets-cache-v[0-9]+" public/sw.js | head -n1)

cat <<NEXT

Next:

  - Confirm the deploy picked up the new assets (service worker ${SW_V:-unknown};
    check DevTools -> Application -> Cache Storage).
  - Play one game and check your score lands on the leaderboard.
NEXT

if ls wrangler.toml.bak.* >/dev/null 2>&1; then
  echo "  - Delete the local wrangler.toml.bak.* file once you are happy."
fi
