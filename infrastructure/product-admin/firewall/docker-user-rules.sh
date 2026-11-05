#!/usr/bin/env bash
# Product Admin host firewall rules (Section 12.1.5).
#
# Docker publishes container ports by writing its own NAT/FORWARD rules, which
# are evaluated BEFORE UFW's INPUT rules: a UFW "deny 5432" does not stop a
# published container port. Docker's supported hook for host policy is the
# DOCKER-USER chain (evaluated first in FORWARD for container traffic), so the
# Product Admin boundary is enforced there:
#
#   1. Nothing arriving on the external interface may open a connection to a
#      Product Admin private subnet (even if a port were published by mistake).
#   2. Nothing arriving on the external interface may open a connection to a
#      container PostgreSQL (5432) or Bridge (8110) port, whatever the subnet.
#
# Only NEW connections are dropped, so replies to outbound traffic are
# unaffected. Rules are tagged (comment cf-product-admin) and idempotent.
#
# Usage (root, through product-admin-staging-ops prepare-host / preflight):
#   docker-user-rules.sh print|apply|verify|remove
# Environment: PA_EXTERNAL_INTERFACE (default: interface of the default
# route), PA_SUBNET_HQ, PA_SUBNET_ADMIN, PA_SUBNET_BRIDGE, PA_SUBNET_KADB
# (defaults from infrastructure/product-admin/staging/network-policy.json).
set -euo pipefail

MODE="${1:-print}"
TAG="cf-product-admin"
PA_SUBNET_HQ="${PA_SUBNET_HQ:-10.231.10.0/28}"
PA_SUBNET_ADMIN="${PA_SUBNET_ADMIN:-10.231.11.0/28}"
PA_SUBNET_BRIDGE="${PA_SUBNET_BRIDGE:-10.231.12.0/28}"
PA_SUBNET_KADB="${PA_SUBNET_KADB:-10.231.13.0/28}"
SUBNETS=("$PA_SUBNET_HQ" "$PA_SUBNET_ADMIN" "$PA_SUBNET_BRIDGE" "$PA_SUBNET_KADB")
PORTS=(5432 8110)

ext_if() {
  if [[ -n "${PA_EXTERNAL_INTERFACE:-}" ]]; then printf '%s' "$PA_EXTERNAL_INTERFACE"; return; fi
  ip route show default 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit }}'
}

EXT_IF="$(ext_if)"
[[ -n "$EXT_IF" ]] || { echo "BLOCKED: cannot determine the external interface (set PA_EXTERNAL_INTERFACE)."; exit 1; }
[[ "$EXT_IF" =~ ^[A-Za-z0-9._-]{1,15}$ ]] || { echo "BLOCKED: invalid interface name."; exit 1; }
for s in "${SUBNETS[@]}"; do [[ "$s" =~ ^10\.[0-9]{1,3}\.[0-9]{1,3}\.0/2[4-8]$ ]] || { echo "BLOCKED: invalid private subnet $s"; exit 1; }; done

rules() {
  for s in "${SUBNETS[@]}"; do
    echo "-i $EXT_IF -d $s -m conntrack --ctstate NEW -m comment --comment $TAG -j DROP"
  done
  for p in "${PORTS[@]}"; do
    echo "-i $EXT_IF -p tcp -m conntrack --ctstate NEW --ctorigdstport $p -m comment --comment $TAG -j DROP"
  done
}

need_chain() {
  iptables -n -L DOCKER-USER >/dev/null 2>&1 || { echo "BLOCKED: DOCKER-USER chain missing (is Docker running with iptables enabled?)."; exit 1; }
}

case "$MODE" in
  print)
    echo "# DOCKER-USER rules for external interface $EXT_IF"
    rules | sed 's/^/iptables -I DOCKER-USER /'
    ;;
  apply)
    need_chain
    # The port rules would also cut any EXISTING container that publishes
    # 5432/8110 to the internet on purpose. Never do that silently: list them
    # and stop unless the operator accepted the impact.
    if command -v docker >/dev/null 2>&1; then
      exposed="$(docker ps --format '{{.Names}} {{.Ports}}' | grep -E '(0\.0\.0\.0|\[?::\]?):[0-9]+->(5432|8110)/tcp' || true)"
      if [[ -n "$exposed" && "${PA_FIREWALL_ACCEPT_PORT_IMPACT:-0}" != 1 ]]; then
        echo "BLOCKED: these containers publish 5432/8110 on a public address; the port rules would cut them:"
        printf '  %s\n' "$exposed"
        echo "Decide per container (bind to 127.0.0.1 or accept with PA_FIREWALL_ACCEPT_PORT_IMPACT=1). Nothing changed."
        exit 1
      fi
    fi
    # Insert in reverse so the final order matches `rules`; skip existing ones.
    mapfile -t wanted < <(rules)
    for (( i = ${#wanted[@]} - 1; i >= 0; i-- )); do
      read -r -a r <<< "${wanted[$i]}"
      if iptables -C DOCKER-USER "${r[@]}" 2>/dev/null; then echo "present: ${wanted[$i]}"; else iptables -I DOCKER-USER 1 "${r[@]}"; echo "added:   ${wanted[$i]}"; fi
    done
    bash "${BASH_SOURCE[0]}" verify
    ;;
  verify)
    need_chain
    missing=0
    while IFS= read -r line; do
      read -r -a r <<< "$line"
      if iptables -C DOCKER-USER "${r[@]}" 2>/dev/null; then echo "OK      $line"; else echo "MISSING $line"; missing=1; fi
    done < <(rules)
    # A wildcard listener on the host for these ports means something is
    # published outside Docker's chains (or with network_mode: host).
    if command -v ss >/dev/null 2>&1; then
      for p in "${PORTS[@]}"; do
        if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "^(0\.0\.0\.0|\*|\[::\]):$p$"; then echo "EXPOSED wildcard host listener on port $p"; missing=1; fi
      done
    fi
    if (( missing )); then echo "FIREWALL_VERIFY=FAIL"; exit 1; fi
    echo "FIREWALL_VERIFY=PASS"
    ;;
  remove)
    need_chain
    while IFS= read -r line; do
      read -r -a r <<< "$line"
      while iptables -C DOCKER-USER "${r[@]}" 2>/dev/null; do iptables -D DOCKER-USER "${r[@]}"; echo "removed: $line"; done
    done < <(rules)
    ;;
  *) echo "usage: $0 print|apply|verify|remove"; exit 2 ;;
esac
