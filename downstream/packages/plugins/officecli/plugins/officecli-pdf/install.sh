#!/bin/sh
# officecli-pdf installer.
#
#   ./install.sh [--prefix DIR] [--bin-dir DIR] [--user] [--dry-run]
#
# Copies the exporter (executable + plugin.json + README) under <prefix>/officecli-pdf/,
# then publishes the standard OfficeCLI discovery paths:
#
#   <officecli-exe-dir>/plugins/exporter/pdf/plugin   (bundled layout, preferred)
#   ~/.officecli/plugins/exporter/pdf/plugin          (always, per-user fallback)
#   <bin-dir>/officecli-pdf                           (PATH layout, when writable)
#
# Idempotent; never prints secrets; safe to run from the package or an unpacked release.
set -eu

PREFIX=/opt/officecli/plugins
BIN_DIR=/usr/local/bin
DRY_RUN=0

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX=${2:?--prefix requires a directory}; shift 2 ;;
    --bin-dir) BIN_DIR=${2:?--bin-dir requires a directory}; shift 2 ;;
    --user) PREFIX="$HOME/.officecli/plugins"; BIN_DIR="$HOME/.local/bin"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "officecli-pdf install: unknown option $1" >&2; exit 2 ;;
  esac
done

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEST="$PREFIX/officecli-pdf"
SOURCES="officecli-pdf plugin.json package.json README.md"

for file in $SOURCES; do
  [ -f "$HERE/$file" ] || { echo "officecli-pdf install: missing $HERE/$file" >&2; exit 1; }
done

run() {
  if [ "$DRY_RUN" = 1 ]; then
    echo "+ $*"
  else
    "$@"
  fi
}

# 1. Lay down the real files (skipped when run from the installed directory itself).
if [ "$HERE/officecli-pdf" -ef "$DEST/officecli-pdf" ]; then
  echo "officecli-pdf: already installed at $DEST; refreshing discovery links only"
else
  run mkdir -p "$DEST"
  run install -m 0755 "$HERE/officecli-pdf" "$DEST/officecli-pdf"
  run install -m 0644 "$HERE/plugin.json" "$DEST/plugin.json"
  run install -m 0644 "$HERE/package.json" "$DEST/package.json"
  run install -m 0644 "$HERE/README.md" "$DEST/README.md"
fi

# 2. Resolve the OfficeCLI main executable, when one is on PATH.
MAIN=""
if command -v officecli >/dev/null 2>&1; then
  MAIN=$(command -v officecli)
  if command -v readlink >/dev/null 2>&1 && readlink -f "$MAIN" >/dev/null 2>&1; then
    MAIN=$(readlink -f "$MAIN")
  fi
fi

link_plugin() {
  directory=$1
  run mkdir -p "$directory"
  run ln -sfn "$DEST/officecli-pdf" "$directory/plugin"
  echo "officecli-pdf: discovery link $directory/plugin -> $DEST/officecli-pdf"
}

NOBODY=""
# 3. Bundled layout next to the native binary. npm `.bin` shims and the launcher script are
#    not the binary directory; only ELF / Mach-O / PE files get the bundled layout.
is_native_binary() {
  magic=$(head -c 4 "$1" 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n')
  case "$magic" in
    7f454c46|feedface|feedfacf|cafebabe|4d5a*) return 0 ;;
    *) return 1 ;;
  esac
}
if [ -n "$MAIN" ]; then
  if is_native_binary "$MAIN"; then
    link_plugin "$(dirname "$MAIN")/plugins/exporter/pdf"
  else
    NOBODY="$MAIN is not a native binary (npm launcher or shim); using the per-user layout"
  fi
fi

# 4. Per-user layout works without root and is always writable.
link_plugin "$HOME/.officecli/plugins/exporter/pdf"

# 5. PATH layout, when the directory is writable.
if [ -d "$BIN_DIR" ] && [ -w "$BIN_DIR" ]; then
  run ln -sfn "$DEST/officecli-pdf" "$BIN_DIR/officecli-pdf"
  echo "officecli-pdf: PATH link $BIN_DIR/officecli-pdf"
else
  echo "officecli-pdf: skipped PATH link ($BIN_DIR is not writable)" >&2
fi

# 6. Report what the host sees. A missing `officecli` is not an install failure.
if [ -n "$MAIN" ]; then
  echo "officecli-pdf: $MAIN plugins list"
  "$MAIN" plugins list 2>&1 | sed 's/^/  /' || true
  "$MAIN" plugins info officecli-pdf 2>&1 | sed 's/^/  /' || true
else
  echo "officecli-pdf: officecli is not on PATH; links are in place for the next invocation." >&2
fi
[ -z "$NOBODY" ] || echo "officecli-pdf: $NOBODY" >&2
echo "officecli-pdf: installed $DEST (version $(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$HERE/plugin.json" | head -1))"