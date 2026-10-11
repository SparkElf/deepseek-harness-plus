#!/usr/bin/env bash
#
# Install the deployment tools from this repository into the DSH home.
#
#   install-deploy-tools.sh [--check] [--home <dir>] [--repo <dir>]
#
#   --check   report drift between the repository copies and the installed ones; change nothing
#
# Why this exists:
#
# The deployment tools kept their only copy under $DSH_HOME, which is not version-controlled. One
# command in that set removes a release tree and another restarts the service, so a host move or a
# careless edit lost the ability to operate the deployment with no way back. A stale duplicate of
# one of them had also accumulated in the repository, 46 lines behind the copy that ran: the record
# and the executor disagreed, and nothing detected it.
#
# The repository is the record; the home holds what executes.
#
# Copies, not links, and the reason is measured. A link makes the installed file follow the working
# tree, so a branch switch changes the tools that operate the deployment - or dangles them. A link
# also broke two of these files outright: they compare `import.meta.url` against `process.argv[1]`,
# and Node realpaths the former while keeping the latter as typed, so through a link the comparison
# is false and the CLI block never runs. Both then exited 0 without checking anything, and the
# guard whose caller reads exit 0 as "safe to proceed" was defeated by its own installation.

set -eu

HOME_DIR="${DSH_HOME:-/root/.dsh}"
REPO=""
CHECK=0

usage() { sed -n '2,20p' "$0"; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    -h|--help|"") usage 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# The repository is found from this script, so the same file works from a checkout and from the
# installed copy.
if [ -z "$REPO" ]; then
  self="$(readlink -f "$0")"
  REPO="$(cd "$(dirname "$self")/../.." && pwd)"
fi
SOURCE="$REPO/scripts/deploy"
[ -d "$SOURCE" ] || { echo "install-deploy-tools: no scripts/deploy under $REPO" >&2; exit 2; }

# Explicit lists: a file added to the directory is not installed by accident, and a file removed
# from it is reported as drift rather than left installed.
COMMANDS="dsh-3080-restart dsh-plus-allow-builds dsh-plus-build dsh-plus-cua dsh-plus-exemptions dsh-plus-mirror dsh-plus-refresh dsh-plus-scope dsh-plus-status dsh-plus-switch verify-client.mjs ws-check.mjs"
SUPERVISOR="carry-profile-state.mjs check-plugin-imports.mjs check-profile-scope.mjs check-target.mjs preflight-start.mjs profile-guard.mjs release-in-use.mjs relink-release.mjs repair-cli-links.mjs repair-shadowed-scope.mjs"

if [ "$CHECK" = "1" ]; then
  drift=0
  for f in $COMMANDS; do
    target="$HOME_DIR/$f"
    if [ -L "$target" ]; then
      echo "  linked, not copied: $f"
      drift=$((drift + 1))
    elif [ ! -e "$target" ]; then
      echo "  missing: $f"
      drift=$((drift + 1))
    elif ! cmp -s "$SOURCE/$f" "$target"; then
      echo "  differs: $f"
      drift=$((drift + 1))
    fi
  done
  for f in $SUPERVISOR; do
    target="$HOME_DIR/supervisor/$f"
    if [ -L "$target" ]; then
      echo "  linked, not copied: supervisor/$f"
      drift=$((drift + 1))
    elif [ ! -e "$target" ]; then
      echo "  missing: supervisor/$f"
      drift=$((drift + 1))
    elif ! cmp -s "$SOURCE/supervisor/$f" "$target"; then
      echo "  differs: supervisor/$f"
      drift=$((drift + 1))
    fi
  done
  if [ "$drift" -gt 0 ]; then
    echo "install-deploy-tools: $drift file(s) do not match the repository" >&2
    echo "run install-deploy-tools.sh to install the repository copies" >&2
    exit 1
  fi
  echo "install-deploy-tools: all installed files match the repository"
  exit 0
fi

echo "install-deploy-tools: installing from $SOURCE"
echo "install-deploy-tools: into $HOME_DIR"
for f in $COMMANDS; do
  mkdir -p "$(dirname "$HOME_DIR/$f")"
  if [ -L "$HOME_DIR/$f" ]; then rm -f "$HOME_DIR/$f"; fi
  cp -f "$SOURCE/$f" "$HOME_DIR/$f"
  chmod +x "$HOME_DIR/$f"
done
for f in $SUPERVISOR; do
  mkdir -p "$HOME_DIR/supervisor"
  if [ -L "$HOME_DIR/supervisor/$f" ]; then rm -f "$HOME_DIR/supervisor/$f"; fi
  cp -f "$SOURCE/supervisor/$f" "$HOME_DIR/supervisor/$f"
  chmod +x "$HOME_DIR/supervisor/$f"
done

echo "install-deploy-tools: installed $(echo $COMMANDS | wc -w) command(s) and $(echo $SUPERVISOR | wc -w) supervisor file(s)"
echo "install-deploy-tools: verify with --check"
