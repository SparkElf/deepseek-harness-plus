#!/usr/bin/env bash
#
# Install the deployment tools from this repository into the DSH home.
#
#   install-deploy-tools.sh [--check] [--home <dir>] [--repo <dir>] [--mode link|copy]
#
#   --check   report drift between the repository files and the installed ones; change nothing
#   --mode    link (default): symlink each tool to the repository, so one copy is authoritative
#             copy: place a copy, for a home that must not depend on a checkout
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
# Links are the default because they cannot drift: the installed path and the repository file are
# the same bytes. The cost is that the tools follow the repository, so point them at a checkout that
# does not move under the running deployment - a detached worktree rather than an active working
# tree, whose branch switches would change or dangle them. Measured 2026-10-11: checking out an
# older branch left a linked dsh-plus-mirror unresolved.
#
# A link is only safe for a script whose entry check resolves both sides. One that compares
# `import.meta.url` against `file://${process.argv[1]}` never enters its CLI block through a link -
# Node realpaths the first and keeps the second as typed - and exits 0 having done nothing, which a
# caller reading exit 0 as "safe to proceed" cannot distinguish from a passing check. Measured that
# same day: the guard meant to protect a rebuild was silenced by its own installation.

set -eu

HOME_DIR="${DSH_HOME:-/root/.dsh}"
REPO=""
CHECK=0
MODE="link"

usage() { sed -n '2,26p' "$0"; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    -h|--help|"") usage 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$MODE" in link|copy) ;; *) echo "unknown mode: $MODE" >&2; exit 2 ;; esac

# The repository is found from this script, so the same file works from a checkout and from the
# installed link.
if [ -z "$REPO" ]; then
  self="$(readlink -f "$0")"
  REPO="$(cd "$(dirname "$self")/../.." && pwd)"
fi
SOURCE="$REPO/scripts/deploy"
[ -d "$SOURCE" ] || { echo "install-deploy-tools: no scripts/deploy under $REPO" >&2; exit 2; }

# Explicit lists: a file added to the directory is not installed by accident, and a file removed
# from it is reported as drift rather than left installed.
COMMANDS="dsh-3080-restart dsh-plus-allow-builds dsh-plus-build dsh-plus-cua dsh-plus-exemptions dsh-plus-mirror dsh-plus-refresh dsh-plus-scope dsh-plus-status dsh-plus-switch verify-client.mjs ws-check.mjs"
SUPERVISOR="carry-profile-state.mjs check-plugin-imports.mjs check-profile-scope.mjs check-target.mjs preflight-start.mjs profile-guard.mjs release-in-use.mjs relink-release.mjs repair-cli-links.mjs repair-shadowed-scope.mjs verify-profile-bundles.mjs"

# One check per file, shared by both placements. The mode decides whether a symlink is required or
# forbidden; content is compared either way, which follows the link to the file it names.
audit_one() {
  local rel="$1" target="$2"
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    echo "  missing: $rel"
    return 1
  fi
  if [ "$MODE" = "link" ] && [ ! -L "$target" ]; then
    echo "  not linked: $rel"
    return 1
  fi
  if [ "$MODE" = "copy" ] && [ -L "$target" ]; then
    echo "  linked, not copied: $rel"
    return 1
  fi
  if ! cmp -s "$SOURCE/$rel" "$target"; then
    echo "  differs: $rel"
    return 1
  fi
  return 0
}

if [ "$CHECK" = "1" ]; then
  drift=0
  for f in $COMMANDS; do audit_one "$f" "$HOME_DIR/$f" || drift=$((drift + 1)); done
  for f in $SUPERVISOR; do audit_one "supervisor/$f" "$HOME_DIR/supervisor/$f" || drift=$((drift + 1)); done
  if [ "$drift" -gt 0 ]; then
    echo "install-deploy-tools: $drift file(s) do not match the repository" >&2
    echo "run install-deploy-tools.sh --mode $MODE to install the repository files" >&2
    exit 1
  fi
  echo "install-deploy-tools: all installed files match the repository ($MODE mode)"
  exit 0
fi

# Place one file. A link replaces whatever is there; a copy removes a link first so the two plac-
# ements cannot be mixed.
place_one() {
  local rel="$1" target="$2"
  mkdir -p "$(dirname "$target")"
  if [ "$MODE" = "link" ]; then
    ln -sfn "$SOURCE/$rel" "$target"
  else
    if [ -L "$target" ]; then rm -f "$target"; fi
    cp -f "$SOURCE/$rel" "$target"
  fi
  chmod +x "$SOURCE/$rel"
}

echo "install-deploy-tools: installing from $SOURCE"
echo "install-deploy-tools: into $HOME_DIR ($MODE)"
for f in $COMMANDS; do place_one "$f" "$HOME_DIR/$f"; done
for f in $SUPERVISOR; do place_one "supervisor/$f" "$HOME_DIR/supervisor/$f"; done

echo "install-deploy-tools: installed $(echo $COMMANDS | wc -w) command(s) and $(echo $SUPERVISOR | wc -w) supervisor file(s)"
echo "install-deploy-tools: verify with --check"
