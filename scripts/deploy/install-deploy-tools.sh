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
# command in that set removes a release tree, and another restarts the service, so a host move or a
# careless edit lost the ability to operate the deployment with no way back. A stale duplicate of
# one of them had also accumulated in the repository, 46 lines behind the copy that ran: the record
# and the executor disagreed, and nothing detected it.
#
# The repository is the record; the home holds what executes. This script makes the link between
# them explicit and checkable rather than a copy that drifts.
#
# Links are created against the repository files, so `--check` compares content rather than paths.
# A link that a working-tree branch switch would change is not used: the installed copy is a link to
# the file, and updating it is this script, run after the merge that changes them.

set -eu

HOME_DIR="${DSH_HOME:-/root/.dsh}"
REPO=""
CHECK=0

usage() { sed -n '2,12p' "$0"; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    -h|--help|"") usage 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# The repository is found from this script rather than from the caller, so the same file works from
# a checkout and from the installed link.
if [ -z "$REPO" ]; then
  self="$(readlink -f "$0")"
  REPO="$(cd "$(dirname "$self")/../.." && pwd)"
fi
SOURCE="$REPO/scripts/deploy"
[ -d "$SOURCE" ] || { echo "install-deploy-tools: no scripts/deploy under $REPO" >&2; exit 2; }

# Top-level commands and the supervisor files they call. Both lists are explicit so a file added to
# the directory is not installed by accident, and a file removed from it is reported as drift.
COMMANDS="dsh-3080-restart dsh-plus-allow-builds dsh-plus-build dsh-plus-cua dsh-plus-exemptions dsh-plus-mirror dsh-plus-refresh dsh-plus-scope dsh-plus-status dsh-plus-switch verify-client.mjs ws-check.mjs"
SUPERVISOR="carry-profile-state.mjs check-plugin-imports.mjs check-profile-scope.mjs check-target.mjs preflight-start.mjs profile-guard.mjs release-in-use.mjs relink-release.mjs repair-cli-links.mjs repair-shadowed-scope.mjs"

drift=0
if [ "$CHECK" = "1" ]; then
  for f in $COMMANDS; do
    target="$HOME_DIR/$f"
    if [ ! -e "$target" ]; then
      echo "  missing: $f"
      drift=$((drift + 1))
    elif ! cmp -s "$SOURCE/$f" "$target"; then
      echo "  differs: $f"
      drift=$((drift + 1))
    fi
  done
  for f in $SUPERVISOR; do
    target="$HOME_DIR/supervisor/$f"
    if [ ! -e "$target" ]; then
      echo "  missing: supervisor/$f"
      drift=$((drift + 1))
    elif ! cmp -s "$SOURCE/supervisor/$f" "$target"; then
      echo "  differs: supervisor/$f"
      drift=$((drift + 1))
    fi
  done
  if [ "$drift" -gt 0 ]; then
    echo "install-deploy-tools: $drift file(s) differ from the repository" >&2
    echo "run install-deploy-tools.sh to install the repository copies" >&2
    exit 1
  fi
  echo "install-deploy-tools: all $(echo $COMMANDS | wc -w) command(s) and $(echo $SUPERVISOR | wc -w) supervisor file(s) match the repository"
  exit 0
fi

echo "install-deploy-tools: installing from $SOURCE"
echo "install-deploy-tools: into $HOME_DIR"

# A link is used so the two cannot disagree about content: reading the installed file reads the
# repository file. The cost is that the link follows the working tree, so this script is what a
# branch switch or a merge must be followed by, and --check is what reports the difference.
for f in $COMMANDS; do
  mkdir -p "$(dirname "$HOME_DIR/$f")"
  if [ -e "$HOME_DIR/$f" ] && [ ! -L "$HOME_DIR/$f" ]; then
    echo "  replacing a regular file: $f"
  fi
  ln -sfn "$SOURCE/$f" "$HOME_DIR/$f"
  chmod +x "$SOURCE/$f"
done
for f in $SUPERVISOR; do
  mkdir -p "$HOME_DIR/supervisor"
  if [ -e "$HOME_DIR/supervisor/$f" ] && [ ! -L "$HOME_DIR/supervisor/$f" ]; then
    echo "  replacing a regular file: supervisor/$f"
  fi
  ln -sfn "$SOURCE/supervisor/$f" "$HOME_DIR/supervisor/$f"
  chmod +x "$SOURCE/supervisor/$f"
done

echo "install-deploy-tools: installed; verify with --check"
