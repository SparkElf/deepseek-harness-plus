#!/bin/bash
# Optional runtime-only prune for a workspace image, default off.
#
# RUNTIME-PRUNE.md separates runtime paths (never delete) from build-only candidates. This
# script executes only the second list, and asserts the first list is intact before and after.
# It defaults to a dry run: apply-plus.sh passes --apply only when RUNTIME_PRUNE=1.
#
# The profile and first-boot template are outside --root and are never touched here. `.git` is
# deleted last: `dsh-plus apply` needs it to classify source patches, so the prune must be the
# final step of the final build phase.
#
# Usage:
#   runtime-prune.sh [--root /opt/dsh-source] [--apply|--dry-run]
set -euo pipefail

root=/opt/dsh-source
mode=dry-run

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root)
      root="${2:?--root needs a directory}"
      shift
      ;;
    --apply)
      mode=apply
      ;;
    --dry-run)
      mode=dry-run
      ;;
    -h|--help)
      sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

root="$(readlink -f "$root")"
if [ "$root" = "/" ] || [ ! -d "$root" ]; then
  echo "refusing to prune unsafe or missing root: $root" >&2
  exit 2
fi
[ -f "$root/apps/cli/lib/bin.js" ] || {
  echo "not a built DSH source root: $root" >&2
  exit 2
}

human() {
  awk -v bytes="$1" 'BEGIN {
    split("B KB MB GB TB", units, " ")
    value = bytes
    i = 1
    while (value >= 1024 && i < 5) { value /= 1024; i += 1 }
    printf "%.1f%s", value, units[i]
  }'
}

bytes_of() {
  local bytes
  bytes="$(du -sb "$1" 2>/dev/null | cut -f1)"
  printf '%s' "${bytes:-0}"
}

# Counts of the paths RUNTIME-PRUNE.md names as runtime-owned. A prune that changes any of
# these counts deleted something the profile links into.
snapshot() {
  local phase="$1"
  package_manifests="$(find "$root/packages" -name package.json -not -path '*/node_modules/*' 2>/dev/null | wc -l)"
  package_libs="$(find "$root/packages" -type d -name lib -not -path '*/node_modules/*' 2>/dev/null | wc -l)"
  package_locales="$(find "$root/packages" -type d -name locale -not -path '*/node_modules/*' 2>/dev/null | wc -l)"
  package_modules="$(find "$root/packages" -type d -name node_modules -prune 2>/dev/null | wc -l)"
  local fail=0
  for path in \
    "$root/apps/cli/lib/bin.js" \
    "$root/apps/cli/package.json" \
    "$root/node_modules/.pnpm" \
    "$root/vendor" \
    "$root/native"; do
    [ -e "$path" ] || {
      echo "FAIL $phase: missing runtime path $path" >&2
      fail=1
    }
  done
  [ "$package_manifests" -gt 0 ] || { echo "FAIL $phase: no package manifests" >&2; fail=1; }
  [ "$package_libs" -gt 0 ] || { echo "FAIL $phase: no package lib directories" >&2; fail=1; }
  if [ "$phase" = "after" ]; then
    [ "$package_manifests" = "$before_package_manifests" ] || {
      echo "FAIL after: package manifest count $package_manifests != $before_package_manifests" >&2
      fail=1
    }
    [ "$package_libs" = "$before_package_libs" ] || {
      echo "FAIL after: package lib count $package_libs != $before_package_libs" >&2
      fail=1
    }
    [ "$package_locales" = "$before_package_locales" ] || {
      echo "FAIL after: package locale count $package_locales != $before_package_locales" >&2
      fail=1
    }
    [ "$package_modules" = "$before_package_modules" ] || {
      echo "FAIL after: package node_modules count $package_modules != $before_package_modules" >&2
      fail=1
    }
  fi
  if [ "$fail" -ne 0 ]; then
    echo "runtime whitelist assertion failed ($phase); nothing further was deleted" >&2
    exit 1
  fi
}

snapshot before
before_package_manifests=$package_manifests
before_package_libs=$package_libs
before_package_locales=$package_locales
before_package_modules=$package_modules

root_bytes_before="$(bytes_of "$root")"
removed_bytes=0
removed_entries=0

remove() {
  local path="$1"
  [ -e "$path" ] || return 0
  local size
  size="$(bytes_of "$path")"
  removed_bytes=$((removed_bytes + size))
  removed_entries=$((removed_entries + 1))
  printf '  %-7s %-48s %s\n' "$mode" "${path#"$root"/}" "$(human "$size")"
  if [ "$mode" = "apply" ]; then
    rm -rf -- "$path"
  fi
}

echo "==> runtime prune ($mode): $root"
# RUNTIME-PRUNE.md delete candidates, in the order the page lists them. Build-only files whose
# type is shared with runtime paths (tsconfig, tsbuildinfo, packages/**/src) are handled below.
for rel in .github snapshots scripts patches python website .gitlab-ci.yml .oxlintrc.json; do
  remove "$root/$rel"
done

while IFS= read -r path; do
  remove "$path"
done < <(find "$root" -maxdepth 1 \( -name 'tsconfig*.json' -o -name '*.tsbuildinfo' \) -type f | sort)
while IFS= read -r path; do
  remove "$path"
done < <(find "$root" -name '*.tsbuildinfo' -type f -not -path '*/node_modules/*' | sort)
while IFS= read -r path; do
  remove "$path"
done < <(find "$root/packages" -type d -name src -prune -not -path '*/node_modules/*' | sort)

# `.git` is deleted last: the current phase's apply has already finished, and a later profile
# phase falls back to the build marker when `.git` is absent.
remove "$root/.git"

root_bytes_after="$(bytes_of "$root")"
snapshot after

if [ "$mode" = "apply" ]; then
  printf '{"mode":"apply","removedBytes":%s,"removedEntries":%s,"rootBytesBefore":%s,"rootBytesAfter":%s,"prunedAt":"%s"}\n' \
    "$removed_bytes" "$removed_entries" "$root_bytes_before" "$root_bytes_after" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$root/.dataops-runtime-pruned"
  echo "==> runtime prune applied: $(human "$removed_bytes") removed from $(human "$root_bytes_before") to $(human "$root_bytes_after")"
else
  echo "==> runtime prune dry run: $(human "$removed_bytes") would be removed"
fi