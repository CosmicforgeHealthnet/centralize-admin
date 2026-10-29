#!/usr/bin/env bash
# Guarded deploy of the Centralize Admin PRODUCTION API (root, Contabo VPS),
# run by .github/workflows/production.yml.
#
#   --preflight            READ-ONLY: identity, runtime database, baseline checks
#   --deploy <params-file> deploy one immutable image (params file: IMAGE_TAG,
#                          GHCR_USER, GHCR_TOKEN; 0600, deleted after reading)
#
# The image is pinned through /var/www/admin-server/docker-compose.release.yml
# (only `services.app.image`), so the base Compose file and .env are never
# edited. Only admin-server-app-1 (and, when present, the production Mail
# worker) is recreated. Every check must pass before and after; any failure
# restores the previous image (kept under a local rollback tag) and verifies it.
# Never touches the database, staging, RTC or any other project.
set -Eeuo pipefail
umask 077
export LC_ALL=C

readonly ROOT=/var/www/admin-server
readonly APP=admin-server-app-1
readonly DB=admin-server-db-1
readonly PROJECT=admin-server
readonly DEST_DB=cosmicforge_admin
readonly OVERRIDE="$ROOT/docker-compose.release.yml"
readonly WORKER_ROOT=/var/www/admin-server-mail
readonly WORKER=admin-server-mail-mail-worker
PUBLIC_API=https://liveca.cosmicforge-healthnet.com
PUBLIC_ORIGIN=https://centralize-admin.vercel.app
# Disposable-replica tests only (the marker never exists on the VPS).
if [[ -f "$ROOT/.ca-replica" && -n "${CA_REPLICA_PUBLIC_API:-}" ]]; then PUBLIC_API="$CA_REPLICA_PUBLIC_API"; fi
readonly PUBLIC_API PUBLIC_ORIGIN
readonly IMAGE_PATTERN='^ghcr\.io/cosmicforgehealthnet/admin-backend:production-[0-9a-f]{40}$'
readonly SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly RUN_ID

mode="${1:-}"
case "$mode" in --preflight) [[ -z "${2:-}" ]] ;; --deploy) [[ -f "${2:-}" ]] ;; *) false ;; esac \
  || { echo 'Usage (root): ca-production-deploy.sh --preflight | --deploy <params-file>' >&2; exit 2; }
[[ "$(id -u)" -eq 0 ]] || { echo 'Run as root.' >&2; exit 2; }

IMAGE_TAG='' GHCR_USER='' GHCR_TOKEN=''
if [[ "$mode" == --deploy ]]; then
  while IFS='=' read -r k v; do
    case "$k" in IMAGE_TAG) IMAGE_TAG="$v" ;; GHCR_USER) GHCR_USER="$v" ;; GHCR_TOKEN) GHCR_TOKEN="$v" ;; esac
  done < "$2"
  rm -f "$2"
  [[ "$IMAGE_TAG" =~ $IMAGE_PATTERN ]] || { echo 'IMAGE_TAG is not an immutable production image of admin-backend.' >&2; exit 2; }
fi

mkdir -p /run/lock
exec 7>/run/lock/centralize-admin-production-deploy.lock
flock -n 7 || { echo 'Another production deploy is running; refusing overlap. Nothing changed.' >&2; exit 1; }
exec 9>/run/lock/centralize-admin-db-isolation.lock
flock -n 9 || { echo 'The CA database isolation cutover is running; refusing overlap. Nothing changed.' >&2; exit 1; }

run_dir="/var/backups/centralize-admin/production-deploy-$RUN_ID"
mkdir -p /var/backups/centralize-admin; chmod 700 /var/backups/centralize-admin; mkdir -m 700 "$run_dir"
exec > >(exec 7>&- 9>&-; tee -a "$run_dir/run.log") 2>&1
echo "CA production deploy, run $RUN_ID, mode $mode"

declare -a SUMMARY=()
pass() { SUMMARY+=("PASS  $*"); echo "PASS: $*"; }
fail() { SUMMARY+=("FAIL  $*"); echo "FAIL: $*" >&2; }
info() { SUMMARY+=("INFO  $*"); echo "INFO: $*"; }

armed=false rollback_tag=''
snapshot_others() {
  local id
  for id in $(docker ps -aq --no-trunc); do
    docker inspect -f '{{.Id}}|{{.Name}}|{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}' "$id"
  done | grep -vE "\|/($APP|$WORKER)\|" | sort
}
others_before="$(snapshot_others)"
on_exit() {
  local code=$?
  trap - EXIT
  if [[ "$armed" == true ]]; then rollback || true; code=1; fi
  local after changed
  after="$(snapshot_others)"
  if [[ "$after" == "$others_before" ]]; then
    pass 'every other container (staging, RTC, KarryGo, CFMeet, CA databases, ...) unchanged'
  else
    changed="$(comm -3 <(sort <<<"$others_before") <(sort <<<"$after") | tr -d '\t' | cut -d'|' -f2 | sort -u | tr '\n' ' ')"
    fail "other containers changed state (names): $changed"; [[ "$code" -ne 0 ]] || code=3
  fi
  echo; echo '==================== SUMMARY ===================='
  local l; for l in "${SUMMARY[@]}"; do echo "$l"; done
  echo "Run directory (root-only): $run_dir"
  echo '================================================='
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

compose_files() { printf '%s\n' -f docker-compose.yml; [[ -f "$OVERRIDE" ]] && printf '%s\n' -f "$OVERRIDE"; return 0; }
compose() {
  local -a files; mapfile -t files < <(compose_files)
  (cd "$ROOT" && env -i HOME=/root PATH="$SAFE_PATH" docker compose "${files[@]}" "$@")
}
recreate_app() { compose up -d --no-deps --no-build --pull never --force-recreate app; }

identity() {
  local c ok=0
  for c in "$APP" "$DB"; do
    [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$c" 2>/dev/null)" == "$PROJECT" ]] || { echo "  $c not in $PROJECT"; ok=1; }
    [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" == true ]] || { echo "  $c not running"; ok=1; }
  done
  [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$APP" 2>/dev/null)" == app ]] || { echo "  $APP is not service app"; ok=1; }
  [[ -f "$ROOT/docker-compose.yml" && -f "$ROOT/.env" ]] || { echo "  $ROOT is incomplete"; ok=1; }
  return "$ok"
}

runtime_db() {
  docker inspect -f '{{json .Config.Env}}' "$APP" | python3 -c '
import json, sys, urllib.parse as u
env = dict(x.split("=", 1) for x in json.load(sys.stdin) if "=" in x)
p = u.urlsplit(env.get("DATABASE_URL", ""))
print(u.unquote(p.path.lstrip("/")) if p.hostname == "db" else "UNEXPECTED_HOST")'
}

mail_flags() {
  docker inspect -f '{{json .Config.Env}}' "$APP" | python3 -c '
import json, sys
env = dict(x.split("=", 1) for x in json.load(sys.stdin) if "=" in x)
print(",".join(f"{k}={env[k].strip().lower()}" for k in sorted(env) if k.startswith("MAIL_") and k.endswith("_ENABLED")) or "none")'
}

verify_internal() { # [attempts] Prisma on cosmicforge_admin, AdminUser, /health, synthetic login 401
  local i
  for ((i = 1; i <= ${1:-45}; i++)); do
    if docker exec -i -w /app "$APP" node - >/dev/null 2>&1 <<'NODE'
const { prisma } = require('./src/shared/config/database');
(async () => {
  const rows = await prisma.$queryRawUnsafe('SELECT current_database() AS name');
  if (rows[0]?.name !== 'cosmicforge_admin') throw new Error('db');
  await prisma.adminUser.count();
  const base = 'http://127.0.0.1:' + Number(process.env.PORT || 4000);
  if (!(await fetch(base + '/health', { signal: AbortSignal.timeout(4000) })).ok) throw new Error('health');
  const l = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ca-db-synthetic-probe@example.invalid', password: 'not-a-real-password' }), signal: AbortSignal.timeout(8000) });
  if (l.status !== 401) throw new Error('login');
})().catch(() => { process.exitCode = 1; }).finally(() => prisma.$disconnect());
NODE
    then return 0; fi
    sleep 2
  done
  return 1
}

verify_public() { # public HTTPS health and browser CORS from the production frontend
  local h c i
  for ((i = 0; i < 10; i++)); do
    h="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$PUBLIC_API/health" 2>/dev/null || true)"
    c="$(curl -sS --max-time 10 -o /dev/null -D - -X OPTIONS -H "Origin: $PUBLIC_ORIGIN" \
        -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type' \
        "$PUBLIC_API/api/auth/login" 2>/dev/null | tr -d '\r' | grep -ci "^access-control-allow-origin: $PUBLIC_ORIGIN\$" || true)"
    [[ "$h" == 200 && "$c" == 1 ]] && return 0
    sleep 3
  done
  echo "  public health $h, CORS allowed for $PUBLIC_ORIGIN: $c" >&2
  return 1
}

set_override() { # image -> pins services.app.image (atomic, root-only)
  local tmp; tmp="$(mktemp "$ROOT/.release-XXXXXX")"
  printf '# Managed by .github/scripts/ca-production-deploy.sh\nservices:\n  app:\n    image: %s\n    pull_policy: never\n' "$1" > "$tmp"
  chmod 600 "$tmp"; mv -f "$tmp" "$OVERRIDE"
}

sync_worker() { # recreate the production Mail worker (if deployed) with the app's image
  docker inspect "$WORKER" >/dev/null 2>&1 || { info 'no production Mail worker deployed; nothing to sync'; return 0; }
  local image; image="$(docker inspect -f '{{.Config.Image}}' "$APP")"
  [[ -f "$WORKER_ROOT/docker-compose.yml" ]] || { fail "production Mail worker exists but $WORKER_ROOT/docker-compose.yml is missing"; return 1; }
  printf 'services:\n  mail-worker:\n    image: %s\n    pull_policy: never\n' "$image" > "$WORKER_ROOT/docker-compose.release.yml"
  (cd "$WORKER_ROOT" && env -i HOME=/root PATH="$SAFE_PATH" docker compose -f docker-compose.yml -f docker-compose.release.yml up -d --no-deps --no-build --pull never --force-recreate mail-worker) >/dev/null
  sleep 8
  local st code; st="$(docker inspect -f '{{.State.Status}}' "$WORKER")"; code="$(docker inspect -f '{{.State.ExitCode}}' "$WORKER")"
  if [[ "$st" == running || ( "$st" == exited && "$code" == 0 ) ]] && [[ "$(docker inspect -f '{{.Config.Image}}' "$WORKER")" == "$image" ]]; then
    pass "production Mail worker now runs the same image as the app ($st)"
  else
    fail "production Mail worker: status $st exit $code after sync"; return 1
  fi
}

rollback() {
  armed=false
  echo 'ROLLBACK: restoring the previous production image.' >&2
  set_override "$rollback_tag"
  if recreate_app >&2 && verify_internal 45; then
    fail "deploy rolled back; previous image verified (runtime DB, Prisma, health, login 401) under $rollback_tag"
    sync_worker || true
  else
    fail "ROLLBACK DID NOT VERIFY. Previous image is tagged $rollback_tag; $OVERRIDE pins it. Inspect $APP."
  fi
}

preflight() {
  identity || { fail 'production identity'; return 1; }
  pass "production containers and Compose project ($PROJECT)"
  [[ "$(runtime_db)" == "$DEST_DB" ]] || { fail "production app does not run on $DEST_DB"; return 1; }
  pass "production app runs on $DEST_DB"
  verify_internal 3 && pass 'baseline: Prisma, AdminUser, health, synthetic login 401' || { fail 'baseline internal checks'; return 1; }
  verify_public && pass "baseline: $PUBLIC_API/health 200 and CORS for $PUBLIC_ORIGIN" || { fail 'baseline public checks'; return 1; }
  info "running image: $(docker inspect -f '{{.Config.Image}}' "$APP") ($(docker inspect -f '{{.Image}}' "$APP" | cut -c1-19)); release override: $([[ -f "$OVERRIDE" ]] && echo present || echo absent); Mail flags: $(mail_flags)"
  compose config -q && pass 'Compose resolves the production configuration' || { fail 'Compose cannot resolve the production configuration'; return 1; }
}

deploy() {
  preflight || return 1
  local old_id flags_before new_id
  old_id="$(docker inspect -f '{{.Image}}' "$APP")"
  flags_before="$(mail_flags)"
  rollback_tag="cf-admin-api:production-rollback-${RUN_ID//[^0-9A-Za-z]/-}"
  docker image tag "$old_id" "$rollback_tag"
  info "previous image kept as $rollback_tag"
  # Pull with a throwaway registry login; the token is never stored on the VPS.
  local auth; auth="$(mktemp -d)"
  ( export DOCKER_CONFIG="$auth"
    printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USER" --password-stdin >/dev/null
    docker pull -q "$IMAGE_TAG" >/dev/null
    docker logout ghcr.io >/dev/null 2>&1 || true ) || { rm -rf "$auth"; fail "could not pull $IMAGE_TAG"; return 1; }
  rm -rf "$auth"; GHCR_TOKEN=''
  new_id="$(docker image inspect -f '{{.Id}}' "$IMAGE_TAG")"
  pass "pulled $IMAGE_TAG ($(cut -c1-19 <<<"$new_id"))"
  armed=true
  set_override "$IMAGE_TAG"
  recreate_app
  [[ "$(docker inspect -f '{{.Image}}' "$APP")" == "$new_id" ]] || { fail 'production app is not running the new image'; return 1; }
  verify_internal 60 || { fail 'new image: internal checks failed (Prisma, health or synthetic login)'; return 1; }
  pass 'new image: runtime DB cosmicforge_admin, Prisma AdminUser, health, synthetic login 401'
  verify_public || { fail 'new image: public HTTPS health/CORS failed'; return 1; }
  pass "new image: $PUBLIC_API/health 200 and CORS for $PUBLIC_ORIGIN"
  [[ "$(mail_flags)" == "$flags_before" ]] || { fail 'Mail flags changed'; return 1; }
  armed=false
  pass "production runs $IMAGE_TAG; Mail flags unchanged: $flags_before"
  sync_worker
}

case "$mode" in
  --preflight) preflight ;;
  --deploy) deploy ;;
esac
