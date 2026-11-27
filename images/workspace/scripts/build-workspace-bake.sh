#!/usr/bin/env bash
# Build the DataOps AI workspace image through `docker buildx bake`, one target at a time.
#
# The three targets read the previous layer by tag (`base-py312`, then
# `plus-cli-py312-<version>` / `runtime-files`), and bake does not order targets from this HCL:
# `depends_on` is a compose-file field and is ignored here. This script is the sequential driver
# that makes the chain reproducible; it never pushes and never writes the `final` or `local` tags.
#
# The runtime target is tagged `<repo>:final-bake`. A candidate repository also gets its own
# binding at acceptance/release-binding-bake.json, which the shell release path does not overwrite.
#
# Usage:
#   ./build-workspace-bake.sh [<plus-version>] [--print] [--no-cache] [--skip-base]
#   ./build-workspace-bake.sh --report acceptance/bake-build-20261126.json
#
# Environment:
#   IMAGE_REPOSITORY  default dataops-ai-workspace-candidate
#   DSH_PLUS_VERSION  default packages/bundle/plus/package.json version
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
cd "$here"

print_only=0
no_cache=0
skip_base=0
report_path=""
version=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --print) print_only=1 ;;
    --no-cache) no_cache=1 ;;
    --skip-base) skip_base=1 ;;
    --report)
      [ "$#" -ge 2 ] || { echo "error: --report needs a path" >&2; exit 2; }
      report_path="$2"
      shift
      ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *)
      [ -z "$version" ] || { echo "error: more than one version argument" >&2; exit 2; }
      version="$1"
      ;;
  esac
  shift
done

if [ -z "$version" ]; then
  version="${DSH_PLUS_VERSION:-$(node -p "require(process.argv[1]).version" "$repo_root/packages/bundle/plus/package.json")}"
fi
export DSH_PLUS_VERSION="$version"

image_repo="${IMAGE_REPOSITORY:-dataops-ai-workspace-candidate}"
base_ref="$image_repo:base-py312"
plus_ref="$image_repo:plus-cli-py312-${version}"
runtime_files_ref="$image_repo:runtime-files"
final_ref="$image_repo:final-bake"
binding_path="$here/acceptance/release-binding-bake.json"
plus_tarball="$here/context/sparkelf-dsh-plus-${version}.tgz"
stamp="$(date +%Y%m%d-%H%M%S)"
if [ -z "$report_path" ]; then
  report_path="$here/acceptance/bake-build-${stamp}.json"
fi

missing=()
[ -f "$plus_tarball" ] || missing+=("Plus tarball: $plus_tarball (run scripts/prepare-inputs.sh)")
[ -f "$here/context/dsh-src.tar.gz" ] || missing+=("DSH source tarball: $here/context/dsh-src.tar.gz (run scripts/prepare-inputs.sh)")
[ -f "$here/context/workspace-web-gateway-protocol/index.js" ] || missing+=("gateway protocol context: $here/context/workspace-web-gateway-protocol/index.js")

# Resolve every target before building; this also catches HCL syntax errors and unknown fields.
bake_plan="$(docker buildx bake --print base plus runtime 2>&1)" || {
  printf '%s\n' "$bake_plan" >&2
  echo "error: docker buildx bake --print failed" >&2
  exit 3
}

if [ "$print_only" = "1" ]; then
  printf '%s\n' "$bake_plan"
  echo "==> plan (no build)"
  echo "  plus version : $version"
  echo "  repository   : $image_repo"
  echo "  tags         : $base_ref, $plus_ref, $runtime_files_ref, $final_ref"
  echo "  cache        : $([ "$no_cache" = "1" ] && echo disabled || echo enabled)"
  echo "  skip base    : $([ "$skip_base" = "1" ] && echo yes || echo no)"
  echo "  binding      : $binding_path"
  echo "  report       : $report_path"
  if [ "${#missing[@]}" -gt 0 ]; then
    printf '==> missing inputs (%s)\n' "${#missing[@]}"
    printf '  - %s\n' "${missing[@]}"
    exit 3
  fi
  echo "==> all declared inputs present"
  exit 0
fi

if [ "${#missing[@]}" -gt 0 ]; then
  echo "cannot build: ${#missing[@]} required input(s) missing" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 3
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
stage_records=()
build_start="$(date +%s)"

record_stage() {
  local target="$1" image="$2" seconds="$3" reused="$4"
  local image_id size_bytes layers repo_digest
  image_id="$(docker image inspect -f '{{.Id}}' "$image")"
  size_bytes="$(docker image inspect -f '{{.Size}}' "$image")"
  layers="$(docker image inspect -f '{{len .RootFS.Layers}}' "$image")"
  repo_digest="$(docker image inspect -f '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$image")"
  stage_records+=("$(jq -nc \
    --arg target "$target" --arg image "$image" --argjson seconds "$seconds" \
    --argjson reused "$reused" --arg imageId "$image_id" --argjson sizeBytes "$size_bytes" \
    --argjson layers "$layers" --arg repoDigest "$repo_digest" \
    '{target:$target,image:$image,seconds:$seconds,reused:$reused,imageId:$imageId,sizeBytes:$sizeBytes,layers:$layers,repoDigest:$repoDigest}')")
}

run_target() {
  local target="$1" image="$2" start end seconds
  start="$(date +%s)"
  echo "==> bake $target"
  if [ "$no_cache" = "1" ]; then
    docker buildx bake --allow=network.host "$target" --load --no-cache --progress=plain --metadata-file "$tmp_dir/$target.json"
  else
    docker buildx bake --allow=network.host "$target" --load --progress=plain --metadata-file "$tmp_dir/$target.json"
  fi
  end="$(date +%s)"
  seconds=$((end - start))
  record_stage "$target" "$image" "$seconds" false
  echo "    $target: ${seconds}s $(docker image inspect -f '{{.Id}}' "$image")"
}

if [ "$skip_base" = "1" ] && docker image inspect "$base_ref" >/dev/null 2>&1; then
  echo "==> reuse $base_ref (--skip-base)"
  record_stage base "$base_ref" 0 true
else
  run_target base "$base_ref"
fi

run_target plus "$plus_ref"
if ! docker image inspect "$runtime_files_ref" >/dev/null 2>&1; then
  echo "error: bake did not tag $runtime_files_ref" >&2
  exit 4
fi

run_target runtime "$final_ref"
build_seconds=$(( $(date +%s) - build_start ))

final_id="$(docker image inspect -f '{{.Id}}' "$final_ref")"
final_size="$(docker image inspect -f '{{.Size}}' "$final_ref")"
final_layers="$(docker image inspect -f '{{len .RootFS.Layers}}' "$final_ref")"
final_digest="$(docker image inspect -f '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$final_ref")"

# The shell entry tags final/local; bake must never move them. Record what they currently point at
# so the report can show whether the two paths produced the same image.
shell_chain="$(jq -nc \
  --arg tag "$image_repo:final" \
  --arg imageId "$(docker image inspect -f '{{.Id}}' "$image_repo:final" 2>/dev/null || true)" \
  --argjson sizeBytes "$(docker image inspect -f '{{.Size}}' "$image_repo:final" 2>/dev/null || echo null)" \
  '{tag:$tag,imageId:(if $imageId == "" then null else $imageId end),sizeBytes:$sizeBytes}')"

binding_written=false
if [[ "$image_repo" == *candidate* ]]; then
  echo "==> release binding"
  node "$here/scripts/release-binding.mjs" write \
    --tag "$final_ref" \
    --path "$binding_path" \
    --build-entry scripts/build-workspace-bake.sh
  node "$here/scripts/release-binding.mjs" verify \
    --path "$binding_path" \
    --image "$final_ref" \
    --require-inputs \
    --require-image
  binding_written=true
fi

stages="$(printf '%s\n' "${stage_records[@]}" | jq -s '.')"
jq -n \
  --arg generatedAt "$(date -Iseconds)" \
  --arg repository "$image_repo" \
  --arg version "$version" \
  --arg cacheMode "$([ "$no_cache" = "1" ] && echo disabled || echo enabled)" \
  --argjson stages "$stages" \
  --argjson totalSeconds "$build_seconds" \
  --arg finalTag "$final_ref" --arg finalImageId "$final_id" --arg finalDigest "$final_digest" \
  --argjson finalSizeBytes "$final_size" --argjson finalLayers "$final_layers" \
  --argjson shellChain "$shell_chain" \
  --arg binding "$binding_path" --argjson bindingWritten "$binding_written" \
  '{schemaVersion:1,kind:"workspace-image-bake-build",generatedAt:$generatedAt,
    repository:$repository,plusVersion:$version,cacheMode:$cacheMode,
    stages:$stages,totalSeconds:$totalSeconds,
    final:{tag:$finalTag,imageId:$finalImageId,digest:$finalDigest,sizeBytes:$finalSizeBytes,layers:$finalLayers},
    shellChain:$shellChain,binding:{path:$binding,written:$bindingWritten}}' > "$report_path"

echo "==> done"
echo "  final   $final_ref $final_id"
echo "  size    $final_size bytes, $final_layers layers"
echo "  digest  $final_digest"
echo "  time    ${build_seconds}s"
echo "  report  $report_path"