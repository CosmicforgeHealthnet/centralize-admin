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
#   --containers          READ-ONLY: every container's name, status, start time
#                         and restart count (no environment, no content)
#   --production-schema-names  READ-ONLY: catalog object NAMES (tables, types,
#                         indexes, columns, ledger rows) of production
#                         admin-server-db-1/cosmicforge_admin, so the runner can
#                         classify which manifest migrations production has.
#                         No data, no change, nothing else in production read.
#
#   --storage-setup       self-hosted Mail storage + keys (no AWS): dedicated
#                         store volume, keyring file generated on the server (or
#                         imported from the existing env keyring so stored data
#                         stays readable), recovery escrow when a recovery public
#                         key is bundled, one mounts file used by every deploy
#                         path, settings installed by ca-mail-env-install.sh,
#                         then --storage-check. (--pilot-storage-setup = alias.)
#   --mail-diagnose       READ-ONLY: Mail processing diagnostic (no content):
#                         worker container state, image, restart policy and
#                         database; queue counts per kind/status; every
#                         inbound job with its webhook event, recipient
#                         routing and stored copies; rollout rules, emergency
#                         stops, heartbeats, open alerts; lock holders.
#   --storage-check       READ-ONLY (one canary object written and removed):
#                         keyring loaded from the file, store on its own volume
#                         and bound to this environment, encrypt/write/fsync/
#                         read/decrypt/delete round trip, worker mounts.
#
# --target=production (default staging) is accepted by the migration, services,
# storage and check modes; the workflow requires a separate production
# confirmation for every mutating one.
#
# Never: enables any Mail flag, touches RTC (cosmicforge-db), Karryam or any
# other project. Only --storage-setup changes the app's .env (Mail storage/key
# settings, through ca-mail-env-install.sh with its backup and rollback).
# Files are read from the RUNNING staging app image and must match the pinned
# checksums below. No secret, URL or record content is printed.
set -Eeuo pipefail
umask 077
export LC_ALL=C

# Target: staging (default) or production (--target=production). Production
# modes read files from the RUNNING production image, so they refuse until
# production runs a release that contains them.
target=staging
[[ "${2:-}" == --target=production ]] && target=production
if [[ "$target" == production ]]; then
  APP=admin-server-app-1; DB=admin-server-db-1; PROJECT=admin-server
  VOLUME=admin-server_postgres_data; NETWORK=admin-server_default
  APP_ROOT=/var/www/admin-server; MAIL_PROJECT=admin-server-mail; MAIL_DIR=/var/www/admin-server-mail
  STORE_VOLUME=admin-server-mail-store
else
  APP=admin-server-staging-app-1; DB=admin-server-staging-db-1; PROJECT=admin-server-staging
  VOLUME=admin-server-staging_postgres_data_staging; NETWORK=admin-server-staging_default
  APP_ROOT=/var/www/admin-server-staging; MAIL_PROJECT=admin-server-staging-mail; MAIL_DIR=/var/www/admin-server-staging-mail
  STORE_VOLUME=admin-server-staging-mail-store
fi
readonly APP DB PROJECT VOLUME NETWORK target APP_ROOT MAIL_PROJECT MAIL_DIR STORE_VOLUME
readonly DEST=cosmicforge_admin
readonly ENV_FILE="$APP_ROOT/.env"
readonly CLAMAV_IMAGE=clamav/clamav:1.4
# Self-hosted Mail storage and keys (no cloud): store volume mounted at
# STORE_DIR; keyring file in a root-only host directory mounted read-only.
readonly STORE_DIR=/var/lib/cosmicforge-mail
readonly KEY_BASE=/etc/cosmicforge-mail
readonly KEY_DIR="$KEY_BASE/$target/keyring"
readonly ESCROW_DIR="$KEY_BASE/$target/escrow"
readonly KEY_MOUNT=/run/secrets/cosmicforge-mail
readonly KEY_FILE_IN_APP="$KEY_MOUNT/keyring.json"
# Every Compose call for the app (deploys, rollbacks, settings installs, the
# cutover) adds this file when present, so the mounts survive every release.
readonly MOUNTS_FILE="$APP_ROOT/docker-compose.mail-storage.yml"
readonly STAGING_OVERRIDE=/home/cf-staging-deploy/docker-compose.github-staging.yml
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
  --migrate-preflight|--migrate-apply|--services-preflight|--services-deploy|--services-remove|--production-schema-names|--containers|--staging-checks|--pilot-storage-setup|--storage-setup|--storage-check|--mail-diagnose) ;;
  *) echo 'Usage (root): ca-mail-staging-ops.sh --migrate-preflight|--migrate-apply|--services-preflight|--services-deploy|--storage-setup|--storage-check|--staging-checks|--mail-diagnose [--target=production] | --services-remove|--production-schema-names|--containers|--pilot-storage-setup' >&2; exit 2 ;;
esac
[[ "$mode" == --pilot-storage-setup ]] && mode=--storage-setup
if [[ -n "${2:-}" ]]; then
  case "$mode" in
    --migrate-preflight|--migrate-apply|--services-preflight|--services-deploy|--storage-setup|--storage-check|--staging-checks|--mail-diagnose) ok_target=yes ;;
    *) ok_target=no ;;
  esac
  [[ "${2:-}" == --target=production && "$ok_target" == yes && -z "${3:-}" ]] \
    || { echo 'Unexpected arguments (--target=production is accepted by the migration, services, storage and check modes only).' >&2; exit 2; }
fi
[[ "$(id -u)" -eq 0 ]] || { echo 'Run as root.' >&2; exit 2; }
for tool in docker python3 flock sha256sum awk; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 2; }; done

# Who holds a lock file: "PID command;" per locking process (or empty).
lock_holder() {
  local ino; ino="$(stat -c %i "$1" 2>/dev/null)" || return 0
  awk -v ino="$ino" '$2 == "FLOCK" { n = split($6, a, ":"); if (a[n] == ino) print $5 }' /proc/locks | sort -u | while read -r pid; do
    [[ "$pid" == "$$" ]] && continue
    printf '%s %s;' "$pid" "$( { tr '\0' ' ' < "/proc/$pid/cmdline"; } 2>/dev/null | cut -c1-160)"
  done
}
# Read-only modes take both locks SHARED: they may run side by side, never
# during a mutating Mail operation or the database isolation cutover, and a
# concurrent production deploy waits for them instead of reporting a cutover.
readonly_mode=false
case "$mode" in --migrate-preflight|--services-preflight|--production-schema-names|--containers|--staging-checks|--storage-check|--mail-diagnose) readonly_mode=true ;; esac
lock_kind=-x; [[ "$readonly_mode" == true ]] && lock_kind=-s
mkdir -p /run/lock
exec 8>"/run/lock/centralize-admin-mail-$target.lock"
flock "$lock_kind" -n 8 || { echo "Another CA $target Mail operation is running (holder: $(lock_holder "/run/lock/centralize-admin-mail-$target.lock")); refusing overlap. Nothing changed." >&2; exit 1; }
# Never overlap the database isolation cutover either.
exec 9>/run/lock/centralize-admin-db-isolation.lock
db_lock_note=''
if ! flock "$lock_kind" -n 9; then
  holder="$(lock_holder /run/lock/centralize-admin-db-isolation.lock)"
  if [[ "$mode" == --mail-diagnose ]]; then
    # The diagnostic only reads; it reports the holder instead of refusing.
    db_lock_note="the DB isolation lock is held by: ${holder:-unknown}"; exec 9>&-
  else
    echo "The CA DB isolation lock is held (holder: ${holder:-unknown}); refusing overlap. Nothing changed." >&2; exit 1
  fi
fi

run_dir="$BACKUP_BASE/mail-$target-$RUN_ID"
mkdir -p "$BACKUP_BASE"; chmod 700 "$BACKUP_BASE"; mkdir -m 700 "$run_dir"
# tee must not inherit the lock descriptors, or a lock released later stays held.
exec > >(exec 8>&- 9>&-; tee -a "$run_dir/run.log") 2>&1
echo "CA Mail ops ($target), run $RUN_ID, mode $mode"
echo "Root-only run directory: $run_dir"

declare -a SUMMARY=()
pass() { SUMMARY+=("PASS  $*"); echo "PASS: $*"; }
fail() { SUMMARY+=("FAIL  $*"); echo "FAIL: $*" >&2; }
info() { SUMMARY+=("INFO  $*"); echo "INFO: $*"; }

snapshot_others() { # every container except the ones this mode may change on purpose
  local id skip="/${MAIL_PROJECT}-(clamav|mail-worker)"
  # --migrate-apply restarts the staging app (same container) on purpose.
  [[ "$mode" == --migrate-apply || "$mode" == --storage-setup ]] && skip="$skip|/$APP"
  for id in $(docker ps -aq --no-trunc); do
    docker inspect -f '{{.Id}}|{{.Name}}|{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}' "$id"
  done | grep -vE "\|($skip)\|" | sort
}
others_before="$(snapshot_others)"
scratch=''
on_exit() {
  local code=$?
  trap - EXIT
  if [[ -n "$scratch" ]]; then drop_scratch || fail "could not drop this run's scratch database $scratch (marked, safe to drop)"; fi
  local others_after changed
  others_after="$(snapshot_others)"
  if [[ "$others_after" == "$others_before" ]]; then
    pass 'every other container (production, RTC, KarryGo, CFMeet, ...) unchanged'
  else
    changed="$(comm -3 <(sort <<<"$others_before") <(sort <<<"$others_after") | tr -d '\t' | cut -d'|' -f2 | sort -u | tr '\n' ' ')"
    fail "other containers changed state during the run (names): $changed"
    [[ "$code" -ne 0 ]] || code=3
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
  [[ "$(app_db)" == "$DEST" ]] || { echo "  $target app does not run on $DEST"; ok=1; }
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
  identity || { fail "$target identity"; return 1; }
  pass "$target identity (containers, project, volume, network); app runs on $DEST"
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
  info "Mail flags in the running $target app: $(mail_flags)"
  verify_app 3 && pass "$target app: Prisma on cosmicforge_admin, AdminUser, health, synthetic login 401" || { fail "$target app does not verify"; return 1; }
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
  verify_app 45 || { fail "$target app did not verify after restart (schema changes are additive; investigate)"; return 1; }
  [[ "$(mail_flags)" == "$flags_before" ]] || { fail 'Mail flags changed'; return 1; }
  pass "$target app restarted and verified (Prisma, AdminUser, health, synthetic login 401); Mail flags unchanged: $flags_before"
}

# --------------------------------------------------------------------------
# Services: ClamAV + Mail worker (staging only).
# --------------------------------------------------------------------------
mem_available_mb() { awk '/MemAvailable/ {print int($2 / 1024)}' /proc/meminfo; }

services_preflight() {
  identity || { fail "$target identity"; return 1; }
  pass "$target identity; network $NETWORK present"
  local avail; avail="$(mem_available_mb)"
  info "host MemAvailable ${avail} MB"
  local have=false; docker inspect "${MAIL_PROJECT}-clamav" >/dev/null 2>&1 && have=true
  if [[ "$have" == false ]] && (( avail < 3072 )); then
    fail "less than 3 GB memory available for ClamAV (needs ~1.5 GB, limit 3 GB); not deploying"; return 1
  fi
  [[ -f "$BUNDLE_DIR/clamd.conf" && -f "$BUNDLE_DIR/freshclam.conf" ]] || { fail 'ClamAV config files missing from the uploaded bundle'; return 1; }
  pass 'memory and ClamAV configuration available'
  info "$target app image: $(docker inspect -f '{{.Config.Image}}' "$APP"); Mail flags: $(mail_flags)"
  local c; for c in clamav mail-worker; do
    if docker inspect "${MAIL_PROJECT}-$c" >/dev/null 2>&1; then
      info "${MAIL_PROJECT}-$c exists: $(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${MAIL_PROJECT}-$c")"
    else
      info "${MAIL_PROJECT}-$c not deployed"
    fi
  done
}

# Mail storage mounts shared by the app and the worker (only what exists).
mail_mount_items() {
  local -a items=()
  docker volume inspect "$STORE_VOLUME" >/dev/null 2>&1 && items+=("\"$STORE_VOLUME:$STORE_DIR\"")
  [[ -f "$KEY_DIR/keyring.json" ]] && items+=("\"$KEY_DIR:$KEY_MOUNT:ro\"")
  local IFS=,; echo "${items[*]}"
}
pilot_worker_volume() { local items; items="$(mail_mount_items)"; [[ -n "$items" ]] && printf '    volumes: [%s]\n' "$items"; return 0; }
pilot_volume_decl() { docker volume inspect "$STORE_VOLUME" >/dev/null 2>&1 && printf '  %s:\n    external: true\n' "$STORE_VOLUME"; return 0; }

write_mounts_file() { # the app's Compose mounts file (no secrets: paths only)
  local items; items="$(mail_mount_items)"
  [[ -n "$items" ]] || { rm -f "$MOUNTS_FILE"; return 0; }
  { printf '# Managed by .github/scripts/ca-mail-staging-ops.sh --storage-setup (paths only, no secrets).\nservices:\n  app:\n    volumes: [%s]\n' "$items"
    docker volume inspect "$STORE_VOLUME" >/dev/null 2>&1 && printf 'volumes:\n  %s:\n    external: true\n' "$STORE_VOLUME"
  } > "$MOUNTS_FILE.new"
  chmod 644 "$MOUNTS_FILE.new"; mv -f "$MOUNTS_FILE.new" "$MOUNTS_FILE"
}

write_mail_compose() {
  local image="$1" worker_restart="$2"
  mkdir -p "$MAIL_DIR"; chmod 750 "$MAIL_DIR"
  install -m 0644 "$BUNDLE_DIR/clamd.conf" "$MAIL_DIR/clamd.conf"
  install -m 0644 "$BUNDLE_DIR/freshclam.conf" "$MAIL_DIR/freshclam.conf"
  cat > "$MAIL_DIR/docker-compose.yml.new" <<EOF
# Managed by .github/scripts/ca-mail-staging-ops.sh (CA ${target^^} only).
# ClamAV: private, no published ports; reachable as clamav:3310 on $NETWORK.
# Mail worker: same image, env file and Mail storage mounts as $APP.
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
      test: ["CMD-SHELL","printf 'zPING\\\\000' | nc -w 3 127.0.0.1 3310 | grep -q '^PONG'"]
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
      appnet:
        aliases: [clamav]
    labels: { ca.environment: $target, ca.component: mail-scanner }
    logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }
  mail-worker:
    image: $image
    pull_policy: never
    container_name: ${MAIL_PROJECT}-mail-worker
    command: ["node", "src/mail-worker.js"]
    restart: "$worker_restart"
    env_file: [$ENV_FILE]
    security_opt: ["no-new-privileges:true"]
    networks: [appnet]
$(pilot_worker_volume)
    labels: { ca.environment: $target, ca.component: mail-worker }
    logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }
volumes:
  clamav-signatures:
$(pilot_volume_decl)
networks:
  appnet:
    name: $NETWORK
    external: true
EOF
  mv "$MAIL_DIR/docker-compose.yml.new" "$MAIL_DIR/docker-compose.yml"
  # The staging deploy account (docker group, no root) recreates the worker on
  # each app release, so it may read these files. They hold no secret: the
  # worker's settings come from the staging .env the app already uses.
  # Production files stay root-only.
  if [[ "$target" == staging ]] && getent group cf-staging-deploy >/dev/null; then
    chgrp cf-staging-deploy "$MAIL_DIR" "$MAIL_DIR/docker-compose.yml" "$MAIL_DIR/clamd.conf" "$MAIL_DIR/freshclam.conf"
    chmod 750 "$MAIL_DIR"; chmod 640 "$MAIL_DIR/docker-compose.yml"
  fi
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
    || { fail 'the $target app image tag no longer points at the running image'; return 1; }
  # Core Mail processing is backend-managed: with Mail on, the worker runs
  # unless MAIL_WORKER_ENABLED=false, and restarts after crashes and reboots.
  # With Mail off it idles (current images) or exits 0 (older images), so the
  # restart policy then avoids any restart loop.
  worker_enabled="$(mail_flags)"
  if [[ ",$worker_enabled," == *,MAIL_ENABLED=true,* && ",$worker_enabled," != *,MAIL_WORKER_ENABLED=false,* ]]; then
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
  local i status code out
  for ((i = 0; i < 30; i++)); do
    status="$(docker inspect -f '{{.State.Status}}' "${MAIL_PROJECT}-mail-worker")"
    [[ "$status" == running || "$status" == exited ]] && break; sleep 2
  done
  sleep 5
  status="$(docker inspect -f '{{.State.Status}}' "${MAIL_PROJECT}-mail-worker")"
  code="$(docker inspect -f '{{.State.ExitCode}}' "${MAIL_PROJECT}-mail-worker")"
  if [[ "$restart" == on-failure:5 ]]; then
    if [[ "$status" == exited && "$code" == 0 ]] && docker logs "${MAIL_PROJECT}-mail-worker" 2>&1 | grep -q 'exiting without processing'; then
      pass "Mail worker deployed (image = $target app image); Mail is OFF so it exits 0 by design (restart: on-failure, no loop)"
    elif [[ "$status" == running ]] && docker logs "${MAIL_PROJECT}-mail-worker" 2>&1 | grep -q '\[MailWorker\] idle:'; then
      pass "Mail worker deployed (image = $target app image); idle by configuration, processing nothing (restart: on-failure)"
    else
      fail "Mail worker: status $status exit $code (expected an idle or cleanly disabled worker)"; return 1
    fi
  else
    [[ "$status" == running ]] || { fail "Mail worker: status $status exit $code although Mail is enabled (an exited worker is never healthy)"; return 1; }
    local r0 r1; r0="$(docker inspect -f '{{.RestartCount}}' "${MAIL_PROJECT}-mail-worker")"; sleep 12; r1="$(docker inspect -f '{{.RestartCount}}' "${MAIL_PROJECT}-mail-worker")"
    [[ "$(docker inspect -f '{{.State.Status}}' "${MAIL_PROJECT}-mail-worker")" == running && "$r0" == "$r1" ]] || { fail "Mail worker is not stable (restarts $r0 -> $r1)"; return 1; }
    if docker exec "$APP" test -f /app/scripts/mail/verify-worker.js; then
      out="$(docker exec -w /app "$APP" node scripts/mail/verify-worker.js --wait 120 2>/dev/null | grep '^CA_MAIL_WORKER_VERIFY ' | tail -n 1 || true)"
      out="${out#CA_MAIL_WORKER_VERIFY }"
      python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d.get("ok") else 1)' "$out" 2>/dev/null         || { fail "Mail worker running but did not prove processing: ${out:-no output}"; return 1; }
      pass 'Mail worker running and processing (restart: unless-stopped; heartbeat, core queues and self-test job verified)'
    else
      pass 'Mail worker running and stable (restart: unless-stopped; image predates worker heartbeats)'
    fi
  fi
  # ClamAV: wait for signatures, then PING and EICAR through the app's network.
  local ping=''
  for ((i = 0; i < 60; i++)); do
    ping="$(clamd_ping_from_app)"; [[ "$ping" == PONG ]] && break; sleep 10
  done
  [[ "$ping" == PONG ]] || { fail "clamd not answering from the $target app network (last: ${ping:-none})"; return 1; }
  pass 'ClamAV answers PING from the $target app network at clamav:3310 (no published ports)'
  local eicar; eicar="$(clamd_eicar_from_app)"
  [[ "$eicar" == FOUND ]] || { fail "clamd did not detect the EICAR test string (got: $eicar)"; return 1; }
  pass 'ClamAV detected the EICAR test string over INSTREAM (signatures loaded)'
  [[ -z "$(docker port "${MAIL_PROJECT}-clamav")" ]] && pass 'ClamAV publishes no host ports' || { fail 'ClamAV publishes ports'; return 1; }
  verify_app 5 && pass "$target app unchanged and verified (Prisma, health, synthetic login 401)" || { fail "$target app does not verify"; return 1; }
  info "Not changed: $target .env (scanner settings MAIL_SCANNER_PROVIDER=clamd, MAIL_CLAMD_HOST=clamav, MAIL_CLAMD_PORT=3310 are set during Mail activation)."
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

# --------------------------------------------------------------------------
# Staging checks that need no external credentials (all read-only; run inside
# the staging app with the code it actually runs).
# --------------------------------------------------------------------------
staging_checks() { # read-only Mail readiness checks (staging or production)
  identity || { fail "$target identity"; return 1; }
  local bad=0 out
  # 1. Schema readiness of every Mail feature set, via the app's own module.
  # dotenv prints a banner on stdout; keep only the JSON result line.
  out="$(docker exec -i -w /app "$APP" node - 2>/dev/null <<'NODE' | grep -E '^\{' | tail -n 1 || true
const { prisma } = require('./src/shared/config/database');
const r = require('./src/modules/mail/schema-readiness');
(async () => {
  const sets = { core: r.MAIL_SCHEMA_REQUIREMENTS, features: r.MAIL_FEATURE_REQUIREMENTS, preferences: r.MAIL_PREFERENCES_REQUIREMENTS, finalGap: r.MAIL_FINAL_GAP_REQUIREMENTS };
  const res = {};
  for (const [name, requirements] of Object.entries(sets)) res[name] = await r.createMailSchemaReadiness({ client: prisma, requirements, label: name }).check();
  process.stdout.write(JSON.stringify(res));
})().catch(e => process.stdout.write(JSON.stringify({ error: e.code || e.name }))).finally(() => prisma.$disconnect());
NODE
)"
  if python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d and all(v.get("ready") for v in d.values()) else 1)' "$out" 2>/dev/null; then
    pass "Mail schema readiness (app code, real $target DB): core, features, preferences, final gap all ready"
  else
    fail "Mail schema readiness: $out"; bad=1
  fi
  # 2. The app's Mail config validator for an ENABLED preview (process
  #    environment only; .env untouched). Lists exactly what is still missing.
  #    Inbound belongs to production (the one shared Resend webhook).
  out="$(docker exec -w /app -e MAIL_DEPLOYMENT_ENV="$target" -e MAIL_PROVIDER=resend -e MAIL_PROVIDER_ENVIRONMENT_TAG="$target" \
      -e MAIL_ENABLED=true -e MAIL_SENDING_ENABLED=true -e MAIL_RECEIVING_ENABLED=true -e MAIL_WORKER_ENABLED=true \
      -e MAIL_SCANNER_PROVIDER=clamd -e MAIL_CLAMD_HOST=clamav -e MAIL_CLAMD_PORT=3310 \
      -e MAIL_DOMAIN_ALLOWLIST=karryam.com -e MAIL_RESERVED_SENDER_ADDRESSES=no-reply@karryam.com \
      -e MAIL_INBOUND_ACTIVE_ENVIRONMENT=production -e MAIL_MIXED_RECIPIENT_MODE=external-only -e MAIL_UNKNOWN_RECIPIENT_POLICY=reject \
      "$APP" node scripts/mail/validate-infrastructure.js 2>/dev/null | tail -1 || true)"
  info "Mail config validator, $target ENABLED preview (what is still missing): $(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(json.dumps({k: d.get(k) for k in ("providerKeyPresent","webhookSecretPresent","storage","kms","scanner","violations")}))' "$out" 2>/dev/null || echo "$out")"
  # 3. ClamAV through the app's own scanner adapter (repo live test).
  if docker exec -w /app -e MAIL_CLAMD_LIVE_HOST=clamav -e MAIL_CLAMD_LIVE_PORT=3310 -e TEST_NETWORK_GUARD_ENABLED=false "$APP" node --test tests/mail-clamd-live.test.js > "$run_dir/clamd-live.txt" 2>&1 \
     && grep -qE '^# pass [1-9]' "$run_dir/clamd-live.txt" && grep -qE '^# skipped 0' "$run_dir/clamd-live.txt"; then
    pass 'ClamAV live test through the app scanner adapter: PING/VERSION, EICAR detected, clean accepted, oversize quarantined'
  else
    fail "ClamAV live test: $(grep -E '^# (pass|fail|skipped)' "$run_dir/clamd-live.txt" | tr '\n' ' ')"; bad=1
  fi
  # 4. Karryam mailbox provisioning, dry run (writes nothing).
  local rc=0
  docker exec -w /app -e MAIL_DOMAIN_ALLOWLIST=karryam.com -e MAIL_RESERVED_SENDER_ADDRESSES=no-reply@karryam.com \
    "$APP" node scripts/mail/provision-karryam.js --allow-remote > "$run_dir/provision-dry-run.json" 2>"$run_dir/provision-dry-run.err" || rc=$?
  if [[ "$rc" == 0 || "$rc" == 2 ]]; then
    info "Karryam provisioning dry run (exit $rc; 2 = steps left to apply): $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(json.dumps(d)[:1500])' "$run_dir/provision-dry-run.json" 2>/dev/null || head -c 600 "$run_dir/provision-dry-run.json")"
  else
    fail "Karryam provisioning dry run failed (exit $rc): $(tail -2 "$run_dir/provision-dry-run.err" | tr '\n' ' ')"; bad=1
  fi
  # 5. Self-hosted storage and keys (canary object written and removed).
  if docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' "$APP" | grep -q "$STORE_DIR"; then
    storage_check || bad=1
  else
    info "self-hosted storage not set up on $target yet (run storage-setup)"
  fi
  # 6. Live readiness endpoint as served.
  info "readiness endpoint: $(docker exec "$APP" node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/mail/v1/health/ready').then(r=>r.text()).then(t=>process.stdout.write(t.slice(0,600)))" 2>/dev/null || echo unavailable)"
  # 7. Mail setup and activity, COUNTS ONLY (no address, subject or body):
  #    what the Admin UI set up and what happened to outbound mail.
  out="$(docker exec -i -w /app "$APP" node - 2>/dev/null <<'NODE' | grep -E '^\{' | tail -n 1 || true
const { prisma: c } = require('./src/shared/config/database');
const day = new Date(Date.now() - 7 * 86400000);
const group = async (model, by, where) => Object.fromEntries((await c[model].groupBy({ by, where, _count: { _all: true } })).map((r) => [by.map((k) => r[k]).join('/'), r._count._all]));
(async () => {
  const domains = await c.mailDomain.findMany({ select: { domain: true, status: true, sendingStatus: true, receivingStatus: true } });
  const res = {
    organizations: await c.mailOrganization.count(),
    domains: domains.map((d) => `${d.domain}:${d.status}/send=${d.sendingStatus}/receive=${d.receivingStatus}`),
    mailboxes: await group('mailMailbox', ['type', 'status']),
    addresses: await c.mailAddress.count({ where: { status: 'ACTIVE' } }),
    activeMemberships: await group('mailMembership', ['role'], { revokedAt: null }),
    activeSenderGrants: await c.mailSenderGrant.count({ where: { revokedAt: null } }),
    rolloutRules: await group('mailRolloutRule', ['capability', 'scopeType', 'effect'], { environment: process.env.MAIL_DEPLOYMENT_ENV, revokedAt: null }),
    cohortMembers: await c.mailRolloutCohortMember.count({ where: { removedAt: null } }),
    emergencyStopsActive: await c.mailEmergencyStop.count({ where: { environment: process.env.MAIL_DEPLOYMENT_ENV, releasedAt: null } }),
    outbound7d: await group('mailMessage', ['status'], { direction: 'OUTBOUND', createdAt: { gte: day } }),
    deliveryEvents7d: await group('mailDeliveryEvent', ['eventType'], { createdAt: { gte: day } }),
    deliveryEventSources7d: await group('mailWebhookEvent', ['provider', 'status'], { receivedAt: { gte: day } }),
    jobs7d: await group('mailOutboxJob', ['kind', 'status'], { createdAt: { gte: day } }),
  };
  process.stdout.write(JSON.stringify(res));
})().catch((e) => process.stdout.write(JSON.stringify({ error: e.code || e.name }))).finally(() => c.$disconnect());
NODE
)"
  info "Mail setup and activity (counts only; outbound/events/jobs over 7 days): ${out:-unavailable}"
  return "$bad"
}

# --------------------------------------------------------------------------
# Self-hosted Mail storage and keys (staging and production, no cloud):
#   store   dedicated Docker volume $STORE_VOLUME at $STORE_DIR (encrypted
#           filesystem backend: bound to this environment, own volume, fsync)
#   keys    $KEY_DIR/keyring.json (root:root 0400, dir 0700), mounted
#           read-only at $KEY_MOUNT. Generated HERE inside the app image, or
#           imported from the existing env keyring so stored data stays
#           readable. Never printed, never in GitHub, never in the .env.
#   escrow  sealed to the offline recovery public key when one is bundled
#           (infrastructure/mail/recovery/<target>.pub), for host recovery.
# Mail flags are never changed.
# --------------------------------------------------------------------------
app_image() { docker inspect -f '{{.Config.Image}}' "$APP"; }

keyring_cli() { # runs scripts/mail/keyring.js in the app image, no network
  docker run --rm --network none --entrypoint node -w /app \
    -v "$KEY_DIR:/keys" -v "$ESCROW_DIR:/escrow" -v "$KEY_BASE/$target/recovery:/recovery:ro" \
    "$(app_image)" scripts/mail/keyring.js "$@"
}

keyring_setup() {
  install -d -m 0711 "$KEY_BASE" "$KEY_BASE/$target"
  install -d -m 0700 "$KEY_DIR" "$ESCROW_DIR"
  install -d -m 0755 "$KEY_BASE/$target/recovery"
  local out
  if [[ -f "$KEY_DIR/keyring.json" ]]; then
    out="$(keyring_cli inspect --file=/keys/keyring.json)" || { fail "existing keyring file is invalid; it was NOT replaced"; return 1; }
    python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d.get("environment")==sys.argv[2] else 1)' "$out" "$target" \
      || { fail "existing keyring belongs to another environment; refusing"; return 1; }
    info "keyring file exists and is kept: $out"
  elif [[ -n "$(docker inspect -f '{{json .Config.Env}}' "$APP" | python3 -c 'import json,sys; e=dict(x.split("=",1) for x in json.load(sys.stdin) if "=" in x); print(e.get("MAIL_ENCRYPTION_KEYS","").strip())')" ]]; then
    # Keep the keys already used for this environment's ciphertext. Values go
    # from docker inspect to the container environment, never to argv or logs.
    out="$(python3 - "$APP" "$(app_image)" "$KEY_DIR" "$target" <<'PY'
import json, os, subprocess, sys
app, image, keydir, target = sys.argv[1:]
env = dict(x.split('=', 1) for x in json.loads(subprocess.check_output(['docker', 'inspect', '-f', '{{json .Config.Env}}', app])) if '=' in x)
penv = {'PATH': os.environ['PATH'], 'HOME': '/root', 'MAIL_ENCRYPTION_KEYS': env.get('MAIL_ENCRYPTION_KEYS', ''), 'MAIL_ENCRYPTION_ACTIVE_KEY': env.get('MAIL_ENCRYPTION_ACTIVE_KEY', '')}
r = subprocess.run(['docker', 'run', '--rm', '--network', 'none', '-e', 'MAIL_ENCRYPTION_KEYS', '-e', 'MAIL_ENCRYPTION_ACTIVE_KEY', '-v', f'{keydir}:/keys',
                    '-w', '/app', '--entrypoint', 'node', image, 'scripts/mail/keyring.js', 'import-env', f'--environment={target}', '--out=/keys/keyring.json'],
                   env=penv, capture_output=True, text=True)
print(r.stdout.strip()); sys.stderr.write(r.stderr[-300:]); sys.exit(r.returncode)
PY
)" || { fail 'importing the existing env keyring failed'; return 1; }
    pass "existing env keyring imported into $KEY_DIR/keyring.json (same keys; stored data stays readable): $out"
  else
    out="$(keyring_cli generate --environment="$target" --out=/keys/keyring.json)" || { fail 'keyring generation failed'; return 1; }
    pass "new keyring generated on the server: $out"
  fi
  chown root:root "$KEY_DIR/keyring.json"; chmod 0400 "$KEY_DIR/keyring.json"
  [[ "$(stat -c '%U:%G %a' "$KEY_DIR/keyring.json")" == 'root:root 400' && "$(stat -c '%a' "$KEY_DIR")" == 700 ]] \
    || { fail 'keyring file or directory permissions are not root-only'; return 1; }
  pass "keyring file root:root 0400 in a 0700 directory; mounted read-only at $KEY_MOUNT"
  # Recovery escrow (sealed to the owner's offline RSA key).
  if [[ -f "$BUNDLE_DIR/recovery-$target.pub" ]]; then
    install -m 0644 "$BUNDLE_DIR/recovery-$target.pub" "$KEY_BASE/$target/recovery/recovery.pub"
    out="$(keyring_cli seal --file=/keys/keyring.json --recipient=/recovery/recovery.pub --out=/escrow/keyring-escrow.json)" || { fail 'sealing the recovery escrow failed'; return 1; }
    chmod 0600 "$ESCROW_DIR/keyring-escrow.json"
    keyring_cli verify-escrow --file=/keys/keyring.json --escrow=/escrow/keyring-escrow.json >/dev/null \
      && pass "recovery escrow sealed and verified against the keyring: $out" || { fail 'escrow does not match the keyring'; return 1; }
  else
    info "no recovery public key bundled (infrastructure/mail/recovery/$target.pub): escrow PENDING. Keys cannot be recovered after host loss until it exists."
  fi
}

storage_setup() {
  identity || { fail "$target identity"; return 1; }
  [[ -f "$BUNDLE_DIR/ca-mail-env-install.sh" ]] || { fail 'ca-mail-env-install.sh missing from the bundle'; return 1; }
  docker run --rm --network none --entrypoint test "$(app_image)" -f /app/scripts/mail/keyring.js \
    || { fail "the running $target image has no self-hosted keyring support; deploy a release with it first"; return 1; }
  if ! docker volume inspect "$STORE_VOLUME" >/dev/null 2>&1; then
    docker volume create --label "ca.environment=$target" --label ca.component=mail-store "$STORE_VOLUME" >/dev/null
    pass "created store volume $STORE_VOLUME"
  else
    [[ "$(docker volume inspect -f '{{index .Labels "ca.environment"}}' "$STORE_VOLUME")" == "$target" ]] \
      || { fail "volume $STORE_VOLUME is not labelled ca.environment=$target; refusing"; return 1; }
    info "store volume $STORE_VOLUME exists (kept)"
  fi
  keyring_setup || return 1
  write_mounts_file
  pass "mounts file $MOUNTS_FILE: $STORE_VOLUME at $STORE_DIR, keyring directory read-only at $KEY_MOUNT"
  if [[ "$target" == staging && -f "$STAGING_OVERRIDE" ]]; then
    # The mounts now live in the mounts file; the deploy override pins the image only.
    local image owner; image="$(app_image)"; owner="$(stat -c '%U:%G' "$STAGING_OVERRIDE")"
    printf 'services:\n  app:\n    image: %s\n    pull_policy: never\n' "$image" > "$STAGING_OVERRIDE.new"
    chown "$owner" "$STAGING_OVERRIDE.new"; chmod 644 "$STAGING_OVERRIDE.new"; mv "$STAGING_OVERRIDE.new" "$STAGING_OVERRIDE"
    pass 'staging deploy override pins the image only (image unchanged)'
  fi
  if [[ -f "$MAIL_DIR/docker-compose.yml" ]]; then
    local restart; restart="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}{{if .HostConfig.RestartPolicy.MaximumRetryCount}}:{{.HostConfig.RestartPolicy.MaximumRetryCount}}{{end}}' "${MAIL_PROJECT}-mail-worker" 2>/dev/null || echo on-failure:5)"
    write_mail_compose "$(app_image)" "$restart"
    pass 'Mail worker Compose file mounts the same store and keyring'
  fi
  local values; values="$(mktemp /run/ca-storage-XXXXXX)"
  printf '%s\n' "MAIL_DEPLOYMENT_ENV=$target" 'MAIL_STORAGE_PROVIDER=filesystem' "MAIL_STORAGE_LOCAL_DIR=$STORE_DIR" \
    'MAIL_KMS_PROVIDER=file' "MAIL_ENCRYPTION_KEYRING_FILE=$KEY_FILE_IN_APP" 'MAIL_ENCRYPTION_KEYS=' 'MAIL_ENCRYPTION_ACTIVE_KEY=' \
    'MAIL_SCANNER_PROVIDER=clamd' 'MAIL_CLAMD_HOST=clamav' 'MAIL_CLAMD_PORT=3310' > "$values"
  # The installer takes the isolation lock itself; release ours first.
  exec 9>&-
  if bash "$BUNDLE_DIR/ca-mail-env-install.sh" --apply "$target" "$values" > "$run_dir/storage-install.log" 2>&1; then
    pass 'storage/key/scanner settings installed by ca-mail-env-install.sh (backup, same-image recreate, app verified); env keys cleared'
  else
    if grep -q '==================== SUMMARY ====================' "$run_dir/storage-install.log"; then
      sed -n '/==================== SUMMARY ====================/,$p' "$run_dir/storage-install.log"
    else
      tail -n 30 "$run_dir/storage-install.log"
    fi
    fail 'storage settings install failed (the installer rolled the .env back; see above)'; rm -f "$values"; return 1
  fi
  rm -f "$values"
  storage_check
}

storage_check() {
  identity || { fail "$target identity"; return 1; }
  local mounts out bad=0
  mounts="$(docker inspect -f '{{range .Mounts}}{{.Source}}|{{.Name}}|{{.Destination}}|{{.RW}};{{end}}' "$APP")"
  [[ "$mounts" == *"|$STORE_VOLUME|$STORE_DIR|true;"* ]] && pass "app mounts $STORE_VOLUME at $STORE_DIR" || { fail "app does not mount $STORE_VOLUME at $STORE_DIR"; bad=1; }
  [[ "$mounts" == *"$KEY_DIR||$KEY_MOUNT|false;"* ]] && pass "app mounts the keyring directory read-only at $KEY_MOUNT" || { fail 'app does not mount the keyring directory read-only'; bad=1; }
  # In the app: config rules, keyring from the file, store health (own volume,
  # environment marker, free space), and one encrypt/write/read/delete canary.
  out="$(docker exec -i -w /app "$APP" node - 2>/dev/null <<'NODE' | grep -E '^\{' | tail -n 1 || true
const { loadMailConfig, infrastructureViolations } = require('./src/modules/mail/mail.config');
const { createMailApplication } = require('./src/modules/mail/application');
(async () => {
  const config = loadMailConfig(process.env);
  const mail = createMailApplication({ client: {}, config, logger: { info() {}, warn() {}, error() {} } });
  await mail.ready();
  const result = { environment: config.deploymentEnvironment, storageProvider: config.storage.provider, kmsProvider: config.kms.provider,
    keyringAvailable: mail.encryption.available, keyVersions: mail.encryption.versions.length, keyringError: mail.encryption.loadError,
    violations: infrastructureViolations(config).filter((v) => /STORAGE|KMS|ENCRYPTION/.test(v)) };
  result.storage = await mail.storage.health();
  if (result.keyringAvailable && result.storage.ok) {
    const payload = Buffer.from('cosmicforge-mail-storage-canary:' + Date.now());
    const put = await mail.storage.put('health', payload, { purpose: 'mail-storage-canary' });
    const back = await mail.storage.get(put.key, { purpose: 'mail-storage-canary', sha256: put.sha256 });
    await mail.storage.remove(put.key);
    result.canary = back.equals(payload) ? 'ok' : 'mismatch';
  }
  process.stdout.write(JSON.stringify(result));
})().catch((e) => process.stdout.write(JSON.stringify({ error: e.code || e.name })));
NODE
)"
  echo "$out" > "$run_dir/storage-check.json"
  if python3 - "$out" "$target" <<'PY'
import json, sys
d = json.loads(sys.argv[1]); t = sys.argv[2]
ok = (d.get('environment') == t and d.get('storageProvider') == 'filesystem' and d.get('kmsProvider') == 'file'
      and d.get('keyringAvailable') is True and (d.get('storage') or {}).get('ok') is True and d.get('canary') == 'ok' and not d.get('violations'))
sys.exit(0 if ok else 1)
PY
  then
    pass "in the app: keyring loaded from the file ($(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["keyVersions"])' "$out") version(s)); store on its own volume, bound to $target ($(python3 -c 'import json,sys; s=json.loads(sys.argv[1])["storage"]; print(str(round(s.get("freeBytes",0)/2**30,1))+" GiB free")' "$out")); encrypt/write/fsync/read/decrypt/delete canary OK"
  else
    fail "storage check in the app: $out"; bad=1
  fi
  if docker inspect "${MAIL_PROJECT}-mail-worker" >/dev/null 2>&1; then
    mounts="$(docker inspect -f '{{range .Mounts}}{{.Source}}|{{.Name}}|{{.Destination}}|{{.RW}};{{end}}' "${MAIL_PROJECT}-mail-worker")"
    if [[ "$mounts" == *"|$STORE_VOLUME|$STORE_DIR|true;"* && "$mounts" == *"$KEY_DIR||$KEY_MOUNT|false;"* ]]; then
      pass 'Mail worker mounts the same store and the keyring read-only'
    else
      fail 'Mail worker is missing the store or keyring mount (run services-deploy)'; bad=1
    fi
  fi
  [[ -f "$ESCROW_DIR/keyring-escrow.json" ]] && pass 'recovery escrow present' || info 'recovery escrow PENDING (no recovery public key yet)'
  return "$bad"
}

# --------------------------------------------------------------------------
# Mail processing diagnostic (read-only; no content).
# --------------------------------------------------------------------------
container_settings() { # container -> Mail flag/routing settings and database target (no secrets)
  docker inspect -f '{{json .Config.Env}}' "$1" | python3 -c '
import json, sys, urllib.parse as u
env = dict(x.split("=", 1) for x in json.load(sys.stdin) if "=" in x)
keys = sorted(k for k in env if (k.startswith("MAIL_") and k.endswith("_ENABLED")) or k in ("MAIL_WORKER_QUEUES", "MAIL_ROLLOUT_ENFORCED", "MAIL_INBOUND_ACTIVE_ENVIRONMENT", "MAIL_DEPLOYMENT_ENV", "MAIL_RELEASE_IMAGE", "MAIL_UNKNOWN_RECIPIENT_POLICY", "MAIL_KMS_PROVIDER", "MAIL_STORAGE_PROVIDER"))
p = u.urlsplit(env.get("DATABASE_URL", ""))
print(" ".join(f"{k}={env[k].strip()[:120]}" for k in keys) + " DATABASE=" + (p.hostname or "?") + "/" + u.unquote(p.path.lstrip("/")))'
}

mail_diagnose() {
  identity || { fail "$target identity"; return 1; }
  pass "$target identity (app runs on $DEST)"
  if [[ -n "$db_lock_note" ]]; then info "$db_lock_note"; else info 'DB isolation lock: no exclusive holder (no cutover running)'; fi
  info "app: image $(docker inspect -f '{{.Config.Image}}' "$APP") ($(docker inspect -f '{{.Image}}' "$APP" | cut -c1-19)), started $(docker inspect -f '{{.State.StartedAt}}' "$APP"); $(container_settings "$APP")"
  local w="${MAIL_PROJECT}-mail-worker" out
  if docker inspect "$w" >/dev/null 2>&1; then
    info "worker: $(docker inspect -f 'status={{.State.Status}} restarting={{.State.Restarting}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} restarts={{.RestartCount}} policy={{.HostConfig.RestartPolicy.Name}}{{if .HostConfig.RestartPolicy.MaximumRetryCount}}:{{.HostConfig.RestartPolicy.MaximumRetryCount}}{{end}}' "$w")"
    local same=NO; [[ "$(docker inspect -f '{{.Image}}' "$w")" == "$(docker inspect -f '{{.Image}}' "$APP")" ]] && same=yes
    info "worker: image $(docker inspect -f '{{.Config.Image}}' "$w") ($(docker inspect -f '{{.Image}}' "$w" | cut -c1-19)); same image as app: $same; networks: $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$w"); $(container_settings "$w")"
    # Worker module log lines only (job ids, kinds, codes; no content).
    docker logs --tail 2000 "$w" 2>&1 | grep -E '\[Mail(Worker|Ops)?\]' | tail -n 40 | cut -c1-400 | sed 's/^/  worker-log: /' || true
    if [[ "$(docker inspect -f '{{.State.Running}}' "$w")" == true ]]; then
      out="$(docker exec -i -e CA_DIAG_MODE=identity -w /app "$w" node - < "$BUNDLE_DIR/ca-mail-diagnose.js" 2>/dev/null | grep '^CA_MAIL_DIAG ' | tail -1 || true)"
      info "worker database identity: ${out#CA_MAIL_DIAG }"
    else
      info 'worker is not running; its database identity cannot be read'
    fi
  else
    info "no $target Mail worker container ($w)"
  fi
  out="$(docker exec -i -w /app "$APP" node - < "$BUNDLE_DIR/ca-mail-diagnose.js" 2>/dev/null | grep '^CA_MAIL_DIAG ' | tail -1 || true)"
  [[ -n "$out" ]] || { fail 'app diagnostic produced no output'; return 1; }
  printf '%s\n' "$out" > "$run_dir/diagnose.json"
  echo "$out"
  pass "diagnostic recorded (JSON line CA_MAIL_DIAG above)"
  info "readiness endpoint: $(docker exec "$APP" node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/mail/v1/health/ready').then(r=>r.text()).then(t=>process.stdout.write(t.slice(0,1500)))" 2>/dev/null || echo unavailable)"
}

list_containers() {
  local id
  for id in $(docker ps -aq --no-trunc); do
    docker inspect -f '{{.Name}} {{.State.Status}} started={{.State.StartedAt}} restarts={{.RestartCount}}' "$id"
  done | sed 's|^/||' | sort
  pass 'container list read; nothing changed'
}

case "$mode" in
  --containers) list_containers ;;
  --mail-diagnose) mail_diagnose ;;
  --staging-checks) staging_checks ;;
  --storage-setup) storage_setup ;;
  --storage-check) storage_check ;;
  --production-schema-names) production_schema_names ;;
  --migrate-preflight) migrate_preflight ;;
  --migrate-apply) migrate_apply ;;
  --services-preflight) services_preflight ;;
  --services-deploy) services_deploy ;;
  --services-remove) services_remove ;;
esac
