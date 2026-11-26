#!/usr/bin/env bash
# Build the two halves of the Plus layer separately and report each stage's wall time.
#
# The Dockerfile keeps `plus-build` as its final stage, so the normal build entry is unchanged.
# This script exposes the split for measurement: `source-build` runs the source patches, the
# official build, the marker and (when RUNTIME_PRUNE=1) the runtime prune in that same layer;
# `plus-build` runs the profile phase with `--skip-build` and the rest of the layer. The default
# repository is a test namespace so a measurement cannot replace the candidate or production tags.
#
# Usage:
#   ./build-plus-staged.sh 0.2.9-alpha.106
#   ./build-plus-staged.sh 0.2.9-alpha.106 --print
#   RUNTIME_PRUNE=1 IMAGE_REPOSITORY=dataops-ai-workspace-candidate ./build-plus-staged.sh 0.2.9-alpha.106
#
# Environment:
#   IMAGE_REPOSITORY  default dataops-ai-workspace-test
#   BASE_IMAGE        default dataops-ai-workspace-candidate:base-py312
#   RUNTIME_PRUNE     0 (default) or 1
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ctx="$here/context"

print_only=0
args=()
for arg in "$@"; do
  case "$arg" in
    --print) print_only=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) args+=("$arg") ;;
  esac
done
version="${args[0]:?usage: $0 <plus-version> [--print]}"

repo="${IMAGE_REPOSITORY:-dataops-ai-workspace-test}"
base_image="${BASE_IMAGE:-dataops-ai-workspace-candidate:base-py312}"
plus_version="${DSH_PLUS_VERSION:-$version}"
runtime_prune="${RUNTIME_PRUNE:-0}"

gateway_context="${WORKSPACE_GATEWAY_PROTOCOL_CONTEXT:-$ctx/workspace-web-gateway-protocol}"
gateway_context_args=()
if [ -n "$gateway_context" ]; then
  gateway_context_args=(--build-context "workspace-web-gateway-protocol=$gateway_context")
fi

common_args=(
  --build-arg "BASE_IMAGE=$base_image"
  --build-arg "DSH_PLUS_VERSION=$plus_version"
  --build-arg "DSH_SOURCE_REVISION=${DSH_SOURCE_REVISION:-4b399c39a6d1479cd84ca591b4d7c88e24d38a96}"
  --build-arg "DSH_SOURCE_REGISTRY=${DSH_SOURCE_REGISTRY:-https://registry.npmmirror.com}"
  --build-arg "DSH_PLUS_INSTALL_REGISTRY=${DSH_PLUS_INSTALL_REGISTRY:-https://mirrors.cloud.tencent.com/npm}"
  --build-arg "DATAOPS_PROFILE_DEFAULTS=${DATAOPS_PROFILE_DEFAULTS:-cordis.patch.yml}"
)

source_cmd=(docker build --network host -f "$ctx/Dockerfile.plus-cli-src" --target source-build
  "${gateway_context_args[@]}" "${common_args[@]}"
  --build-arg "RUNTIME_PRUNE=$runtime_prune"
  -t "$repo:source-build-$plus_version" "$ctx")
plus_cmd=(docker build --network host -f "$ctx/Dockerfile.plus-cli-src" --target plus-build
  "${gateway_context_args[@]}" "${common_args[@]}"
  --build-arg "RUNTIME_PRUNE=$runtime_prune"
  -t "$repo:plus-cli-py312-$plus_version" "$ctx")

if [ "$print_only" = "1" ]; then
  echo "==> staged plus plan (no build)"
  echo "  version      : $plus_version"
  echo "  base image   : $base_image"
  echo "  runtime prune: $runtime_prune"
  echo "  source stage : $repo:source-build-$plus_version"
  echo "  profile stage: $repo:plus-cli-py312-$plus_version"
  echo
  printf '  source: '
  printf '%q ' "${source_cmd[@]}"
  echo
  printf '  plus:   '
  printf '%q ' "${plus_cmd[@]}"
  echo
  exit 0
fi

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 2; }
docker image inspect "$base_image" >/dev/null 2>&1 || {
  echo "base image not found: $base_image" >&2
  exit 2
}

started="$(date +%s)"
source_id="$("${source_cmd[@]}")"
source_seconds=$(( $(date +%s) - started ))

started="$(date +%s)"
plus_id="$("${plus_cmd[@]}")"
plus_seconds=$(( $(date +%s) - started ))

echo "==> staged plus complete"
echo "  source-build ${source_id} ${source_seconds}s"
echo "  plus-build   ${plus_id} ${plus_seconds}s"
printf '{"sourceBuildSeconds":%s,"plusBuildSeconds":%s,"totalSeconds":%s,"runtimePrune":"%s","sourceImage":"%s","plusImage":"%s"}\n' \
  "$source_seconds" "$plus_seconds" "$((source_seconds + plus_seconds))" "$runtime_prune" "$source_id" "$plus_id"