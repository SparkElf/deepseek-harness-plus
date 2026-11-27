#!/usr/bin/env bash
# Compare the mirrored workspace build context against the DataOps source tree.
#
# The migration keeps DataOps as the owner of these files until B-10. This check makes the
# duplication safe: every file that is supposed to be byte-identical is compared by SHA-256, and
# everything that is intentionally absent is listed so its absence cannot be mistaken for drift.
#
# Usage:
#   ./check-parity.sh [--dataops <infra/docker-workspace>]
#   DATAOPS_WORKSPACE_DIR=/root/projects/dataops/infra/docker-workspace ./check-parity.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ctx="$here/context"

dataops="${DATAOPS_WORKSPACE_DIR:-}"
if [ "${1:-}" = "--dataops" ]; then
  dataops="${2:?usage: $0 [--dataops <infra/docker-workspace>]}"
fi
if [ -z "$dataops" ]; then
  dataops="$here/../../../dataops/infra/docker-workspace"
fi
if [ ! -d "$dataops" ]; then
  echo "DataOps build directory not found: $dataops" >&2
  echo "Pass it with --dataops <path> or DATAOPS_WORKSPACE_DIR." >&2
  exit 2
fi

# Files this mirror owns rather than copies: placeholder notes, the context README, and the
# context-level .dockerignore (the DataOps context has no equivalent).
is_owned_here() {
  case "$1" in
    ".dockerignore" | "README.md" | "vendor/README.md" | "officecli-bin/README.md" | "dsh-src.tar.gz" | "sparkelf-dsh-plus-"*.tgz | "workspace-web-gateway-protocol/"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Artifacts that must NOT be mirrored; each is a documented migration gap.
absent_expectations=(
)

fail=0
checked=0
cd "$ctx"
while IFS= read -r rel; do
  if is_owned_here "$rel"; then
    continue
  fi
  checked=$((checked + 1))
  if [ ! -f "$dataops/$rel" ]; then
    echo "MISSING-IN-DATAOPS $rel"
    fail=1
  elif ! cmp -s "$rel" "$dataops/$rel"; then
    echo "DIFF               $rel"
    fail=1
  fi
done < <(find . -type f -printf '%P\n' | sort)

for rel in "${absent_expectations[@]}"; do
  if [ -e "$rel" ]; then
    echo "UNEXPECTED         $rel (must stay out of the mirror)"
    fail=1
  fi
done

if [ "$checked" -eq 0 ]; then
  echo "no mirrored files found under $ctx" >&2
  exit 2
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "parity check failed: the mirror and $dataops disagree" >&2
  exit 1
fi

echo "parity ok: $checked mirrored files identical to $dataops"
echo "intentionally absent: ${#absent_expectations[@]} artifacts (documented in inputs.lock.json)"