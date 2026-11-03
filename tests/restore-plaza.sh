#!/bin/bash
# Restore the container's ui-schedule package to its pre-test state.
set -u
C=dataops-ai-admin-dsh-runtime
PKG=node_modules/@deepseek-ai/dsh-client-ui-schedule
STOCK_TYPES=/root/projects/deepseek-harness-022/packages/client/ui-schedule/lib/types

for P in /workspace/.dataops/dsh/profiles/dataops-web /opt/dsh-home/profiles/dataops-web; do
  echo "== $P =="
  docker exec "$C" sh -c "L=$P/$PKG/lib; cp \$L/client.js.plaza-bak \$L/client.js && cp \$L/client.js.map.plaza-bak \$L/client.js.map && rm -f \$L/client.js.plaza-bak \$L/client.js.map.plaza-bak && md5sum \$L/client.js"
  docker exec "$C" sh -c "rm -rf $P/$PKG/lib/types && mkdir -p $P/$PKG/lib/types"
  docker cp "$STOCK_TYPES/." "$C:$P/$PKG/lib/types/"
done

echo "== restart =="
docker exec "$C" sh -c 'dataops-dsh-service stop; sleep 2; dataops-dsh-service start' || exit 1
for i in $(seq 1 90); do
  S=$(docker exec "$C" sh -c 'dataops-dsh-service status' 2>/dev/null || true)
  case "$S" in
    *'"ready":true'*) echo "READY: $S"; break ;;
  esac
  sleep 1
done
echo "== verify stock served =="
docker exec "$C" sh -c 'curl -s http://127.0.0.1:3080/ -o /tmp/i.html; R=$(grep -o "\"id\":\"@deepseek-ai/dsh-client-ui-schedule\",\"url\":\"[^\"]*\"" /tmp/i.html | head -1); echo "$R"; REV=$(echo "$R" | grep -o "rev=[a-f0-9]*" | cut -d= -f2); curl -s --path-as-is "http://127.0.0.1:3080/plugins/??@deepseek-ai/dsh-client-ui-schedule/client.js&rev=$REV" -o /tmp/s.js; wc -c /tmp/s.js; grep -c "task-manager-plaza" /tmp/s.js || echo NO-PLAZA-MARKER'