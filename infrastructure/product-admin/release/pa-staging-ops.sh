#!/usr/bin/env bash
# Product Admin staging host operations (Sections 12.1-12.5, stages S1-S2).
#
# Runs ON the staging VPS, uploaded and started only by
# .github/workflows/product-admin-staging-ops.yml (pinned host key, verified
# bundle checksum). Never run by a coding agent over SSH. In CI the same
# script runs on the GitHub runner with PA_REHEARSAL=1 against disposable
# containers, so every operation is exercised before it reaches the VPS.
#
# Read-only:  preflight | network-probe | db-audit | status | migrate-preview
# Mutating:   prepare-host | backup | migrate-apply | deploy | rollback | disable | attach-gateway
#             (the workflow requires confirm=APPLY_STAGING_PRODUCT_ADMIN_CHANGES)
#
# Every verification prints one line per check:
#   PA_CHECK {"id":"...","status":"PASS|FAIL|PENDING_EXTERNAL|NOT_RUN","detail":"..."}
# which the workflow turns into stage evidence (release-state.mjs). Values of
# secrets, connection strings and keys are never printed.
#
# Never touches: production (/var/www/admin-server, admin-server-db-1),
# the Central Admin API image, Mail, or any source-owned Karryam or CF Meet
# service.
#
# CF Meet Admin (uid 10003) is OPTIONAL. deploy decides once: CF Meet Admin
# joins the release iff PA_CM_IMAGE is a cfmeet-admin digest AND
# $PA_CONFIG_ROOT/cfmeet-admin.env exists (PA_CM_IMAGE with missing CF Meet
# files is refused). The decision is recorded in the release's images.env
# (CFMEET_ADMIN_IMAGE present or absent); every later operation derives it
# from there. Without CF Meet Admin the release is PIC + Karryam Admin exactly
# as before, and checks that need CF Meet running report SKIPPED_NOT_DEPLOYED.
#
# The CF Meet Admin Bridge runs on CF Meet's OWN host. HQ reaches it over an
# operator-managed private tunnel (WireGuard or equivalent; privileged S1/S2
# step) at PA_CM_BRIDGE_ADDRESS (RFC 1918, e.g. 10.250.0.1; never 100.64/10)
# port PA_CM_BRIDGE_PORT (default 8460). cf-staging-cfmeet-bridge is the only
# non-internal network; the DOCKER-USER egress allowlist (firewall script)
# permits exactly that address:port from it. A release with CF Meet Admin
# records both values in images.env.
set -euo pipefail
umask 077

OP="${1:-}"
shift || true

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE="$(cd "$HERE/../../.." && pwd)"
POLICY="$BUNDLE/infrastructure/product-admin/staging/network-policy.json"
COMPOSE="$BUNDLE/infrastructure/product-admin/staging/docker-compose.yml"
FIREWALL="$BUNDLE/infrastructure/product-admin/firewall/docker-user-rules.sh"
INFRA_CHECK="infrastructure/scripts/product-admin-infra-check.mjs"

PA_REHEARSAL="${PA_REHEARSAL:-0}"
PA_HOST_ROOT="${PA_HOST_ROOT:-/srv/cosmicforge/staging}"
PA_CONFIG_ROOT="${PA_CONFIG_ROOT:-/etc/cosmicforge/staging}"
PA_HQ_DB_CONTAINER="${PA_HQ_DB_CONTAINER:-admin-server-staging-db-1}"
PA_HQ_DB_NAME="${PA_HQ_DB_NAME:-cosmicforge_admin}"
PA_API_CONTAINER="${PA_API_CONTAINER:-admin-server-staging-app-1}"
PA_API_DIR="${PA_API_DIR:-/var/www/admin-server-staging}"
PA_BRIDGE_CONTAINER="${PA_BRIDGE_CONTAINER:-}"
PA_BRIDGE_ADDRESS="${PA_BRIDGE_ADDRESS:-}"
PA_CM_BRIDGE_ADDRESS="${PA_CM_BRIDGE_ADDRESS:-}"
PA_CM_BRIDGE_PORT="${PA_CM_BRIDGE_PORT:-8460}"
PA_DB_IMAGE="${PA_DB_IMAGE:-postgres:16-alpine}"
PA_SUBNET_HQ="${PA_SUBNET_HQ:-10.231.10.0/28}"
PA_SUBNET_ADMIN="${PA_SUBNET_ADMIN:-10.231.11.0/28}"
PA_SUBNET_BRIDGE="${PA_SUBNET_BRIDGE:-10.231.12.0/28}"
PA_SUBNET_KADB="${PA_SUBNET_KADB:-10.231.13.0/28}"
PA_SUBNET_CMBRIDGE="${PA_SUBNET_CMBRIDGE:-10.231.14.0/28}"
PA_SUBNET_CMDB="${PA_SUBNET_CMDB:-10.231.15.0/28}"
export PA_SUBNET_HQ PA_SUBNET_ADMIN PA_SUBNET_BRIDGE PA_SUBNET_KADB PA_SUBNET_CMBRIDGE PA_SUBNET_CMDB

PROJECT="cf-product-admin-staging"
NETWORKS=("cf-staging-hq-private:$PA_SUBNET_HQ" "cf-staging-admin-private:$PA_SUBNET_ADMIN" "cf-staging-karryam-bridge:$PA_SUBNET_BRIDGE" "cf-staging-karryam-admin-db:$PA_SUBNET_KADB")
# CF Meet Admin networks: created by prepare-host, required only by a release that includes CF Meet Admin.
CM_NETWORKS=("cf-staging-cfmeet-bridge:$PA_SUBNET_CMBRIDGE" "cf-staging-cfmeet-admin-db:$PA_SUBNET_CMDB")
if [[ "$PA_REHEARSAL" == 1 ]]; then REGISTRY_PREFIX="${PA_REHEARSAL_REGISTRY:-127.0.0.1:5000}/"; else REGISTRY_PREFIX="ghcr.io/cosmicforgehealthnet/"; fi
RELEASE_DIR="$PA_HOST_ROOT/release"
RUN_DIR="$RELEASE_DIR/runs/${PA_RUN_ID:-manual-$(date -u +%Y%m%dT%H%M%SZ)}"
CTR_PIC="$PROJECT-product-integration-core-1"
CTR_KA="$PROJECT-karryam-admin-1"
CTR_KW="$PROJECT-karryam-admin-worker-1"
CTR_KDB="$PROJECT-karryam-admin-db-1"
CTR_CM="$PROJECT-cfmeet-admin-1"
CTR_CW="$PROJECT-cfmeet-admin-worker-1"
CTR_CDB="$PROJECT-cfmeet-admin-db-1"
PIC_SOCK="$PA_HOST_ROOT/run/pic/product-integration-core.sock"
KA_SOCK="$PA_HOST_ROOT/run/karryam-admin/karryam-admin.sock"
CM_SOCK="$PA_HOST_ROOT/run/cfmeet-admin/cfmeet-admin.sock"

FAILED=0
check() {
  local id="$1" st="$2" detail="${3:-}"
  detail="$(printf '%s' "$detail" | tr -d '\000-\037"\\' | cut -c1-300)"
  [[ "$st" == FAIL ]] && FAILED=1
  printf 'PA_CHECK {"id":"%s","status":"%s","detail":"%s"}\n' "$id" "$st" "$detail"
}
die() { echo "BLOCKED: $*"; exit 1; }
require_root() { [[ "$(id -u)" == 0 ]] || die "this operation needs root on the host"; }
# CF Meet Admin is part of a release iff its images.env records CFMEET_ADMIN_IMAGE.
cm_in() { [[ -f "$1" ]] && grep -Eq '^CFMEET_ADMIN_IMAGE=.+' "$1"; }
release_cm_on() { cm_in "$RELEASE_DIR/images.env"; }
# The compose profile "cfmeet" is activated only for such a release.
compose_with() {
  local envf="$1"; shift
  local prof=(); if cm_in "$envf"; then prof=(--profile cfmeet); fi
  docker compose --project-name "$PROJECT" --env-file "$envf" -f "$COMPOSE" "${prof[@]}" "$@"
}
compose() { compose_with "$RELEASE_DIR/images.env" "$@"; }
skipped() { check "$1" SKIPPED_NOT_DEPLOYED "CF Meet Admin is not part of this release"; }
# CF Meet Bridge tunnel endpoint: recorded in a CF Meet release's images.env, else from the environment.
cm_bridge_env() {
  local addr="$PA_CM_BRIDGE_ADDRESS" port="$PA_CM_BRIDGE_PORT"
  if release_cm_on; then
    addr="$(grep '^PA_CM_BRIDGE_ADDRESS=' "$RELEASE_DIR/images.env" | cut -d= -f2)"
    port="$(grep '^PA_CM_BRIDGE_PORT=' "$RELEASE_DIR/images.env" | cut -d= -f2)"
  fi
  CM_ADDR="$addr"; CM_PORT="${port:-8460}"
}
firewall() { PA_CM_BRIDGE_ADDRESS="$CM_ADDR" PA_CM_BRIDGE_PORT="$CM_PORT" bash "$FIREWALL" "$@"; }
# Expected Docker "internal" flag: every Product Admin network is internal except the egress-allowlisted CF Meet Bridge network.
want_internal() { [[ "$1" == cf-staging-cfmeet-bridge ]] && echo false || echo true; }
# Stop CF Meet containers left from an earlier release (data volumes are kept).
stop_cfmeet() { local c; for c in "$@"; do if running "$c"; then docker stop "$c" >/dev/null; echo "stopped $c (CF Meet Admin is not part of this release; data kept)"; fi; done; }
enabled_in() { [[ -f "$1" ]] && grep -Eq "^$2=true\s*$" "$1"; }
running() { [[ "$(docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null || true)" == running ]]; }

sock_status() {
  local sock="$1" path="$2"
  [[ -S "$sock" ]] || { echo 000; return; }
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 --unix-socket "$sock" "http://local$path" 2>/dev/null || echo 000
}

# TCP reachability from inside a container that has node (KA, PIC, API).
tcp_from() {
  local ctr="$1" host="$2" port="$3"
  docker exec "$ctr" node -e '
    const s = require("net").connect({ host: process.argv[1], port: Number(process.argv[2]), timeout: 3000 });
    s.on("connect", () => { console.log("OPEN"); s.destroy(); process.exit(0); });
    s.on("timeout", () => { console.log("TIMEOUT"); process.exit(1); });
    s.on("error", (e) => { console.log(e.code || "ERROR"); process.exit(1); });' "$host" "$port" 2>/dev/null || true
}

# role of a container on a Product Admin network (for membership audits)
role_of() {
  local n="$1"
  case "$n" in
    "$PROJECT"-*-1) n="${n#"$PROJECT"-}"; echo "${n%-1}" ;;
    "$PA_HQ_DB_CONTAINER") echo hq-database ;;
    "$PA_API_CONTAINER") echo central-admin-api ;;
    *) if [[ -n "$PA_BRIDGE_CONTAINER" && "$n" == "$PA_BRIDGE_CONTAINER" ]]; then echo karryam-backoffice-bridge
       else echo "unknown:$n"; fi ;;
  esac
}

permitted() { # network-name role -> 0 if the policy permits the role
  python3 - "$POLICY" "$1" "$2" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
net = next((n for n in p["networks"].values() if n["name"] == sys.argv[2]), None)
sys.exit(0 if net and sys.argv[3] in net["permitted_members"] else 1)
PY
}

audit_networks() {
  local ok=1 bad="" entry name subnet cmnote=""
  for entry in "${NETWORKS[@]}" "${CM_NETWORKS[@]}"; do
    name="${entry%%:*}"; subnet="${entry#*:}"
    if ! docker network inspect "$name" >/dev/null 2>&1; then
      # The CF Meet networks are optional until a release includes CF Meet Admin.
      if [[ "$name" == cf-staging-cfmeet-* ]] && ! release_cm_on; then cmnote+="$name not created; "; continue; fi
      ok=0; bad+="$name missing; "; continue
    fi
    [[ "$(docker network inspect -f '{{.Internal}}' "$name")" == "$(want_internal "$name")" ]] || { ok=0; bad+="$name internal flag is not $(want_internal "$name"); "; }
    [[ "$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$name")" == "$subnet" ]] || { ok=0; bad+="$name subnet differs; "; }
    local c
    for c in $(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$name"); do
      permitted "$name" "$(role_of "$c")" || { ok=0; bad+="$c not permitted on $name; "; }
    done
  done
  if (( ok )); then check networks_internal_and_isolated PASS "4 internal networks, fixed subnets, policy membership only${cmnote:+; CF Meet Admin (optional): $cmnote}; cf-staging-cfmeet-bridge non-internal behind the egress allowlist"; else check networks_internal_and_isolated FAIL "$bad"; fi
}

mode_of() { stat -c '%a %u %g' "$1" 2>/dev/null || echo "missing"; }

audit_dirs() {
  local ok=1 bad=""
  [[ "$(mode_of "$PA_HOST_ROOT/run/pic")" == "750 10002 10002" ]] || { ok=0; bad+="run/pic $(mode_of "$PA_HOST_ROOT/run/pic"); "; }
  [[ "$(mode_of "$PA_HOST_ROOT/run/karryam-admin")" == "750 10001 10001" ]] || { ok=0; bad+="run/karryam-admin $(mode_of "$PA_HOST_ROOT/run/karryam-admin"); "; }
  # Optional CF Meet Admin socket dir: if present (prepare-host/deploy create it) it must be owned by 10003.
  if [[ -e "$PA_HOST_ROOT/run/cfmeet-admin" ]]; then
    [[ "$(mode_of "$PA_HOST_ROOT/run/cfmeet-admin")" == "750 10003 10003" ]] || { ok=0; bad+="run/cfmeet-admin $(mode_of "$PA_HOST_ROOT/run/cfmeet-admin"); "; }
  fi
  if (( ok )); then check socket_dirs_owned PASS "socket dirs 0750 owned by their service uid"; else check socket_dirs_owned FAIL "$bad"; fi
}

audit_config_files() {
  local missing="" weak="" f d
  for f in product-integration-core.env karryam-admin.env; do
    [[ -f "$PA_CONFIG_ROOT/$f" ]] || { missing+="$f "; continue; }
    [[ "$(stat -c '%u %a' "$PA_CONFIG_ROOT/$f")" =~ ^0\ 6[04]0$ ]] || weak+="$f mode $(stat -c '%a' "$PA_CONFIG_ROOT/$f"); "
  done
  for d in product-integration-core:10002 karryam-admin:10001 karryam-admin-db:70; do
    local dir="$PA_CONFIG_ROOT/secrets/${d%%:*}"
    [[ -d "$dir" ]] || { missing+="secrets/${d%%:*} "; continue; }
    [[ "$(mode_of "$dir")" == "750 0 ${d#*:}" ]] || weak+="secrets/${d%%:*} $(mode_of "$dir"); "
    while IFS= read -r -d '' f; do
      local m; m="$(stat -c '%a' "$f")"
      [[ "$m" =~ ^[0-7][0-7]0$ && ! "$m" =~ ^[0-7][2367][0-7]$ ]] || weak+="$(basename "$f") mode $m; "
    done < <(find "$dir" -type f -print0)
  done
  # Optional CF Meet Admin files: required once cfmeet-admin.env exists; checked whenever present.
  if [[ -f "$PA_CONFIG_ROOT/cfmeet-admin.env" ]]; then
    [[ "$(stat -c '%u %a' "$PA_CONFIG_ROOT/cfmeet-admin.env")" =~ ^0\ 6[04]0$ ]] || weak+="cfmeet-admin.env mode $(stat -c '%a' "$PA_CONFIG_ROOT/cfmeet-admin.env"); "
  fi
  for d in cfmeet-admin:10003 cfmeet-admin-db:70; do
    local dir="$PA_CONFIG_ROOT/secrets/${d%%:*}"
    if [[ ! -d "$dir" ]]; then [[ -f "$PA_CONFIG_ROOT/cfmeet-admin.env" ]] && missing+="secrets/${d%%:*} "; continue; fi
    [[ "$(mode_of "$dir")" == "750 0 ${d#*:}" ]] || weak+="secrets/${d%%:*} $(mode_of "$dir"); "
    while IFS= read -r -d '' f; do
      local m; m="$(stat -c '%a' "$f")"
      [[ "$m" =~ ^[0-7][0-7]0$ && ! "$m" =~ ^[0-7][2367][0-7]$ ]] || weak+="$(basename "$f") mode $m; "
    done < <(find "$dir" -type f -print0)
  done
  if [[ -n "$missing" ]]; then check config_files_protected PENDING_EXTERNAL "operator files missing: $missing"
  elif [[ -n "$weak" ]]; then check config_files_protected FAIL "$weak"
  else check config_files_protected PASS "env files root 0600/0640; secret dirs 0750 root:<service gid>; no world access"; fi
  # HQ never holds Bridge or Karryam Admin DB credentials; Karryam Admin never holds HQ DB credentials.
  local cross=""
  if [[ -f "$PA_CONFIG_ROOT/product-integration-core.env" ]]; then
    grep -Eq '^(KARRYAM_BRIDGE_|KARRYAM_ADMIN_DATABASE_URL|ADMIN_BACKOFFICE_)' "$PA_CONFIG_ROOT/product-integration-core.env" && cross+="PIC env has Karryam/Bridge credentials; "
    grep -Eq '@karryam-admin-db[:/]' "$PA_CONFIG_ROOT/product-integration-core.env" && cross+="PIC env points at DB-B; "
    grep -Eq '^(CFMEET_BRIDGE_|CFMEET_ADMIN_DATABASE_URL)' "$PA_CONFIG_ROOT/product-integration-core.env" && cross+="PIC env has CF Meet Admin/Bridge credentials; "
    grep -Eq '@cfmeet-admin-db[:/]' "$PA_CONFIG_ROOT/product-integration-core.env" && cross+="PIC env points at the CF Meet Admin database; "
  fi
  if [[ -f "$PA_CONFIG_ROOT/karryam-admin.env" ]]; then
    grep -Eq '^(PIC_DATABASE_URL|PIC_MIGRATION_DATABASE_URL|DATABASE_URL)=' "$PA_CONFIG_ROOT/karryam-admin.env" && cross+="Karryam Admin env has HQ database variables; "
    grep -Eq "@hq-db[:/]|/$PA_HQ_DB_NAME(\?|$)" "$PA_CONFIG_ROOT/karryam-admin.env" && cross+="Karryam Admin env points at DB-A; "
    grep -Eq '^KARRYAM_ADMIN_DATABASE_URL=postgres(ql)?://postgres[:@]' "$PA_CONFIG_ROOT/karryam-admin.env" && cross+="Karryam Admin runtime uses the postgres superuser; "
    grep -Eq '^CFMEET_|@cfmeet-admin-db[:/]' "$PA_CONFIG_ROOT/karryam-admin.env" && cross+="Karryam Admin env has CF Meet Admin variables; "
  fi
  if [[ -f "$PA_CONFIG_ROOT/cfmeet-admin.env" ]]; then
    grep -Eq '^(PIC_DATABASE_URL|PIC_MIGRATION_DATABASE_URL|DATABASE_URL)=' "$PA_CONFIG_ROOT/cfmeet-admin.env" && cross+="CF Meet Admin env has HQ database variables; "
    grep -Eq "@hq-db[:/]|/$PA_HQ_DB_NAME(\?|$)" "$PA_CONFIG_ROOT/cfmeet-admin.env" && cross+="CF Meet Admin env points at DB-A; "
    grep -Eq '^CFMEET_ADMIN_DATABASE_URL=postgres(ql)?://postgres[:@]' "$PA_CONFIG_ROOT/cfmeet-admin.env" && cross+="CF Meet Admin runtime uses the postgres superuser; "
    grep -Eq '^(KARRYAM_|ADMIN_BACKOFFICE_)|@karryam-admin-db[:/]' "$PA_CONFIG_ROOT/cfmeet-admin.env" && cross+="CF Meet Admin env has Karryam variables; "
  fi
  if [[ -f "$PA_CONFIG_ROOT/product-integration-core.env" ]] && grep -Eq '^PIC_DATABASE_URL=postgres(ql)?://postgres[:@]' "$PA_CONFIG_ROOT/product-integration-core.env"; then cross+="PIC runtime uses the postgres superuser; "; fi
  if [[ -n "$cross" ]]; then check db_no_cross_credentials FAIL "$cross"
  elif [[ -n "$missing" ]]; then check db_no_cross_credentials PENDING_EXTERNAL "env files not provisioned"
  else check db_no_cross_credentials PASS "no cross-boundary database or Bridge credentials; no superuser runtime identity"; fi
}

audit_firewall() {
  if [[ "$(id -u)" != 0 ]]; then check firewall_docker_user NOT_RUN "needs root"; return; fi
  cm_bridge_env
  if out="$(firewall verify 2>&1)"; then check firewall_docker_user PASS "DOCKER-USER rules present (exact set; CF Meet Bridge egress ${CM_ADDR:-closed}${CM_ADDR:+:$CM_PORT}); no wildcard 5432/8110/8460 listener"
  else check firewall_docker_user FAIL "$(printf '%s' "$out" | grep -E 'MISSING|UNEXPECTED|EXPOSED|BLOCKED' | head -3 | tr '\n' ' ')"; fi
}

# ---------------------------------------------------------------------------
prepare_host() {
  require_root
  # The CF Meet Bridge tunnel endpoint is validated before anything changes (RFC 1918, outside every cf-staging subnet).
  CM_ADDR="$PA_CM_BRIDGE_ADDRESS"; CM_PORT="$PA_CM_BRIDGE_PORT"
  firewall validate || die "invalid CF Meet Bridge tunnel endpoint (PA_CM_BRIDGE_ADDRESS/PA_CM_BRIDGE_PORT); nothing was changed"
  [[ -n "$CM_ADDR" ]] || echo "PA_CM_BRIDGE_ADDRESS not set: cf-staging-cfmeet-bridge gets no egress at all until prepare-host runs with the tunnel address."
  echo "Preparing host directories under $PA_HOST_ROOT and $PA_CONFIG_ROOT"
  install -d -m 0755 -o 0 -g 0 "$PA_HOST_ROOT" "$PA_HOST_ROOT/run"
  install -d -m 0750 -o 10002 -g 10002 "$PA_HOST_ROOT/run/pic"
  install -d -m 0750 -o 10001 -g 10001 "$PA_HOST_ROOT/run/karryam-admin"
  # Created even when CF Meet Admin is not deployed: PIC bind-mounts it (empty) read-only.
  install -d -m 0750 -o 10003 -g 10003 "$PA_HOST_ROOT/run/cfmeet-admin"
  install -d -m 0700 -o 0 -g 0 "$RELEASE_DIR" "$PA_HOST_ROOT/backups"
  install -d -m 0750 -o 0 -g 0 "$PA_CONFIG_ROOT" "$PA_CONFIG_ROOT/secrets"
  install -d -m 0750 -o 0 -g 10002 "$PA_CONFIG_ROOT/secrets/product-integration-core"
  install -d -m 0750 -o 0 -g 10001 "$PA_CONFIG_ROOT/secrets/karryam-admin"
  install -d -m 0750 -o 0 -g 70 "$PA_CONFIG_ROOT/secrets/karryam-admin-db"
  install -d -m 0750 -o 0 -g 10003 "$PA_CONFIG_ROOT/secrets/cfmeet-admin"
  install -d -m 0750 -o 0 -g 70 "$PA_CONFIG_ROOT/secrets/cfmeet-admin-db"
  local entry name subnet
  for entry in "${NETWORKS[@]}" "${CM_NETWORKS[@]}"; do
    name="${entry%%:*}"; subnet="${entry#*:}"
    if docker network inspect "$name" >/dev/null 2>&1; then
      [[ "$(docker network inspect -f '{{.Internal}}' "$name")" == "$(want_internal "$name")" ]] || die "$name exists with internal=$(docker network inspect -f '{{.Internal}}' "$name") (expected $(want_internal "$name")); remove it after review"
      [[ "$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$name")" == "$subnet" ]] || die "$name exists with another subnet"
      echo "network present: $name ($subnet, internal=$(want_internal "$name"))"
    else
      # cf-staging-cfmeet-bridge is created WITHOUT --internal: its only egress is the
      # CF Meet Bridge tunnel address, enforced by the DOCKER-USER allowlist below.
      local internal=(--internal); [[ "$(want_internal "$name")" == false ]] && internal=()
      docker network create --driver bridge "${internal[@]}" --subnet "$subnet" --label com.cosmicforge.product-admin.policy=v1 "$name" >/dev/null
      echo "network created: $name ($subnet, internal=$(want_internal "$name"))"
    fi
  done
  # DB-A joins the HQ private network under the alias hq-db. Connecting a
  # network to a running container does not restart it.
  if docker inspect "$PA_HQ_DB_CONTAINER" >/dev/null 2>&1; then
    if docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' cf-staging-hq-private | grep -qw "$PA_HQ_DB_CONTAINER"; then echo "HQ database already on cf-staging-hq-private"
    else docker network connect --alias hq-db cf-staging-hq-private "$PA_HQ_DB_CONTAINER"; echo "HQ database attached to cf-staging-hq-private as hq-db"; fi
  else
    echo "WARNING: $PA_HQ_DB_CONTAINER not found; DB-A attachment pending."
  fi
  if [[ "${PA_SKIP_FIREWALL:-0}" == 1 ]]; then echo "Firewall step skipped by request (PA_SKIP_FIREWALL=1). A release with CF Meet Admin will be refused until the egress allowlist is applied."; else firewall apply; fi
  preflight
}

preflight() {
  audit_networks
  audit_dirs
  audit_config_files
  audit_firewall
}

# ---------------------------------------------------------------------------
resolve_db_image() {
  if [[ "$PA_DB_IMAGE" == *@sha256:* ]]; then echo "$PA_DB_IMAGE"; return; fi
  docker pull -q "$PA_DB_IMAGE" >/dev/null
  local d; d="$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$PA_DB_IMAGE" | grep -m1 '@sha256:' || true)"
  [[ -n "$d" ]] || die "cannot resolve a digest for $PA_DB_IMAGE"
  [[ "$d" == */* ]] || d="docker.io/library/$d"
  [[ "$d" == postgres@* ]] && d="docker.io/library/$d"
  echo "$d"
}

valid_ref() { [[ "$1" =~ ^${REGISTRY_PREFIX//./\\.}(karryam-admin|cfmeet-admin|product-integration-core)@sha256:[0-9a-f]{64}$ ]]; }

config_check() { # image envfile secretsdir target-dir enabled-var expect-var
  local image="$1" envf="$2" sec="$3" target="$4" en="$5" expect="$6" envname="$7" out
  local args=(--rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --env-file "$envf" -e "$envname=staging" -v "$sec:$target:ro")
  if enabled_in "$envf" "$en"; then args+=(-e "$expect=staging"); fi
  out="$(docker run "${args[@]}" "$image" node scripts/check-config.js 2>/dev/null | tail -n 1 || true)"
  printf '%s' "$out"
}

deploy() {
  require_root
  local pic="${PA_PIC_IMAGE:-}" ka="${PA_KA_IMAGE:-}" sha="${PA_RELEASE_SHA:-}"
  valid_ref "$pic" || die "PA_PIC_IMAGE must be ${REGISTRY_PREFIX}product-integration-core@sha256:<digest>"
  valid_ref "$ka" || die "PA_KA_IMAGE must be ${REGISTRY_PREFIX}karryam-admin@sha256:<digest>"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "PA_RELEASE_SHA must be the full release commit"
  for entry in "${NETWORKS[@]}"; do docker network inspect "${entry%%:*}" >/dev/null 2>&1 || die "host not prepared (${entry%%:*} missing): run prepare-host"; done
  [[ -d "$PA_HOST_ROOT/run/pic" && -d "$PA_HOST_ROOT/run/karryam-admin" ]] || die "host not prepared: run prepare-host"
  for f in product-integration-core.env karryam-admin.env; do [[ -f "$PA_CONFIG_ROOT/$f" ]] || die "operator env file $PA_CONFIG_ROOT/$f is missing"; done
  [[ -f "$PA_CONFIG_ROOT/secrets/karryam-admin-db/postgres-password" ]] || die "DB-B superuser password file is missing"
  # CF Meet Admin decision, made once and recorded in images.env.
  local cm="${PA_CM_IMAGE:-}" cm_on=0
  if [[ -n "$cm" ]]; then
    valid_ref "$cm" && [[ "$cm" == *cfmeet-admin@* ]] || die "PA_CM_IMAGE must be ${REGISTRY_PREFIX}cfmeet-admin@sha256:<digest>"
    [[ -f "$PA_CONFIG_ROOT/cfmeet-admin.env" ]] || die "PA_CM_IMAGE is set but $PA_CONFIG_ROOT/cfmeet-admin.env is missing: provision the CF Meet Admin files (staging/README.md section 7) or deploy without PA_CM_IMAGE; nothing was changed"
    [[ -d "$PA_HOST_ROOT/run/cfmeet-admin" ]] || die "PA_CM_IMAGE is set but $PA_HOST_ROOT/run/cfmeet-admin is missing: run prepare-host; nothing was changed"
    [[ -f "$PA_CONFIG_ROOT/secrets/cfmeet-admin-db/postgres-password" ]] || die "PA_CM_IMAGE is set but the CF Meet Admin database superuser password file is missing; nothing was changed"
    for entry in "${CM_NETWORKS[@]}"; do docker network inspect "${entry%%:*}" >/dev/null 2>&1 || die "PA_CM_IMAGE is set but ${entry%%:*} is missing: run prepare-host; nothing was changed"; done
    # The CF Meet Bridge tunnel endpoint: required, valid, and enforced by the firewall before anything changes.
    CM_ADDR="$PA_CM_BRIDGE_ADDRESS"; CM_PORT="$PA_CM_BRIDGE_PORT"
    [[ -n "$CM_ADDR" ]] || die "PA_CM_IMAGE is set but PA_CM_BRIDGE_ADDRESS (RFC 1918 tunnel address of the CF Meet host, e.g. 10.250.0.1) is not; nothing was changed"
    firewall validate >/dev/null || die "PA_CM_BRIDGE_ADDRESS=$CM_ADDR / PA_CM_BRIDGE_PORT=$CM_PORT is not a valid tunnel endpoint (RFC 1918, never 100.64/10, outside every cf-staging subnet); nothing was changed"
    [[ "$(docker network inspect -f '{{.Internal}}' cf-staging-cfmeet-bridge)" == false ]] || die "cf-staging-cfmeet-bridge is internal (old local-Bridge model): remove it after review and re-run prepare-host; nothing was changed"
    firewall verify >/dev/null 2>&1 || die "the DOCKER-USER egress allowlist for $CM_ADDR:$CM_PORT is not in place (exact rule set): run prepare-host with PA_CM_BRIDGE_ADDRESS=$CM_ADDR; nothing was changed"
    # cfmeet-admin.env must agree with the tunnel endpoint where it names it.
    local envaddr envorigin
    envaddr="$(grep -E '^CFMEET_BRIDGE_ADDRESS=' "$PA_CONFIG_ROOT/cfmeet-admin.env" | tail -n 1 | cut -d= -f2- | tr -d '[:space:]' || true)"
    [[ -z "$envaddr" || "$envaddr" == "$CM_ADDR" ]] || die "CFMEET_BRIDGE_ADDRESS in cfmeet-admin.env ($envaddr) differs from PA_CM_BRIDGE_ADDRESS ($CM_ADDR); nothing was changed"
    envorigin="$(grep -E '^CFMEET_BRIDGE_ORIGIN=' "$PA_CONFIG_ROOT/cfmeet-admin.env" | tail -n 1 | cut -d= -f2- | tr -d '[:space:]' || true)"
    if [[ -n "$envorigin" ]]; then
      [[ "$envorigin" =~ :([0-9]+)/?$ && "${BASH_REMATCH[1]}" == "$CM_PORT" ]] || die "CFMEET_BRIDGE_ORIGIN in cfmeet-admin.env must name port $CM_PORT (PA_CM_BRIDGE_PORT); nothing was changed"
    fi
    cm_on=1
    echo "CF Meet Admin is part of this release ($cm)."
  elif [[ -f "$PA_CONFIG_ROOT/cfmeet-admin.env" ]]; then
    echo "CF Meet Admin skipped: $PA_CONFIG_ROOT/cfmeet-admin.env exists but PA_CM_IMAGE is not set; this release is PIC + Karryam Admin only."
  else
    echo "CF Meet Admin not part of this release (no PA_CM_IMAGE, no cfmeet-admin.env)."
  fi
  # PIC always bind-mounts the CF Meet socket directory read-only; on a host
  # prepared before CF Meet support it may not exist yet (empty is fine).
  if [[ ! -d "$PA_HOST_ROOT/run/cfmeet-admin" ]]; then install -d -m 0750 -o 10003 -g 10003 "$PA_HOST_ROOT/run/cfmeet-admin"; echo "created empty $PA_HOST_ROOT/run/cfmeet-admin for the PIC read-only mount"; fi
  install -d -m 0700 "$RUN_DIR"

  if [[ -n "${GHCR_TOKEN:-}" ]]; then
    local auth; auth="$(mktemp -d)"
    DOCKER_CONFIG="$auth" bash -c 'printf "%s" "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USER" --password-stdin >/dev/null && docker pull -q "$1" >/dev/null && docker pull -q "$2" >/dev/null && { [[ -z "$3" ]] || docker pull -q "$3" >/dev/null; }' _ "$pic" "$ka" "$([[ $cm_on == 1 ]] && echo "$cm")"
    rm -rf "$auth"; unset GHCR_TOKEN
  else
    docker pull -q "$pic" >/dev/null; docker pull -q "$ka" >/dev/null
    if (( cm_on )); then docker pull -q "$cm" >/dev/null; fi
  fi
  local img imgs=("$pic" "$ka")
  if (( cm_on )); then imgs+=("$cm"); fi
  for img in "${imgs[@]}"; do
    local rev; rev="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$img")"
    [[ "$rev" == "$sha" ]] || die "image $img was built from $rev, not the release commit $sha"
  done
  local db; db="$(resolve_db_image)"

  # Validate the operator configuration INSIDE the release images before anything changes.
  local c1 c2
  c1="$(config_check "$pic" "$PA_CONFIG_ROOT/product-integration-core.env" "$PA_CONFIG_ROOT/secrets/product-integration-core" /run/secrets/product-integration-core PIC_ENABLED PIC_EXPECT_ENVIRONMENT PIC_ENVIRONMENT)"
  c2="$(config_check "$ka" "$PA_CONFIG_ROOT/karryam-admin.env" "$PA_CONFIG_ROOT/secrets/karryam-admin" /run/secrets/karryam-admin KARRYAM_ADMIN_ENABLED KARRYAM_ADMIN_EXPECT_ENVIRONMENT KARRYAM_ADMIN_ENVIRONMENT)"
  echo "PIC configuration: $c1"
  echo "Karryam Admin configuration: $c2"
  [[ "$c1" == *'"event":"config_valid"'* ]] || die "Product Integration Core configuration is invalid; nothing was changed"
  [[ "$c2" == *'"event":"config_valid"'* ]] || die "Karryam Admin configuration is invalid; nothing was changed"
  if (( cm_on )); then
    local c3
    c3="$(config_check "$cm" "$PA_CONFIG_ROOT/cfmeet-admin.env" "$PA_CONFIG_ROOT/secrets/cfmeet-admin" /run/secrets/cfmeet-admin CFMEET_ADMIN_ENABLED CFMEET_ADMIN_EXPECT_ENVIRONMENT CFMEET_ADMIN_ENVIRONMENT)"
    echo "CF Meet Admin configuration: $c3"
    [[ "$c3" == *'"event":"config_valid"'* ]] || die "CF Meet Admin configuration is invalid; nothing was changed"
  fi

  [[ -f "$RELEASE_DIR/images.env" ]] && cp "$RELEASE_DIR/images.env" "$RELEASE_DIR/previous-images.env"
  printf 'PIC_IMAGE=%s\nKARRYAM_ADMIN_IMAGE=%s\nKARRYAM_ADMIN_DB_IMAGE=%s\nPA_HOST_ROOT=%s\nPA_CONFIG_ROOT=%s\nPA_RELEASE_SHA=%s\n' "$pic" "$ka" "$db" "$PA_HOST_ROOT" "$PA_CONFIG_ROOT" "$sha" > "$RUN_DIR/images.env"
  # Recording CFMEET_ADMIN_IMAGE is THE decision that CF Meet Admin is in this release (same PostgreSQL digest as DB-B).
  if (( cm_on )); then printf 'CFMEET_ADMIN_IMAGE=%s\nCFMEET_ADMIN_DB_IMAGE=%s\nPA_CM_BRIDGE_ADDRESS=%s\nPA_CM_BRIDGE_PORT=%s\n' "$cm" "$db" "$CM_ADDR" "$CM_PORT" >> "$RUN_DIR/images.env"; fi

  # Static policy check of the exact resolved model, with the release image's own node.
  local req=(); if (( cm_on )); then req=(--require-product cfmeet); fi
  compose_with "$RUN_DIR/images.env" config --format json > "$RUN_DIR/resolved.json"
  chmod 0644 "$RUN_DIR/resolved.json"; chmod 0755 "$RUN_DIR"
  if docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 0:0 \
      -v "$BUNDLE:/bundle:ro" -v "$RUN_DIR:/out" --entrypoint node "$pic" \
      "/bundle/$INFRA_CHECK" --compose-json /out/resolved.json --require-digests "${req[@]}" --report /out/network-policy-report.json; then
    check compose_policy PASS "resolved model passes the network/container policy"
  else
    chmod 0700 "$RUN_DIR"; die "resolved compose model violates the policy; nothing was changed"
  fi
  chmod 0700 "$RUN_DIR"

  cp "$RUN_DIR/images.env" "$RELEASE_DIR/images.env"
  local feed=0
  enabled_in "$PA_CONFIG_ROOT/karryam-admin.env" KARRYAM_BRIDGE_FEED_ENABLED && feed=1
  # Explicit service lists: without CF Meet Admin no cfmeet service is ever created.
  local up=(karryam-admin-db karryam-admin)
  if (( cm_on )); then up+=(cfmeet-admin-db cfmeet-admin); fi
  up+=(product-integration-core)
  if (( feed )); then up+=(karryam-admin-worker); fi
  if (( cm_on )) && enabled_in "$PA_CONFIG_ROOT/cfmeet-admin.env" CFMEET_BRIDGE_FEED_ENABLED; then up+=(cfmeet-admin-worker); fi
  compose up -d --no-build --pull never --remove-orphans "${up[@]}"
  if (( ! feed )); then compose rm -f -s karryam-admin-worker >/dev/null 2>&1 || true; fi
  if (( cm_on )); then
    enabled_in "$PA_CONFIG_ROOT/cfmeet-admin.env" CFMEET_BRIDGE_FEED_ENABLED || { compose rm -f -s cfmeet-admin-worker >/dev/null 2>&1 || true; }
  else
    stop_cfmeet "$CTR_CW" "$CTR_CM" "$CTR_CDB"
  fi

  FAILED=0
  verify_deploy "$pic" "$ka"
  if (( FAILED )); then
    echo "Verification failed: rolling back."
    restore_previous
    exit 1
  fi
  if (( cm_on )); then echo "DEPLOYED $sha (PIC $pic, Karryam Admin $ka, CF Meet Admin $cm)"; else echo "DEPLOYED $sha (PIC $pic, Karryam Admin $ka)"; fi
}

restore_previous() {
  if [[ -f "$RELEASE_DIR/previous-images.env" ]]; then
    cp "$RELEASE_DIR/previous-images.env" "$RELEASE_DIR/images.env"
    # A previous release without CF Meet Admin is a valid target: PIC + Karryam only, CF Meet stopped.
    if release_cm_on; then compose up -d --no-build --pull never karryam-admin-db karryam-admin cfmeet-admin-db cfmeet-admin product-integration-core || true
    else compose up -d --no-build --pull never karryam-admin-db karryam-admin product-integration-core || true; stop_cfmeet "$CTR_CW" "$CTR_CM" "$CTR_CDB"; fi
    echo "ROLLED_BACK to $(grep '^PA_RELEASE_SHA=' "$RELEASE_DIR/images.env" | cut -d= -f2)"
  else
    compose stop karryam-admin karryam-admin-worker product-integration-core || true
    stop_cfmeet "$CTR_CW" "$CTR_CM"
    echo "No previous release: new services stopped (data and evidence preserved)."
  fi
}

verify_deploy() {
  local pic="$1" ka="$2" cm="" cm_on=0
  # CF Meet Admin participation comes from the release's images.env, never from a fresh guess.
  if release_cm_on; then cm_on=1; cm="$(grep '^CFMEET_ADMIN_IMAGE=' "$RELEASE_DIR/images.env" | cut -d= -f2)"; fi
  for _ in $(seq 1 40); do [[ -S "$PIC_SOCK" && -S "$KA_SOCK" ]] && { (( ! cm_on )) || [[ -S "$CM_SOCK" ]]; } && break; sleep 2; done
  local okimg=1
  [[ "$(docker inspect -f '{{.Config.Image}}' "$CTR_PIC" 2>/dev/null)" == "$pic" ]] || okimg=0
  [[ "$(docker inspect -f '{{.Config.Image}}' "$CTR_KA" 2>/dev/null)" == "$ka" ]] || okimg=0
  [[ "$(docker inspect -f '{{.Image}}' "$CTR_PIC" 2>/dev/null)" == "$(docker image inspect -f '{{.Id}}' "$pic")" ]] || okimg=0
  [[ "$(docker inspect -f '{{.Image}}' "$CTR_KA" 2>/dev/null)" == "$(docker image inspect -f '{{.Id}}' "$ka")" ]] || okimg=0
  if (( cm_on )); then
    [[ "$(docker inspect -f '{{.Config.Image}}' "$CTR_CM" 2>/dev/null)" == "$cm" ]] || okimg=0
    [[ "$(docker inspect -f '{{.Image}}' "$CTR_CM" 2>/dev/null)" == "$(docker image inspect -f '{{.Id}}' "$cm")" ]] || okimg=0
  elif running "$CTR_CM" || running "$CTR_CW" || running "$CTR_CDB"; then
    okimg=0  # a CF Meet container outside a CF Meet release
  fi
  if (( okimg )); then check images_match_tested_digests PASS "running containers use exactly the release digests"; else check images_match_tested_digests FAIL "running image differs from the release digest"; fi

  local nr="" c
  for c in "$CTR_PIC:10002" "$CTR_KA:10001"; do
    running "${c%%:*}" || { nr+="${c%%:*} not running; "; continue; }
    [[ "$(docker exec "${c%%:*}" id -u 2>/dev/null)" == "${c#*:}" ]] || nr+="${c%%:*} uid; "
  done
  running "$CTR_KDB" || nr+="$CTR_KDB not running; "
  # The Stage A worker runs only when the feed is enabled; then it must be up and non-root.
  if enabled_in "$PA_CONFIG_ROOT/karryam-admin.env" KARRYAM_BRIDGE_FEED_ENABLED; then
    running "$CTR_KW" || nr+="$CTR_KW not running although the feed is enabled; "
    [[ "$(docker exec "$CTR_KW" id -u 2>/dev/null || true)" == 10001 ]] || nr+="$CTR_KW uid; "
  fi
  [[ "$(docker exec "$CTR_KDB" id -u 2>/dev/null || true)" == 70 ]] || nr+="$CTR_KDB uid; "
  local cmdetail=""
  if (( cm_on )); then
    running "$CTR_CM" || nr+="$CTR_CM not running; "
    [[ "$(docker exec "$CTR_CM" id -u 2>/dev/null || true)" == 10003 ]] || nr+="$CTR_CM uid; "
    running "$CTR_CDB" || nr+="$CTR_CDB not running; "
    [[ "$(docker exec "$CTR_CDB" id -u 2>/dev/null || true)" == 70 ]] || nr+="$CTR_CDB uid; "
    if enabled_in "$PA_CONFIG_ROOT/cfmeet-admin.env" CFMEET_BRIDGE_FEED_ENABLED; then
      running "$CTR_CW" || nr+="$CTR_CW not running although the feed is enabled; "
      [[ "$(docker exec "$CTR_CW" id -u 2>/dev/null || true)" == 10003 ]] || nr+="$CTR_CW uid; "
    fi
    cmdetail=", CF Meet Admin uid 10003, CF Meet Admin database uid 70"
  fi
  if [[ -z "$nr" ]]; then check containers_running_non_root PASS "PIC uid 10002, Karryam Admin uid 10001, DB-B uid 70$cmdetail"; else check containers_running_non_root FAIL "$nr"; fi

  local pub=""
  for c in $(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}'); do
    local b; b="$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$c")"
    [[ "$b" == "{}" || "$b" == "null" ]] || pub+="$c publishes $b; "
    [[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$c")" != host ]] || pub+="$c uses host networking; "
    [[ "$(docker inspect -f '{{.HostConfig.Privileged}}' "$c")" == false ]] || pub+="$c privileged; "
  done
  if [[ -z "$pub" ]]; then check no_published_ports PASS "no host port, no host networking, not privileged"; else check no_published_ports FAIL "$pub"; fi

  local before=$FAILED; FAILED=0
  audit_networks >/dev/null
  local netfail=$FAILED; FAILED=$before
  if (( netfail )); then check network_membership_matches_policy FAIL "see networks_internal_and_isolated"; audit_networks; else check network_membership_matches_policy PASS "membership equals network-policy.json"; fi

  local sp=""
  [[ "$(mode_of "$PIC_SOCK")" == "660 10002 10002" ]] || sp+="PIC socket $(mode_of "$PIC_SOCK"); "
  [[ "$(mode_of "$KA_SOCK")" == "660 10001 10001" ]] || sp+="Karryam Admin socket $(mode_of "$KA_SOCK"); "
  if (( cm_on )); then [[ "$(mode_of "$CM_SOCK")" == "660 10003 10003" ]] || sp+="CF Meet Admin socket $(mode_of "$CM_SOCK"); "; fi
  if [[ -z "$sp" ]]; then check socket_permissions PASS "sockets 0660 owned by the service uid/gid"; else check socket_permissions FAIL "$sp"; fi

  # With CF Meet Admin out of the release its expected values equal the observed placeholders,
  # so the Karryam/PIC results and detail texts are exactly as before.
  local l1 l2 l3=200; l1="$(sock_status "$PIC_SOCK" /health/live)"; l2="$(sock_status "$KA_SOCK" /health/live)"
  if (( cm_on )); then l3="$(sock_status "$CM_SOCK" /health/live)"; fi
  if [[ "$l1" == 200 && "$l2" == 200 && "$l3" == 200 ]]; then check health_live PASS "live 200 on $( (( cm_on )) && echo "all three" || echo both) sockets"; else check health_live FAIL "PIC $l1, Karryam Admin $l2$( (( cm_on )) && echo ", CF Meet Admin $l3")"; fi

  local e1=503 e2=503 e3=503
  enabled_in "$PA_CONFIG_ROOT/product-integration-core.env" PIC_ENABLED && e1=200
  enabled_in "$PA_CONFIG_ROOT/karryam-admin.env" KARRYAM_ADMIN_ENABLED && e2=200
  if (( cm_on )) && enabled_in "$PA_CONFIG_ROOT/cfmeet-admin.env" CFMEET_ADMIN_ENABLED; then e3=200; fi
  local r1 r2 r3="$e3"
  for _ in $(seq 1 15); do r1="$(sock_status "$PIC_SOCK" /health/ready)"; r2="$(sock_status "$KA_SOCK" /health/ready)"; if (( cm_on )); then r3="$(sock_status "$CM_SOCK" /health/ready)"; fi; [[ "$r1" == "$e1" && "$r2" == "$e2" && "$r3" == "$e3" ]] && break; sleep 2; done
  local rd="ready PIC $r1 (expected $e1), Karryam Admin $r2 (expected $e2)"
  if (( cm_on )); then rd+=", CF Meet Admin $r3 (expected $e3)"; fi
  if [[ "$r1" == "$e1" && "$r2" == "$e2" && "$r3" == "$e3" ]]; then check health_ready_expected PASS "$rd"; else check health_ready_expected FAIL "$rd"; fi

  local u1 u2 u3=401; u1="$(sock_status "$PIC_SOCK" /internal/pic/v1/products)"; u2="$(sock_status "$KA_SOCK" /internal/product-admin/v1/manifest)"
  if (( cm_on )); then u3="$(sock_status "$CM_SOCK" /internal/product-admin/v1/manifest)"; fi
  local ud="PIC $u1, Karryam Admin $u2"
  if (( cm_on )); then ud+=", CF Meet Admin $u3"; fi
  if [[ "$u1" =~ ^(401|503)$ && "$u2" =~ ^(401|503)$ && "$u3" =~ ^(401|503)$ ]]; then check unauthenticated_refused PASS "$ud without credentials"; else check unauthenticated_refused FAIL "$ud without credentials"; fi

  local p; p="$(docker exec "$CTR_PIC" node -e 'require("http").get({socketPath:"/run/cosmicforge/karryam/karryam-admin.sock",path:"/health/live"},r=>{console.log(r.statusCode);process.exit(0)}).on("error",e=>{console.log(e.code);process.exit(0)})' 2>/dev/null || echo error)"
  if [[ "$p" == 200 ]]; then check pic_to_karryam_socket PASS "PIC reaches the Karryam Admin socket"; else check pic_to_karryam_socket FAIL "PIC to Karryam Admin socket: $p"; fi
  if (( cm_on )); then
    p="$(docker exec "$CTR_PIC" node -e 'require("http").get({socketPath:"/run/cosmicforge/cfmeet/cfmeet-admin.sock",path:"/health/live"},r=>{console.log(r.statusCode);process.exit(0)}).on("error",e=>{console.log(e.code);process.exit(0)})' 2>/dev/null || echo error)"
    if [[ "$p" == 200 ]]; then check pic_to_cfmeet_socket PASS "PIC reaches the CF Meet Admin socket"; else check pic_to_cfmeet_socket FAIL "PIC to CF Meet Admin socket: $p"; fi
  else
    skipped pic_to_cfmeet_socket
  fi
  # Product Admins cannot reach each other's sockets (not mounted, other uid/gid).
  # The Karryam side is asserted in every release; the CF Meet side when it runs.
  p="$(docker exec "$CTR_KA" node -e 'require("http").get({socketPath:"/run/cosmicforge/cfmeet/cfmeet-admin.sock",path:"/health/live"},r=>{console.log(r.statusCode);process.exit(0)}).on("error",e=>{console.log(e.code);process.exit(0)})' 2>/dev/null || echo error)"
  local q="CF Meet Admin not deployed"
  if (( cm_on )); then q="$(docker exec "$CTR_CM" node -e 'require("http").get({socketPath:"/run/cosmicforge/karryam/karryam-admin.sock",path:"/health/live"},r=>{console.log(r.statusCode);process.exit(0)}).on("error",e=>{console.log(e.code);process.exit(0)})' 2>/dev/null || echo error)"; fi
  if [[ "$p" != 200 && "$q" != 200 ]]; then check product_admin_sockets_isolated PASS "Karryam Admin to CF Meet socket $p; CF Meet Admin to Karryam socket $q"; else check product_admin_sockets_isolated FAIL "Karryam Admin to CF Meet socket $p; CF Meet Admin to Karryam socket $q"; fi

  if docker inspect "$PA_API_CONTAINER" >/dev/null 2>&1 && [[ "$(docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' "$PA_API_CONTAINER")" == *"/run/cosmicforge/pic"* ]]; then
    p="$(docker exec "$PA_API_CONTAINER" node -e 'require("http").get({socketPath:"/run/cosmicforge/pic/product-integration-core.sock",path:"/health/live"},r=>{console.log(r.statusCode);process.exit(0)}).on("error",e=>{console.log(e.code);process.exit(0)})' 2>/dev/null || echo error)"
    if [[ "$p" == 200 ]]; then check hq_gateway_socket_reachable PASS "Central Admin API reaches the PIC socket"; else check hq_gateway_socket_reachable FAIL "API to PIC socket: $p"; fi
  else
    check hq_gateway_socket_reachable PENDING_EXTERNAL "PIC socket not yet mounted into the Central Admin API (attach-gateway)"
  fi
}

network_probe() {
  local cm_on=0; release_cm_on && cm_on=1
  running "$CTR_PIC" && running "$CTR_KA" && { (( ! cm_on )) || running "$CTR_CM"; } || { check network_flows NOT_RUN "services not running"; return; }
  local r bad="" good=""
  expect_closed() { r="$(tcp_from "$1" "$2" "$3")"; if [[ "$r" == OPEN ]]; then bad+="$1 -> $2:$3 open; "; else good+="$1 -> $2:$3 $r; "; fi; }
  expect_open() { r="$(tcp_from "$1" "$2" "$3")"; if [[ "$r" == OPEN ]]; then good+="$1 -> $2:$3 open; "; else bad+="$1 -> $2:$3 $r (expected open); "; fi; }
  # Allowed flows.
  expect_open "$CTR_KA" karryam-admin-db 5432
  if (( cm_on )); then expect_open "$CTR_CM" cfmeet-admin-db 5432; fi
  if docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' cf-staging-hq-private | grep -qw "$PA_HQ_DB_CONTAINER"; then expect_open "$CTR_PIC" hq-db 5432; else good+="hq-db not attached; "; fi
  # Forbidden flows.
  expect_closed "$CTR_PIC" karryam-admin-db 5432
  expect_closed "$CTR_KA" hq-db 5432
  expect_closed "$CTR_PIC" 1.1.1.1 443
  expect_closed "$CTR_KA" 1.1.1.1 443
  # Absence of a path to the CF Meet Admin database holds whether or not it is deployed.
  expect_closed "$CTR_PIC" cfmeet-admin-db 5432
  expect_closed "$CTR_KA" cfmeet-admin-db 5432
  if (( cm_on )); then
    expect_closed "$CTR_CM" hq-db 5432
    expect_closed "$CTR_CM" 1.1.1.1 443
    expect_closed "$CTR_CM" karryam-admin-db 5432
  fi
  if [[ -n "$PA_BRIDGE_ADDRESS" ]]; then
    expect_open "$CTR_KA" "$PA_BRIDGE_ADDRESS" 8110
    expect_closed "$CTR_PIC" "$PA_BRIDGE_ADDRESS" 8110
    docker inspect "$PA_API_CONTAINER" >/dev/null 2>&1 && expect_closed "$PA_API_CONTAINER" "$PA_BRIDGE_ADDRESS" 8110
    if (( cm_on )); then expect_closed "$CTR_CM" "$PA_BRIDGE_ADDRESS" 8110; fi
    check bridge_network_reachable_only_from_karryam "$([[ -z "$bad" ]] && echo PASS || echo FAIL)" "Bridge $PA_BRIDGE_ADDRESS:8110"
  else
    check bridge_network_reachable_only_from_karryam PENDING_EXTERNAL "Bridge not attached to cf-staging-karryam-bridge yet"
  fi
  # CF Meet Admin Bridge over the private tunnel (CF Meet's own host).
  cm_bridge_env
  if (( ! cm_on )); then
    skipped bridge_network_reachable_only_from_cfmeet
    # Absence holds anyway: nothing on the HQ side may open the tunnel address.
    if [[ -n "$CM_ADDR" ]]; then
      expect_closed "$CTR_PIC" "$CM_ADDR" "$CM_PORT"
      expect_closed "$CTR_KA" "$CM_ADDR" "$CM_PORT"
      docker inspect "$PA_API_CONTAINER" >/dev/null 2>&1 && expect_closed "$PA_API_CONTAINER" "$CM_ADDR" "$CM_PORT"
    fi
  else
    local before_cm="$bad" gw="${PA_SUBNET_CMBRIDGE%.0/*}.1" t
    # CF Meet Admin: no other destination behind the allowlist (internet, DNS, the host, other ports on the bridge host).
    expect_closed "$CTR_CM" 1.1.1.1 53
    expect_closed "$CTR_CM" "$gw" 22
    expect_closed "$CTR_CM" "$CM_ADDR" "$((CM_PORT + 1))"
    # Nothing else on the HQ side reaches the bridge.
    expect_closed "$CTR_PIC" "$CM_ADDR" "$CM_PORT"
    expect_closed "$CTR_KA" "$CM_ADDR" "$CM_PORT"
    docker inspect "$PA_API_CONTAINER" >/dev/null 2>&1 && expect_closed "$PA_API_CONTAINER" "$CM_ADDR" "$CM_PORT"
    # The one allowed flow. A tunnel that is not up yet is PENDING_EXTERNAL, never a pass.
    t="$(tcp_from "$CTR_CM" "$CM_ADDR" "$CM_PORT")"
    if [[ "$bad" != "$before_cm" ]]; then check bridge_network_reachable_only_from_cfmeet FAIL "CF Meet Bridge $CM_ADDR:$CM_PORT: ${bad#"$before_cm"}"
    elif [[ "$t" == OPEN ]]; then check bridge_network_reachable_only_from_cfmeet PASS "CF Meet Admin reaches $CM_ADDR:$CM_PORT over the tunnel; every other destination closed; PIC, Karryam Admin and the API cannot reach it"
    else check bridge_network_reachable_only_from_cfmeet PENDING_EXTERNAL "tunnel or CF Meet Bridge not reachable yet ($CM_ADDR:$CM_PORT $t); isolation verified"; fi
  fi
  if docker inspect "$PA_API_CONTAINER" >/dev/null 2>&1; then expect_closed "$PA_API_CONTAINER" karryam-admin-db 5432; expect_closed "$PA_API_CONTAINER" cfmeet-admin-db 5432; fi
  if [[ -z "$bad" ]]; then check network_flows PASS "$good"; else check network_flows FAIL "$bad"; fi
}

# ---------------------------------------------------------------------------
psql_kdb() { docker exec -i "$CTR_KDB" sh -c 'PGPASSWORD="$(cat /run/secrets/karryam-admin-db/postgres-password)" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -tA "$@"' _ "$@"; }
psql_cdb() { docker exec -i "$CTR_CDB" sh -c 'PGPASSWORD="$(cat /run/secrets/cfmeet-admin-db/postgres-password)" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -tA "$@"' _ "$@"; }
psql_hq() { docker exec -i "$PA_HQ_DB_CONTAINER" sh -c 'psql -U "${POSTGRES_USER:-postgres}" -v ON_ERROR_STOP=1 -tA "$@"' _ "$@"; }

db_audit() {
  local bad="" pending=""
  if running "$CTR_KDB"; then
    local r; r="$(psql_kdb -d postgres -c "SELECT string_agg(rolname || ':' || rolsuper || rolcreaterole || rolcreatedb || rolbypassrls, ',') FROM pg_roles WHERE rolname LIKE 'karryam_admin_%'" 2>/dev/null || echo ERROR)"
    if [[ "$r" == ERROR ]]; then bad+="DB-B unreadable; "
    elif [[ -z "$r" ]]; then pending+="DB-B roles not created; "
    elif [[ "$r" == *true* ]]; then bad+="a Karryam Admin role is privileged ($r); "; fi
    [[ "$(psql_kdb -d postgres -c "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'pic_%'" 2>/dev/null || echo 0)" == 0 ]] || bad+="HQ roles exist in DB-B; "
    [[ "$(psql_kdb -d postgres -c "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'cfmeet_admin_%'" 2>/dev/null || echo 0)" == 0 ]] || bad+="CF Meet Admin roles exist in DB-B; "
  else pending+="DB-B not running; "; fi
  local cmnote=""
  if ! release_cm_on; then cmnote="; CF Meet Admin database not audited (not part of this release)"
  elif running "$CTR_CDB"; then
    local c; c="$(psql_cdb -d postgres -c "SELECT string_agg(rolname || ':' || rolsuper || rolcreaterole || rolcreatedb || rolbypassrls, ',') FROM pg_roles WHERE rolname LIKE 'cfmeet_admin_%'" 2>/dev/null || echo ERROR)"
    if [[ "$c" == ERROR ]]; then bad+="CF Meet Admin database unreadable; "
    elif [[ -z "$c" ]]; then pending+="CF Meet Admin database roles not created; "
    elif [[ "$c" == *true* ]]; then bad+="a CF Meet Admin role is privileged ($c); "; fi
    [[ "$(psql_cdb -d postgres -c "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'pic_%' OR rolname LIKE 'karryam_admin_%'" 2>/dev/null || echo 0)" == 0 ]] || bad+="HQ or Karryam Admin roles exist in the CF Meet Admin database; "
  else pending+="CF Meet Admin database not running; "; fi
  if docker inspect "$PA_HQ_DB_CONTAINER" >/dev/null 2>&1; then
    local h; h="$(psql_hq -d "$PA_HQ_DB_NAME" -c "SELECT string_agg(rolname || ':' || rolsuper || rolcreaterole || rolcreatedb || rolbypassrls, ',') FROM pg_roles WHERE rolname LIKE 'pic_%'" 2>/dev/null || echo ERROR)"
    if [[ "$h" == ERROR ]]; then bad+="DB-A unreadable; "
    elif [[ -z "$h" ]]; then pending+="DB-A PIC roles not created; "
    elif [[ "$h" == *true* ]]; then bad+="a PIC role is privileged ($h); "; fi
    [[ "$(psql_hq -d "$PA_HQ_DB_NAME" -c "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'karryam_admin_%'" 2>/dev/null || echo 0)" == 0 ]] || bad+="Karryam Admin roles exist in DB-A; "
    [[ "$(psql_hq -d "$PA_HQ_DB_NAME" -c "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'cfmeet_admin_%'" 2>/dev/null || echo 0)" == 0 ]] || bad+="CF Meet Admin roles exist in DB-A; "
    local acl; acl="$(psql_hq -d "$PA_HQ_DB_NAME" -c "SELECT coalesce(datacl::text, 'DEFAULT') FROM pg_database WHERE datname = '$PA_HQ_DB_NAME'" 2>/dev/null || echo ERROR)"
    if [[ "$acl" == DEFAULT || "$acl" =~ (\{|,)=[A-Za-z]*c ]]; then pending+="PUBLIC still holds CONNECT on $PA_HQ_DB_NAME (operator decision, runbook 9.1); "; fi
  else pending+="DB-A container $PA_HQ_DB_CONTAINER not found; "; fi
  if [[ -n "$bad" ]]; then check db_roles_separated FAIL "$bad"
  elif [[ -n "$pending" ]]; then check db_roles_separated PENDING_EXTERNAL "$pending"
  else check db_roles_separated PASS "migration/runtime roles unprivileged; no cross-database roles; DB-B on its own server$cmnote"; fi
}

backup() {
  require_root
  local ts d; ts="$(date -u +%Y%m%dT%H%M%SZ)"; d="$PA_HOST_ROOT/backups/$ts"
  install -d -m 0700 "$d"
  local parts=()
  if docker inspect "$PA_HQ_DB_CONTAINER" >/dev/null 2>&1; then
    docker exec "$PA_HQ_DB_CONTAINER" sh -c 'pg_dump -U "${POSTGRES_USER:-postgres}" -Fc "$1"' _ "$PA_HQ_DB_NAME" > "$d/db-a-$PA_HQ_DB_NAME.dump"
    parts+=("db-a-$PA_HQ_DB_NAME.dump:$(docker inspect -f '{{.Config.Image}}' "$PA_HQ_DB_CONTAINER")")
  fi
  if running "$CTR_KDB" && [[ "$(psql_kdb -d postgres -c "SELECT count(*) FROM pg_database WHERE datname='karryam_admin'" 2>/dev/null || echo 0)" == 1 ]]; then
    docker exec "$CTR_KDB" sh -c 'PGPASSWORD="$(cat /run/secrets/karryam-admin-db/postgres-password)" pg_dump -h 127.0.0.1 -U postgres -Fc karryam_admin' > "$d/db-b-karryam_admin.dump"
    parts+=("db-b-karryam_admin.dump:$(docker inspect -f '{{.Config.Image}}' "$CTR_KDB")")
  fi
  if ! release_cm_on; then echo "CF Meet Admin database not backed up: not part of this release."
  elif running "$CTR_CDB" && [[ "$(psql_cdb -d postgres -c "SELECT count(*) FROM pg_database WHERE datname='cfmeet_admin'" 2>/dev/null || echo 0)" == 1 ]]; then
    docker exec "$CTR_CDB" sh -c 'PGPASSWORD="$(cat /run/secrets/cfmeet-admin-db/postgres-password)" pg_dump -h 127.0.0.1 -U postgres -Fc cfmeet_admin' > "$d/db-cfmeet-cfmeet_admin.dump"
    parts+=("db-cfmeet-cfmeet_admin.dump:$(docker inspect -f '{{.Config.Image}}' "$CTR_CDB")")
  fi
  (( ${#parts[@]} )) || { check backup_restorable PENDING_EXTERNAL "no database to back up yet"; return; }
  (cd "$d" && sha256sum ./*.dump > SHA256SUMS)
  # Restore drill: each dump into a disposable, network-less server of the same image.
  local p ok=1 detail=""
  for p in "${parts[@]}"; do
    local f="${p%%:*}" image="${p#*:}" name pw; name="pa-restore-$ts-$RANDOM"; pw="$(head -c 18 /dev/urandom | base64 | tr -dc A-Za-z0-9)"
    docker run -d --rm --name "$name" --network none -e POSTGRES_PASSWORD="$pw" -v "$d:/backup:ro" "$image" >/dev/null
    for _ in $(seq 1 30); do docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres 2>/dev/null && break; sleep 2; done
    local listed restored
    # The archive must list cleanly; then count its table-data entries (0 is valid for an empty database).
    if docker exec "$name" pg_restore --list "/backup/$f" > /dev/null 2>&1; then
      listed="$(docker exec "$name" sh -c 'pg_restore --list "/backup/$1" | grep -c " TABLE DATA " || true' _ "$f")"
    else
      listed=-1
    fi
    if docker exec "$name" sh -c 'createdb -U postgres restored && pg_restore -U postgres --no-owner --no-privileges --exit-on-error -d restored "/backup/$1"' _ "$f" >/dev/null 2>&1; then
      restored="$(docker exec "$name" psql -U postgres -d restored -tAc "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")"
      detail+="$f: $listed table data entries, $restored tables restored; "
      [[ "$listed" -ge 0 && "$restored" -ge "$listed" ]] || ok=0
    else ok=0; detail+="$f: restore failed; "; fi
    docker rm -f "$name" >/dev/null 2>&1 || true
  done
  printf '{"backup":"%s","files":"%s","restore_verified":%s}\n' "$ts" "$(cut -c1-12 "$d/SHA256SUMS" | tr '\n' ' ')" "$([[ $ok == 1 ]] && echo true || echo false)" > "$d/backup-evidence.json"
  if (( ok )); then check backup_restorable PASS "backup $ts checksummed and restored into a disposable server: $detail"; else check backup_restorable FAIL "$detail"; fi
}

latest_verified_backup_age_ok() {
  local last; last="$(ls -1d "$PA_HOST_ROOT"/backups/*/ 2>/dev/null | sort | tail -n 1)"
  [[ -n "$last" && -f "$last/backup-evidence.json" ]] || return 1
  grep -q '"restore_verified":true' "$last/backup-evidence.json" || return 1
  (cd "$last" && sha256sum -c --quiet SHA256SUMS) || return 1
  (( $(date +%s) - $(stat -c %Y "$last/backup-evidence.json") < 86400 ))
}

migrate_service() { # mode service
  local mode="$1" svc="$2" image net envf user
  [[ -f "$RELEASE_DIR/images.env" ]] || { check "migration_${mode}_$svc" NOT_RUN "no deployed release images"; return; }
  if [[ "$svc" == cfmeet ]] && ! release_cm_on; then skipped "migration_${mode}_$svc"; return; fi
  if [[ "$svc" == pic ]]; then image="$(grep '^PIC_IMAGE=' "$RELEASE_DIR/images.env" | cut -d= -f2)"; net=cf-staging-hq-private; envf="$PA_CONFIG_ROOT/product-integration-core.migrate.env"; user=10002:10002
  elif [[ "$svc" == cfmeet ]]; then image="$(grep '^CFMEET_ADMIN_IMAGE=' "$RELEASE_DIR/images.env" | cut -d= -f2)"; net=cf-staging-cfmeet-admin-db; envf="$PA_CONFIG_ROOT/cfmeet-admin.migrate.env"; user=10003:10003
  else image="$(grep '^KARRYAM_ADMIN_IMAGE=' "$RELEASE_DIR/images.env" | cut -d= -f2)"; net=cf-staging-karryam-admin-db; envf="$PA_CONFIG_ROOT/karryam-admin.migrate.env"; user=10001:10001; fi
  [[ -f "$envf" ]] || { check "migration_${mode}_$svc" PENDING_EXTERNAL "operator migration env file missing"; return; }
  local args=(--rm --network "$net" --read-only --cap-drop ALL --security-opt no-new-privileges --user "$user" --env-file "$envf" "$image" node scripts/migrate.js)
  [[ "$mode" == preview ]] && args+=(--preview)
  local out rc=0; out="$(docker run "${args[@]}" 2>&1)" || rc=$?
  printf '%s\n' "$out" | grep -E '"event":"(preview|migration_preview|done|migrations_complete)"' | sed -E 's/postgres(ql)?:\/\/[^ "]*/[redacted-url]/g' | tail -n 1 | cut -c1-600
  if (( rc == 0 )) && { [[ "$mode" == apply ]] || printf '%s' "$out" | grep -q '"ok":true'; }; then check "migration_${mode}_$svc" PASS "$svc $mode ok"; else check "migration_${mode}_$svc" FAIL "$svc $mode exit $rc"; fi
}

migrate_preview() { migrate_service preview pic; migrate_service preview karryam; migrate_service preview cfmeet; }
migrate_apply() {
  require_root
  latest_verified_backup_age_ok || die "no verified, restorable backup from the last 24 hours: run backup first"
  FAILED=0; migrate_preview; (( FAILED )) && die "migration preview failed; nothing applied"
  migrate_service apply pic; migrate_service apply karryam; migrate_service apply cfmeet
  FAILED=0; migrate_preview
}

disable() {
  require_root
  [[ -f "$RELEASE_DIR/images.env" ]] || die "nothing deployed"
  compose stop karryam-admin-worker karryam-admin product-integration-core
  # CF Meet Admin (if in this release) stops too; its database is preserved like DB-B.
  stop_cfmeet "$CTR_CW" "$CTR_CM"
  echo "DISABLED: Product Admin services stopped; DB-B, data, receipts and evidence preserved."
}

rollback() {
  require_root
  [[ -f "$RELEASE_DIR/previous-images.env" ]] || die "no previous release recorded"
  restore_previous
  FAILED=0
  verify_deploy "$(grep '^PIC_IMAGE=' "$RELEASE_DIR/images.env" | cut -d= -f2)" "$(grep '^KARRYAM_ADMIN_IMAGE=' "$RELEASE_DIR/images.env" | cut -d= -f2)"
  (( FAILED )) && exit 1 || true
}

attach_gateway() {
  require_root
  [[ -d "$PA_API_DIR" && -f "$PA_API_DIR/docker-compose.yml" ]] || die "Central Admin API deployment directory not found"
  [[ -S "$PIC_SOCK" ]] || die "PIC socket not present: deploy first"
  local f="$PA_API_DIR/docker-compose.product-admin-gateway.yml"
  printf 'services:\n  app:\n    volumes:\n      - type: bind\n        source: %s/run/pic\n        target: /run/cosmicforge/pic\n        read_only: true\n' "$PA_HOST_ROOT" > "$f.new"
  chmod 0644 "$f.new"; mv "$f.new" "$f"
  echo "Wrote $f. The next Central Admin API staging release (staging.yml) mounts the PIC socket read-only;"
  echo "PRODUCT_INTEGRATION_CORE_SOCKET_PATH=/run/cosmicforge/pic/product-integration-core.sock and PRODUCT_INTEGRATION_ENABLED in the API env file stay operator decisions."
}

status() {
  echo "== containers"; docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}} {{.Status}} {{.Image}}' || true
  echo "== release"; [[ -f "$RELEASE_DIR/images.env" ]] && grep -E '^(PIC_IMAGE|KARRYAM_ADMIN_IMAGE|CFMEET_ADMIN_IMAGE|PA_RELEASE_SHA)=' "$RELEASE_DIR/images.env" || echo "nothing deployed"
  echo "== health"; echo "PIC live $(sock_status "$PIC_SOCK" /health/live) ready $(sock_status "$PIC_SOCK" /health/ready); Karryam Admin live $(sock_status "$KA_SOCK" /health/live) ready $(sock_status "$KA_SOCK" /health/ready)"
  echo "== sync"; [[ -S "$KA_SOCK" ]] && curl -s --max-time 5 --unix-socket "$KA_SOCK" http://local/sync/status | head -c 4000; echo
  if release_cm_on; then
    echo "== CF Meet Admin"; echo "live $(sock_status "$CM_SOCK" /health/live) ready $(sock_status "$CM_SOCK" /health/ready)"
    [[ -S "$CM_SOCK" ]] && curl -s --max-time 5 --unix-socket "$CM_SOCK" http://local/sync/status | head -c 4000; echo
  else
    echo "== CF Meet Admin: not part of this release"
  fi
}

LOCK="/run/lock/cf-product-admin-staging.lock"
[[ "$PA_REHEARSAL" == 1 ]] && LOCK="${PA_HOST_ROOT}.lock"
exec 9> "$LOCK"
flock -n 9 || die "another Product Admin staging operation is running"

# Keep the latest log of every operation on the host; the workflow builds
# stage evidence from these (never from memory or from a different run).
if [[ -d "$RELEASE_DIR" ]]; then
  install -d -m 0700 "$RELEASE_DIR/logs"
  exec > >(tee "$RELEASE_DIR/logs/$OP.log") 2>&1
fi

case "$OP" in
  prepare-host) prepare_host ;;
  preflight) preflight; db_audit ;;
  network-probe) network_probe ;;
  db-audit) db_audit ;;
  backup) backup ;;
  migrate-preview) migrate_preview ;;
  migrate-apply) migrate_apply ;;
  deploy) deploy; network_probe ;;
  rollback) rollback ;;
  disable) disable ;;
  attach-gateway) attach_gateway ;;
  status) status ;;
  *) echo "usage: $0 prepare-host|preflight|network-probe|db-audit|backup|migrate-preview|migrate-apply|deploy|rollback|disable|attach-gateway|status"; exit 2 ;;
esac
exit "$FAILED"
