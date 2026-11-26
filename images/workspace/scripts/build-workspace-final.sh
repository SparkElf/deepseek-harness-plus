#!/usr/bin/env bash
# Build the DataOps AI workspace image in three layers: base -> plus -> runtime.
#
# This is the monorepo copy of `dataops/infra/docker-workspace/build-workspace-final.sh`. The
# build semantics are unchanged: the layers are chained by image ID (never by a surviving
# intermediate tag), the build runs with `--network host`, and the final image is tagged
# `<repo>:final-<stamp>`, `<repo>:final` and `<repo>:local`.
#
# Two inputs are not part of this repository and are named rather than guessed:
#   WORKSPACE_GATEWAY_PROTOCOL_CONTEXT  DataOps-owned `packages/workspace-web-gateway-protocol`
#   context artifacts                   dsh-src.tar.gz, the Plus tarball, vendor/*.tgz
# `scripts/prepare-inputs.sh` materializes the artifacts from a DataOps checkout or from public
# sources and verifies them; `--print` resolves every command and reports missing inputs without
# building anything.
#
# Usage:
#   ./build-workspace-final.sh 0.2.9-alpha.105
#   ./build-workspace-final.sh 0.2.9-alpha.105 --print
#   DSH_PLUS_TARBALL=/tmp/rel/sparkelf-dsh-plus-0.2.9-alpha.105.tgz ./build-workspace-final.sh 0.2.9-alpha.105
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

image_repo="${IMAGE_REPOSITORY:-dataops-ai-workspace}"
profile_defaults="${DATAOPS_PROFILE_DEFAULTS:-cordis.patch.yml}"
stamp="$(date +%Y%m%d-%H%M)"
plus_version="${DSH_PLUS_VERSION:-$version}"
source_revision="${DSH_SOURCE_REVISION:-4b399c39a6d1479cd84ca591b4d7c88e24d38a96}"
source_registry="${DSH_SOURCE_REGISTRY:-https://registry.npmmirror.com}"
plus_registry="${DSH_PLUS_INSTALL_REGISTRY:-https://mirrors.cloud.tencent.com/npm}"

tarball="${DSH_PLUS_TARBALL:-$ctx/sparkelf-dsh-plus-${plus_version}.tgz}"
dest="$ctx/sparkelf-dsh-plus-${plus_version}.tgz"

gateway_context="${WORKSPACE_GATEWAY_PROTOCOL_CONTEXT:-$ctx/workspace-web-gateway-protocol}"

# Inputs a build needs but this repository deliberately does not carry. `prepare-inputs.sh`
# supplies and verifies them; this list reports every absence at once so a reviewer sees the
# whole surface before a build starts.
missing=()
test -f "$tarball" || missing+=("plus tarball: $tarball (run scripts/prepare-inputs.sh)")
test -f "$ctx/dsh-src.tar.gz" || missing+=("DSH source tarball: $ctx/dsh-src.tar.gz (run scripts/prepare-inputs.sh)")
if [ ! -f "$gateway_context/index.js" ]; then
  missing+=("gateway protocol context has no index.js: $gateway_context")
fi
# `pin-plus-plugins.mjs` reads two of these tarballs and `COPY vendor/` carries the rest; a
# missing file fails the Plus or Runtime layer after a long install, so resolve them here too.
for vendor_tarball in \
  xlsx-0.20.3.tgz \
  sparkelf-dsh-better-sidebar-0.30.1-sparkelf.22.tgz \
  sparkelf-dsh-dataops-managed-0.4.2.tgz \
  sparkelf-dsh-dataops-managed-0.4.1.tgz \
  sparkelf-dsh-dataops-im-0.1.2.tgz \
  sparkelf-dsh-group-chat-0.5.12.tgz; do
  test -f "$ctx/vendor/$vendor_tarball" || missing+=("vendor tarball: $ctx/vendor/$vendor_tarball (run scripts/prepare-inputs.sh)")
done

base_ref="$image_repo:base-py312"
plus_ref="$image_repo:plus-cli-py312-${plus_version}"
runtime_files_ref="$image_repo:runtime-files"

# The named context is only meaningful once it resolves; omitting it keeps a printed plan
# copy-pasteable instead of carrying an empty `--build-context name=`.
gateway_context_args=()
if [ -n "$gateway_context" ]; then
  gateway_context_args=(--build-context "workspace-web-gateway-protocol=$gateway_context")
fi

build_base=(docker build --network host -f "$ctx/Dockerfile" --target workspace-base
  "${gateway_context_args[@]}" -q "$ctx")
build_plus=(docker build --network host -f "$ctx/Dockerfile.plus-cli-src"
  "${gateway_context_args[@]}"
  --build-arg "BASE_IMAGE=$base_ref"
  --build-arg "DSH_PLUS_VERSION=${plus_version}"
  --build-arg "DSH_SOURCE_REVISION=${source_revision}"
  --build-arg "DSH_SOURCE_REGISTRY=${source_registry}"
  --build-arg "DATAOPS_PROFILE_DEFAULTS=${profile_defaults}"
  --build-arg "DSH_PLUS_INSTALL_REGISTRY=${plus_registry}"
  --build-arg "HTTP_PROXY=${HTTP_PROXY:-}" --build-arg "HTTPS_PROXY=${HTTPS_PROXY:-}"
  --build-arg "NO_PROXY=${NO_PROXY:-localhost,127.0.0.1,registry.npmmirror.com}"
  -q "$ctx")
build_runtime=(docker build --network host -f "$ctx/Dockerfile.runtime-cli"
  --build-arg "DSH_LAYER_IMAGE=$plus_ref"
  --build-arg "DSH_PLUS_VERSION=${plus_version}"
  --build-arg "DATAOPS_PROFILE_DEFAULTS=${profile_defaults}" -q "$ctx")

if [ "$print_only" = "1" ]; then
  echo "==> plan (no build)"
  echo "  plus version : $plus_version"
  echo "  source rev   : $source_revision"
  echo "  context      : $ctx"
  echo "  tags         : $image_repo:final-$stamp, :final, :local"
  echo
  print_cmd() {
    local a
    for a in "$@"; do
      if [ -z "$a" ] || [[ "$a" == *[[:space:]]* ]]; then printf "'%s' " "$a"; else printf '%s ' "$a"; fi
    done
    echo
  }
  for step in base plus runtime; do
    var="build_$step[@]"
    echo "==> $step"
    printf '  '
    print_cmd "${!var}"
  done
  echo
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "==> missing inputs (${#missing[@]})"
    printf '  - %s\n' "${missing[@]}"
    echo
    echo "A build would fail before producing an image. See docs/workspace-image-migration-gap.md."
  else
    echo "==> all declared inputs present"
  fi
  exit 0
fi

if [ "${#missing[@]}" -gt 0 ]; then
  echo "cannot build: ${#missing[@]} required input(s) missing" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  echo "See docs/workspace-image-migration-gap.md; --print resolves the plan without building." >&2
  exit 3
fi

# The build context copies the Plus tarball under its versioned name; keep the requested file
# there when the caller pointed somewhere else.
if [ "$tarball" != "$dest" ]; then cp -f "$tarball" "$dest"; fi

echo "==> base"
if [ "${SKIP_BASE:-0}" = "1" ] && docker image inspect "$base_ref" >/dev/null 2>&1; then
  # DSH-only upgrade: reuse the system layer. LibreOffice 25.8.7 lives in base, so a reused base
  # must already carry it.
  echo "    reusing $base_ref (SKIP_BASE=1)"
  base_id=$(docker image inspect -f '{{.Id}}' "$base_ref")
else
  base_id=$("${build_base[@]}")
  docker tag "$base_id" "$base_ref"
fi

echo "==> plus-cli-src ($plus_version)"
src_id=$("${build_plus[@]}")
docker tag "$src_id" "$plus_ref"

echo "==> runtime-files"
# The runtime layer needs a `COPY --from` source; tag the same filesystem instead of committing a
# container, which avoids the containerd commit path that can fail with `lease does not exist`.
docker tag "$src_id" "$runtime_files_ref"

echo "==> runtime"
final_id=$("${build_runtime[@]}")

docker tag "$final_id" "$image_repo:final-${stamp}"
docker tag "$final_id" "$image_repo:final"
docker tag "$final_id" "$image_repo:local"

echo "==> done"
echo "  base=${base_id}"
echo "  src=${src_id}"
echo "  final=${final_id}  tags: final-${stamp}, final, local"