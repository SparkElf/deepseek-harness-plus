#!/bin/bash
# Deploy the patched ui-schedule client into both profile trees, then restart DSH.
# Caller must hold /tmp/dsh-deploy.lock.
set -u
C=dataops-ai-admin-dsh-runtime
SRC=/tmp/ui-schedule-patched
PKG=node_modules/@deepseek-ai/dsh-client-ui-schedule

for P in /workspace/.dataops/dsh/profiles/dataops-web /opt/dsh-home/profiles/dataops-web; do
  echo "== $P =="
  docker exec "$C" sh -c "test -d $P/$PKG/lib && cp -n $P/$PKG/lib/client.js $P/$PKG/lib/client.js.plaza-bak && cp -n $P/$PKG/lib/client.js.map $P/$PKG/lib/client.js.map.plaza-bak; echo backup-ok"
  docker cp "$SRC/client.js" "$C:$P/$PKG/lib/client.js"
  docker cp "$SRC/client.js.map" "$C:$P/$PKG/lib/client.js.map"
  docker cp "$SRC/index.js" "$C:$P/$PKG/lib/index.js"
  docker exec "$C" sh -c "rm -rf $P/$PKG/lib/types && mkdir -p $P/$PKG/lib/types"
  docker cp "$SRC/types/." "$C:$P/$PKG/lib/types/"
  docker exec "$C" sh -c "grep -c 'task-manager-plaza' $P/$PKG/lib/client.js"
done

echo "== restart =="
docker exec "$C" sh -c 'dataops-dsh-service stop; sleep 2; dataops-dsh-service start' || exit 1

echo "== poll ready =="
for i in $(seq 1 90); do
  S=$(docker exec "$C" sh -c 'dataops-dsh-service status' 2>/dev/null || true)
  case "$S" in
    *'"ready":true'*) echo "READY after ${i}s: $S"; exit 0 ;;
  esac
  sleep 1
done
echo "NOT READY: $S"
docker exec "$C" sh -c 'tail -40 /workspace/.dataops/dsh/logs/web.log'
exit 1