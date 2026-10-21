#!/usr/bin/env bash
#
# Reapply the manual patches under patches/manual/ to a tree that carries them.
#
#   apply-manual-patches.sh <root> [<root>...]
#
# `<root>` is either a profile directory (has node_modules/) or a release/mirror
# tree (has packages/). Each patch declares the package it belongs to, so the same
# script serves an npm-installed profile and a source-built release.
#
# These patches are manual on purpose: patches/npm entries are applied by every
# profile install, and a profile built from official sources already carries the
# fix, so the same patch there fails on an already-fixed file and aborts the build.
# The cost of that choice is that a rebuilt profile or release loses them — this
# script is how they come back.
#
# Idempotent: a patch that no longer applies is reported and skipped, so re-running
# after a partial apply is safe.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  sed -n '3,6p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# patch directory -> candidate package paths, relative to the root being patched.
patch_targets() {
  case "$1" in
    image-offload-lenient-replay)
      printf '%s\n' \
        'node_modules/@deepseek-ai/dsh-compaction-image-offload' \
        'packages/compaction/compaction-image-offload'
      ;;
    native-command-reveal)
      printf '%s\n' \
        'node_modules/@deepseek-ai/dsh-native-command' \
        'packages/util/native-command'
      ;;
    *) return 1 ;;
  esac
}

# The string each patch introduces; its presence means the patch is in place.
patch_marker() {
  case "$1" in
    image-offload-lenient-replay) printf '%s' 'positionsAreAuthoritative' ;;
    native-command-reveal) printf '%s' 'child.once("spawn"' ;;
    *) return 1 ;;
  esac
}

applied=0
skipped=0
missing=0

for root in "$@"; do
  root="$(cd "$root" && pwd)"
  echo "[manual-patches] root: $root"
  for dir in "$HERE"/*/; do
    name="$(basename "$dir")"
    [ -f "$dir/$name.patch" ] || continue
    patch="$dir/$name.patch"
    target=""
    while IFS= read -r candidate; do
      if [ -f "$root/$candidate/package.json" ]; then target="$root/$candidate"; break; fi
    done < <(patch_targets "$name")
    if [ -z "$target" ]; then
      echo "  $name: no target package under this root"
      missing=$((missing + 1))
      continue
    fi
    # A marker string decides whether the patch is already in place. `git apply
    # --check` cannot answer that once the file is modified: its context no longer
    # matches, which reads the same as "target moved".
    if grep -rqF "$(patch_marker "$name")" "$target/lib" 2>/dev/null; then
      echo "  $name: already applied -> ${target#"$root"/}"
      skipped=$((skipped + 1))
    elif git -C "$target" apply --check "$patch" 2>/dev/null; then
      git -C "$target" apply "$patch"
      echo "  $name: applied -> ${target#"$root"/}"
      applied=$((applied + 1))
    else
      echo "  $name: does not apply to ${target#"$root"/} (target moved; re-derive it)"
      skipped=$((skipped + 1))
    fi
  done
done

echo "[manual-patches] applied $applied, already present or skipped $skipped, no target $missing"
[ "$missing" -eq 0 ]