#!/usr/bin/env bash
# Read-only proof that a workspace image still resolves the paths a runtime prune would touch.
#
# The profile links 397 official packages plus vendor, native and app directories straight into
# /opt/dsh-source. A prune that deletes a link target breaks DSH at import time, often only on a
# screen nobody opened during the build. This check starts one throwaway container and asserts:
#
#   - the `dsh` entry resolves to /opt/dsh-source/apps/cli/lib/bin.js and reports its version;
#   - every profile symlink resolves, except three known inert links that the build already leaves
#     dangling (benchmarks, the pruned IM dsh-im bin, and the officecli export shim);
#   - the runtime roots (apps, packages, vendor, native, node_modules, profile, template) exist;
#   - the profile still declares its bundles.
#
# It then prints the measured size of every path named in RUNTIME-PRUNE.md, so a prune change can
# show what it would remove without deleting anything. Run it before and after a prune candidate.
#
# Usage:
#   ./verify-runtime-paths.sh [--image <ref>] [--expect-dsh <version>] [--expect-plus <version>]
#                            [--expect-bundles <count>]
set -euo pipefail

image="dataops-ai-workspace-candidate:local"
expect_dsh=""
expect_plus=""
expect_bundles=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image)
      image="${2:?--image needs a value}"
      shift
      ;;
    --expect-dsh)
      expect_dsh="${2:?--expect-dsh needs a value}"
      shift
      ;;
    --expect-plus)
      expect_plus="${2:?--expect-plus needs a value}"
      shift
      ;;
    --expect-bundles)
      expect_bundles="${2:?--expect-bundles needs a value}"
      shift
      ;;
    -h|--help)
      sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

command -v docker >/dev/null 2>&1 || {
  echo "docker is required to inspect a runtime image" >&2
  exit 2
}
docker image inspect "$image" >/dev/null 2>&1 || {
  echo "image not found: $image" >&2
  exit 2
}

echo "==> runtime path check: $image"
docker run --rm \
  -e EXPECT_DSH="$expect_dsh" \
  -e EXPECT_PLUS="$expect_plus" \
  -e EXPECT_BUNDLES="$expect_bundles" \
  --entrypoint sh "$image" -c '
set -eu
profile=/opt/dsh-home/profiles/dataops-web
source=/opt/dsh-source
fail=0

check_file() {
  if [ ! -e "$1" ]; then
    echo "FAIL missing $1" >&2
    fail=1
  fi
}

check_file "$source/apps/cli/lib/bin.js"
check_file "$source/node_modules/.pnpm"
check_file "$profile/package.json"
check_file /opt/dataops-dsh-profile-template/package.json
check_file "$profile/node_modules/.bin/dsh"

dsh_target="$(readlink -f "$profile/node_modules/.bin/dsh" 2>/dev/null || true)"
case "$dsh_target" in
  "$source"/apps/cli/lib/bin.js) echo "PASS dsh entry -> $dsh_target" ;;
  *) echo "FAIL dsh entry -> ${dsh_target:-<unresolved>}" >&2; fail=1 ;;
esac

dsh_version="$("$profile/node_modules/.bin/dsh" --version 2>/dev/null || true)"
if [ -z "$dsh_version" ]; then
  echo "FAIL dsh --version produced no output" >&2
  fail=1
elif [ -n "${EXPECT_DSH:-}" ] && [ "$dsh_version" != "$EXPECT_DSH" ]; then
  echo "FAIL dsh version $dsh_version, expected $EXPECT_DSH" >&2
  fail=1
else
  echo "PASS dsh --version $dsh_version"
fi

plus_version="$(dsh-plus --version 2>/dev/null || true)"
if [ -z "$plus_version" ]; then
  echo "FAIL dsh-plus --version produced no output" >&2
  fail=1
elif [ -n "${EXPECT_PLUS:-}" ] && [ "$plus_version" != "$EXPECT_PLUS" ]; then
  echo "FAIL dsh-plus version $plus_version, expected $EXPECT_PLUS" >&2
  fail=1
else
  echo "PASS dsh-plus --version $plus_version"
fi

bundles="$(node -p "const m=require(\"$profile/package.json\"); (m.dsh && m.dsh.profile && m.dsh.profile.bundles || []).length")"
if [ "$bundles" -eq 0 ]; then
  echo "FAIL profile declares no bundles" >&2
  fail=1
elif [ -n "${EXPECT_BUNDLES:-}" ] && [ "$bundles" != "$EXPECT_BUNDLES" ]; then
  echo "FAIL bundle count $bundles, expected $EXPECT_BUNDLES" >&2
  fail=1
else
  echo "PASS profile bundles $bundles"
fi

# Three links are already dangling in the candidate image. Each is inert: the benchmarks package
# is not mounted, the IM connector is pruned from the default profile, and the officecli shim is a
# bin alias the launcher rewrites at install time. Anything else is a prune regression.
known_inert() {
  case "$1" in
    "$profile/node_modules/@deepseek-ai/dsh-benchmarks" | \
      "$profile/node_modules/.bin/dsh-im" | \
      "$profile/node_modules/.bin/dsoffice") return 0 ;;
    *) return 1 ;;
  esac
}

links=0
dangling=0
unexpected=0
find "$profile/node_modules" -type l > /tmp/runtime-links.txt
while IFS= read -r link; do
  links=$((links + 1))
  target="$(readlink -f "$link" 2>/dev/null || true)"
  if [ -z "$target" ] || [ ! -e "$target" ]; then
    dangling=$((dangling + 1))
    if known_inert "$link"; then
      echo "INFO known-inert dangling link $(basename "$link")"
    else
      echo "FAIL dangling link $link -> $(readlink "$link")" >&2
      unexpected=$((unexpected + 1))
    fi
  fi
done < /tmp/runtime-links.txt
if [ "$unexpected" -ne 0 ]; then
  fail=1
else
  echo "PASS profile symlinks resolve ($links checked, $dangling known-inert dangling)"
fi

echo "==> sizes"
for path in "$source" "$source/node_modules" "$source/.git" "$source/packages" \
  "$profile" /opt/dataops-dsh-profile-template; do
  printf "  %-40s %s\n" "$path" "$(du -sh "$path" 2>/dev/null | cut -f1)"
done

echo "==> prune candidates (read-only, not deleted)"
for rel in .git .github snapshots scripts patches python website .gitlab-ci.yml \
  .oxlintrc.json tsconfig.base.json tsconfig.host.json tsconfig.client.json \
  tsconfig.host.tsbuildinfo tsconfig.client.tsbuildinfo; do
  if [ -e "$source/$rel" ]; then
    printf "  %-40s %s\n" "$rel" "$(du -sh "$source/$rel" 2>/dev/null | cut -f1)"
  fi
done
src_bytes="$(find "$source/packages" -type d -name src -prune -exec du -sb {} + 2>/dev/null | awk "{s+=\$1} END{print s+0}")"
echo "  packages/**/src                          $((src_bytes / 1048576))MB"

if [ "$fail" -ne 0 ]; then
  echo "runtime path check FAILED" >&2
  exit 1
fi
echo "runtime path check passed"
'
