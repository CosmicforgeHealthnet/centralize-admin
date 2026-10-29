#!/usr/bin/env bash
# Disposable replica of the Contabo layout for testing
# .github/scripts/ca-db-isolation-cutover.sh end to end, UNMODIFIED, with real
# Docker, Docker Compose and PostgreSQL 16.
#
# It recreates the exact names the cutover script guards on:
#   /var/www/admin-server-staging + admin-server-staging-{app,db}-1
#   /var/www/admin-server         + admin-server-{app,db}-1
#   /home/cf-staging-deploy/docker-compose.github-staging.yml
#   volumes admin-server-staging_postgres_data_staging / admin-server_postgres_data
# plus decoys that must never change: RTC `cosmicforge-db` and `karrygo-db`.
# Secrets contain `$admN` / `$K` exactly like the warnings seen on the VPS.
#
# NEVER run this on the VPS. It refuses unless CA_REPLICA_TEST=1 and refuses
# any host that already has non-replica admin-server containers or folders.
#
#   sudo CA_REPLICA_TEST=1 bash ca-db-cutover-replica.sh run-all
set -Eeuo pipefail
export LC_ALL=C
here="$(cd "$(dirname "$0")" && pwd)"
cutover="$here/../ca-db-isolation-cutover.sh"
work=/var/tmp/ca-db-cutover-replica
SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[[ "${CA_REPLICA_TEST:-}" == 1 && "$(id -u)" -eq 0 ]] || { echo 'Set CA_REPLICA_TEST=1 and run as root in a disposable machine.' >&2; exit 2; }
for d in /var/www/admin-server /var/www/admin-server-staging; do
  if [[ -e "$d" && ! -e "$d/.ca-replica" ]]; then echo "Refusing: $d exists and is not a replica." >&2; exit 2; fi
done
for c in $(docker ps -a --format '{{.Names}}' | grep -E '^(admin-server|cosmicforge-db$|karrygo-db$)' || true); do
  [[ "$(docker inspect -f '{{index .Config.Labels "ca.replica"}}' "$c")" == 1 ]] || { echo "Refusing: $c is not a replica container." >&2; exit 2; }
done

compose() { local root="$1"; shift; (cd "$root" && env -i HOME=/root PATH="$SAFE_PATH" docker compose "$@"); }
log() { printf '\n### %s\n' "$*"; }
failures=0
check() { local name="$1"; shift; if "$@"; then echo "ok   - $name"; else echo "FAIL - $name"; failures=$((failures + 1)); fi; }
psqlc() { local c="$1" d="$2"; shift 2; docker exec -i "$c" psql -X -qAt -v ON_ERROR_STOP=1 -U caadmin -d "$d" "$@"; }

build_image() {
  mkdir -p "$work/app/src/shared/config"
  cat > "$work/app/Dockerfile" <<'EOF'
FROM node:22-alpine
WORKDIR /app
COPY node_modules ./node_modules
COPY src ./src
COPY server.js ./
CMD ["node", "server.js"]
EOF
  cat > "$work/app/src/shared/config/database.js" <<'EOF'
// Minimal Prisma-shaped client: what the cutover script's verification uses.
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
module.exports.prisma = {
  async $queryRawUnsafe(sql) { return (await pool.query(sql)).rows; },
  adminUser: { async count() { return Number((await pool.query('SELECT count(*) AS n FROM admin_users')).rows[0].n); } },
  async $disconnect() { await pool.end(); },
};
EOF
  cat > "$work/app/server.js" <<'EOF'
// Replica CA app: /health, and a write every 300 ms (to prove quiescing).
const http = require('http');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const failOn = process.env.REPLICA_FAIL_ON_DB || '';
http.createServer(async (req, res) => {
  if (req.url !== '/health') { res.writeHead(404); return res.end(); }
  try {
    const db = (await pool.query('SELECT current_database() AS d')).rows[0].d;
    res.writeHead(failOn && db === failOn ? 500 : 200); res.end('{}');
  } catch { res.writeHead(500); res.end(); }
}).listen(Number(process.env.PORT || 4000));
setInterval(() => pool.query("INSERT INTO marketing_events(kind) VALUES ('tick')").catch(() => {}), 300);
EOF
  # Installed on the host (where the package proxy is configured), then copied.
  [[ -d "$work/app/node_modules/pg" ]] || (cd "$work/app" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund pg@8.13.1 >/dev/null)
  docker build -q -t ca-replica-app:1 "$work/app" >/dev/null
  docker tag ca-replica-app:1 ghcr.io/cosmicforgehealthnet/admin-backend:staging-replica
  docker tag ca-replica-app:1 cosmicforge-admin-api:production-replica
}

write_env() { # file db port app_password_raw super_password_raw
  # Single-quoted heredoc: the `$` below reach the file literally, exactly as
  # on the VPS. Compose turns `$K` / `$admN` into empty strings.
  cat > "$1" <<'EOF'
# Replica CA environment (fake secrets)
NODE_ENV=staging
POSTGRES_USER=caadmin
POSTGRES_PASSWORD=Sup3r$admN!x
POSTGRES_DB=@DB@
DATABASE_URL=postgresql://ca_app:Str0ng$K@db:5432/@DB@?schema=public
JWT_SECRET=Xy7$admN!q-signing
SESSION_SECRET="p$K/9-session"
ALREADY_QUOTED='lit$eral'
ESCAPED=a$$b
# Known duplicate Google OAuth keys: Compose uses the final definitions.
GOOGLE_CLIENT_ID=obsolete-client
GOOGLE_CLIENT_SECRET=obsolete-secret
GOOGLE_CLIENT_ID=effective-client
GOOGLE_CLIENT_SECRET=effective-secret
PORT=@PORT@
MAIL_ENABLED=false
EOF
  sed -i "s/@DB@/$2/g; s/@PORT@/$3/g" "$1"
}

write_compose() { # file volume_key image
  cat > "$1" <<EOF
services:
  app:
    image: $3
    env_file: .env
    depends_on: [db]
    restart: unless-stopped
    labels: { ca.replica: "1" }
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    volumes: [$2:/var/lib/postgresql/data]
    restart: unless-stopped
    labels: { ca.replica: "1" }
volumes:
  $2:
EOF
}

seed_db() { # container db
  local c="$1" d="$2"
  for _ in $(seq 1 60); do docker exec "$c" pg_isready -h 127.0.0.1 -U caadmin -d "$d" >/dev/null 2>&1 && break; sleep 1; done
  psqlc "$c" postgres <<SQL
CREATE ROLE ca_app LOGIN PASSWORD 'Str0ng';
CREATE ROLE ca_readonly NOLOGIN;
ALTER DATABASE $d OWNER TO ca_app;
REVOKE CONNECT ON DATABASE $d FROM PUBLIC;
GRANT CONNECT ON DATABASE $d TO ca_app, ca_readonly;
ALTER DATABASE $d SET search_path TO "\$user", public;
SQL
  psqlc "$c" "$d" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SET ROLE ca_app;
CREATE TABLE admin_users (id serial PRIMARY KEY, email text UNIQUE NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE marketing_campaigns (id bigserial PRIMARY KEY, name text NOT NULL, owner_id int REFERENCES admin_users(id));
CREATE TABLE marketing_events (id bigserial PRIMARY KEY, kind text, at timestamptz DEFAULT now());
CREATE INDEX marketing_events_at ON marketing_events(at);
CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.created_at := now(); RETURN NEW; END $$;
CREATE TRIGGER admin_users_touch BEFORE INSERT ON admin_users FOR EACH ROW EXECUTE FUNCTION touch();
CREATE VIEW admin_user_emails AS SELECT email FROM admin_users;
INSERT INTO admin_users(email) SELECT 'admin' || g || '@replica.example' FROM generate_series(1, 4) g;
INSERT INTO marketing_campaigns(name, owner_id) VALUES ('c1', 1), ('c2', 2);
GRANT SELECT ON admin_users TO ca_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ca_readonly;
SQL
}

setup() {
  teardown quiet
  log 'Building replica'
  build_image
  mkdir -p /var/www/admin-server-staging /var/www/admin-server /home/cf-staging-deploy
  touch /var/www/admin-server-staging/.ca-replica /var/www/admin-server/.ca-replica
  write_env /var/www/admin-server-staging/.env rtc_db_staging 4001
  write_env /var/www/admin-server/.env rtc_db 4000
  # Same ownership idea as the VPS: root-owned, group-readable by the deploy user.
  getent group cfdeploy >/dev/null || groupadd -g 4242 cfdeploy
  chown root:cfdeploy /var/www/admin-server-staging/.env /var/www/admin-server/.env
  chmod 640 /var/www/admin-server-staging/.env /var/www/admin-server/.env
  write_compose /var/www/admin-server-staging/docker-compose.yml postgres_data_staging cosmicforge-admin-api:staging-base
  docker tag ca-replica-app:1 cosmicforge-admin-api:staging-base
  printf 'services:\n  app:\n    image: %s\n    pull_policy: never\n' ghcr.io/cosmicforgehealthnet/admin-backend:staging-replica > /home/cf-staging-deploy/docker-compose.github-staging.yml
  write_compose /var/www/admin-server/docker-compose.yml postgres_data cosmicforge-admin-api:production-replica

  compose /var/www/admin-server-staging -f docker-compose.yml -f /home/cf-staging-deploy/docker-compose.github-staging.yml up -d db 2>/dev/null
  compose /var/www/admin-server -f docker-compose.yml up -d db 2>/dev/null
  seed_db admin-server-staging-db-1 rtc_db_staging
  seed_db admin-server-db-1 rtc_db
  # The failed first attempt left a stale staging copy; then the source moved on
  # (new rows and a schema change), so the copy now differs from the source.
  docker exec admin-server-staging-db-1 createdb -U caadmin -T rtc_db_staging cosmicforge_admin
  psqlc admin-server-staging-db-1 rtc_db_staging -c "SET ROLE ca_app; ALTER TABLE marketing_campaigns ADD COLUMN status text DEFAULT 'draft'"
  compose /var/www/admin-server-staging -f docker-compose.yml -f /home/cf-staging-deploy/docker-compose.github-staging.yml up -d app 2>/dev/null
  compose /var/www/admin-server -f docker-compose.yml up -d app 2>/dev/null

  # Decoys that must never change.
  docker run -d --name cosmicforge-db --label ca.replica=1 -e POSTGRES_PASSWORD=rtc -e POSTGRES_DB=rtc_db \
    -v rtc_backend_postgres_data:/var/lib/postgresql/data postgres:16-alpine >/dev/null
  docker run -d --name karrygo-db --label ca.replica=1 -e POSTGRES_PASSWORD=kg postgres:16-alpine >/dev/null
  for _ in $(seq 1 60); do docker exec cosmicforge-db pg_isready -h 127.0.0.1 -U postgres -d rtc_db >/dev/null 2>&1 && break; sleep 1; done
  docker exec cosmicforge-db psql -qAt -U postgres -d rtc_db -c "CREATE TABLE rtc_rooms(id int); INSERT INTO rtc_rooms VALUES (1),(2),(3)"
  sleep 3
  log 'Replica ready'
}

teardown() {
  local c
  for c in admin-server-staging-app-1 admin-server-staging-db-1 admin-server-app-1 admin-server-db-1 cosmicforge-db karrygo-db; do
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
  docker volume rm -f admin-server-staging_postgres_data_staging admin-server_postgres_data rtc_backend_postgres_data >/dev/null 2>&1 || true
  docker network rm admin-server-staging_default admin-server_default >/dev/null 2>&1 || true
  rm -rf /var/www/admin-server-staging /var/www/admin-server /home/cf-staging-deploy /var/backups/centralize-admin
  [[ "${1:-}" == quiet ]] || echo 'replica removed'
}

# Runs the UNMODIFIED script under a pseudo-terminal, typing the answers.
run_cutover() { # answers... -- args
  local answers=()
  while [[ "$1" != -- ]]; do answers+=("$1"); shift; done; shift
  printf '%s\n' "${answers[@]}" | script -qec "bash $cutover $*" /dev/null | tee "$work/last.log" | sed 's/^/    | /'
  return "${PIPESTATUS[1]}"
}

db_on() { docker exec "$1" node -e 'process.stdout.write(decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1)))'; }
count() { psqlc "$1" "$2" -c "SELECT count(*) FROM $3"; }
others() { docker inspect -f '{{.Name}} {{.State.StartedAt}} {{.RestartCount}}' cosmicforge-db karrygo-db admin-server-staging-db-1 admin-server-db-1; }
rtc_sum() { docker exec cosmicforge-db psql -qAt -U postgres -d rtc_db -c "SELECT string_agg(id::text, ',' ORDER BY id) FROM rtc_rooms"; }
no_warnings() { local out; out="$(compose "$1" "${@:2}" config 2>&1 >/dev/null)"; [[ "$out" != *'variable is not set'* ]]; }
has_warnings() { ! no_warnings "$@"; }
envmode() { stat -c '%U:%G %a' "$1"; }
dbs() { psqlc "$1" postgres -c "SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE datname NOT LIKE 'template%' AND datname <> 'postgres'"; }
secret_hash() { docker exec "$1" node -e 'const k=["JWT_SECRET","SESSION_SECRET","POSTGRES_PASSWORD","ALREADY_QUOTED","ESCAPED"];process.stdout.write(require("crypto").createHash("sha256").update(JSON.stringify(k.map(x=>process.env[x]))).digest("hex"))'; }

run_all() {
  mkdir -p "$work"
  setup
  local others0 rtc0 sh0 ph0
  others0="$(others)"; rtc0="$(rtc_sum)"
  sh0="$(secret_hash admin-server-staging-app-1)"; ph0="$(secret_hash admin-server-app-1)"
  S=(/var/www/admin-server-staging -f docker-compose.yml -f /home/cf-staging-deploy/docker-compose.github-staging.yml)
  check 'replica reproduces the VPS interpolation warnings' has_warnings "${S[@]}"

  log 'T1 read-only preflight changes nothing'
  run_cutover -- --preflight || true
  check 'preflight passes both environments' grep -q 'PASS: production state: source' "$work/last.log"
  check 'preflight lists the interpolated keys by name only' grep -q 'DATABASE_URL.*JWT_SECRET.*POSTGRES_PASSWORD.*SESSION_SECRET' "$work/last.log"
  check 'preflight leaves staging on rtc_db_staging' test "$(db_on admin-server-staging-app-1)" = rtc_db_staging

  log 'T2 declining the first confirmation changes nothing'
  run_cutover no -- --apply-both || true
  check 'staging still on rtc_db_staging after decline' test "$(db_on admin-server-staging-app-1)" = rtc_db_staging
  check 'stale staging copy untouched after decline' test "$(dbs admin-server-staging-db-1)" = cosmicforge_admin,rtc_db_staging

  log 'T3 a lingering session on the source stops the run before the copy; the stopped app is started unchanged'
  docker exec -d admin-server-staging-db-1 psql -U caadmin -d rtc_db_staging -c 'SELECT pg_sleep(300)'
  sleep 1
  ! run_cutover CUTOVER_STAGING -- --apply-both
  check 'run failed closed on the lingering session' grep -q 'sessions still use rtc_db_staging' "$work/last.log"
  check 'rollback verified (docker start of the untouched container)' grep -q 'rolled back; app verified healthy on rtc_db_staging' "$work/last.log"
  check 'staging back on rtc_db_staging' test "$(db_on admin-server-staging-app-1)" = rtc_db_staging
  check 'production was not started after the staging failure' test "$(db_on admin-server-app-1)" = rtc_db
  docker exec admin-server-staging-db-1 psql -qAt -U caadmin -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='rtc_db_staging' AND query LIKE '%pg_sleep%'" >/dev/null
  sleep 1

  log 'T4 the app fails verification on the new database: full rollback through Compose, verified'
  sed -i 's/^MAIL_ENABLED=false$/MAIL_ENABLED=false\nREPLICA_FAIL_ON_DB=cosmicforge_admin/' /var/www/admin-server-staging/.env
  compose "${S[@]}" up -d --no-deps --force-recreate app 2>/dev/null; sleep 3
  ! run_cutover CUTOVER_STAGING -- --apply-both
  check 'run failed on new-database verification' grep -q 'app did not verify on cosmicforge_admin' "$work/last.log"
  check 'rollback through Compose verified' grep -q 'rolled back; app verified healthy on rtc_db_staging' "$work/last.log"
  check 'staging back on rtc_db_staging' test "$(db_on admin-server-staging-app-1)" = rtc_db_staging
  check 'original .env (with $) restored exactly' grep -q 'DATABASE_URL=postgresql://ca_app:Str0ng\$K@db:5432/rtc_db_staging' /var/www/admin-server-staging/.env
  check 'production untouched' test "$(db_on admin-server-app-1)" = rtc_db
  sed -i '/^REPLICA_FAIL_ON_DB=/d' /var/www/admin-server-staging/.env
  compose "${S[@]}" up -d --no-deps --force-recreate app 2>/dev/null; sleep 3

  local before_users before_events
  before_users="$(count admin-server-staging-db-1 rtc_db_staging admin_users)"
  log 'T5 full run: staging, real-login pause, production'
  run_cutover CUTOVER_STAGING STAGING_LOGIN_OK CUTOVER_PRODUCTION -- --apply-both
  check 'staging app on cosmicforge_admin' test "$(db_on admin-server-staging-app-1)" = cosmicforge_admin
  check 'production app on cosmicforge_admin' test "$(db_on admin-server-app-1)" = cosmicforge_admin
  check 'staging Admin users intact' test "$(count admin-server-staging-db-1 cosmicforge_admin admin_users)" = "$before_users"
  check 'production Admin users intact' test "$(count admin-server-db-1 cosmicforge_admin admin_users)" = 4
  sleep 2
  before_events="$(count admin-server-staging-db-1 rtc_db_staging marketing_events)"
  sleep 2
  check 'legacy staging database no longer receives writes' test "$(count admin-server-staging-db-1 rtc_db_staging marketing_events)" = "$before_events"
  check 'live writes now land in cosmicforge_admin' test "$(count admin-server-staging-db-1 cosmicforge_admin marketing_events)" -gt "$before_events"
  check 'staging databases: new, legacy, preserved stale copy, failed attempt' \
    bash -c "[[ \"$(dbs admin-server-staging-db-1)\" =~ ^cosmicforge_admin,cosmicforge_admin_previous_copy_[0-9_]+,cosmicforge_admin_previous_copy_[0-9_]+,rtc_db_staging$ ]]"
  check 'production databases: new and legacy' test "$(dbs admin-server-db-1)" = cosmicforge_admin,rtc_db
  check 'staging Google client id appears exactly once after cutover' bash -c "[[ \$(grep -c '^GOOGLE_CLIENT_ID=' /var/www/admin-server-staging/.env) == 1 ]]"
  check 'staging Google client secret appears exactly once after cutover' bash -c "[[ \$(grep -c '^GOOGLE_CLIENT_SECRET=' /var/www/admin-server-staging/.env) == 1 ]]"
  check 'production Google client id appears exactly once after cutover' bash -c "[[ \$(grep -c '^GOOGLE_CLIENT_ID=' /var/www/admin-server/.env) == 1 ]]"
  check 'production Google client secret appears exactly once after cutover' bash -c "[[ \$(grep -c '^GOOGLE_CLIENT_SECRET=' /var/www/admin-server/.env) == 1 ]]"
  check 'no interpolation warnings left (staging)' no_warnings "${S[@]}"
  check 'no interpolation warnings left (production)' no_warnings /var/www/admin-server -f docker-compose.yml
  check 'staging secrets byte-identical to before' test "$(secret_hash admin-server-staging-app-1)" = "$sh0"
  check 'production secrets byte-identical to before' test "$(secret_hash admin-server-app-1)" = "$ph0"
  check '.env owner and mode preserved' test "$(envmode /var/www/admin-server-staging/.env)" = 'root:cfdeploy 640'
  check 'database owner copied' test "$(psqlc admin-server-db-1 postgres -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='cosmicforge_admin'")" = ca_app
  check 'PUBLIC still has no CONNECT on the new database' test "$(psqlc admin-server-db-1 postgres -c "SELECT has_database_privilege('public','cosmicforge_admin','CONNECT')")" = f
  check 'database setting copied' test "$(psqlc admin-server-db-1 postgres -c "SELECT array_to_string(setconfig, ',') FROM pg_db_role_setting s JOIN pg_database d ON d.oid=s.setdatabase WHERE d.datname='cosmicforge_admin'")" = 'search_path="$user", public'
  check 'RTC decoy data unchanged' test "$(rtc_sum)" = "$rtc0"
  check 'RTC, KarryGo and CA db containers never restarted' test "$(others)" = "$others0"
  check 'RTC volume still present' docker volume inspect rtc_backend_postgres_data
  check 'legacy CA volumes still present' docker volume inspect admin-server-staging_postgres_data_staging admin-server_postgres_data
  check 'no secret value in any run log' bash -c '! grep -rqE "Str0ng|Sup3r|Xy7|p/9-session" /var/backups/centralize-admin/*/run.log'
  check 'backups are root-only' test "$(stat -c '%a' /var/backups/centralize-admin)" = 700
  check 'no database error anywhere in the run' bash -c "! grep -q 'ERROR:' '$work/last.log'"
  check 'catalog comparison covered real entries (staging and production)' \
    bash -c "[[ \$(grep -cE 'clone: [1-9][0-9]* ownership/ACL/extension/sequence entries match' '$work/last.log') -eq 2 ]]"

  log 'T6 rerun: both environments verified and skipped, nothing changed'
  run_cutover STAGING_LOGIN_OK CUTOVER_PRODUCTION -- --apply-both
  check 'rerun skipped staging' grep -q 'staging already uses cosmicforge_admin' "$work/last.log"
  check 'rerun skipped production' grep -q 'production already uses cosmicforge_admin' "$work/last.log"
  check 'RTC and other containers still unchanged' test "$(others)" = "$others0"

  echo
  if (( failures )); then echo "REPLICA TESTS FAILED: $failures"; return 1; fi
  echo 'REPLICA TESTS PASSED'
}

run_production_guard() {
  mkdir -p "$work"
  setup
  log 'T11 additional conflicting Google duplicate blocks before stopping staging'
  local staging_started
  staging_started="$(docker inspect -f '{{.State.StartedAt}}' admin-server-staging-app-1)"
  printf '%s\n' 'GOOGLE_CLIENT_SECRET=modified-after-deploy' >> /var/www/admin-server-staging/.env
  ! run_cutover CUTOVER_STAGING -- --apply-both
  check 'conflicting duplicate blocked before staging changes' grep -q 'staging configuration check' "$work/last.log"
  check 'conflicting duplicate did not stop staging' test "$(docker inspect -f '{{.State.StartedAt}}' admin-server-staging-app-1)" = "$staging_started"
  sed -i '${/^GOOGLE_CLIENT_SECRET=modified-after-deploy$/d;}' /var/www/admin-server-staging/.env
  log 'T7 production refuses a cosmicforge_admin it did not create'
  docker exec admin-server-db-1 createdb -U caadmin cosmicforge_admin
  ! run_cutover CUTOVER_STAGING STAGING_LOGIN_OK CUTOVER_PRODUCTION -- --apply-both
  check 'production refused the unknown database' grep -q 'production already has a cosmicforge_admin this script did not create' "$work/last.log"
  check 'staging completed' test "$(db_on admin-server-staging-app-1)" = cosmicforge_admin
  check 'production untouched on rtc_db' test "$(db_on admin-server-app-1)" = rtc_db
  check 'production unknown database preserved' test "$(dbs admin-server-db-1)" = cosmicforge_admin,rtc_db
  log 'T8 declining STAGING_LOGIN_OK leaves production untouched'
  docker exec admin-server-db-1 dropdb -U caadmin cosmicforge_admin
  run_cutover nope -- --apply-both
  check 'production still on rtc_db after decline' test "$(db_on admin-server-app-1)" = rtc_db
  log 'T9 a .env edited since the last deploy is refused before anything stops'
  local started
  started="$(docker inspect -f '{{.State.StartedAt}}' admin-server-app-1)"
  sed -i 's/^JWT_SECRET=.*/JWT_SECRET=changed-after-deploy/' /var/www/admin-server/.env
  ! run_cutover STAGING_LOGIN_OK CUTOVER_PRODUCTION -- --apply-both
  check 'production refused: recreation would change JWT_SECRET' grep -q 'app env would change on recreation: JWT_SECRET' "$work/last.log"
  check 'production app never stopped or recreated' test "$(docker inspect -f '{{.State.StartedAt}}' admin-server-app-1)" = "$started"
  check 'production still on rtc_db' test "$(db_on admin-server-app-1)" = rtc_db
  log 'T10 production app created with LITERAL $ values (as Compose 1.x would): the running value is kept'
  sed -i "s/^JWT_SECRET=.*/JWT_SECRET='Xy7\$admN!q-signing'/" /var/www/admin-server/.env
  compose /var/www/admin-server -f docker-compose.yml up -d --no-deps --force-recreate app 2>/dev/null; sleep 3
  sed -i 's/^JWT_SECRET=.*/JWT_SECRET=Xy7$admN!q-signing/' /var/www/admin-server/.env
  local literal
  literal="$(docker exec admin-server-app-1 printenv JWT_SECRET)"
  check 'replica: running JWT_SECRET keeps a literal $' test "$literal" = 'Xy7$admN!q-signing'
  run_cutover STAGING_LOGIN_OK CUTOVER_PRODUCTION -- --apply-both
  check 'production now on cosmicforge_admin' test "$(db_on admin-server-app-1)" = cosmicforge_admin
  check 'running literal JWT_SECRET kept byte for byte' test "$(docker exec admin-server-app-1 printenv JWT_SECRET)" = "$literal"
  check '.env writes that value single-quoted' grep -qx "JWT_SECRET='Xy7\$admN!q-signing'" /var/www/admin-server/.env
  check 'plain values written without quotes' grep -qx 'SESSION_SECRET=p/9-session' /var/www/admin-server/.env
  check 'no interpolation warnings left (production)' no_warnings /var/www/admin-server -f docker-compose.yml
  if (( failures )); then echo "REPLICA TESTS FAILED: $failures"; return 1; fi
  echo 'REPLICA GUARD TESTS PASSED'
}

case "${1:-}" in
  setup) setup ;;
  teardown) teardown ;;
  run-all) run_all; rc=$?; [[ "${KEEP_REPLICA:-}" == 1 ]] || teardown quiet; exit "$rc" ;;
  run-guards) run_production_guard; rc=$?; [[ "${KEEP_REPLICA:-}" == 1 ]] || teardown quiet; exit "$rc" ;;
  *) echo 'usage: CA_REPLICA_TEST=1 bash ca-db-cutover-replica.sh setup|run-all|run-guards|teardown' >&2; exit 2 ;;
esac
