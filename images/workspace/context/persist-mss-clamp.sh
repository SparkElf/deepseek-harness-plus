#!/bin/sh
#
# Persist the two link facts this deployment needs, because neither survives a container rebuild
# and only one of them can be expressed inside the image.
#
# 1. The FORWARD MSS clamp. The uplink is a 1492-byte PPPoE link (`eth4` on this host) while every
#    Docker bridge is 1500. A container that opens a websocket therefore advertises an MSS the
#    path cannot carry, and the oversized TLS records are dropped without an ICMP that the peer
#    acts on: DSH renders, opens `/api/remote.mux`, and then nothing moves. `--clamp-mss-to-pmtu`
#    rewrites the SYN's MSS to the path MTU, which is the half of the fix the host owns.
#
# 2. The workspace link MTU (1492). A container cannot change its own MTU: the entrypoint holds no
#    CAP_NET_ADMIN (`CapEff: 0`), so `ip link set` there fails by design and only reports. This
#    script sets it from the host through the container's network namespace, and does it again
#    whenever a workspace container is recreated -- `--install` writes the systemd unit that runs
#    the clamp at boot, so the rule is back before any workspace starts.
#
# Usage:
#   ./persist-mss-clamp.sh --install              # install + enable the unit, apply the rule now
#   ./persist-mss-clamp.sh --status               # report rule, unit state, container MTUs
#   ./persist-mss-clamp.sh --set-mtu <container>  # set eth0 MTU 1492 in one running container
#
# The MTU itself still has to be re-applied after a workspace container is recreated, because
# `docker create` takes no MTU argument: `POST /api/ai/workspace/restart` recreates the container
# on the 1500-byte default bridge. Either run `--set-mtu dataops-ai-admin` right after that (the
# workspace container owns the link namespace), or add `"mtu": 1492` to
# /etc/docker/daemon.json once so every future container starts at the right link size.
#
# Verified 2026-10-25 on this host: the rule is present in `iptables -t mangle -S`, the unit is
# enabled, and flushing the chain then restarting the unit restores the rule (see
# V8-FINAL-EVIDENCE.md §3).
set -eu

RULE_CHAIN=FORWARD
UNIT_NAME=dataops-mss-clamp.service
UNIT_PATH="/etc/systemd/system/$UNIT_NAME"
INSTALLED_PATH=/usr/local/sbin/dataops-mss-clamp
SELF_PATH="$(readlink -f "$0")"
EXPECTED_MTU=1492

apply_rule() {
  # Idempotent: `-C` first, because a second `-A` would add a duplicate rule on every boot.
  if iptables -t mangle -C "$RULE_CHAIN" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null; then
    echo "mangle $RULE_CHAIN TCPMSS clamp already present"
  else
    iptables -t mangle -A "$RULE_CHAIN" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
    echo "mangle $RULE_CHAIN TCPMSS clamp added"
  fi
}

set_container_mtu() {
  container="$1"
  pid="$(docker inspect -f '{{.State.Pid}}' "$container" 2>/dev/null || true)"
  if [ -z "$pid" ] || [ "$pid" = "0" ]; then
    echo "set-mtu: $container is not running" >&2
    return 1
  fi
  # nsenter reaches the container namespace with the host's privileges, which is the only way to
  # change a link the container itself is not allowed to touch.
  nsenter -t "$pid" -n ip link set dev eth0 mtu "$EXPECTED_MTU"
  # Read the value back through `docker exec`: /sys comes from the host mount, so a `cat` inside
  # `nsenter -n` resolves the host's eth0 (1500) rather than the container's. Measured before this
  # correction: the set succeeded while the readback reported the unchanged host value.
  echo "set-mtu: $container eth0 -> $(docker exec "$container" cat /sys/class/net/eth0/mtu)"
}

install_unit() {
  # The unit must not depend on a checkout: /root/projects can move, and a boot-time unit that
  # names a missing path fails only at the next boot, which is the one time nobody is watching.
  install -D -m 0755 "$SELF_PATH" "$INSTALLED_PATH"
  cat >"$UNIT_PATH" <<EOF
[Unit]
Description=DataOps workspace link fix: FORWARD MSS clamp for the 1492-byte uplink
Documentation=file://$INSTALLED_PATH
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$INSTALLED_PATH --apply

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$UNIT_PATH"
  systemctl daemon-reload
  systemctl enable "$UNIT_NAME" >/dev/null
  systemctl restart "$UNIT_NAME"
  echo "installed $INSTALLED_PATH, $UNIT_PATH and enabled $UNIT_NAME"
}

status() {
  echo "== rule =="
  if iptables -t mangle -C "$RULE_CHAIN" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null; then
    iptables -t mangle -S "$RULE_CHAIN" | grep TCPMSS
  else
    echo "MISSING: no TCPMSS clamp in mangle $RULE_CHAIN"
  fi
  echo "== unit =="
  systemctl is-enabled "$UNIT_NAME" 2>/dev/null || echo "not installed"
  systemctl is-active "$UNIT_NAME" 2>/dev/null || true
  echo "== container MTUs =="
  for c in $(docker ps --format '{{.Names}}' | grep '^dataops-ai-' | sort); do
    printf '  %-38s %s\n' "$c" "$(docker exec "$c" cat /sys/class/net/eth0/mtu 2>/dev/null || echo unknown)"
  done
}

case "${1:-}" in
  --apply) apply_rule ;;
  --install) apply_rule; install_unit ;;
  --set-mtu) set_container_mtu "${2:?--set-mtu needs a container name}" ;;
  --status) status ;;
  *)
    echo "usage: $0 --install | --status | --set-mtu <container>" >&2
    exit 2
    ;;
esac
