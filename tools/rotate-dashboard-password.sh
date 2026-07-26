#!/usr/bin/env bash
#
# 6Lets -- rotate the admin dashboard password.
#
#   cd ~/Documents/6Lets && bash tools/rotate-dashboard-password.sh
#
# Prompts for the new password, pushes it to Cloudflare Pages, and updates the
# local .dev.vars so dev and production stay in sync.
#
# The password is never echoed, never passed as a command-line argument (which
# would expose it in `ps` output), and never written to your shell history.
# It reaches wrangler over a pipe and python over the environment.
#
set -u
set -o pipefail

PAGES_PROJECT="sixlets-pwa"
DEV_VARS=".dev.vars"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
ok()   { printf '%s  PASS%s  %s\n' "$GRN" "$RST" "$1"; }
bad()  { printf '%s  FAIL%s  %s\n' "$RED" "$RST" "$1"; }
warn() { printf '%s  WARN%s  %s\n' "$YLW" "$RST" "$1"; }
hdr()  { printf '\n%s=== %s ===%s\n' "$BLD" "$1" "$RST"; }
die()  { bad "$1"; exit 1; }

hdr "Preflight"

[ -f wrangler.toml ] || die "not in the 6Lets project root"
command -v python3 >/dev/null 2>&1 || die "python3 not found"
ok "project root ($(pwd))"

npx --yes wrangler whoami >/dev/null 2>&1 || die "not logged in -- run: npx wrangler login"
ok "authenticated with Cloudflare"

hdr "New password"

printf 'New DASHBOARD_PASSWORD: '
read -r -s NEW_PW < /dev/tty
echo
printf 'Again to confirm:        '
read -r -s CONFIRM_PW < /dev/tty
echo

[ -n "$NEW_PW" ]              || die "empty password"
[ "$NEW_PW" = "$CONFIRM_PW" ] || die "the two entries did not match"
[ "${#NEW_PW}" -ge 12 ]       || die "use at least 12 characters"
ok "accepted (${#NEW_PW} characters)"

unset CONFIRM_PW

hdr "Push to Cloudflare Pages"

# Piped, not argv: an argument would be visible to anyone running `ps`.
if printf '%s' "$NEW_PW" | npx --yes wrangler pages secret put DASHBOARD_PASSWORD \
     --project-name="$PAGES_PROJECT" >/dev/null 2>&1; then
  ok "DASHBOARD_PASSWORD updated on $PAGES_PROJECT"
else
  die "wrangler rejected the secret -- check the project name above"
fi

hdr "Update $DEV_VARS"

if [ ! -f "$DEV_VARS" ]; then
  warn "$DEV_VARS not found -- skipping. Local dev will not have the new value."
else
  # Rewrite in place rather than sed: the password may contain any character,
  # including sed's delimiters and backreferences.
  NEW_PW="$NEW_PW" python3 - "$DEV_VARS" <<'PY'
import os, sys

path = sys.argv[1]
pw = os.environ['NEW_PW']

with open(path, 'r', encoding='utf-8') as fh:
    lines = fh.read().splitlines()

out, replaced = [], False
for line in lines:
    if line.startswith('DASHBOARD_PASSWORD='):
        out.append('DASHBOARD_PASSWORD="%s"' % pw)
        replaced = True
    else:
        out.append(line)

if not replaced:
    out.append('DASHBOARD_PASSWORD="%s"' % pw)

with open(path, 'w', encoding='utf-8') as fh:
    fh.write('\n'.join(out) + '\n')
PY

  if [ $? -eq 0 ]; then
    chmod 600 "$DEV_VARS"
    ok "$DEV_VARS updated (mode 600)"
  else
    bad "could not update $DEV_VARS -- edit it by hand"
  fi
fi

unset NEW_PW

hdr "Done"

cat <<'NEXT'
  NOT LIVE YET. Cloudflare Pages binds environment variables and secrets at
  DEPLOYMENT time. An existing deployment keeps the values it was built with,
  so until you redeploy, the old password still works and the new one does not.
  (Workers differ -- there a secret applies on the next request. Pages does not.)

  Deploy to activate:

    npx wrangler pages deploy

  Or push any commit, if the Pages project builds from the repo.

  Then verify by logging in. You will be prompted regardless, since the auth
  cookie changed in an earlier commit.

  Note: .dev.vars is gitignored and must stay that way.
NEXT
