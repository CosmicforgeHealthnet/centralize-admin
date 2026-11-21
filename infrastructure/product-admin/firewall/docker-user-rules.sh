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
#      container PostgreSQL (5432), Karryam Bridge (8110) or CF Meet Bridge
#      (8460) port, whatever the subnet. 8460 is served on CF Meet's own host;
#      the HQ staging host must never publish it either.
#   3. CF Meet Admin Bridge egress allowlist. cf-staging-cfmeet-bridge is the
#      only NON-internal Product Admin network: the CF Meet Admin Bridge runs
#      on CF Meet's host and is reached over an operator-managed private
#      tunnel at PA_CM_BRIDGE_ADDRESS:PA_CM_BRIDGE_PORT (default 8460).
#      From that subnet exactly one destination is allowed (NEW and
#      ESTABLISHED tcp to address:port, and its replies); every other egress
#      is dropped (internet, DNS, the host itself via INPUT, other cf-staging
#      subnets, other ports on the bridge host). Nothing else on the host may
#      open a connection to the bridge address through Docker. Without
#      PA_CM_BRIDGE_ADDRESS the subnet gets the drop rules only (no egress).
#
# Karryam rules (1 and 2) are unchanged by rule 3. Rules are tagged (comment
# cf-product-admin) and idempotent; `verify` checks the exact rule set (every
# expected rule present and no other tagged rule in DOCKER-USER or INPUT).
#
# Usage (root, through product-admin-staging-ops prepare-host / preflight):
#   docker-user-rules.sh print|apply|verify|remove|validate
# `validate` only checks the inputs (no root, no iptables).
# Environment: PA_EXTERNAL_INTERFACE (default: interface of the default
# route), PA_SUBNET_HQ, PA_SUBNET_ADMIN, PA_SUBNET_BRIDGE, PA_SUBNET_KADB,
# PA_SUBNET_CMBRIDGE, PA_SUBNET_CMDB
# (defaults from infrastructure/product-admin/staging/network-policy.json),
# PA_CM_BRIDGE_ADDRESS (RFC 1918 IPv4 tunnel address of the CF Meet host,
# e.g. 10.250.0.1; never 100.64/10, never inside a cf-staging subnet),
# PA_CM_BRIDGE_PORT (default 8460).
set -euo pipefail

MODE="${1:-print}"
TAG="cf-product-admin"
PA_SUBNET_HQ="${PA_SUBNET_HQ:-10.231.10.0/28}"
PA_SUBNET_ADMIN="${PA_SUBNET_ADMIN:-10.231.11.0/28}"
PA_SUBNET_BRIDGE="${PA_SUBNET_BRIDGE:-10.231.12.0/28}"
PA_SUBNET_KADB="${PA_SUBNET_KADB:-10.231.13.0/28}"
PA_SUBNET_CMBRIDGE="${PA_SUBNET_CMBRIDGE:-10.231.14.0/28}"
PA_SUBNET_CMDB="${PA_SUBNET_CMDB:-10.231.15.0/28}"
PA_CM_BRIDGE_ADDRESS="${PA_CM_BRIDGE_ADDRESS:-}"
PA_CM_BRIDGE_PORT="${PA_CM_BRIDGE_PORT:-8460}"
SUBNETS=("$PA_SUBNET_HQ" "$PA_SUBNET_ADMIN" "$PA_SUBNET_BRIDGE" "$PA_SUBNET_KADB" "$PA_SUBNET_CMBRIDGE" "$PA_SUBNET_CMDB")
PORTS=(5432 8110 8460)

ip2int() { local a b c d; IFS=. read -r a b c d <<< "$1"; echo $(( (a << 24) | (b << 16) | (c << 8) | d )); }
in_cidr() { # ip cidr
  local net="${2%/*}" bits="${2#*/}" mask
  mask=$(( bits == 0 ? 0 : (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF ))
  (( ($(ip2int "$1") & mask) == ($(ip2int "$net") & mask) ))
}

# Inputs are validated before anything else (also the only work of `validate`).
for s in "${SUBNETS[@]}"; do [[ "$s" =~ ^10\.[0-9]{1,3}\.[0-9]{1,3}\.0/2[4-8]$ ]] || { echo "BLOCKED: invalid private subnet $s"; exit 1; }; done
[[ "$PA_CM_BRIDGE_PORT" =~ ^[0-9]{1,5}$ ]] && (( PA_CM_BRIDGE_PORT >= 1 && PA_CM_BRIDGE_PORT <= 65535 )) || { echo "BLOCKED: PA_CM_BRIDGE_PORT must be a TCP port (default 8460)."; exit 1; }
if [[ -n "$PA_CM_BRIDGE_ADDRESS" ]]; then
  [[ "$PA_CM_BRIDGE_ADDRESS" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || { echo "BLOCKED: PA_CM_BRIDGE_ADDRESS must be a single IPv4 address (no name, no range)."; exit 1; }
  for o in "${BASH_REMATCH[@]:1}"; do (( 10#$o <= 255 )) || { echo "BLOCKED: PA_CM_BRIDGE_ADDRESS has an invalid octet."; exit 1; }; done
  # RFC 1918 only: CGNAT 100.64/10, loopback, link-local and public space are refused (cfmeet-admin refuses them too).
  in_cidr "$PA_CM_BRIDGE_ADDRESS" 10.0.0.0/8 || in_cidr "$PA_CM_BRIDGE_ADDRESS" 172.16.0.0/12 || in_cidr "$PA_CM_BRIDGE_ADDRESS" 192.168.0.0/16 \
    || { echo "BLOCKED: PA_CM_BRIDGE_ADDRESS must be RFC 1918 (10/8, 172.16/12, 192.168/16); 100.64/10 and public addresses are refused."; exit 1; }
  for s in "${SUBNETS[@]}"; do ! in_cidr "$PA_CM_BRIDGE_ADDRESS" "$s" || { echo "BLOCKED: PA_CM_BRIDGE_ADDRESS lies inside the Product Admin subnet $s; it must be the tunnel address of the CF Meet host."; exit 1; }; done
fi
if [[ "$MODE" == validate ]]; then
  echo "VALID: subnets; CF Meet Bridge ${PA_CM_BRIDGE_ADDRESS:-<not set: egress closed>}:$PA_CM_BRIDGE_PORT"
  exit 0
fi

ext_if() {
  if [[ -n "${PA_EXTERNAL_INTERFACE:-}" ]]; then printf '%s' "$PA_EXTERNAL_INTERFACE"; return; fi
  ip route show default 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit }}'
}

EXT_IF="$(ext_if)"
[[ -n "$EXT_IF" ]] || { echo "BLOCKED: cannot determine the external interface (set PA_EXTERNAL_INTERFACE)."; exit 1; }
[[ "$EXT_IF" =~ ^[A-Za-z0-9._-]{1,15}$ ]] || { echo "BLOCKED: invalid interface name."; exit 1; }

# One rule per line: "<CHAIN> <iptables match/target>", in final chain order.
cm_rules() {
  if [[ -n "$PA_CM_BRIDGE_ADDRESS" ]]; then
    # The single allowed destination (RETURN hands the packet on to Docker's own chains).
    echo "DOCKER-USER -s $PA_SUBNET_CMBRIDGE -d $PA_CM_BRIDGE_ADDRESS/32 -p tcp --dport $PA_CM_BRIDGE_PORT -m conntrack --ctstate NEW,ESTABLISHED -m comment --comment $TAG -j RETURN"
    echo "DOCKER-USER -s $PA_CM_BRIDGE_ADDRESS/32 -d $PA_SUBNET_CMBRIDGE -p tcp --sport $PA_CM_BRIDGE_PORT -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment $TAG -j RETURN"
    # Nothing else (other containers, other ports) may open a connection to the bridge address.
    echo "DOCKER-USER -d $PA_CM_BRIDGE_ADDRESS/32 -m conntrack --ctstate NEW -m comment --comment $TAG -j DROP"
  fi
  # Every other egress from, and ingress to, the CF Meet Bridge subnet; and the host itself.
  echo "DOCKER-USER -s $PA_SUBNET_CMBRIDGE -m comment --comment $TAG -j DROP"
  echo "DOCKER-USER -d $PA_SUBNET_CMBRIDGE -m comment --comment $TAG -j DROP"
  echo "INPUT -s $PA_SUBNET_CMBRIDGE -m comment --comment $TAG -j DROP"
}

rules() {
  cm_rules
  for s in "${SUBNETS[@]}"; do
    echo "DOCKER-USER -i $EXT_IF -d $s -m conntrack --ctstate NEW -m comment --comment $TAG -j DROP"
  done
  for p in "${PORTS[@]}"; do
    echo "DOCKER-USER -i $EXT_IF -p tcp -m conntrack --ctstate NEW --ctorigdstport $p -m comment --comment $TAG -j DROP"
  done
}

need_chain() {
  iptables -n -L DOCKER-USER >/dev/null 2>&1 || { echo "BLOCKED: DOCKER-USER chain missing (is Docker running with iptables enabled?)."; exit 1; }
}

# Tagged rules currently in a chain (exact tag, not the transient guard).
tagged() { iptables -S "$1" 2>/dev/null | grep -Ec -- "--comment \"?$TAG\"?( |$)" || true; }
expected_count() { rules | grep -c "^$1 " || true; }

# Exact-set check: every expected rule present and no other tagged rule.
exact() {
  local line chain ok=0
  while IFS= read -r line; do
    chain="${line%% *}"; read -r -a r <<< "${line#* }"
    if iptables -C "$chain" "${r[@]}" 2>/dev/null; then echo "OK      $line"; else echo "MISSING $line"; ok=1; fi
  done < <(rules)
  for chain in DOCKER-USER INPUT; do
    local have want; have="$(tagged "$chain")"; want="$(expected_count "$chain")"
    [[ "$have" == "$want" ]] || { echo "UNEXPECTED $chain has $have tagged rules, expected exactly $want"; ok=1; }
  done
  return "$ok"
}

delete_tagged() { # chain: remove every rule carrying the exact tag
  local chain="$1" spec
  while IFS= read -r spec; do
    # iptables -S prints a valid rule spec; the tag contains no spaces, so plain word splitting is exact.
    read -r -a r <<< "${spec#-A "$chain" }"
    iptables -D "$chain" "${r[@]}" 2>/dev/null || true
  done < <(iptables -S "$chain" | grep -E -- "--comment \"?$TAG\"?( |$)")
}

case "$MODE" in
  print)
    echo "# DOCKER-USER/INPUT rules for external interface $EXT_IF; CF Meet Bridge ${PA_CM_BRIDGE_ADDRESS:-<not set: egress closed>}:$PA_CM_BRIDGE_PORT"
    rules | sed 's/^\([A-Z-]*\) /iptables -I \1 /'
    ;;
  apply)
    need_chain
    # The port rules would also cut any EXISTING container that publishes
    # 5432/8110/8460 to the internet on purpose. Never do that silently: list
    # them and stop unless the operator accepted the impact.
    if command -v docker >/dev/null 2>&1; then
      portre="$(IFS='|'; echo "${PORTS[*]}")"
      exposed="$(docker ps --format '{{.Names}} {{.Ports}}' | grep -E "(0\.0\.0\.0|\[?::\]?):[0-9]+->($portre)/tcp" || true)"
      if [[ -n "$exposed" && "${PA_FIREWALL_ACCEPT_PORT_IMPACT:-0}" != 1 ]]; then
        echo "BLOCKED: these containers publish ${PORTS[*]} on a public address; the port rules would cut them:"
        printf '  %s\n' "$exposed"
        echo "Decide per container (bind to 127.0.0.1 or accept with PA_FIREWALL_ACCEPT_PORT_IMPACT=1). Nothing changed."
        exit 1
      fi
    fi
    if exact >/dev/null 2>&1; then
      echo "present: exact rule set already in place"
    else
      # Rebuild the tagged set. A transient guard keeps the CF Meet Bridge
      # subnet closed (fail-closed) while stale rules (for example an old
      # bridge address) are removed and the expected set is inserted.
      guard=(-s "$PA_SUBNET_CMBRIDGE" -m comment --comment "$TAG-guard" -j DROP)
      iptables -I DOCKER-USER 1 "${guard[@]}"; iptables -I INPUT 1 "${guard[@]}"
      delete_tagged DOCKER-USER; delete_tagged INPUT
      # Insert in reverse so the final order matches `rules` (above the guard).
      mapfile -t wanted < <(rules)
      for (( i = ${#wanted[@]} - 1; i >= 0; i-- )); do
        chain="${wanted[$i]%% *}"; read -r -a r <<< "${wanted[$i]#* }"
        iptables -I "$chain" 1 "${r[@]}"; echo "added:   ${wanted[$i]}"
      done
      while iptables -C DOCKER-USER "${guard[@]}" 2>/dev/null; do iptables -D DOCKER-USER "${guard[@]}"; done
      while iptables -C INPUT "${guard[@]}" 2>/dev/null; do iptables -D INPUT "${guard[@]}"; done
    fi
    bash "${BASH_SOURCE[0]}" verify
    ;;
  verify)
    need_chain
    missing=0
    exact || missing=1
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
    delete_tagged DOCKER-USER; delete_tagged INPUT
    echo "removed: every $TAG rule from DOCKER-USER and INPUT"
    ;;
  *) echo "usage: $0 print|apply|verify|remove|validate"; exit 2 ;;
esac
