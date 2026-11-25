#!/usr/bin/env bash
# Put the OCR plugin's code where DSH resolves profile bundles from.
#
# The profile's node_modules is populated at IMAGE BUILD time: the container has no pnpm,
# so editing package.json alone leaves a dependency that resolves to nothing and DSH
# refuses the bundle with "cannot resolve profile bundle". This extracts the packed payload
# into node_modules/@sparkelf/dsh-ocr, which is the same shape the existing tarball
# dependencies have (a real directory, no .pnpm entry).
#
# Usage: install-ocr-payload.sh <tarball-in-container> [--verify-only]
set -uo pipefail

TARBALL="${1:?usage: install-ocr-payload.sh <tarball> [--verify-only]}"
MODE="${2:-install}"
DEST_NAME="dsh-ocr"

CONTAINERS=(
  dataops-ai-operator-dsh-runtime
  dataops-ai-admin-dsh-runtime
  dataops-ai-operator
  dataops-ai-admin
)

cat > /tmp/extract-ocr.py <<'PY'
"""Extract the packed OCR payload into one profile's node_modules."""
import json, os, shutil, sys, tarfile

profile = sys.argv[1]
tarball = sys.argv[2]
dest_name = sys.argv[3]
mode = sys.argv[4]

dest = os.path.join(profile, 'node_modules', '@sparkelf', dest_name)

if mode == 'verify-only':
    manifest = os.path.join(dest, 'package.json')
    if os.path.isfile(manifest):
        doc = json.load(open(manifest))
        print(f'  payload present: {doc.get("name")}@{doc.get("version")}')
    else:
        print(f'  payload ABSENT: {dest}')
    sys.exit(0)

if not os.path.isfile(tarball):
    print(f'  tarball missing: {tarball}')
    sys.exit(1)

# Replace whatever is there: a partial previous extraction must not survive.
if os.path.isdir(dest):
    shutil.rmtree(dest)
os.makedirs(dest, exist_ok=True)

with tarfile.open(tarball, 'r:gz') as archive:
    # `package/` is the tarball's single top-level directory; strip it.
    for member in archive.getmembers():
        parts = member.name.split('/', 1)
        if len(parts) < 2 or parts[1] == '':
            continue
        member.name = parts[1]
        archive.extract(member, dest, filter='data')

manifest = os.path.join(dest, 'package.json')
if not os.path.isfile(manifest):
    print(f'  FAILED: no package.json after extraction ({dest})')
    sys.exit(1)
doc = json.load(open(manifest))
print(f'  installed: {doc.get("name")}@{doc.get("version")} -> {dest}')
PY

FAILED=0
for container in "${CONTAINERS[@]}"; do
  echo "=== $container ==="
  docker cp /tmp/extract-ocr.py "$container:/tmp/extract-ocr.py" >/dev/null
  docker cp "$TARBALL" "$container:/tmp/$(basename "$TARBALL")" >/dev/null
  for profile in /workspace/.dataops/dsh/profiles/dataops-web /opt/dataops-dsh-profile-template; do
    if ! docker exec "$container" python3 /tmp/extract-ocr.py "$profile" "/tmp/$(basename "$TARBALL")" "$DEST_NAME" "$MODE"; then
      FAILED=$((FAILED + 1))
      echo "  PAYLOAD FAILED for $container $profile"
    fi
  done
done

echo
[ "$FAILED" -eq 0 ] && echo "ALL PAYLOADS OK" || { echo "FAILURES: $FAILED"; exit 1; }
