#!/usr/bin/env bash
# Centralize Admin ONLY. One-time staging-then-production database isolation.
# Requires root on Contabo; NEVER addresses the RTC-owned cosmicforge-db.
# Backups and legacy databases are kept for rollback. Stops each CA app briefly.
set -Eeuo pipefail
umask 077

recover_staging_clone=false
if [[ "${1:-}" != '--apply-both' || "$(id -u)" -ne 0 ]]; then
  echo 'Usage (as root, during maintenance): bash ca-db-isolation-cutover.sh --apply-both' >&2
  exit 2
fi
if [[ "${2:-}" == '--recover-failed-staging-clone' && -z "${3:-}" ]]; then
  recover_staging_clone=true
elif [[ -n "${2:-}" ]]; then
  echo 'Unexpected arguments; only --recover-failed-staging-clone is supported.' >&2
  exit 2
fi

# Avoid concurrent operator invocations on this shared VPS.
exec 9>/run/lock/centralize-admin-db-isolation.lock
if ! flock -n 9; then
  echo 'Another CA DB isolation run is already active; refusing overlap.' >&2
  exit 1
fi

backup_dir="/var/backups/centralize-admin/cutover-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -m 700 -p "$backup_dir"
active_root=''
active_app=''
active_backup=''
active_source=''

compose_up() {
  local mode="$1" root="$2"
  if [[ "$mode" == staging ]]; then
    (cd "$root" && docker compose -f docker-compose.yml \
      -f /home/cf-staging-deploy/docker-compose.github-staging.yml \
      up -d --no-deps --no-build --pull never --force-recreate app)
  else
    (cd "$root" && docker compose -f docker-compose.yml \
      up -d --no-deps --no-build --pull never --force-recreate app)
  fi
}

on_exit() {
  local code="$1"
  trap - EXIT
  if [[ "$code" -ne 0 && -n "$active_root" ]]; then
    echo 'ERROR: restoring the original CA app configuration and restarting it.' >&2
    if [[ -f "$active_backup" ]]; then
      cp -p "$active_backup" "$active_root/.env" || true
    fi
    local mode=production
    [[ "$active_app" == admin-server-staging-app-1 ]] && mode=staging
    compose_up "$mode" "$active_root" >&2 || echo 'WARNING: automatic restart failed; original database and backup are preserved.' >&2
    echo "Recovery files: $backup_dir" >&2
  fi
  exit "$code"
}
trap 'on_exit $?' EXIT

# The exact container IDs and projects are checked before ANY mutation.
check_instance() {
  local project="$1" app="$2" db="$3" source="$4" root="$5"
  [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$app")" == "$project" ]]
  [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$db")" == "$project" ]]
  local expected_volume='admin-server_postgres_data'
  [[ "$project" == admin-server-staging ]] && expected_volume='admin-server-staging_postgres_data_staging'
  if [[ "$(docker inspect -f '{{range .Mounts}}{{.Name}}{{end}}' "$db")" != "$expected_volume" ]]; then
    echo "BLOCKED: unexpected database storage volume for $db" >&2
    return 1
  fi
  [[ "$(docker inspect -f '{{.State.Running}}' "$app")" == true ]]
  [[ "$(docker inspect -f '{{.State.Running}}' "$db")" == true ]]
  [[ -f "$root/.env" && -f "$root/docker-compose.yml" ]]
  if [[ "$project" == admin-server-staging ]]; then
    [[ -f /home/cf-staging-deploy/docker-compose.github-staging.yml ]]
  fi
  # Explicitly pass expected source via docker exec -e; no URL is printed.
  docker exec -e EXPECTED_SOURCE="$source" "$app" node -e '
    const u = new URL(process.env.DATABASE_URL);
    if (u.hostname !== "db" || decodeURIComponent(u.pathname.slice(1)) !== process.env.EXPECTED_SOURCE)
      process.exit(1);
  '
  python3 - "$root/.env" "$source" <<'PY'
import re,sys
from urllib.parse import urlsplit,unquote
lines=open(sys.argv[1],encoding='utf-8').read().splitlines()
items=[m.group(1).strip() for line in lines if (m:=re.match(r'^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)$',line))]
assert len(items)==1, 'expected one DATABASE_URL line'
value=items[0]
if len(value)>1 and value[0] in "'\"" and value[-1]==value[0]: value=value[1:-1]
u=urlsplit(value)
assert u.hostname=='db' and unquote(u.path.lstrip('/'))==sys.argv[2], 'source DB does not match expected CA app target'
PY
  # Refuse unexpected existing destinations. A *single*, explicitly opted-in
  # staging recovery may preserve the failed attempt's disconnected clone.
  if docker exec "$db" sh -c 'exec psql -X -qAt -U "${POSTGRES_USER:-postgres}" -d postgres -c "SELECT datname FROM pg_database"' \
      | grep -Fx cosmicforge_admin >/dev/null; then
    if [[ "$project" != admin-server-staging || "$recover_staging_clone" != true ]]; then
      echo "BLOCKED: cosmicforge_admin already exists in $db; not overwriting." >&2
      return 1
    fi
    echo 'Existing staging clone found: will verify, rename and preserve before creating a fresh one.'
  fi
  # Compose must resolve to the exact image already used by the CA app.
  # Do not accidentally deploy a new mutable :latest image during a DB cutover.
  local running_image tagged_image resolved_image
  running_image="$(docker inspect -f '{{.Image}}' "$app")"
  tagged_image="$(docker inspect -f '{{.Config.Image}}' "$app")"
  resolved_image="$(docker image inspect -f '{{.Id}}' "$tagged_image")"
  if [[ "$resolved_image" != "$running_image" ]]; then
    echo 'BLOCKED: Compose image tag differs from running app image.' >&2
    return 1
  fi
}

# For backups from the same PostgreSQL instance, pg_dump textual headers and
# database-wide comments may differ even though the template-cloned objects
# are identical. Fail on missing/added/changed object SQL; no raw SQL logging.
compare_schema_objects() {
  python3 - "$1" "$2" <<'PYSCHEMA'
import re, sys
from pathlib import Path
pattern = re.compile(r'^-- Name: (.*); Type: ([^;]+); Schema: ([^;]+); Owner: (.*)$')
def objects(filename):
    catalog = {}
    current = None
    for line in Path(filename).read_text(errors='replace').splitlines():
        m = pattern.fullmatch(line)
        if m:
            current = (m.group(2), m.group(3), m.group(1))
            if current in catalog:
                raise ValueError('duplicate schema object')
            catalog[current] = []
            continue
        if line.lstrip().startswith('--') or not line.strip():
            continue
        if line.startswith('\\restrict ') or line.startswith('\\unrestrict '):
            continue
        if current is not None:
            catalog[current].append(line.rstrip())
    return {key: '\n'.join(lines) for key, lines in catalog.items()}
try:
    a, b = objects(sys.argv[1]), objects(sys.argv[2])
    missing, added = set(a)-set(b), set(b)-set(a)
    changed = {k for k in set(a)&set(b) if a[k] != b[k]}
    if not a or missing or added or changed:
        print('Schema objects differ: missing=%d added=%d changed=%d' % (len(missing),len(added),len(changed)))
        sys.exit(1)
    print('Normalized schema verified: %d objects match.' % len(a))
except (OSError, ValueError):
    print('BLOCKED: schema comparison unavailable')
    sys.exit(1)
PYSCHEMA
}

# Compare source and cloned database object definitions and every public table count.
compare_databases() {
  local dbcontainer="$1" source="$2" destination="$3" dir="$4"
  docker exec "$dbcontainer" sh -c \
    'exec pg_dump -U "${POSTGRES_USER:-postgres}" --schema-only --no-owner --no-acl -d "$1"' sh "$source" > "$dir/source-schema.sql"
  docker exec "$dbcontainer" sh -c \
    'exec pg_dump -U "${POSTGRES_USER:-postgres}" --schema-only --no-owner --no-acl -d "$1"' sh "$destination" > "$dir/dest-schema.sql"
  # Raw pg_dump text is NOT byte-stable across different database names.
  # Compare the substantive pg_dump object definitions, ignoring generated
  # comments and \restrict markers. No SQL or secrets are printed.
  if ! compare_schema_objects "$dir/source-schema.sql" "$dir/dest-schema.sql"; then
    echo 'BLOCKED: schema object definitions differ; no DB switch.' >&2
    return 1
  fi
  for current in "$source" "$destination"; do
    docker exec -i "$dbcontainer" sh -c \
      'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$1"' sh "$current" <<'SQL' | sort > "$dir/counts-$current.txt"
SELECT format('SELECT %L || ''|'' || count(*)::text FROM %I.%I',
              schemaname || '.' || tablename, schemaname, tablename)
FROM pg_catalog.pg_tables
WHERE schemaname = 'public'
ORDER BY tablename
\gexec
SQL
  done
  if ! cmp -s "$dir/counts-$source.txt" "$dir/counts-$destination.txt"; then
    echo 'BLOCKED: table row counts differ; original database remains unchanged.' >&2
    return 1
  fi
  echo "Database copy verified: $(wc -l < "$dir/counts-$source.txt") public tables; all row counts and schema definitions match."
}

# Secret values are never printed or persisted, only a SHA-256 digest in
# root-only cutover backups. Database name is masked, credentials are not.
app_env_fingerprint() {
  docker exec "$1" node -e '
    const crypto = require("node:crypto");
    const keys = Object.keys(process.env).filter(k =>
      /SECRET|TOKEN|PASSWORD|API_KEY|CREDENTIAL|DATABASE_URL|PRIVATE_KEY|SMTP_/i.test(k)).sort();
    const values = keys.map(k => {
      let v = process.env[k];
      if (k === "DATABASE_URL") {
        const u = new URL(v);
        u.pathname = "/__DATABASE_NAME_IGNORED__";
        v = u.toString();
      }
      return [k, v];
    });
    process.stdout.write(crypto.createHash("sha256")
      .update(JSON.stringify(values)).digest("hex") + "\n");
  '
}

verify_app() {
  local app="$1" dest="$2"
  local attempt
  for attempt in $(seq 1 30); do
    if docker exec -i -e EXPECTED_DB="$dest" -w /app "$app" node - <<'NODE' >/dev/null 2>&1
const {prisma}=require('./src/shared/config/database');
(async()=>{
  const u=new URL(process.env.DATABASE_URL);
  if(decodeURIComponent(u.pathname.slice(1))!==process.env.EXPECTED_DB)throw new Error('wrong target');
  const rows=await prisma.$queryRawUnsafe('SELECT current_database() AS name');
  if(rows[0]?.name!==process.env.EXPECTED_DB)throw new Error('wrong connected DB');
  await prisma.adminUser.count();
  const port=Number(process.env.PORT || 4000);
  const response=await fetch('http://127.0.0.1:'+port+'/health', {signal:AbortSignal.timeout(4000)});
  if(!response.ok)throw new Error('HTTP health failed');
})().catch(()=>{process.exitCode=1}).finally(()=>prisma.$disconnect());
NODE
    then
      echo "Verified $app connected to dedicated $dest with Prisma AdminUser access."
      return 0
    fi
    sleep 2
  done
  echo "BLOCKED: $app did not pass Admin DB verification." >&2
  return 1
}

switch_one() {
  local mode="$1" project app db source root
  if [[ "$mode" == staging ]]; then
    project=admin-server-staging
    app=admin-server-staging-app-1
    db=admin-server-staging-db-1
    source=rtc_db_staging
    root=/var/www/admin-server-staging
  else
    project=admin-server
    app=admin-server-app-1
    db=admin-server-db-1
    source=rtc_db
    root=/var/www/admin-server
  fi
  echo "=== $mode: preserving $source, copying to cosmicforge_admin in existing CA-owned $db ==="
  check_instance "$project" "$app" "$db" "$source" "$root"

  local dir="$backup_dir/$mode"
  mkdir -m 700 "$dir"
  cp -p "$root/.env" "$dir/original.env"
  chmod 600 "$dir/original.env"
  # Before/after secret fingerprint catches Compose '$' interpolation drift.
  app_env_fingerprint "$app" > "$dir/original-app-secrets.sha256"

  # Verify the image is held fixed across the recreation.
  local running_image_at_start
  running_image_at_start="$(docker inspect -f '{{.Image}}' "$app")"

  # From this point, a failure auto-restores the CA app's old environment.
  active_root="$root"
  active_app="$app"
  active_backup="$dir/original.env"
  active_source="$source"
  docker stop "$app" >/dev/null

  local active_connections
  active_connections="$(docker exec -i "$db" sh -c \
    'exec psql -X -qAt -v ON_ERROR_STOP=1 -v "source_db=$1" -U "${POSTGRES_USER:-postgres}" -d postgres' sh "$source" <<'SQL'
SELECT count(*) FROM pg_stat_activity WHERE datname = :'source_db';
SQL
  )"
  if [[ "$active_connections" != 0 ]]; then
    echo "BLOCKED: $active_connections active connections remain on $source; source remains unchanged." >&2
    return 1
  fi
  # The failed initial attempt created cosmicforge_admin and stopped before
  # switching the staging app. Preserve that old clone under an archive name,
  # but ONLY if the owner explicitly used --recover-failed-staging-clone,
  # no processes use it, and its schema still matches the CA source.
  if [[ "$mode" == staging && "$recover_staging_clone" == true ]]; then
    if docker exec "$db" sh -c 'exec psql -X -qAt -U "${POSTGRES_USER:-postgres}" -d postgres -c "SELECT datname FROM pg_database"' \
       | grep -Fx cosmicforge_admin >/dev/null; then
      local dest_sessions hold
      dest_sessions="$(docker exec -i "$db" sh -c \
        'exec psql -X -qAt -v ON_ERROR_STOP=1 -v "target_db=$1" -U "${POSTGRES_USER:-postgres}" -d postgres' sh cosmicforge_admin <<'SQL'
SELECT count(*) FROM pg_stat_activity WHERE datname = :'target_db';
SQL
      )"
      [[ "$dest_sessions" == 0 ]] || { echo 'BLOCKED: previous clone has active sessions.' >&2; return 1; }
      # No schema or data is deleted; the old clone is retained separately.
      docker exec "$db" sh -c 'exec pg_dump -U "${POSTGRES_USER:-postgres}" --schema-only --no-owner --no-acl -d rtc_db_staging' > "$dir/original-for-recovery.sql"
      docker exec "$db" sh -c 'exec pg_dump -U "${POSTGRES_USER:-postgres}" --schema-only --no-owner --no-acl -d cosmicforge_admin' > "$dir/previous-copy-for-recovery.sql"
      compare_schema_objects "$dir/original-for-recovery.sql" "$dir/previous-copy-for-recovery.sql" || { echo 'BLOCKED: prior clone is not schema-equivalent.' >&2; return 1; }
      hold="cosmicforge_admin_previous_copy_$(date -u +%Y%m%d_%H%M%S)_$$"
      [[ "$hold" =~ ^cosmicforge_admin_previous_copy_[0-9]{8}_[0-9]{6}_[0-9]+$ ]]
      docker exec "$db" sh -c \
        'exec psql -X -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d postgres -c "ALTER DATABASE cosmicforge_admin RENAME TO \"$1\""' sh "$hold" >/dev/null
      echo "Preserved earlier staging copy as $hold (no data deleted)."
    fi
  fi
  # PostgreSQL's template-clone guard also prevents concurrent source reads.

  # Fresh backup AFTER writers are quiesced, not the earlier dated archive.
  docker exec "$db" sh -c 'exec pg_dump -U "${POSTGRES_USER:-postgres}" -Fc -d "$1"' sh "$source" > "$dir/fresh-source.dump"
  docker exec -i "$db" pg_restore --list < "$dir/fresh-source.dump" > /dev/null
  sha256sum "$dir/fresh-source.dump" > "$dir/archive.sha256"

  # PostgreSQL template cloning is a physical, internally consistent snapshot.
  # It includes every table, index, trigger, role grant and exact row contents.
  # Both databases stay in the SAME isolated CA-owned PostgreSQL instance.
  docker exec "$db" sh -c \
    'exec createdb -U "${POSTGRES_USER:-postgres}" -T "$1" "$2"' \
    sh "$source" cosmicforge_admin
  compare_databases "$db" "$source" cosmicforge_admin "$dir"

  # Edit ONLY the DATABASE_URL path in the CA app env file. Atomic local write.
  python3 - "$root/.env" "$source" <<'PY'
import os,re,sys,tempfile
from pathlib import Path
from urllib.parse import urlsplit,urlunsplit,unquote
p=Path(sys.argv[1]); source=sys.argv[2]
lines=p.read_text(encoding='utf-8').splitlines(keepends=True)
changed=0
out=[]
for line in lines:
    m=re.match(r'^(\s*(?:export\s+)?DATABASE_URL\s*=\s*)([^\r\n]*)(\r?\n?)$',line)
    if not m:
        out.append(line); continue
    raw=m.group(2).strip(); quote=raw[0] if len(raw)>1 and raw[0] in "'\"" and raw[-1]==raw[0] else ''
    value=raw[1:-1] if quote else raw
    u=urlsplit(value)
    if u.hostname!='db' or unquote(u.path.lstrip('/'))!=source: raise SystemExit('database target guard failed')
    out.append(m.group(1)+quote+urlunsplit(u._replace(path='/cosmicforge_admin'))+quote+m.group(3))
    changed+=1
if changed!=1: raise SystemExit('DATABASE_URL must occur exactly once')
fd,name=tempfile.mkstemp(prefix='.ca-env-tmp-',dir=p.parent)
try:
    with os.fdopen(fd,'w',encoding='utf-8') as f: f.writelines(out)
    os.chmod(name,p.stat().st_mode & 0o777)
    os.replace(name,p)
finally:
    if os.path.exists(name): os.unlink(name)
PY
  compose_up "$mode" "$root"
  verify_app "$app" cosmicforge_admin
  if ! cmp -s "$dir/original-app-secrets.sha256" <(app_env_fingerprint "$app"); then
    echo 'BLOCKED: application credentials changed during Compose recreation; rolling back.' >&2
    return 1
  fi
  if [[ "$(docker inspect -f '{{.Image}}' "$app")" != "$running_image_at_start" ]]; then
    echo 'BLOCKED: the running application image changed during cutover; rolling back.' >&2
    return 1
  fi

  # This environment now runs on its new DB; don't auto-rollback on later env failure.
  active_root=''
  active_app=''
  active_backup=''
  active_source=''
  echo "SUCCESS: CA $mode now uses cosmicforge_admin. Legacy $source and its volume were preserved."
}

# Fail closed: do not proceed to production if staging fails.
switch_one staging
if [[ ! -t 0 ]]; then
  echo 'Staging switched; production requires terminal confirmation after checking staging login.' >&2
  exit 2
fi
echo 'STAGING COMPLETE. Verify a real staging Admin login before changing production.'
read -r -p 'Type STAGING_LOGIN_OK to begin the production cutover, or anything else to stop: ' answer
if [[ "$answer" != STAGING_LOGIN_OK ]]; then
  echo 'Production left unchanged. Staging remains on cosmicforge_admin.'
  exit 0
fi
switch_one production

echo "SUCCESS: staging AND production CA app connections use their own cosmicforge_admin DBs."
echo "Old CA databases and actual RTC project were NOT modified or removed."
echo "Backup and original .env copies: $backup_dir"
echo 'Mail flags remain off; enabling Resend/S3/KMS/scanner/workers is a separate readiness task.'
