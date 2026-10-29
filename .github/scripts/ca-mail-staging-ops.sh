#!/usr/bin/env bash
# Centralize Admin (CA) STAGING Mail operations. Run as root on the Contabo VPS
# (by .github/workflows/ca-mail-staging-ops.yml). Touches ONLY CA staging:
# admin-server-staging-db-1 / cosmicforge_admin, and the new staging-only
# Compose project admin-server-staging-mail (ClamAV + Mail worker).
#
#   --migrate-preflight   read-only: identity, ledger, checksums, name collisions
#   --migrate-apply       backup + restore check, full rehearsal of 27-37 on the
#                         restored copy, then 27-37 on cosmicforge_admin: one
#                         transaction per file with its ledger row (runbook
#                         docs/cosmicforge-mail-staging-migration-runbook.md)
#   --services-preflight  read-only: memory, network, images, existing services
#   --services-deploy     ClamAV (private network alias `clamav`, no ports) and
#                         one Mail worker (same image + env as the staging app)
#   --services-remove     stop and remove those two containers (volume kept)
#   --production-schema-names  READ-ONLY: catalog object NAMES (tables, types,
#                         indexes, columns, ledger rows) of production
#                         admin-server-db-1/cosmicforge_admin, so the runner can
#                         classify which manifest migrations production has.
#                         No data, no change, nothing else in production read.
#
# Never: changes staging .env, recreates the staging app, enables any Mail
# flag, touches production, RTC (cosmicforge-db), Karryam or any other project.
# Files are read from the RUNNING staging app image and must match the pinned
# checksums below. No secret, URL or record content is printed.
set -Eeuo pipefail
umask 077
export LC_ALL=C

readonly APP=admin-server-staging-app-1
readonly DB=admin-server-staging-db-1
readonly PROJECT=admin-server-staging
readonly VOLUME=admin-server-staging_postgres_data_staging
readonly NETWORK=admin-server-staging_default
readonly DEST=cosmicforge_admin
readonly ENV_FILE=/var/www/admin-server-staging/.env
readonly MAIL_PROJECT=admin-server-staging-mail
readonly MAIL_DIR=/var/www/admin-server-staging-mail
readonly CLAMAV_IMAGE=clamav/clamav:1.4
readonly BACKUP_BASE=/var/backups/centralize-admin
readonly MIGRATION_DIR=/app/prisma/manual-migrations
readonly LEDGER=social_manual_migrations
readonly BUNDLE_DIR="${CA_MAIL_BUNDLE_DIR:-$(cd "$(dirname "$0")" && pwd)}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly RUN_ID

# Manifest orders 27-37 (prisma/manual-migrations/manifest.json, LF-normalised).
readonly -a MIGRATIONS=(
  "27 20261024_add_cosmicforge_mail_m1_m6.sql a3b7d61f61fb815affb4f617481d878472d099ed48db43d60f2e52e9022ec9f0"
  "28 20261025_add_admin_sessions_mfa.sql e8d1b5537677367aed24c2a09191bb95568cde2ad14d6b4d62c6fa083adbf883"
  "29 20261026_mail_step_up_session_binding.sql 5bfc3b52d1eb6d4dd957d139045f1bddecb00f818c2d856997c30be8cdf56fbf"
  "30 20261027_mail_m7_broadcasts_automation.sql 88c17ea2ca3f835f2eeb5ee4213da76a0751ccd373cedc20238f51a36232e65f"
  "31 20261028_mail_m8_product_integration.sql c526d300c48ed6e406b6cd4ea6532e32f738c81ebdd4fa1da68bcddb11abff94"
  "32 20261029_mail_m9_operations.sql a3bf88806a0a74bc2d06ddce972fa56f6cf2c0c6580270e9d4bf91c402686447"
  "33 20261030_mail_m10_rollout.sql 1bc07e19b8fe54837c0b2c5ff1199c7dc2841bfa4e5be37fdeb9f305ab7a1753"
  "34 20261031_account_setup_tokens.sql 364fa19c3b9bdd6844dcfe068a4f63e6952d8a6d631b354f0416317b9bf9a613"
  "35 20261101_mail_spec_gap_closure.sql efc3c863c21ba0413a9d239ea53de50cf2837c3ba456caa622776ed65818f5b4"
  "36 20261102_mail_user_preferences.sql f99c79176acf7a3f36e154d742ff487943e485413d88472a20731be1848ab3ea"
  "37 20261103_mail_final_gap_closure.sql 70952bf8a685cfe04e230b522fa103f343cdacd36c97c25b1dba5f04f350d8e6"
)

mode="${1:-}"
case "$mode" in
  --migrate-preflight|--migrate-apply|--services-preflight|--services-deploy|--services-remove|--production-schema-names) ;;
  *) echo 'Usage (root): ca-mail-staging-ops.sh --migrate-preflight|--migrate-apply|--services-preflight|--services-deploy|--services-remove|--production-schema-names' >&2; exit 2 ;;
esac
[[ -z "${2:-}" ]] || { echo 'Unexpected arguments.' >&2; exit 2; }
[[ "$(id -u)" -eq 0 ]] || { echo 'Run as root.' >&2; exit 2; }
for tool in docker python3 flock sha256sum awk; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 2; }; done

mkdir -p /run/lock
exec 8>/run/lock/centralize-admin-mail-staging.lock
flock -n 8 || { echo 'Another CA staging Mail operation is running; refusing overlap. Nothing changed.' >&2; exit 1; }
# Never overlap the database isolation cutover either.
exec 9>/run/lock/centralize-admin-db-isolation.lock
flock -n 9 || { echo 'The CA database isolation cutover is running; refusing overlap. Nothing changed.' >&2; exit 1; }

run_dir="$BACKUP_BASE/mail-staging-$RUN_ID"
mkdir -p "$BACKUP_BASE"; chmod 700 "$BACKUP_BASE"; mkdir -m 700 "$run_dir"
exec > >(tee -a "$run_dir/run.log") 2>&1
echo "CA staging Mail ops, run $RUN_ID, mode $mode"
echo "Root-only run directory: $run_dir"

declare -a SUMMARY=()
pass() { SUMMARY+=("PASS  $*"); echo "PASS: $*"; }
fail() { SUMMARY+=("FAIL  $*"); echo "FAIL: $*" >&2; }
info() { SUMMARY+=("INFO  $*"); echo "INFO: $*"; }

snapshot_others() { # every container except the two this script may create
  local id
  for id in $(docker ps -aq --no-trunc); do
    docker inspect -f '{{.Id}}|{{.Name}}|{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}' "$id"
  done | grep -vE "\|/${MAIL_PROJECT}-(clamav|mail-worker)\|" | sort
}
others_before="$(snapshot_others)"
scratch=''
on_exit() {
  local code=$?
  trap - EXIT
  if [[ -n "$scratch" ]]; then drop_scratch || fail "could not drop this run's scratch database $scratch (marked, safe to drop)"; fi
  if [[ "$(snapshot_others)" == "$others_before" ]]; then
    pass 'every other container (staging app/db, production, RTC, KarryGo, CFMeet, ...) unchanged'
  else
    fail 'another container changed state during the run; inspect docker ps'
  fi
  [[ "$code" -eq 0 ]] || fail "stopped with exit code $code"
  echo; echo '==================== SUMMARY ===================='
  local l; for l in "${SUMMARY[@]}"; do echo "$l"; done
  echo "Run directory (root-only): $run_dir"
  echo '================================================='
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

psql_db() { # database [psql args...]; SQL on stdin
  local database="$1"; shift
  docker exec -i "$DB" sh -c 'db="$1"; shift; exec psql -X -qAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$db" "$@"' sh "$database" "$@"
}

# --------------------------------------------------------------------------
# Identity (read-only).
# --------------------------------------------------------------------------
identity() {
  local ok=0 c
  for c in "$APP" "$DB"; do
    docker inspect "$c" >/dev/null 2>&1 || { echo "  $c missing"; return 1; }
    [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$c")" == "$PROJECT" ]] || { echo "  $c not in $PROJECT"; ok=1; }
    [[ "$(docker inspect -f '{{.State.Running}}' "$c")" == true ]] || { echo "  $c not running"; ok=1; }
  done
  [[ "$(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$DB")" == "$VOLUME " ]] || { echo "  $DB volume is not exactly $VOLUME"; ok=1; }
  docker network inspect "$NETWORK" >/dev/null 2>&1 || { echo "  network $NETWORK missing"; ok=1; }
  [[ "$(app_db)" == "$DEST" ]] || { echo "  staging app does not run on $DEST"; ok=1; }
  return "$ok"
}

app_db() {
  docker inspect -f '{{json .Config.Env}}' "$APP" | python3 -c '
import json, sys, urllib.parse as u
env = dict(x.split("=", 1) for x in json.load(sys.stdin) if "=" in x)
p = u.urlsplit(env.get("DATABASE_URL", ""))
print(u.unquote(p.path.lstrip("/")) if p.hostname == "db" else "UNEXPECTED_HOST")'
}

mail_flags() { # names=values of MAIL_*_ENABLED in the running app (booleans only)
  docker inspect -f '{{json .Config.Env}}' "$APP" | python3 -c '
import json, sys
env = dict(x.split("=", 1) for x in json.load(sys.stdin) if "=" in x)
print(",".join(f"{k}={env[k].strip().lower()}" for k in sorted(env) if k.startswith("MAIL_") and k.endswith("_ENABLED")) or "none")'
}

verify_app() { # Prisma on DEST, AdminUser, /health, synthetic login 401
  local i
  for ((i = 1; i <= ${1:-30}; i++)); do
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

# --------------------------------------------------------------------------
# Migrations.
# --------------------------------------------------------------------------
migration_sql() { docker exec "$APP" cat "$MIGRATION_DIR/$1"; }

check_files() { # every file present in the image with the pinned checksum
  local entry order file sha got bad=0
  for entry in "${MIGRATIONS[@]}"; do
    read -r order file sha <<<"$entry"
    got="$(migration_sql "$file" 2>/dev/null | tr -d '\r' | sha256sum | cut -d' ' -f1)" || got=missing
    if [[ "$got" != "$sha" ]]; then echo "  order $order $file: checksum mismatch or missing in the running image"; bad=1; fi
  done
  return "$bad"
}

ledger_rows() { # database -> number of ledger rows for 27-37 (or 'no-ledger')
  local db="$1" files
  files="$(for e in "${MIGRATIONS[@]}"; do read -r _ f _ <<<"$e"; printf "'%s'," "$f"; done)"
  if [[ "$(psql_db "$db" <<SQL
SELECT to_regclass('public.$LEDGER') IS NOT NULL;
SQL
)" != t ]]; then echo no-ledger; return; fi
  psql_db "$db" <<SQL
SELECT count(*) FROM public.$LEDGER WHERE file IN (${files%,});
SQL
}

created_objects() { # names of tables and types the 11 files create (for collision checks)
  local entry file
  for entry in "${MIGRATIONS[@]}"; do
    read -r _ file _ <<<"$entry"
    migration_sql "$file" | python3 -c '
import re, sys
sql = sys.stdin.read()
for kind, name in re.findall(r"CREATE\s+(TABLE|TYPE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\"?public\"?\.)?\"?([A-Za-z_][A-Za-z0-9_]*)\"?", sql, re.I):
    print(kind.upper() + " " + name)'
  done | sort -u
}

collisions() { # database -> list of objects created by 27-37 that already exist
  local db="$1"
  created_objects | python3 -c '
import sys
rows = [l.split() for l in sys.stdin if l.strip()]
q = lambda names: ",".join("\x27%s\x27" % n for n in names) or "NULL"
tables = q([n for k, n in rows if k == "TABLE"])
types = q([n for k, n in rows if k == "TYPE"])
print("SELECT \x27TABLE \x27 || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
      " WHERE n.nspname = \x27public\x27 AND c.relkind IN (\x27r\x27, \x27p\x27) AND c.relname IN (%s)"
      " UNION ALL SELECT \x27TYPE \x27 || t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace"
      " WHERE n.nspname = \x27public\x27 AND t.typname IN (%s) ORDER BY 1;" % (tables, types))' \
    | psql_db "$db"
}

apply_all() { # database -> applies 27..37, one transaction per file incl. its ledger row
  local db="$1" entry order file sha
  psql_db "$db" <<SQL >/dev/null
CREATE TABLE IF NOT EXISTS public.$LEDGER (file TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
SQL
  for entry in "${MIGRATIONS[@]}"; do
    read -r order file sha <<<"$entry"
    if [[ "$(psql_db "$db" -v "f=$file" <<SQL
SELECT count(*) FROM public.$LEDGER WHERE file = :'f';
SQL
)" == 1 ]]; then echo "  $db order $order already recorded; skipped"; continue; fi
    { migration_sql "$file"; printf "\nINSERT INTO public.%s (file, sha256) VALUES ('%s', '%s');\n" "$LEDGER" "$file" "$sha"; } \
      | psql_db "$db" --single-transaction >/dev/null \
      || { echo "  $db order $order ($file) FAILED; its transaction was rolled back" >&2; return 1; }
    echo "  $db order $order applied"
  done
}

verify_applied() { # database -> every created object exists and 11 ledger rows
  local db="$1" expected found
  expected="$(created_objects | wc -l)"
  found="$(collisions "$db" | wc -l)"
  [[ "$(ledger_rows "$db")" == 11 && "$found" == "$expected" ]] || { echo "  $db: ledger $(ledger_rows "$db")/11, objects $found/$expected" >&2; return 1; }
  echo "  $db: ledger 11/11, $found/$expected created tables and types present"
}

table_counts() { psql_db "$1" <<'SQL'
SELECT format('SELECT %L || ''|'' || count(*)::text FROM %I.%I', schemaname || '.' || tablename, schemaname, tablename)
  FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1 \gexec
SQL
}

db_comment() { psql_db postgres -v "n=$1" <<'SQL'
SELECT coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = :'n';
SQL
}

drop_scratch() { # only this run's own marked scratch database
  [[ "$scratch" =~ ^ca_mail_rehearsal_[0-9]+$ && "$(db_comment "$scratch")" == "ca-mail-staging:$RUN_ID:rehearsal" ]] || return 1
  psql_db postgres -v "n=$scratch" <<'SQL' >/dev/null
SELECT format('DROP DATABASE %I', :'n') \gexec
SQL
  scratch=''
}

migrate_preflight() {
  identity || { fail 'staging identity'; return 1; }
  pass "staging identity (containers, project, volume, network); app runs on $DEST"
  check_files || { fail 'migration files in the running staging image'; return 1; }
  pass 'all 11 migration files (27-37) present in the running staging image with the pinned checksums'
  local rows; rows="$(ledger_rows "$DEST")"
  info "ledger rows for 27-37 in $DEST: $rows"
  local hits; hits="$(collisions "$DEST")"
  if [[ "$rows" == 11 ]]; then
    verify_applied "$DEST" && pass "27-37 already applied and verified in $DEST" || fail "27-37 recorded but objects missing in $DEST"
    return 0
  fi
  if [[ "$rows" != 0 && "$rows" != no-ledger ]]; then fail "ledger records only $rows of 11; partial state needs manual review"; return 1; fi
  if [[ -n "$hits" ]]; then fail "objects created by 27-37 already exist in $DEST (partial state): $(tr '\n' ',' <<<"$hits")"; return 1; fi
  pass "none of the $(created_objects | wc -l) tables/types created by 27-37 exist yet in $DEST (no collision)"
  info "Mail flags in the running staging app: $(mail_flags)"
  verify_app 3 && pass 'staging app: Prisma on cosmicforge_admin, AdminUser, health, synthetic login 401' || { fail 'staging app does not verify'; return 1; }
}

migrate_apply() {
  migrate_preflight || return 1
  [[ "$(ledger_rows "$DEST")" == 11 ]] && { info 'nothing to apply'; return 0; }
  local flags_before; flags_before="$(mail_flags)"
  # Fresh backup + restore check into a marked scratch database.
  docker exec "$DB" sh -c 'exec pg_dump -U "${POSTGRES_USER:-postgres}" -Fc -d "$1"' sh "$DEST" > "$run_dir/$DEST.dump"
  [[ -s "$run_dir/$DEST.dump" ]] && docker exec -i "$DB" pg_restore --list < "$run_dir/$DEST.dump" >/dev/null
  sha256sum "$run_dir/$DEST.dump" > "$run_dir/$DEST.dump.sha256"
  scratch="ca_mail_rehearsal_${RUN_ID//[^0-9]/}"; scratch="${scratch:0:60}"
  psql_db postgres -v "n=$scratch" -v "c=ca-mail-staging:$RUN_ID:rehearsal" <<'SQL' >/dev/null
SELECT format('CREATE DATABASE %I TEMPLATE template0', :'n') \gexec
SELECT format('COMMENT ON DATABASE %I IS %L', :'n', :'c') \gexec
SQL
  docker exec -i "$DB" sh -c 'exec pg_restore -U "${POSTGRES_USER:-postgres}" --exit-on-error --single-transaction -d "$1"' sh "$scratch" < "$run_dir/$DEST.dump" >/dev/null
  table_counts "$DEST" | sort > "$run_dir/source-counts.txt"
  table_counts "$scratch" | sort > "$run_dir/restored-counts.txt"
  cmp -s "$run_dir/source-counts.txt" "$run_dir/restored-counts.txt" || { fail 'backup restore check: row counts differ'; return 1; }
  pass "fresh backup $(du -h "$run_dir/$DEST.dump" | cut -f1) written, checksummed, restored and row counts matched ($(wc -l < "$run_dir/source-counts.txt") tables)"
  # Rehearsal on the restored copy: nothing touches cosmicforge_admin unless all 11 succeed here.
  apply_all "$scratch" || { fail 'rehearsal on the restored copy failed; cosmicforge_admin was NOT changed'; return 1; }
  verify_applied "$scratch" || { fail 'rehearsal verification failed; cosmicforge_admin was NOT changed'; return 1; }
  # Every pre-existing table keeps its row count (the ledger itself gains 11 rows).
  grep -v "^public\.$LEDGER|" "$run_dir/source-counts.txt" > "$run_dir/existing-counts.txt" || true
  table_counts "$scratch" | sort | grep -Fxf "$run_dir/existing-counts.txt" > "$run_dir/rehearsal-kept.txt" || true
  cmp -s "$run_dir/rehearsal-kept.txt" "$run_dir/existing-counts.txt" || { fail 'rehearsal changed existing table row counts; cosmicforge_admin was NOT changed'; return 1; }
  pass 'rehearsal: 27-37 applied to the restored copy, all objects present, every existing table row count unchanged'
  drop_scratch
  # Real apply.
  apply_all "$DEST" || { fail "apply stopped; files before the failing one are committed and recorded in the ledger. Rollback scripts: docs/sql/*-rollback.sql. Backup: $run_dir/$DEST.dump"; return 1; }
  verify_applied "$DEST" || { fail "verification after apply failed; backup: $run_dir/$DEST.dump"; return 1; }
  pass "27-37 applied to $DEST: 11 ledger rows with manifest checksums, every created object present"
  # Restart (same container, same config) so the app re-reads schema readiness.
  docker restart -t 30 "$APP" >/dev/null
  verify_app 45 || { fail 'staging app did not verify after restart (schema changes are additive; investigate)'; return 1; }
  [[ "$(mail_flags)" == "$flags_before" ]] || { fail 'Mail flags changed'; return 1; }
  pass "staging app restarted and verified (Prisma, AdminUser, health, synthetic login 401); Mail flags unchanged: $flags_before"
}

# --------------------------------------------------------------------------
# Services: ClamAV + Mail worker (staging only).
# --------------------------------------------------------------------------
mem_available_mb() { awk '/MemAvailable/ {print int($2 / 1024)}' /proc/meminfo; }

services_preflight() {
  identity || { fail 'staging identity'; return 1; }
  pass "staging identity; network $NETWORK present"
  local avail; avail="$(mem_available_mb)"
  info "host MemAvailable ${avail} MB"
  local have=false; docker inspect "${MAIL_PROJECT}-clamav" >/dev/null 2>&1 && have=true
  if [[ "$have" == false ]] && (( avail < 3072 )); then
    fail "less than 3 GB memory available for ClamAV (needs ~1.5 GB, limit 3 GB); not deploying"; return 1
  fi
  [[ -f "$BUNDLE_DIR/clamd.conf" && -f "$BUNDLE_DIR/freshclam.conf" ]] || { fail 'ClamAV config files missing from the uploaded bundle'; return 1; }
  pass 'memory and ClamAV configuration available'
  info "staging app image: $(docker inspect -f '{{.Config.Image}}' "$APP"); Mail flags: $(mail_flags)"
  local c; for c in clamav mail-worker; do
    if docker inspect "${MAIL_PROJECT}-$c" >/dev/null 2>&1; then
      info "${MAIL_PROJECT}-$c exists: $(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${MAIL_PROJECT}-$c")"
    else
      info "${MAIL_PROJECT}-$c not deployed"
    fi
  done
}

write_mail_compose() {
  local image="$1" worker_restart="$2"
  mkdir -p "$MAIL_DIR"; chmod 750 "$MAIL_DIR"
  install -m 0644 "$BUNDLE_DIR/clamd.conf" "$MAIL_DIR/clamd.conf"
  install -m 0644 "$BUNDLE_DIR/freshclam.conf" "$MAIL_DIR/freshclam.conf"
  cat > "$MAIL_DIR/docker-compose.yml.new" <<EOF
# Managed by .github/scripts/ca-mail-staging-ops.sh (CA STAGING only).
# ClamAV: private, no published ports; reachable as clamav:3310 on $NETWORK.
# Mail worker: same image and env file as admin-server-staging-app-1.
name: $MAIL_PROJECT
services:
  clamav:
    image: $CLAMAV_IMAGE
    container_name: ${MAIL_PROJECT}-clamav
    restart: unless-stopped
    expose: ["3310"]
    environment:
      CLAMAV_NO_FRESHCLAMD: "false"
      CLAMAV_NO_CLAMD: "false"
      CLAMAV_NO_MILTERD: "true"
    volumes:
      - ./clamd.conf:/etc/clamav/clamd.conf:ro
      - ./freshclam.conf:/etc/clamav/freshclam.conf:ro
      - clamav-signatures:/var/lib/clamav
    healthcheck:
      test: ["CMD", "clamdcheck.sh"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 300s
    deploy:
      resources:
        limits: { cpus: "1.5", memory: 3g }
        reservations: { memory: 1536m }
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
    cap_add: [CHOWN, SETUID, SETGID, DAC_OVERRIDE]
    networks:
      staging:
        aliases: [clamav]
    labels: { ca.environment: staging, ca.component: mail-scanner }
    logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }
  mail-worker:
    image: $image
    pull_policy: never
    container_name: ${MAIL_PROJECT}-mail-worker
    command: ["node", "src/mail-worker.js"]
    restart: "$worker_restart"
    env_file: [$ENV_FILE]
    security_opt: ["no-new-privileges:true"]
    networks: [staging]
    labels: { ca.environment: staging, ca.component: mail-worker }
    logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }
volumes:
  clamav-signatures:
networks:
  staging:
    name: $NETWORK
    external: true
EOF
  mv "$MAIL_DIR/docker-compose.yml.new" "$MAIL_DIR/docker-compose.yml"
}

mail_compose() { (cd "$MAIL_DIR" && env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin docker compose "$@"); }

clamd_ping_from_app() { # proves the staging app network reaches clamav:3310 (PING -> PONG)
  docker exec -i "$APP" node - 2>/dev/null <<'NODE' || true
const s = require('net').connect({ host: 'clamav', port: 3310 }, () => s.write('zPING\0'));
let out = ''; s.setTimeout(8000);
s.on('data', d => { out += d; if (out.includes('\0')) s.end(); });
s.on('end', () => process.stdout.write(out.replace(/\0/g, '').trim()));
s.on('timeout', () => { process.stdout.write('timeout'); s.destroy(); });
s.on('error', e => process.stdout.write(e.code || 'error'));
NODE
}

clamd_eicar_from_app() { # scans the standard EICAR test string through clamd INSTREAM
  docker exec -i "$APP" node - 2>/dev/null <<'NODE' || true
const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
const s = require('net').connect({ host: 'clamav', port: 3310 }, () => {
  s.write('zINSTREAM\0');
  const len = Buffer.alloc(4); len.writeUInt32BE(eicar.length); s.write(len); s.write(eicar);
  s.write(Buffer.alloc(4));
});
let out = ''; s.setTimeout(15000);
s.on('data', d => { out += d; if (out.includes('\0')) s.end(); });
s.on('end', () => process.stdout.write(/FOUND/.test(out) ? 'FOUND' : (out.replace(/\0/g, '').trim() || 'empty')));
s.on('timeout', () => { process.stdout.write('timeout'); s.destroy(); });
s.on('error', e => process.stdout.write(e.code || 'error'));
NODE
}

services_deploy() {
  services_preflight || return 1
  local image worker_enabled restart
  image="$(docker inspect -f '{{.Config.Image}}' "$APP")"
  [[ "$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null)" == "$(docker inspect -f '{{.Image}}' "$APP")" ]] \
    || { fail 'the staging app image tag no longer points at the running image'; return 1; }
  # A disabled worker exits 0 by design; only keep it always-on once Mail and
  # the worker are enabled (redeploy then), so it never restart-loops.
  worker_enabled="$(mail_flags)"
  if [[ ",$worker_enabled," == *,MAIL_ENABLED=true,* && ",$worker_enabled," == *,MAIL_WORKER_ENABLED=true,* ]]; then
    restart=unless-stopped
  else
    restart=on-failure:5
  fi
  write_mail_compose "$image" "$restart"
  mail_compose config -q || { fail 'Mail services Compose file is invalid'; return 1; }
  docker pull -q "$CLAMAV_IMAGE" >/dev/null
  info "ClamAV image $CLAMAV_IMAGE digest: $(docker image inspect -f '{{index .RepoDigests 0}}' "$CLAMAV_IMAGE" | cut -d@ -f2)"
  mail_compose up -d --no-build clamav mail-worker
  # Mail worker: must start with the app's image and env and behave as configured.
  local i status code
  for ((i = 0; i < 30; i++)); do
    status="$(docker inspect -f '{{.State.Status}}' "${MAIL_PROJECT}-mail-worker")"
    [[ "$status" == running || "$status" == exited ]] && break; sleep 2
  done
  sleep 5
  status="$(docker inspect -f '{{.State.Status}}' "${MAIL_PROJECT}-mail-worker")"
  code="$(docker inspect -f '{{.State.ExitCode}}' "${MAIL_PROJECT}-mail-worker")"
  if [[ "$restart" == on-failure:5 ]]; then
    if [[ "$status" == exited && "$code" == 0 ]] && docker logs "${MAIL_PROJECT}-mail-worker" 2>&1 | grep -q 'exiting without processing'; then
      pass "Mail worker deployed (image = staging app image); Mail is OFF so it exits 0 by design (restart: on-failure, no loop)"
    else
      fail "Mail worker: status $status exit $code (expected a clean disabled exit)"; return 1
    fi
  else
    [[ "$status" == running ]] && pass 'Mail worker running (Mail and worker enabled)' || { fail "Mail worker: status $status"; return 1; }
  fi
  # ClamAV: wait for signatures, then PING and EICAR through the app's network.
  local ping=''
  for ((i = 0; i < 60; i++)); do
    ping="$(clamd_ping_from_app)"; [[ "$ping" == PONG ]] && break; sleep 10
  done
  [[ "$ping" == PONG ]] || { fail "clamd not answering from the staging app network (last: ${ping:-none})"; return 1; }
  pass 'ClamAV answers PING from the staging app network at clamav:3310 (no published ports)'
  local eicar; eicar="$(clamd_eicar_from_app)"
  [[ "$eicar" == FOUND ]] || { fail "clamd did not detect the EICAR test string (got: $eicar)"; return 1; }
  pass 'ClamAV detected the EICAR test string over INSTREAM (signatures loaded)'
  [[ -z "$(docker port "${MAIL_PROJECT}-clamav")" ]] && pass 'ClamAV publishes no host ports' || { fail 'ClamAV publishes ports'; return 1; }
  verify_app 5 && pass 'staging app unchanged and verified (Prisma, health, synthetic login 401)' || { fail 'staging app does not verify'; return 1; }
  info "Not changed: staging .env (scanner settings MAIL_SCANNER_PROVIDER=clamd, MAIL_CLAMD_HOST=clamav, MAIL_CLAMD_PORT=3310 are set during Mail activation)."
}

services_remove() {
  [[ -f "$MAIL_DIR/docker-compose.yml" ]] || { info 'no Mail services Compose file; nothing to remove'; return 0; }
  mail_compose down
  pass "${MAIL_PROJECT} containers removed (signature volume kept)"
}

production_schema_names() {
  local pdb=admin-server-db-1
  [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$pdb" 2>/dev/null)" == admin-server ]] \
    || { fail 'production database container identity'; return 1; }
  docker exec -i "$pdb" sh -c 'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d cosmicforge_admin' > "$run_dir/prod-names.txt" <<'SQL'
SELECT 't:' || tablename FROM pg_tables WHERE schemaname = 'public'
UNION ALL SELECT 'y:' || t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd')
UNION ALL SELECT 'i:' || indexname FROM pg_indexes WHERE schemaname = 'public'
UNION ALL SELECT 'c:' || table_name || '.' || column_name FROM information_schema.columns WHERE table_schema = 'public';
SQL
  if grep -qx 't:social_manual_migrations' "$run_dir/prod-names.txt"; then
    docker exec -i "$pdb" sh -c 'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d cosmicforge_admin' >> "$run_dir/prod-names.txt" <<'SQL'
SELECT 'l:' || file || ':' || sha256 FROM public.social_manual_migrations;
SQL
  fi
  python3 - "$run_dir/prod-names.txt" <<'PY'
import json, sys
names = {'tables': [], 'types': [], 'indexes': [], 'columns': [], 'ledger': []}
key = {'t': 'tables', 'y': 'types', 'i': 'indexes', 'c': 'columns', 'l': 'ledger'}
for line in open(sys.argv[1]):
    kind, _, value = line.strip().partition(':')
    if kind in key and value:
        names[key[kind]].append(value)
for v in names.values():
    v.sort()
present = 'social_manual_migrations' in names['tables']
print('CA_SCHEMA_NAMES ' + json.dumps({'schemaNames': {'database': 'cosmicforge_admin', 'ledgerTablePresent': present, **names}}, sort_keys=True))
PY
  pass "production cosmicforge_admin catalog names read ($(grep -c '^t:' "$run_dir/prod-names.txt") tables); nothing changed"
}

case "$mode" in
  --production-schema-names) production_schema_names ;;
  --migrate-preflight) migrate_preflight ;;
  --migrate-apply) migrate_apply ;;
  --services-preflight) services_preflight ;;
  --services-deploy) services_deploy ;;
  --services-remove) services_remove ;;
esac
