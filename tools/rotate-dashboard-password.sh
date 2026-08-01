#!/usr/bin/env bash
#
# 6Lets -- rotate the admin dashboard credentials.
#
#   cd ~/Documents/6Lets && bash tools/rotate-dashboard-password.sh
#
# Prompts for the new password, offers to rotate SECRET_KEY alongside it,
# pushes both to Cloudflare Pages, and updates the local .dev.vars so dev and
# production stay in sync.
#
# Why SECRET_KEY too: session cookies are HMAC-signed with SECRET_KEY and
# verified against it, not the password. Changing only the password leaves
# every already-issued session valid for up to a week -- including one an
# attacker minted with the leaked password. Rotating SECRET_KEY kills them all
# at the next deploy.
#
# The secrets are never echoed, never passed as command-line arguments to a
# new process (which would expose them in `ps` output), and never written to
# your shell history. They reach wrangler over a pipe and python over the
# environment.
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

# Piped, not argv: an argument to a new process would be visible in `ps`.
# (The call to this function itself is a builtin, not an exec.)
# Wrangler's output is captured and shown on failure instead of guessed at.
push_secret() {
  local name="$1" value="$2" out
  if out=$(printf '%s' "$value" | npx --yes wrangler pages secret put "$name" \
       --project-name="$PAGES_PROJECT" 2>&1); then
    ok "$name updated on $PAGES_PROJECT"
  else
    printf '%s\n' "$out" | sed 's/^/       /'
    die "wrangler could not set $name -- its output is above"
  fi
}

hdr "Preflight"

[ -f wrangler.toml ] || die "not in the 6Lets project root"
command -v python3 >/dev/null 2>&1 || die "python3 not found"
{ : < /dev/tty; } 2>/dev/null || die "no interactive terminal -- this script prompts via /dev/tty"
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

hdr "SECRET_KEY"

printf 'Rotate SECRET_KEY too? This signs session cookies; rotating it logs\n'
printf 'every existing dashboard session out at the next deploy. If the old\n'
printf 'password may have been used by someone else, say yes. [Y/n] '
read -r ROTATE_KEY < /dev/tty || ROTATE_KEY=n

NEW_KEY=""
case "${ROTATE_KEY:-y}" in
  [nN]*)
    warn "keeping the current SECRET_KEY -- sessions issued under the old password stay valid until they expire"
    ;;
  *)
    NEW_KEY="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
    [ -n "$NEW_KEY" ] || die "could not generate a new SECRET_KEY"
    ok "generated a new 64-hex-char SECRET_KEY"
    ;;
esac

hdr "Push to Cloudflare Pages"

push_secret DASHBOARD_PASSWORD "$NEW_PW"
[ -n "$NEW_KEY" ] && push_secret SECRET_KEY "$NEW_KEY"

hdr "Update $DEV_VARS"

if [ ! -f "$DEV_VARS" ]; then
  warn "$DEV_VARS not found -- skipping. Local dev will not have the new values."
else
  # Close the permissions before the new secrets land in the file, not after.
  chmod 600 "$DEV_VARS"

  # Rewrite in place rather than sed: the password may contain sed's
  # delimiters and backreferences. Values are written in dotenv single quotes
  # (fully literal) when possible; a value containing a single quote falls
  # back to double quotes, which are only unambiguous while it has no `"` or
  # backslash -- dotenv parsers do not reliably unescape those, so that rare
  # combination is skipped with a warning rather than written corrupted.
  UPDATE_VARS="DASHBOARD_PASSWORD"
  [ -n "$NEW_KEY" ] && UPDATE_VARS="DASHBOARD_PASSWORD SECRET_KEY"

  UPDATE_VARS="$UPDATE_VARS" DASHBOARD_PASSWORD="$NEW_PW" SECRET_KEY="$NEW_KEY" \
  python3 - "$DEV_VARS" <<'PY'
import os, sys

path = sys.argv[1]
names = os.environ['UPDATE_VARS'].split()


def render(name, value):
    if "'" not in value:
        return "%s='%s'" % (name, value)
    if '"' not in value and '\\' not in value:
        return '%s="%s"' % (name, value)
    return None


replacements, skipped = {}, []
for name in names:
    line = render(name, os.environ[name])
    if line is None:
        skipped.append(name)
    else:
        replacements[name] = line

with open(path, 'r', encoding='utf-8') as fh:
    lines = fh.read().splitlines()

done = set()
out = []
for line in lines:
    key = line.split('=', 1)[0].strip()
    if key in replacements:
        out.append(replacements[key])
        done.add(key)
    else:
        out.append(line)

for name, line in replacements.items():
    if name not in done:
        out.append(line)

with open(path, 'w', encoding='utf-8') as fh:
    fh.write('\n'.join(out) + '\n')

for name in skipped:
    print('  skipped %s: it mixes single quotes with `"` or `\\`, which '
          '.dev.vars cannot represent unambiguously -- set it by hand' % name)
sys.exit(2 if skipped else 0)
PY

  case $? in
    0) ok "$DEV_VARS updated (mode 600)" ;;
    2) warn "$DEV_VARS partially updated -- see the skipped value above" ;;
    *) bad "could not update $DEV_VARS -- edit it by hand" ;;
  esac
fi

unset NEW_PW NEW_KEY

hdr "Done"

cat <<'NEXT'
  NOT LIVE YET. Three things to know:

  1. Cloudflare Pages binds secrets at DEPLOYMENT time. Until you redeploy,
     the current deployment keeps the old values. Deploy to activate:

       npx wrangler pages deploy

     (Workers differ -- there a secret applies on the next request.)

  2. OLD DEPLOYMENTS KEEP THE OLD SECRETS. Every previous deployment stays
     reachable at its own permanent <hash>.<project>.pages.dev URL, still
     bound to the credentials it shipped with. Rotating because the password
     leaked? Delete the old deployments in the Cloudflare dashboard
     (Workers & Pages -> project -> Deployments), or the leaked password
     keeps working there.

  3. Wrangler writes the PRODUCTION environment only. If these secrets were
     ever also set on the preview environment (dashboard -> Settings ->
     Environment variables -> Preview), rotate them there by hand.

  If you rotated SECRET_KEY, every dashboard session is invalidated the
  moment the new deployment is live, so you will be asked to log in again --
  that is the rotation working.

  Note: .dev.vars is gitignored and must stay that way.
NEXT
