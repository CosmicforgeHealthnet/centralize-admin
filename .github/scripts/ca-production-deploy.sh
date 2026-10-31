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
#
# Mail worker: with Mail enabled the worker must really process work, not just
# exist. A worker that exited (even with code 0), restart-loops, runs another
# image or another database, serves no core queue, or does not complete an
# isolated self-test job fails the deploy and rolls back app and worker.
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
# Who holds a lock file: "PID command;" per locking process (or empty).
lock_holder() {
  local ino; ino="$(stat -c %i "$1" 2>/dev/null)" || return 0
  awk -v ino="$ino" '$2 == "FLOCK" { n = split($6, a, ":"); if (a[n] == ino) print $5 }' /proc/locks | sort -u | while read -r pid; do
    [[ "$pid" == "$$" ]] && continue
    printf '%s %s;' "$pid" "$( { tr '\0' ' ' < "/proc/$pid/cmdline"; } 2>/dev/null | cut -c1-160)"
  done
}
# The DB isolation lock is also taken (shared) by short read-only Mail checks.
# A running cutover is never overlapped: refuse at once. Any other holder is
# waited for (at most 10 minutes); the lock is never removed or bypassed.
readonly DB_LOCK=/run/lock/centralize-admin-db-isolation.lock
exec 9>"$DB_LOCK"
if ! flock -n 9; then
  holder="$(lock_holder "$DB_LOCK")"
  if [[ "$holder" == *cutover* ]]; then
    echo "The CA database isolation cutover is running (holder: $holder); refusing overlap. Nothing changed." >&2; exit 1
  fi
  echo "The CA DB isolation lock is held by another CA operation (holder: ${holder:-unknown}); waiting up to 10 minutes for it to finish."
  flock -w 600 9 || { echo "The CA DB isolation lock is still held after 10 minutes (holder: $(lock_holder "$DB_LOCK")); refusing overlap. Nothing changed." >&2; exit 1; }
  echo 'The CA DB isolation lock was released; continuing.'
fi

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

# The image override pins the release; the Mail storage mounts file (store
# volume + read-only keyring, written by ca-mail-staging-ops --storage-setup)
# is kept on every deploy and rollback.
compose_files() {
  printf '%s\n' -f docker-compose.yml
  [[ -f "$OVERRIDE" ]] && printf '%s\n' -f "$OVERRIDE"
  [[ -f "$ROOT/docker-compose.mail-storage.yml" ]] && printf '%s\n' -f "$ROOT/docker-compose.mail-storage.yml"
  return 0
}
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

verify_internal() { # [attempts] Prisma on cosmicforge_admin, AdminUser, /health, synthetic login 401, Mail mounts
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
    then mail_mounts_ok && return 0; fi
    sleep 2
  done
  return 1
}

# When self-hosted Mail storage is set up, the app must come back with the
# store volume and the read-only keyring mounted (a release that lost them
# is rolled back like any other failed check).
mail_mounts_ok() {
  [[ -f "$ROOT/docker-compose.mail-storage.yml" ]] || return 0
  local m; m="$(docker inspect -f '{{range .Mounts}}{{.Name}}|{{.Source}}|{{.Destination}}|{{.RW}};{{end}}' "$APP")"
  [[ "$m" == *"|/var/lib/cosmicforge-mail|true;"* && "$m" == *"|/etc/cosmicforge-mail/production/keyring|/run/secrets/cosmicforge-mail|false;"* ]] && return 0
  echo '  app is missing the Mail store or keyring mount' >&2
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

mail_on() { [[ ",$(mail_flags)," == *,MAIL_ENABLED=true,* ]]; }
# Core Mail processing is backend-managed: with Mail on the worker runs unless
# MAIL_WORKER_ENABLED=false (an explicit emergency shutdown).
worker_expected() { mail_on && [[ ",$(mail_flags)," != *,MAIL_WORKER_ENABLED=false,* ]]; }

worker_db() { # database name the worker's own Prisma client is connected to
  { docker exec -i -w /app "$WORKER" node - 2>/dev/null <<'NODE' || true; } | grep -E '^DB ' | tail -n 1 | cut -c4- || true
const { prisma } = require('./src/shared/config/database');
prisma.$queryRawUnsafe('SELECT current_database() AS name').then((r) => process.stdout.write('DB ' + (r[0]?.name || '') + '\n')).catch(() => process.stdout.write('DB ?\n')).finally(() => prisma.$disconnect());
NODE
}

# Verifies the worker after (re)creation. Mail off / worker shut down: an idle
# (running) or, on older images, cleanly exited worker is accepted. Mail on:
# running, stable (no restart loop), restart policy survives reboots, same
# image as the app, same database as the app, and (images with
# scripts/mail/verify-worker.js) a fresh heartbeat for this release serving
# every core queue plus a completed isolated self-test job.
verify_worker() {
  local image="$1" i st code restarts0 restarts1 policy
  for ((i = 0; i < 30; i++)); do
    st="$(docker inspect -f '{{.State.Status}}' "$WORKER")"
    [[ "$st" == running || "$st" == exited ]] && break; sleep 2
  done
  sleep 5
  st="$(docker inspect -f '{{.State.Status}}' "$WORKER")"; code="$(docker inspect -f '{{.State.ExitCode}}' "$WORKER")"
  [[ "$(docker inspect -f '{{.Config.Image}}' "$WORKER")" == "$image" ]] || { fail "production Mail worker runs $(docker inspect -f '{{.Config.Image}}' "$WORKER"), not $image"; return 1; }
  if ! worker_expected; then
    if [[ "$st" == running || ( "$st" == exited && "$code" == 0 ) ]]; then
      pass "production Mail worker on the app image; idle by configuration (Mail flags: $(mail_flags); $st)"; return 0
    fi
    fail "production Mail worker: status $st exit $code (Mail off; expected an idle worker)"; return 1
  fi
  [[ "$st" == running ]] || { fail "production Mail worker is not running (status $st, exit $code) although Mail is enabled; an exited worker is never healthy"; return 1; }
  restarts0="$(docker inspect -f '{{.RestartCount}}' "$WORKER")"; sleep 15
  st="$(docker inspect -f '{{.State.Status}}' "$WORKER")"; restarts1="$(docker inspect -f '{{.RestartCount}}' "$WORKER")"
  [[ "$st" == running && "$restarts1" == "$restarts0" ]] || { fail "production Mail worker is not stable (status $st, restarts $restarts0 -> $restarts1)"; return 1; }
  policy="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$WORKER")"
  [[ "$policy" == unless-stopped || "$policy" == always ]] || { fail "production Mail worker restart policy is $policy (must survive crashes and reboots: unless-stopped)"; return 1; }
  local wdb; wdb="$(worker_db)"
  [[ "$wdb" == "$DEST_DB" && "$(runtime_db)" == "$DEST_DB" ]] || { fail "production Mail worker database is '${wdb:-unknown}', the app's is '$(runtime_db)' (must both be $DEST_DB)"; return 1; }
  pass "production Mail worker running, stable, restart=$policy, same image and database ($DEST_DB) as the app"
  if docker exec "$APP" test -f /app/scripts/mail/verify-worker.js; then
    local out
    # Verdict comes from the JSON line (the exit code is non-zero on failure).
    out="$(docker exec -w /app "$APP" node scripts/mail/verify-worker.js --expect-release "$image" --wait 150 2>/dev/null | grep '^CA_MAIL_WORKER_VERIFY ' | tail -n 1 || true)"
    out="${out#CA_MAIL_WORKER_VERIFY }"
    if python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d.get("ok") and d.get("checks",{}).get("selfTest") else 1)' "$out" 2>/dev/null; then
      pass "production Mail worker processes work: heartbeat for this release on $DEST_DB, core queues served, isolated self-test job completed ($(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print("queues=" + ",".join(d.get("coreQueues", [])) + " selfTestSeconds=" + str(d.get("selfTest", {}).get("latencySeconds")))' "$out"))"
      info "Mail queues after deploy: $(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1]).get("queues")))' "$out" 2>/dev/null)"
    else
      fail "production Mail worker did not prove processing: ${out:-no output}"; return 1
    fi
  else
    info 'this image predates worker heartbeats (scripts/mail/verify-worker.js): verified running, stable, image and database only'
  fi
}

sync_worker() { # recreate the production Mail worker with the app's image, then verify it
  if ! docker inspect "$WORKER" >/dev/null 2>&1; then
    if worker_expected; then
      fail "Mail is enabled but no production Mail worker is deployed (run CA Mail operations: services-deploy, target production)"; return 4
    fi
    info 'no production Mail worker deployed; Mail is off (nothing to sync)'; return 0
  fi
  local image; image="$(docker inspect -f '{{.Config.Image}}' "$APP")"
  [[ -f "$WORKER_ROOT/docker-compose.yml" ]] || { fail "production Mail worker exists but $WORKER_ROOT/docker-compose.yml is missing"; return 1; }
  # Same image as the app, the release recorded in its heartbeat, and (Mail
  # on) a restart policy that survives crashes and server reboots.
  { printf 'services:\n  mail-worker:\n    image: %s\n    pull_policy: never\n' "$image"
    worker_expected && printf '    restart: unless-stopped\n'
    printf '    environment:\n      MAIL_RELEASE_IMAGE: "%s"\n' "$image"
  } > "$WORKER_ROOT/docker-compose.release.yml"
  (cd "$WORKER_ROOT" && env -i HOME=/root PATH="$SAFE_PATH" docker compose -f docker-compose.yml -f docker-compose.release.yml up -d --no-deps --no-build --pull never --force-recreate mail-worker) >/dev/null
  verify_worker "$image"
}

rollback() {
  armed=false
  echo 'ROLLBACK: restoring the previous production image.' >&2
  set_override "$rollback_tag"
  if recreate_app >&2 && verify_internal 45; then
    fail "deploy rolled back; previous image verified (runtime DB, Prisma, health, login 401) under $rollback_tag"
    sync_worker || fail 'Mail worker on the previous image did not verify (see above)'
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
  # Mail worker state as it is now (read-only; reported, never gating).
  if docker inspect "$WORKER" >/dev/null 2>&1; then
    info "Mail worker now: $(docker inspect -f 'status={{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}} policy={{.HostConfig.RestartPolicy.Name}} image={{.Config.Image}}' "$WORKER")"
    if docker exec "$APP" test -f /app/scripts/mail/verify-worker.js 2>/dev/null; then
      info "Mail worker heartbeat now: $(docker exec -w /app "$APP" node scripts/mail/verify-worker.js --no-self-test --wait 5 2>/dev/null | grep '^CA_MAIL_WORKER_VERIFY ' | tail -n 1 | cut -c23-900)"
    fi
  elif worker_expected; then
    info 'Mail is enabled but no production Mail worker is deployed'
  fi
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
  pass "production app runs $IMAGE_TAG; Mail flags unchanged: $flags_before"
  # Still armed: a worker that does not prove processing rolls back app and
  # worker together. A missing worker (exit 4) is an infrastructure gap, not
  # a release defect: reported as a failure without rolling the app back.
  local wrc=0
  sync_worker || wrc=$?
  if [[ "$wrc" == 4 ]]; then armed=false; return 4; fi
  [[ "$wrc" == 0 ]] || return 1
  armed=false
  pass "production release $IMAGE_TAG complete (app and Mail worker verified)"
}

case "$mode" in
  --preflight) preflight ;;
  --deploy) deploy ;;
esac
