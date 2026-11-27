#!/usr/bin/env bash
# Materialize the build artifacts the workspace image context does not track.
#
# `context/` carries the Dockerfiles and scripts, not `dsh-src.tar.gz`, the Plus distribution
# tarball or `vendor/*.tgz`. This script supplies those bytes from one of two sources and checks
# every file before a build can consume it:
#
#   fast path    DATAOPS_WORKSPACE_DIR (or --dataops) names a DataOps
#                `infra/docker-workspace` checkout; the artifacts are copied from it.
#   public path  the DSH source is fetched at DSH_SOURCE_REVISION and packed with its `.git`,
#                the Plus tarball is packed from this monorepo, a vendor row with a `seedPath`
#                is copied from the tracked `seed/` directory, and the remaining `vendor/*.tgz`
#                is downloaded from npm. The SheetJS CDN is only a fallback for a missing or
#                mismatched xlsx seed.
#
# `dsh-plus apply` runs `git rev-parse HEAD` and `git apply --3way` in the source tree, so a
# source archive without `.git` cannot build a Plus layer. The public path keeps the checkout's
# `.git` and refuses to write an archive whose HEAD differs from DSH_SOURCE_REVISION.
#
# Every vendor digest is read from `../inputs.lock.json`; the Plus tarball is checked by package
# name and version because `pnpm pack` output depends on the installed toolchain. Any missing or
# mismatched input exits non-zero with the expected value, and the build entry refuses to run.
#
# Usage:
#   ./prepare-inputs.sh                     # fast path when a DataOps checkout is found
#   ./prepare-inputs.sh --public            # ignore DataOps; fetch and pack from public sources
#   ./prepare-inputs.sh --dataops <dir>     # explicit fast path
#   ./prepare-inputs.sh --check             # verify present inputs only; write nothing
#   ./prepare-inputs.sh --help
#
# Environment:
#   DATAOPS_WORKSPACE_DIR   DataOps `infra/docker-workspace` checkout (fast path)
#   DSH_SOURCE_REVISION     official revision; defaults to downstream/upstream.lock.json
#   DSH_SOURCE_REPOSITORY   official repository; defaults to downstream/upstream.lock.json
#   DSH_SOURCE_TAG          fallback tag when the server refuses a fetch by revision
#   DSH_PLUS_VERSION        Plus version; defaults to packages/bundle/plus/package.json
#   DSH_PLUS_TARBALL        existing Plus tarball to copy instead of packing
#   DSH_VENDOR_REGISTRY     npm registry for @sparkelf tarballs (default registry.npmjs.org)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ctx="$here/context"
repo_root="$(cd "$here/../.." && pwd)"
lock="$here/inputs.lock.json"

mode=auto
check_only=0
dataops="${DATAOPS_WORKSPACE_DIR:-}"

usage() {
  sed -n '2,38p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --public)
      mode=public
      ;;
    --dataops)
      dataops="${2:?--dataops needs a path}"
      mode=dataops
      shift
      ;;
    --check)
      check_only=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

die() {
  echo "error: $*" >&2
  exit 3
}

note() {
  echo "==> $*"
}

# Read one dot-path from a JSON file. Fails when the path is absent so a renamed lock field
# stops the script instead of silently falling back to an unpinned default.
json_value() {
  node -e "const j=require(process.argv[1]);let v=j;for(const k of process.argv.slice(2))v=v[k];if(v===undefined)process.exit(1);process.stdout.write(String(v))" "$1" "${@:2}"
}

sha256_of() {
  sha256sum "$1" | cut -d' ' -f1
}

command -v node >/dev/null 2>&1 || die "node is required to read inputs.lock.json"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"
[ -f "$lock" ] || die "missing lock file: $lock"

source_revision="${DSH_SOURCE_REVISION:-$(json_value "$repo_root/downstream/upstream.lock.json" revision)}"
source_repository="${DSH_SOURCE_REPOSITORY:-$(json_value "$repo_root/downstream/upstream.lock.json" repository)}"
source_tag="${DSH_SOURCE_TAG:-$(json_value "$repo_root/downstream/upstream.lock.json" tag)}"
plus_version="${DSH_PLUS_VERSION:-$(json_value "$repo_root/packages/bundle/plus/package.json" version)}"
plus_dest="$ctx/sparkelf-dsh-plus-${plus_version}.tgz"

# A sibling DataOps checkout is the normal host layout; an explicit --dataops or env wins.
if [ -z "$dataops" ]; then
  sibling="$(cd "$repo_root/.." && pwd)/dataops/infra/docker-workspace"
  if [ -d "$sibling" ]; then
    dataops="$sibling"
  fi
fi
if [ "$mode" = "auto" ]; then
  if [ -n "$dataops" ] && [ -d "$dataops" ]; then
    mode=dataops
  else
    mode=public
  fi
fi
if [ "$mode" = "dataops" ]; then
  [ -d "$dataops" ] || die "DataOps build directory not found: $dataops"
  dataops="$(cd "$dataops" && pwd)"
fi

# Vendor rows: path, sha256, fallback URL, size, seed path, upstream digest. The loop reads a
# file rather than a process substitution so a node failure stops the script before anything is
# copied.
rows="$(mktemp)"
trap 'rm -f "$rows"' EXIT
node - "$lock" >"$rows" <<'NODE'
const fs = require('fs')
const lock = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const rows = lock.vendorTarballs ?? []
for (const row of rows) {
  if (row.required === false) continue
  const url = row.source?.url ?? row.source?.fallback?.url ?? ''
  const upstreamSha = row.source?.upstreamSha256 ?? row.source?.fallback?.upstreamSha256 ?? ''
  process.stdout.write([row.path, row.sha256, url, row.bytes ?? '', row.seedPath ?? '', upstreamSha].join('\t') + '\n')
}
NODE
row_count="$(wc -l <"$rows" | tr -d ' ')"
[ "$row_count" -gt 0 ] || die "inputs.lock.json declares no required vendorTarballs"

problems=()
vendor_xlsx_source=""

add_problem() {
  problems+=("$1")
}

# A working tree can pass `git rev-parse` and still fail `git apply --3way`; the index is what
# the patch application reads, so its presence is part of the input contract.
verify_dsh_src() {
  local path="$ctx/dsh-src.tar.gz"
  if [ ! -s "$path" ]; then
    add_problem "context/dsh-src.tar.gz: missing"
    return
  fi
  local head
  head="$(tar xzOf "$path" ./.git/HEAD 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$head" =~ ^[0-9a-f]{40}$ ]]; then
    if [ "$head" != "$source_revision" ]; then
      add_problem "context/dsh-src.tar.gz: HEAD $head, expected $source_revision"
      return
    fi
  elif [[ "$head" == ref:* ]]; then
    local checkout
    checkout="$(mktemp -d)"
    if ! tar xzf "$path" -C "$checkout" ./.git >/dev/null 2>&1; then
      add_problem "context/dsh-src.tar.gz: cannot read .git for a symbolic HEAD"
      rm -rf "$checkout"
      return
    fi
    local revision
    revision="$(git --git-dir="$checkout/.git" rev-parse HEAD 2>/dev/null || true)"
    rm -rf "$checkout"
    if [ "$revision" != "$source_revision" ]; then
      add_problem "context/dsh-src.tar.gz: HEAD $revision, expected $source_revision"
      return
    fi
  else
    add_problem "context/dsh-src.tar.gz: no .git/HEAD; dsh-plus apply requires a git checkout"
    return
  fi
  if ! tar tzf "$path" ./.git/index >/dev/null 2>&1; then
    add_problem "context/dsh-src.tar.gz: no .git/index; dsh-plus apply --3way needs an index"
  fi
}

verify_plus() {
  local path="$plus_dest"
  if [ ! -s "$path" ]; then
    add_problem "context/sparkelf-dsh-plus-${plus_version}.tgz: missing"
    return
  fi
  local manifest name_version
  manifest="$(tar xzOf "$path" package/package.json 2>/dev/null || true)"
  if [ -z "$manifest" ]; then
    add_problem "context/sparkelf-dsh-plus-${plus_version}.tgz: no package/package.json"
    return
  fi
  name_version="$(printf '%s' "$manifest" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.name+'@'+j.version)})" 2>/dev/null || true)"
  if [ "$name_version" != "@sparkelf/dsh-plus@${plus_version}" ]; then
    add_problem "context/sparkelf-dsh-plus-${plus_version}.tgz: found ${name_version:-unreadable}, expected @sparkelf/dsh-plus@${plus_version}"
    return
  fi
  if ! tar tzf "$path" package/lib/index.js >/dev/null 2>&1; then
    add_problem "context/sparkelf-dsh-plus-${plus_version}.tgz: no package/lib/index.js; run pnpm install && pnpm run build before packing"
  fi
}

verify_vendor() {
  local rel sha _url bytes _seed _upstream path actual size
  while IFS=$'\t' read -r rel sha _url bytes _seed _upstream; do
    path="$here/$rel"
    if [ ! -s "$path" ]; then
      add_problem "$rel: missing"
      continue
    fi
    actual="$(sha256_of "$path")"
    if [ "$actual" != "$sha" ]; then
      add_problem "$rel: sha256 $actual, expected $sha"
      if [ "$check_only" = "0" ]; then
        rm -f "$path"
        echo "    removed mismatched $rel" >&2
      fi
      continue
    fi
    if [ -n "$bytes" ]; then
      size="$(stat -c %s "$path")"
      if [ "$size" != "$bytes" ]; then
        add_problem "$rel: $size bytes, expected $bytes"
      fi
    fi
  done <"$rows"
}

verify_gateway() {
  if [ ! -s "$ctx/workspace-web-gateway-protocol/index.js" ]; then
    add_problem "context/workspace-web-gateway-protocol/index.js: missing"
  fi
}

report() {
  if [ "${#problems[@]}" -eq 0 ]; then
    return
  fi
  echo "error: ${#problems[@]} input(s) missing or invalid:" >&2
  printf '  - %s\n' "${problems[@]}" >&2
  if [ "$mode" = "dataops" ]; then
    echo "The DataOps checkout is incomplete for these files; pass --public to use the public sources." >&2
  else
    echo "No build can run until every entry above is supplied and verifies." >&2
  fi
  exit 3
}

copy_from_dataops() {
  local rel="$1"
  local name src
  name="$(basename "$rel")"
  src="$dataops/vendor/$name"
  if [ ! -s "$src" ]; then
    add_problem "$rel: missing from $dataops/vendor"
    return
  fi
  cp -f "$src" "$ctx/vendor/$name"
  if [ "$name" = "xlsx-0.20.3.tgz" ]; then
    vendor_xlsx_source="dataops"
  fi
}

# Copy a tracked seed when the lock row names one and its bytes match the row. A seed is already
# the pinned artifact, so a hit needs neither the network nor the CDN repack recipe. A missing or
# mismatched seed is not a failure by itself: the caller falls back and verification still gates
# the final file.
copy_from_seed() {
  local rel="$1" sha="$2" bytes="$3" seed="$4"
  [ -n "$seed" ] || return 1
  local src="$here/$seed" actual size
  if [ ! -s "$src" ]; then
    note "repo-seed: $seed missing; falling back for $rel"
    return 1
  fi
  actual="$(sha256_of "$src")"
  if [ "$actual" != "$sha" ]; then
    note "repo-seed: $seed sha256 $actual, expected $sha; falling back for $rel"
    return 1
  fi
  if [ -n "$bytes" ]; then
    size="$(stat -c %s "$src")"
    if [ "$size" != "$bytes" ]; then
      note "repo-seed: $seed $size bytes, expected $bytes; falling back for $rel"
      return 1
    fi
  fi
  cp -f "$src" "$here/$rel"
  note "repo-seed: $rel from $seed (sha256 ${sha:0:12}…)"
  return 0
}

materialize_dataops() {
  note "source: DataOps checkout $dataops"
  if [ -s "$dataops/dsh-src.tar.gz" ]; then
    cp -f "$dataops/dsh-src.tar.gz" "$ctx/dsh-src.tar.gz"
  else
    add_problem "context/dsh-src.tar.gz: missing from $dataops"
  fi
  while IFS=$'\t' read -r rel _sha _url _bytes _seed _upstream; do
    copy_from_dataops "$rel"
  done <"$rows"
  if [ -n "${DSH_PLUS_TARBALL:-}" ]; then
    cp_from_external_plus
  elif [ -s "$dataops/sparkelf-dsh-plus-${plus_version}.tgz" ]; then
    cp -f "$dataops/sparkelf-dsh-plus-${plus_version}.tgz" "$plus_dest"
  else
    note "DataOps has no Plus $plus_version tarball; packing it from this monorepo"
    pack_plus
  fi
}

cp_from_external_plus() {
  [ -s "$DSH_PLUS_TARBALL" ] || {
    add_problem "DSH_PLUS_TARBALL: missing or empty: $DSH_PLUS_TARBALL"
    return
  }
  if [ "$(cd "$(dirname "$DSH_PLUS_TARBALL")" && pwd)/$(basename "$DSH_PLUS_TARBALL")" != "$plus_dest" ]; then
    cp -f "$DSH_PLUS_TARBALL" "$plus_dest"
  fi
}

pack_plus() {
  command -v pnpm >/dev/null 2>&1 || die "pnpm is required to pack @sparkelf/dsh-plus"
  [ -f "$repo_root/packages/bundle/plus/lib/index.js" ] || die "packages/bundle/plus/lib/index.js is missing; run: pnpm install --frozen-lockfile && pnpm run build"
  local out
  out="$(mktemp -d)"
  note "packing @sparkelf/dsh-plus@$plus_version"
  if ! (cd "$repo_root" && pnpm --filter @sparkelf/dsh-plus pack --pack-destination "$out" >/dev/null); then
    rm -rf "$out"
    die "pnpm --filter @sparkelf/dsh-plus pack failed"
  fi
  if [ ! -s "$out/sparkelf-dsh-plus-${plus_version}.tgz" ]; then
    rm -rf "$out"
    die "pnpm pack produced no sparkelf-dsh-plus-${plus_version}.tgz"
  fi
  cp -f "$out/sparkelf-dsh-plus-${plus_version}.tgz" "$plus_dest"
  rm -rf "$out"
}

fetch_url() {
  local url="$1" dest="$2"
  if ! curl -fsSL --retry 3 --retry-delay 2 --max-time 300 -o "$dest" "$url"; then
    die "download failed: $url"
  fi
}

materialize_public_dsh_src() {
  command -v git >/dev/null 2>&1 || die "git is required to fetch the DSH source"
  local work
  work="$(mktemp -d)"
  note "fetching $source_repository at $source_revision (depth 1)"
  git init -q "$work/src"
  git -C "$work/src" remote add origin "$source_repository"
  if ! GIT_TERMINAL_PROMPT=0 git -C "$work/src" fetch --depth=1 --no-tags --progress origin "$source_revision"; then
    note "fetch by revision was refused; retrying through tag $source_tag"
    GIT_TERMINAL_PROMPT=0 git -C "$work/src" fetch --depth=1 --no-tags --progress origin "refs/tags/$source_tag:refs/tags/$source_tag" \
      || die "cannot fetch $source_revision or tag $source_tag from $source_repository"
    git -C "$work/src" checkout -q --detach "refs/tags/$source_tag"
  else
    git -C "$work/src" checkout -q --detach FETCH_HEAD
  fi
  local revision
  revision="$(git -C "$work/src" rev-parse HEAD)"
  if [ "$revision" != "$source_revision" ]; then
    rm -rf "$work"
    die "fetched HEAD $revision, expected $source_revision"
  fi
  if [ -n "$(git -C "$work/src" status --porcelain)" ]; then
    rm -rf "$work"
    die "fetched checkout is dirty; refusing to pack it"
  fi
  # Checkout timestamps and reflogs make the archive differ on every run without changing the
  # tree; the reflog is not read by `dsh-plus apply`, so drop it before packing.
  rm -rf "$work/src/.git/logs"
  tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$ctx/dsh-src.tar.gz" -C "$work/src" .
  rm -rf "$work"
}

materialize_public_xlsx() {
  local rel="$1" sha="$2" bytes="$3" url="$4" upstream_sha="$5"
  [ -n "$url" ] || die "$rel: no CDN fallback URL in inputs.lock.json"
  [ -n "$upstream_sha" ] || die "$rel: no source.fallback.upstreamSha256 in inputs.lock.json"
  command -v npm >/dev/null 2>&1 || die "npm is required to repack the xlsx tarball"
  local work built size
  work="$(mktemp -d)"
  note "downloading the xlsx CDN tarball and repacking it to the build's pinned bytes"
  fetch_url "$url" "$work/xlsx-cdn.tgz"
  if [ "$(sha256_of "$work/xlsx-cdn.tgz")" != "$upstream_sha" ]; then
    rm -rf "$work"
    die "xlsx CDN tarball does not match the recorded upstream digest"
  fi
  mkdir -p "$work/tree" "$work/out"
  tar xzf "$work/xlsx-cdn.tgz" -C "$work/tree"
  # The build pins a repack of the installed tree, not the CDN bytes: `package/LICENSE` is a
  # hardlink to `package/dist/LICENSE`, every file is 0600, and `bin/xlsx.njs` stays 0711.
  # With those three properties `npm pack` reproduces md5 5ab9436a1aabeae822c3ed26dd1465d9.
  (
    cd "$work/tree/package"
    rm -f LICENSE
    ln dist/LICENSE LICENSE
    chmod -R u=rwX,go= .
    chmod 711 bin/xlsx.njs
    npm pack --ignore-scripts --pack-destination "$work/out" >/dev/null
  )
  built="$work/out/xlsx-0.20.3.tgz"
  if [ ! -s "$built" ]; then
    rm -rf "$work"
    die "npm pack produced no xlsx-0.20.3.tgz"
  fi
  if [ "$(sha256_of "$built")" != "$sha" ]; then
    rm -rf "$work"
    die "repacked xlsx tarball sha256 $(sha256_of "$built"), expected $sha"
  fi
  size="$(stat -c %s "$built")"
  if [ -n "$bytes" ] && [ "$size" != "$bytes" ]; then
    rm -rf "$work"
    die "repacked xlsx tarball is $size bytes, expected $bytes"
  fi
  cp -f "$built" "$ctx/vendor/xlsx-0.20.3.tgz"
  rm -rf "$work"
}

materialize_public_vendor() {
  local rel sha url bytes seed upstream_sha name
  while IFS=$'\t' read -r rel sha url bytes seed upstream_sha; do
    name="$(basename "$rel")"
    if copy_from_seed "$rel" "$sha" "$bytes" "$seed"; then
      if [ "$name" = "xlsx-0.20.3.tgz" ]; then
        vendor_xlsx_source="repo-seed"
      fi
      continue
    fi
    if [ "$name" = "xlsx-0.20.3.tgz" ]; then
      materialize_public_xlsx "$rel" "$sha" "$bytes" "$url" "$upstream_sha"
      vendor_xlsx_source="cdn-repack"
      continue
    fi
    if [ -z "$url" ]; then
      add_problem "$rel: no public source URL in inputs.lock.json"
      continue
    fi
    if [ -n "${DSH_VENDOR_REGISTRY:-}" ]; then
      url="${DSH_VENDOR_REGISTRY%/}/${url#https://registry.npmjs.org/}"
    fi
    note "downloading $name"
    fetch_url "$url" "$ctx/vendor/$name"
  done <"$rows"
}

materialize_public() {
  note "source: public (git, pnpm, npm, repository seed, SheetJS CDN fallback)"
  materialize_public_dsh_src
  if [ -n "${DSH_PLUS_TARBALL:-}" ]; then
    cp_from_external_plus
  else
    pack_plus
  fi
  materialize_public_vendor
}

if [ "$check_only" = "0" ]; then
  case "$mode" in
    dataops) materialize_dataops ;;
    public) materialize_public ;;
    *) die "unreachable mode: $mode" ;;
  esac
  report
fi

verify_dsh_src
verify_plus
verify_vendor
verify_gateway
report

if [ "$check_only" = "1" ]; then
  note "inputs verified"
else
  note "inputs materialized"
fi
echo "  dsh-src      $ctx/dsh-src.tar.gz ($(sha256_of "$ctx/dsh-src.tar.gz" | cut -c1-12)…, HEAD $source_revision)"
echo "  plus         $plus_dest (@sparkelf/dsh-plus@${plus_version})"
echo "  vendor       $row_count files match inputs.lock.json"
echo "  xlsx         $ctx/vendor/xlsx-0.20.3.tgz (source: ${vendor_xlsx_source:-present})"
echo "  next         ./build-workspace-final.sh $plus_version --print"
