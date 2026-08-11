# 6Lets — shared plumbing for the tools/ scripts. Source it, do not run it:
#
#   . "$(dirname "$0")/lib.sh"
#
# Provides the color codes, the PASS/FAIL/WARN/SKIP printers (with counters,
# for scripts that print a summary), and db_name(), which reads the production
# database_name out of wrangler.toml so no script hard-codes it.

PASS=0; FAIL=0; SKIP=0
RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'

ok()   { printf '%s  PASS%s  %s\n' "$GRN" "$RST" "$1"; PASS=$((PASS+1)); }
bad()  { printf '%s  FAIL%s  %s\n' "$RED" "$RST" "$1"; FAIL=$((FAIL+1)); }
warn() { printf '%s  WARN%s  %s\n' "$YLW" "$RST" "$1"; }
skip() { printf '%s  SKIP%s  %s\n' "$YLW" "$RST" "$1"; SKIP=$((SKIP+1)); }
hdr()  { printf '\n%s=== %s ===%s\n' "$BLD" "$1" "$RST"; }
die()  { bad "$1"; exit 1; }

# The first database_name in wrangler.toml (the production [[d1_databases]]
# block). Callers are expected to have checked that wrangler.toml exists.
db_name() {
  sed -n 's/^[[:space:]]*database_name[[:space:]]*=[[:space:]]*"\(.*\)".*$/\1/p' wrangler.toml | head -n1
}
