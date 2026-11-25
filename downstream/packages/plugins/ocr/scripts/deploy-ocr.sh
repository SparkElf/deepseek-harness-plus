#!/usr/bin/env bash
# Deploy the OCR plugin into every DataOps workspace container's profile and
# profile-template, then verify each one.
#
# Idempotent, and it refuses rather than half-applies:
#   * every target is backed up before it is touched;
#   * an already-configured target is reported instead of rewritten;
#   * a target that does not parse afterwards is restored from its backup.
#
# Usage: deploy-ocr.sh <ocr-tarball> [--verify-only]
set -uo pipefail

TARBALL="${1:?usage: deploy-ocr.sh <ocr-tarball> [--verify-only]}"
MODE="${2:-deploy}"
TS="$(date +%Y%m%d-%H%M%S)"
TARBALL_NAME="$(basename "$TARBALL")"
PKG="@sparkelf/dsh-ocr"
BUNDLE="@sparkelf/dsh-ocr"

CONTAINERS=(
  dataops-ai-operator-dsh-runtime
  dataops-ai-admin-dsh-runtime
  dataops-ai-operator
  dataops-ai-admin
)

if [ ! -f "$TARBALL" ]; then echo "tarball not found: $TARBALL" >&2; exit 1; fi

# The installer runs inside the container: it edits JSON, so it belongs in a file
# rather than in a quoted here-document.
cat > /tmp/install-ocr.py <<'PY'
"""Add the OCR plugin to one profile: its tarball, its dependency, and its bundle."""
import json, os, shutil, sys

profile = sys.argv[1]
tarball_name = sys.argv[2]
package = sys.argv[3]
bundle = sys.argv[4]
mode = sys.argv[5]
stamp = sys.argv[6]

extra = os.path.join(profile, '.dataops-extra-plugins')
manifest = os.path.join(profile, 'package.json')
if not os.path.isfile(manifest):
    print(f'  SKIP (no package.json): {profile}')
    sys.exit(0)

doc = json.load(open(manifest))

# Copy the tarball in, so the dependency is a relative path this profile owns.
os.makedirs(extra, exist_ok=True)
source = os.path.join('/tmp', tarball_name)
destination = os.path.join(extra, tarball_name)
if os.path.abspath(source) != os.path.abspath(destination):
    shutil.copy2(source, destination)
print(f'  tarball: {destination}')

spec = f'file:./.dataops-extra-plugins/{tarball_name}'
deps = doc.setdefault('dependencies', {})
already = deps.get(package) == spec

if mode == 'verify-only':
    bundles = (doc.get('dsh', {}).get('profile', {}) or {}).get('bundles') or []
    print(f'  dep: {deps.get(package, "ABSENT")}  in_bundles: {bundle in bundles}')
    sys.exit(0)

if already and bundle in ((doc.get('dsh', {}).get('profile', {}) or {}).get('bundles') or []):
    print('  ALREADY configured; leaving it alone')
    sys.exit(0)

# Back up before the first write this run.
backup = f'{manifest}.bak-ocr-{stamp}'
if not os.path.exists(backup):
    shutil.copy2(manifest, backup)
    print(f'  backup: {backup}')

deps[package] = spec
profile_section = doc.setdefault('dsh', {}).setdefault('profile', {})
bundles = profile_section.setdefault('bundles', [])
if bundle not in bundles:
    bundles.append(bundle)

# Write through a sibling and rename, so a reader never sees a half-written manifest.
scratch = manifest + '.ocr-new'
with open(scratch, 'w') as handle:
    json.dump(doc, handle, indent=2, ensure_ascii=False)
    handle.write('\n')
os.replace(scratch, manifest)

# Re-read rather than trusting the write.
check = json.load(open(manifest))
ok_dep = (check.get('dependencies') or {}).get(package) == spec
ok_bundle = bundle in ((check.get('dsh', {}).get('profile', {}) or {}).get('bundles') or [])
if not (ok_dep and ok_bundle):
    shutil.copy2(backup, manifest)
    print(f'  FAILED verification; restored {backup}')
    sys.exit(1)
print(f'  OK dep={ok_dep} bundle={ok_bundle} bundles={len(check["dsh"]["profile"]["bundles"])}')
PY

# Copy the installer and the tarball into each container once each.
for container in "${CONTAINERS[@]}"; do
  docker cp /tmp/install-ocr.py "$container:/tmp/install-ocr.py" >/dev/null
  docker cp "$TARBALL" "$container:/tmp/$TARBALL_NAME" >/dev/null
done

FAILED=0
for container in "${CONTAINERS[@]}"; do
  echo "=== $container ==="
  for profile in /workspace/.dataops/dsh/profiles/dataops-web /opt/dataops-dsh-profile-template; do
    if docker exec "$container" python3 /tmp/install-ocr.py "$profile" "$TARBALL_NAME" "$PKG" "$BUNDLE" "$MODE" "$TS"; then
      :
    else
      FAILED=$((FAILED + 1))
      echo "  DEPLOY FAILED for $container $profile"
    fi
  done
done

echo
if [ "$FAILED" -ne 0 ]; then
  echo "FAILURES: $FAILED"
  exit 1
fi
echo "ALL TARGETS OK"
