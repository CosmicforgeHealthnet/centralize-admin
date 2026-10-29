#!/usr/bin/env bash
# Disposable replica for .github/scripts/ca-mail-staging-ops.sh (UNMODIFIED):
# a staging-shaped app container carrying the REAL migration files 27-37, and
# PostgreSQL 16 with cosmicforge_admin built by `prisma db push` of the schema
# just before migration 27 (how the staging schema was built), plus decoys.
# NEVER run on the VPS: refuses unless CA_REPLICA_TEST=1 and the host has no
# non-replica admin-server containers.
#
#   sudo CA_REPLICA_TEST=1 bash ca-mail-staging-ops-replica.sh run [--with-clamav]
set -Eeuo pipefail
export LC_ALL=C
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
ops="$repo/.github/scripts/ca-mail-staging-ops.sh"
api="$repo/services/central-admin-api"
work=/var/tmp/ca-mail-ops-replica

[[ "${CA_REPLICA_TEST:-}" == 1 && "$(id -u)" -eq 0 ]] || { echo 'Set CA_REPLICA_TEST=1 and run as root in a disposable machine.' >&2; exit 2; }
for c in $(docker ps -a --format '{{.Names}}' | grep -E '^(admin-server|cosmicforge-db$)' || true); do
  # The two containers the ops script creates carry no test label; they are
  # replica-owned only when the staging app beside them is a replica.
  if [[ "$c" =~ ^admin-server-staging-mail-(clamav|mail-worker)$ ]]; then
    [[ "$(docker inspect -f '{{index .Config.Labels "ca.replica"}}' admin-server-staging-app-1 2>/dev/null)" == 1 ]] && continue
  fi
  [[ "$(docker inspect -f '{{index .Config.Labels "ca.replica"}}' "$c")" == 1 ]] || { echo "Refusing: $c is not a replica container." >&2; exit 2; }
done

failures=0
check() { local n="$1"; shift; if "$@"; then echo "ok   - $n"; else echo "FAIL - $n"; failures=$((failures + 1)); fi; }
log() { printf '\n### %s\n' "$*"; }
psqlc() { docker exec -i admin-server-staging-db-1 psql -X -qAt -v ON_ERROR_STOP=1 -U caadmin -d "$1" "${@:2}"; }

teardown() {
  docker rm -f admin-server-staging-app-1 admin-server-staging-db-1 cosmicforge-db \
    admin-server-staging-mail-clamav admin-server-staging-mail-mail-worker >/dev/null 2>&1 || true
  docker volume rm -f admin-server-staging_postgres_data_staging admin-server-staging-mail_clamav-signatures >/dev/null 2>&1 || true
  docker network rm admin-server-staging_default >/dev/null 2>&1 || true
  rm -rf /var/www/admin-server-staging /var/www/admin-server-staging-mail "$work" /var/backups/centralize-admin
  rm -f /run/lock/centralize-admin-mail-staging.lock
}

setup() {
  teardown
  mkdir -p "$work/app/src/shared/config" "$work/app/prisma" /var/www/admin-server-staging
  cp -r "$api/prisma/manual-migrations" "$work/app/prisma/"
  cat > "$work/app/Dockerfile" <<'EOF'
FROM node:22-alpine
WORKDIR /app
COPY node_modules ./node_modules
COPY src ./src
COPY prisma ./prisma
COPY server.js ./
CMD ["node", "server.js"]
EOF
  cat > "$work/app/src/shared/config/database.js" <<'EOF'
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
module.exports.prisma = {
  async $queryRawUnsafe(sql) { return (await pool.query(sql)).rows; },
  adminUser: { async count() { return Number((await pool.query('SELECT count(*) AS n FROM admin_users')).rows[0].n); } },
  async $disconnect() { await pool.end(); },
};
EOF
  cat > "$work/app/src/mail-worker.js" <<'EOF'
const on = (v) => String(v || '').trim().toLowerCase() === 'true';
if (!on(process.env.MAIL_ENABLED) || !on(process.env.MAIL_WORKER_ENABLED)) {
  console.log('[MailWorker] MAIL_ENABLED and MAIL_WORKER_ENABLED must both be true; exiting without processing.');
  process.exit(0);
}
setInterval(() => console.log('[MailWorker] liveness'), 30000);
EOF
  cat > "$work/app/server.js" <<'EOF'
const http = require('http');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
http.createServer(async (req, res) => {
  try {
    if (req.url === '/health') { await pool.query('SELECT 1'); res.writeHead(200); return res.end('{}'); }
    if (req.url === '/api/auth/login' && req.method === 'POST') {
      let b = ''; for await (const c of req) b += c;
      const { email } = JSON.parse(b || '{}');
      const r = await pool.query('SELECT 1 FROM admin_users WHERE email = $1', [email]);
      res.writeHead(r.rowCount ? 403 : 401); return res.end('{}');
    }
    res.writeHead(404); res.end();
  } catch { res.writeHead(500); res.end(); }
}).listen(4000);
EOF
  (cd "$work/app" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund pg@8.13.1 >/dev/null)
  docker build -q -t ca-mail-replica-app:1 "$work/app" >/dev/null

  docker network create admin-server-staging_default >/dev/null
  docker run -d --name admin-server-staging-db-1 --network admin-server-staging_default --network-alias db \
    --label ca.replica=1 --label com.docker.compose.project=admin-server-staging --label com.docker.compose.service=db \
    -e POSTGRES_USER=caadmin -e POSTGRES_PASSWORD=Sup3r -e POSTGRES_DB=cosmicforge_admin \
    -v admin-server-staging_postgres_data_staging:/var/lib/postgresql/data postgres:16-alpine >/dev/null
  for _ in $(seq 1 60); do docker exec admin-server-staging-db-1 pg_isready -h 127.0.0.1 -U caadmin -d cosmicforge_admin >/dev/null 2>&1 && break; sleep 1; done
  sleep 2
  # Base schema = the committed schema just before migration 27, via db push.
  local base; base="$(git -C "$repo" rev-parse 40f06fb419113e4ea01221551c020b8202e1658d^)"
  git -C "$repo" show "$base:services/central-admin-api/prisma/schema.prisma" > "$work/baseline.prisma"
  local ip; ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' admin-server-staging-db-1)"
  cat > "$work/prisma.config.mjs" <<EOF
export default { schema: '$work/baseline.prisma', datasource: { url: 'postgresql://caadmin:Sup3r@$ip:5432/cosmicforge_admin?schema=public' } };
EOF
  # Equivalent of `prisma db push` without letting Prisma write to a database:
  # Prisma only renders the SQL, which is applied to this disposable database.
  (cd "$api" && node_modules/.bin/prisma migrate diff --config "$work/prisma.config.mjs" --from-empty \
    --to-schema "$work/baseline.prisma" --script) > "$work/baseline.sql"
  psqlc cosmicforge_admin --single-transaction < "$work/baseline.sql" >/dev/null
  psqlc cosmicforge_admin <<'SQL'
CREATE TABLE IF NOT EXISTS public.social_manual_migrations (file TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO admin_users (id, email, password, name, "updatedAt")
  SELECT gen_random_uuid(), 'admin' || g || '@replica.example', 'x', 'A', now() FROM generate_series(1, 4) g;
SQL
  cat > /var/www/admin-server-staging/.env <<'EOF'
DATABASE_URL=postgresql://caadmin:Sup3r@db:5432/cosmicforge_admin?schema=public
MAIL_ENABLED=false
MAIL_WORKER_ENABLED=false
EOF
  chmod 640 /var/www/admin-server-staging/.env
  docker tag ca-mail-replica-app:1 ghcr.io/cosmicforgehealthnet/admin-backend:staging-mail-replica
  docker run -d --name admin-server-staging-app-1 --network admin-server-staging_default \
    --label ca.replica=1 --label com.docker.compose.project=admin-server-staging --label com.docker.compose.service=app \
    --env-file /var/www/admin-server-staging/.env ghcr.io/cosmicforgehealthnet/admin-backend:staging-mail-replica >/dev/null
  docker run -d --name cosmicforge-db --label ca.replica=1 -e POSTGRES_PASSWORD=rtc postgres:16-alpine >/dev/null
  mkdir -p "$work/bundle"
  cp "$ops" "$work/bundle/"; cp "$repo/infrastructure/mail/clamav/clamd.conf" "$repo/infrastructure/mail/clamav/freshclam.conf" "$work/bundle/"
  sleep 3
}

run_ops() { bash "$work/bundle/ca-mail-staging-ops.sh" "$@" < /dev/null 2>&1 | tee "$work/last.log" | sed 's/^/    | /'; return "${PIPESTATUS[0]}"; }
ledger() { psqlc cosmicforge_admin -c "SELECT count(*) FROM social_manual_migrations"; }
started() { docker inspect -f '{{.State.StartedAt}}' "$1"; }

run() {
  mkdir -p "$work"; setup
  local rtc0 users0; rtc0="$(started cosmicforge-db)"; users0="$(psqlc cosmicforge_admin -c 'SELECT count(*) FROM admin_users')"

  log 'M1 read-only preflight'
  run_ops --migrate-preflight
  check 'preflight: files present with pinned checksums' grep -q 'all 11 migration files (27-37) present' "$work/last.log"
  check 'preflight: no collisions on the pre-Mail schema' grep -q 'none of the .* tables/types created by 27-37 exist yet' "$work/last.log"
  check 'preflight changed nothing' test "$(ledger)" = 0

  log 'M2 a tampered migration file in the image is refused before any change'
  docker exec admin-server-staging-app-1 sh -c 'cp /app/prisma/manual-migrations/20261029_mail_m9_operations.sql /tmp/keep && echo "-- tampered" >> /app/prisma/manual-migrations/20261029_mail_m9_operations.sql'
  ! run_ops --migrate-apply
  check 'tampered file refused' grep -q 'order 32 20261029_mail_m9_operations.sql: checksum mismatch' "$work/last.log"
  check 'nothing applied, no backup taken' bash -c "[[ \$(docker exec -i admin-server-staging-db-1 psql -qAt -U caadmin -d cosmicforge_admin -c 'SELECT count(*) FROM social_manual_migrations') == 0 ]]"
  docker exec admin-server-staging-app-1 cp /tmp/keep /app/prisma/manual-migrations/20261029_mail_m9_operations.sql

  log 'M3 a run that holds the lock blocks the operation'
  flock /run/lock/centralize-admin-db-isolation.lock sleep 120 &
  local holder=$!; sleep 1
  ! run_ops --migrate-apply
  check 'refused while the DB isolation lock is held' grep -q 'database isolation cutover is running' "$work/last.log"
  pkill -P "$holder" 2>/dev/null || true; kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true

  log 'M4 apply: backup, rehearsal on a restored copy, then 27-37'
  local app0; app0="$(docker inspect -f '{{.Id}}' admin-server-staging-app-1)"
  run_ops --migrate-apply
  check 'backup restore check passed' grep -q 'fresh backup .* restored and row counts matched' "$work/last.log"
  check 'rehearsal passed before the real apply' grep -q 'rehearsal: 27-37 applied to the restored copy' "$work/last.log"
  check 'ledger has 11 rows with manifest checksums' test "$(psqlc cosmicforge_admin -c "SELECT count(*) FROM social_manual_migrations WHERE sha256 ~ '^[0-9a-f]{64}$'")" = 11
  check 'Mail tables exist' test "$(psqlc cosmicforge_admin -c "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'mail\_%'")" -gt 30
  check 'existing admin users kept' test "$(psqlc cosmicforge_admin -c 'SELECT count(*) FROM admin_users')" = "$users0"
  check 'scratch rehearsal database dropped' test "$(psqlc postgres -c "SELECT count(*) FROM pg_database WHERE datname LIKE 'ca_mail_rehearsal_%'")" = 0
  check 'same app container (restarted, not recreated)' test "$(docker inspect -f '{{.Id}}' admin-server-staging-app-1)" = "$app0"
  check 'Mail flags unchanged' grep -q 'Mail flags unchanged: MAIL_ENABLED=false,MAIL_WORKER_ENABLED=false' "$work/last.log"
  check 'RTC decoy never restarted' test "$(started cosmicforge-db)" = "$rtc0"
  check 'apply reports no unexpected container change (the app restart is intended)' grep -q 'PASS: every other container (production, RTC' "$work/last.log"
  check 'backup kept root-only' bash -c 'ls /var/backups/centralize-admin/mail-staging-*/cosmicforge_admin.dump.sha256 >/dev/null && [[ $(stat -c %a /var/backups/centralize-admin) == 700 ]]'
  check 'no secret in run logs' bash -c '! grep -rq "Sup3r" /var/backups/centralize-admin/*/run.log'

  log 'M5a read-only container listing'
  run_ops --containers
  check 'container listing names the staging app' grep -q '^admin-server-staging-app-1 running started=' "$work/last.log"

  log 'M5 rerun: verified and skipped'
  run_ops --migrate-apply
  check 'rerun reports already applied' grep -q '27-37 already applied and verified' "$work/last.log"
  check 'still 11 ledger rows' test "$(ledger)" = 11

  log 'M6 services preflight + deploy (worker; ClamAV only with --with-clamav)'
  run_ops --services-preflight || true
  check 'services preflight reports worker not deployed' grep -q 'admin-server-staging-mail-mail-worker not deployed' "$work/last.log"
  if [[ "${1:-}" == --with-clamav ]]; then
    run_ops --services-deploy
    check 'ClamAV PING from the app network' grep -q 'ClamAV answers PING' "$work/last.log"
    check 'ClamAV detected EICAR' grep -q 'ClamAV detected the EICAR' "$work/last.log"
    check 'worker clean disabled exit' grep -q 'Mail worker deployed' "$work/last.log"
    check 'no ClamAV host ports' test -z "$(docker port admin-server-staging-mail-clamav)"
    run_ops --services-remove
    check 'services removed' bash -c '! docker inspect admin-server-staging-mail-clamav >/dev/null 2>&1'
  fi

  echo
  if (( failures )); then echo "MAIL OPS REPLICA TESTS FAILED: $failures"; return 1; fi
  echo 'MAIL OPS REPLICA TESTS PASSED'
}

case "${1:-}" in
  run) shift; rc=0; run "$@" || rc=$?; [[ "${KEEP_REPLICA:-}" == 1 ]] || teardown; exit "$rc" ;;
  teardown) teardown ;;
  *) echo 'usage: CA_REPLICA_TEST=1 bash ca-mail-staging-ops-replica.sh run [--with-clamav] | teardown' >&2; exit 2 ;;
esac
