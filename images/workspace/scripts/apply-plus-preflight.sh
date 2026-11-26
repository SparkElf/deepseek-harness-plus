#!/usr/bin/env bash
# Read-only phase report for apply-plus.sh and the marker that `--skip-build` verifies.
#
# `apply-plus.sh` exposes three phases: `full` (the existing chain), `source` (patches and one
# official build) and `profile` (`dsh-plus apply --skip-build`, no source install or build). The
# final phase authenticates the prebuilt source tree with a marker at
# /opt/dsh-source/.dataops-official-build.json:
#
#   {
#     "sourceRevision": "<40-hex>",
#     "patchsetDigest": "<sha256 over the selected source patch ids, files and bytes>",
#     "builtAt": "<ISO-8601>"
#   }
#
# A skip-build phase may run only when the marker matches the source revision and the patch set in
# the installed distribution, and the built entry points exist. The revision comes from `.git` when
# the checkout still has it; a pruned checkout uses the lock's `dsh.baseRevision`, which is the same
# marker-versus-distribution check `--skip-build` performs. Without a marker the verdict is
# `full-build-required`, which is the state of a pre-G6 image. The report also records whether the
# optional runtime prune already ran.
#
# Usage:
#   ./apply-plus-preflight.sh [--image <ref>] [--json <path>]
set -euo pipefail

image="dataops-ai-workspace-candidate:local"
container=""
json_out=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image)
      image="${2:?--image needs a value}"
      container=""
      shift
      ;;
    --container)
      container="${2:?--container needs a value}"
      shift
      ;;
    --json)
      json_out="${2:?--json needs a path}"
      shift
      ;;
    -h|--help)
      sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
  echo "docker is required" >&2
  exit 2
}
if [ -n "$container" ]; then
  docker inspect -f '{{.State.Running}}' "$container" >/dev/null 2>&1 || {
    echo "container not found: $container" >&2
    exit 2
  }
  probe=(docker exec "$container" sh -c)
  target="$container (container)"
else
  docker image inspect "$image" >/dev/null 2>&1 || {
    echo "image not found: $image" >&2
    exit 2
  }
  probe=(docker run --rm --entrypoint sh "$image" -c)
  target="$image"
fi

echo "==> apply-plus phase report: $target"
"${probe[@]}" '
set -eu
profile=/opt/dsh-home/profiles/dataops-web
source=/opt/dsh-source
distribution=/usr/local/lib/node_modules/@sparkelf/dsh-plus
lock="$profile/.dsh-plus/patchset.lock.json"
marker="$source/.dataops-official-build.json"

node - "$lock" "$distribution" "$source" "$marker" "$profile" <<"NODE"
const { createHash } = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const [lockPath, distribution, sourceRoot, markerPath, profile] = process.argv.slice(2)
const report = { phases: [], checks: [], verdict: "full-build-required", patchsetDigest: null }

const addCheck = (id, status, detail) => report.checks.push({ id, status, detail })
const addPhase = (id, action, reason) => report.phases.push({ id, wouldRun: action, reason })
let lockBaseRevision = ""

if (!fs.existsSync(lockPath)) {
  addCheck("patchset-lock", "missing", lockPath)
} else {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"))
  lockBaseRevision = lock.dsh && lock.dsh.baseRevision ? lock.dsh.baseRevision : ""
  const patches = Array.isArray(lock.patches) ? lock.patches : []
  const sourcePatches = patches.filter(patch => patch.target && patch.target.kind === "dsh-source")
  addCheck("patchset-lock", "ok", `${patches.length} patches, ${sourcePatches.length} source`)

  const rows = []
  let missing = 0
  for (const patch of sourcePatches) {
    const file = path.join(distribution, patch.file)
    if (!fs.existsSync(file)) {
      missing += 1
      continue
    }
    rows.push({
      id: patch.id,
      file: patch.file,
      baseRevision: patch.target.baseRevision,
      sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    })
  }
  rows.sort((left, right) => left.id.localeCompare(right.id))
  report.patchsetDigest = createHash("sha256").update(JSON.stringify(rows)).digest("hex")
  addCheck("patch-files", missing === 0 ? "ok" : "missing", `${missing} missing of ${sourcePatches.length}`)
  addPhase("source-patch", sourcePatches.length > 0, `${sourcePatches.length} source patches selected`)
}

const entries = [
  path.join(sourceRoot, "apps/cli/lib/bin.js"),
  path.join(sourceRoot, "packages/client/ui-chat/lib/client.js"),
]
const missingEntries = entries.filter(file => !fs.existsSync(file))
addCheck("build-outputs", missingEntries.length === 0 ? "ok" : "missing", missingEntries.join(", ") || "entry points present")
addPhase("profile-install", true, "dsh-plus apply installs and links the profile on every run")
addPhase("official-build", true, "a full apply builds whenever a source patch is selected; --skip-build verifies the marker instead")
report.skipBuild = { available: false, reason: "no matching prebuilt marker" }

if (fs.existsSync(markerPath)) {
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"))
  const hasGit = fs.existsSync(path.join(sourceRoot, ".git/HEAD"))
  // A pruned checkout has no `.git`; the marker and the lock it was written for then carry the
  // revision. That is the same authentication `--skip-build` performs on the source tree.
  const revision = hasGit
    ? require("node:child_process").execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    : lockBaseRevision
  const matches = marker.sourceRevision === revision && marker.patchsetDigest === report.patchsetDigest
  addCheck("prebuilt-marker", matches ? "ok" : "mismatch", JSON.stringify({ ...marker, git: hasGit ? revision : "pruned" }))
  if (matches && missingEntries.length === 0) {
    report.verdict = "skip-build-safe"
    report.skipBuild = { available: true, reason: "marker matches revision, patch set and built entry points" }
  } else if (!matches) {
    report.skipBuild.reason = "marker does not match the revision or selected patch set"
  } else {
    report.skipBuild.reason = "built entry points are missing"
  }
} else {
  addCheck("prebuilt-marker", "missing", "no " + markerPath)
}

report.runtimePruned = null
const pruneStamp = path.join(sourceRoot, ".dataops-runtime-pruned")
if (fs.existsSync(pruneStamp)) {
  try {
    report.runtimePruned = JSON.parse(fs.readFileSync(pruneStamp, "utf8"))
  } catch {
    report.runtimePruned = { unreadable: pruneStamp }
  }
}

report.bundles = (() => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(profile, "package.json"), "utf8"))
    return (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles || []).length
  } catch {
    return null
  }
})()

console.log(JSON.stringify(report, null, 2))
const blocking = report.checks.filter(check =>
  (check.id === "patchset-lock" || check.id === "patch-files" || check.id === "build-outputs")
  && check.status !== "ok")
process.exitCode = blocking.length > 0 ? 1 : 0
NODE
' | tee /tmp/apply-plus-preflight.json

if [ -n "$json_out" ]; then
  cp /tmp/apply-plus-preflight.json "$json_out"
  echo "wrote $json_out"
fi

echo "==> verdict"
node -e '
const report = JSON.parse(require("fs").readFileSync("/tmp/apply-plus-preflight.json", "utf8"))
for (const phase of report.phases) console.log(`  ${phase.wouldRun ? "RUN " : "SKIP"} ${phase.id}: ${phase.reason}`)
console.log(`  bundles: ${report.bundles}`)
console.log(`  patchset: ${report.patchsetDigest ?? "<unavailable>"}`)
console.log(`  skip-build: ${report.skipBuild && report.skipBuild.available ? "available" : "unavailable"}: ${report.skipBuild ? report.skipBuild.reason : ""}`)
console.log(`  runtime-pruned: ${report.runtimePruned ? JSON.stringify(report.runtimePruned) : "no"}`)
console.log(`  verdict: ${report.verdict}`)
'
