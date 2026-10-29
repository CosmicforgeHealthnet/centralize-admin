#!/usr/bin/env bash
# Centralize Admin Mail backups: encrypted, off-host, with tested restores.
# Root, Contabo VPS. Installed and driven by .github/workflows/ca-mail-backup.yml;
# afterwards a systemd timer runs it nightly (backup) and weekly (restore drill).
#
#   --install <staging|production> <values-file>   off-host repository (restic):
#        values = RESTIC_REPOSITORY (s3:https://... or rest:https://...),
#        RESTIC_PASSWORD (>= 24 chars) and, for S3-compatible storage,
#        AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION
#        (restic's names for ANY S3-compatible service: Contabo Object
#        Storage, Backblaze B2, MinIO, ...). Or RESTIC_REST_USERNAME/PASSWORD.
#   --install-local <staging|production>   repository on THIS host (tests and
#        drills only; reported as LOCAL, never as off-host). Password generated here.
#   --run <target>      backup now
#   --drill <target>    restore drill now (non-destructive)
#   --status <target>   READ-ONLY: schedule, repository kind, latest snapshots,
#                       last backup and last drill, keys recoverable or not
#
# What a backup holds (restic encrypts it all with RESTIC_PASSWORD before it
# leaves the host; mail objects are additionally AES-256-GCM envelopes):
#   - pg_dump (custom format) of the CA database cosmicforge_admin (Mail
#     metadata, encrypted drafts/snippets/notes, and the rest of CA);
#   - the Mail store volume (encrypted bodies, attachments, archives);
#   - the recovery escrow of the keyring (sealed to the owner's offline RSA
#     key; the raw keyring is NEVER backed up);
#   - a manifest (row and object counts, key fingerprints, image).
# The database is dumped BEFORE the store is read, so every object a dumped
# row references already exists (objects are written before their rows).
#
# Restore drill: latest snapshot -> scratch directory; the dump -> a throwaway
# PostgreSQL container on an internal network (live databases untouched);
# scripts/mail/verify-restored-content.js (app image) decrypts EVERY restored
# object and encrypted column and checks the SHA-256 recorded in the database;
# row counts compared with the manifest; the escrow checked against the live
# keyring. Everything removed afterwards. Nothing secret is printed.
set -Eeuo pipefail
umask 077
export LC_ALL=C
readonly SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH="$SAFE_PATH"
# restic: the official release binary, pinned by version and SHA-256
# (https://github.com/restic/restic/releases, SHA256SUMS of v0.17.3).
readonly RESTIC_VERSION=0.17.3
readonly RESTIC_SHA256=5097faeda6aa13167aae6e36efdba636637f8741fed89bbf015678334632d4d3
readonly INSTALL_DIR=/usr/local/lib/cosmicforge-mail-backup
readonly RESTIC_BIN="$INSTALL_DIR/restic-$RESTIC_VERSION"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly RUN_ID

mode="${1:-}" target="${2:-}" values="${3:-}"
case "$mode" in --install|--install-local|--run|--drill|--status) ;; *) echo 'Usage: ca-mail-backup.sh --install <target> <values> | --install-local|--run|--drill|--status <target>' >&2; exit 2 ;; esac
case "$target" in
  staging) APP=admin-server-staging-app-1; DB=admin-server-staging-db-1; PROJECT=admin-server-staging; STORE_VOLUME=admin-server-staging-mail-store ;;
  production) APP=admin-server-app-1; DB=admin-server-db-1; PROJECT=admin-server; STORE_VOLUME=admin-server-mail-store ;;
  *) echo 'target must be staging or production' >&2; exit 2 ;;
esac
[[ "$(id -u)" -eq 0 ]] || { echo 'Run as root.' >&2; exit 2; }
readonly APP DB PROJECT STORE_VOLUME target
readonly DEST=cosmicforge_admin
readonly CONF="/etc/cosmicforge-mail/$target/backup"
readonly KEY_DIR="/etc/cosmicforge-mail/$target/keyring"
readonly ESCROW="/etc/cosmicforge-mail/$target/escrow/keyring-escrow.json"
readonly STATE="/var/lib/cosmicforge-mail-backup/$target"
readonly HOST_TAG="ca-$target"
# Fixed path so restored snapshots always have the same layout.
readonly META="$STATE/meta"

mkdir -p /run/lock "$STATE"; chmod 700 "$STATE"
if [[ "$mode" != --status ]]; then
  exec 8>"/run/lock/cosmicforge-mail-backup-$target.lock"
  flock -n 8 || { echo "Another Mail backup operation for $target is running. Nothing changed." >&2; exit 1; }
fi

declare -a SUMMARY=()
pass() { SUMMARY+=("PASS  $*"); echo "PASS: $*"; }
fail() { SUMMARY+=("FAIL  $*"); echo "FAIL: $*" >&2; }
info() { SUMMARY+=("INFO  $*"); echo "INFO: $*"; }
work=''
drill_db='' drill_net=''
on_exit() {
  local code=$?
  trap - EXIT
  [[ -n "$drill_db" ]] && docker rm -f "$drill_db" >/dev/null 2>&1
  [[ -n "$drill_net" ]] && docker network rm "$drill_net" >/dev/null 2>&1
  [[ -n "$work" && "$work" == "$STATE"/* ]] && rm -rf "$work"
  # The database dump is never left on disk after a run.
  [[ "$mode" == --run || "$mode" == --install || "$mode" == --install-local ]] && rm -rf "$META"
  [[ "$code" -eq 0 ]] || fail "stopped with exit code $code"
  echo; echo '==================== SUMMARY ===================='
  local l; for l in "${SUMMARY[@]}"; do echo "$l"; done
  echo '================================================='
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP
echo "CA Mail backup ($target), run $RUN_ID, mode $mode"

repo_kind() { cat "$CONF/kind" 2>/dev/null || echo none; }

# restic with a clean environment: password from the root-only file,
# repository and credentials from the root-only env file. Nothing on argv.
restic() {
  local -a e=(HOME=/root "PATH=$SAFE_PATH" "RESTIC_PASSWORD_FILE=$CONF/password" "RESTIC_CACHE_DIR=$STATE/cache")
  local line
  while IFS= read -r line; do [[ "$line" == *=* ]] && e+=("$line"); done < "$CONF/restic.env"
  mkdir -p "$STATE/cache"
  env -i "${e[@]}" "$RESTIC_BIN" "$@"
}

store_path() { docker volume inspect -f '{{.Mountpoint}}' "$STORE_VOLUME"; }

identity() {
  local c
  for c in "$APP" "$DB"; do
    [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$c" 2>/dev/null)" == "$PROJECT" ]] || { fail "$c is not a running $PROJECT container"; return 1; }
    [[ "$(docker inspect -f '{{.State.Running}}' "$c")" == true ]] || { fail "$c is not running"; return 1; }
  done
  docker volume inspect "$STORE_VOLUME" >/dev/null 2>&1 || { fail "store volume $STORE_VOLUME missing (run storage-setup first)"; return 1; }
  [[ -f "$KEY_DIR/keyring.json" ]] || { fail "keyring file missing (run storage-setup first)"; return 1; }
}

psql_dest() { docker exec -i "$DB" sh -c 'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$1"' sh "$DEST"; }

mail_counts() { # JSON row counts of every mail_* table + referenced objects
  local sql
  sql="SELECT json_build_object('tables', (SELECT coalesce(json_object_agg(t.relname, t.n), '{}'::json) FROM (SELECT c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text::bigint AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'mail\\_%') t))"
  "$@" <<<"$sql"
}

write_state() { # file json
  printf '%s\n' "$2" > "$STATE/$1.new"; mv -f "$STATE/$1.new" "$STATE/$1"
}

install_schedule() {
  if [[ ! -d /run/systemd/system ]]; then
    # Only the disposable test replica has no systemd.
    [[ "${CA_REPLICA_TEST:-}" == 1 ]] && { info 'no systemd (test replica): schedule not installed'; return 0; }
    fail 'systemd is not running; the backup schedule cannot be installed'; return 1
  fi
  install -d -m 0700 "$INSTALL_DIR"
  install -m 0700 "$0" "$INSTALL_DIR/ca-mail-backup.sh"
  local sha; sha="$(sha256sum "$INSTALL_DIR/ca-mail-backup.sh" | cut -d' ' -f1)"
  cat > /etc/systemd/system/cosmicforge-mail-backup@.service <<EOF
[Unit]
Description=CosmicForge Mail backup (%i), script $sha
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=$INSTALL_DIR/ca-mail-backup.sh --run %i
Nice=10
IOSchedulingClass=idle
EOF
  cat > /etc/systemd/system/cosmicforge-mail-backup@.timer <<'EOF'
[Unit]
Description=Nightly CosmicForge Mail backup (%i)
[Timer]
OnCalendar=*-*-* 02:17:00 UTC
RandomizedDelaySec=20m
Persistent=true
[Install]
WantedBy=timers.target
EOF
  cat > /etc/systemd/system/cosmicforge-mail-restore-drill@.service <<EOF
[Unit]
Description=CosmicForge Mail restore drill (%i), script $sha
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=$INSTALL_DIR/ca-mail-backup.sh --drill %i
Nice=10
IOSchedulingClass=idle
EOF
  cat > /etc/systemd/system/cosmicforge-mail-restore-drill@.timer <<'EOF'
[Unit]
Description=Weekly CosmicForge Mail restore drill (%i)
[Timer]
OnCalendar=Sun *-*-* 04:23:00 UTC
RandomizedDelaySec=30m
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload || { fail 'systemctl daemon-reload failed'; return 1; }
  systemctl enable --now "cosmicforge-mail-backup@$target.timer" "cosmicforge-mail-restore-drill@$target.timer" >/dev/null \
    || { fail 'could not enable the backup timers'; return 1; }
  pass "schedule installed: nightly backup and weekly restore drill for $target (script $sha)"
}

install_restic() {
  install -d -m 0700 "$INSTALL_DIR"
  if [[ -x "$RESTIC_BIN" ]] && [[ "$("$RESTIC_BIN" version 2>/dev/null)" == "restic $RESTIC_VERSION "* ]]; then
    info "restic $RESTIC_VERSION already installed"; return 0
  fi
  local tmp; tmp="$(mktemp -d /run/ca-restic-XXXXXX)"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/restic.bz2" "https://github.com/restic/restic/releases/download/v$RESTIC_VERSION/restic_${RESTIC_VERSION}_linux_amd64.bz2" \
    || { rm -rf "$tmp"; fail 'could not download restic'; return 1; }
  [[ "$(sha256sum "$tmp/restic.bz2" | cut -d' ' -f1)" == "$RESTIC_SHA256" ]] || { rm -rf "$tmp"; fail 'restic download does not match the pinned SHA-256'; return 1; }
  python3 -c 'import bz2,sys; open(sys.argv[2],"wb").write(bz2.decompress(open(sys.argv[1],"rb").read()))' "$tmp/restic.bz2" "$tmp/restic"
  install -m 0700 "$tmp/restic" "$RESTIC_BIN"; rm -rf "$tmp"
  [[ "$("$RESTIC_BIN" version)" == "restic $RESTIC_VERSION "* ]] || { fail 'installed restic does not run'; return 1; }
  pass "restic $RESTIC_VERSION installed (release binary, SHA-256 pinned)"
}

init_repository() {
  local rc=0
  restic cat config >/dev/null 2>"$STATE/init.err" || rc=$?
  if [[ "$rc" == 0 ]]; then info 'repository already initialised (kept)'; return 0; fi
  if [[ "$rc" == 10 ]] || grep -qiE 'does not exist|unable to open config file|Is there a repository' "$STATE/init.err"; then
    restic init >/dev/null 2>"$STATE/init.err" && { pass 'repository initialised (encrypted with the repository password)'; return 0; }
  fi
  fail "repository not reachable or wrong password: $(tail -1 "$STATE/init.err" | sed -E 's#(https?://)[^/ ]+#\1<host>#g' | cut -c1-200)"
  return 1
}

do_install() {
  local kind="$1"
  install -d -m 0711 /etc/cosmicforge-mail "/etc/cosmicforge-mail/$target"
  install -d -m 0700 "$CONF"
  if [[ "$kind" == local ]]; then
    [[ -f "$CONF/password" && "$(repo_kind)" == local ]] || head -c 32 /dev/urandom | base64 -w0 > "$CONF/password"
    printf 'RESTIC_REPOSITORY=%s\n' "$STATE/local-repo" > "$CONF/restic.env"
    install -d -m 0700 "$STATE/local-repo"
    printf 'local\n' > "$CONF/kind"
    info "LOCAL repository on this host ($STATE/local-repo): proves the mechanism, NOT an off-host backup"
  else
    [[ -f "$values" ]] || { fail 'values file missing'; return 1; }
    local tmp; tmp="$(mktemp -d /run/ca-backup-XXXXXX)"
    cp "$values" "$tmp/values"; rm -f "$values"
    if ! python3 - "$tmp/values" "$CONF" <<'PY'
import os, re, sys
src, conf = sys.argv[1:]
allowed = {'RESTIC_REPOSITORY', 'RESTIC_PASSWORD', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_DEFAULT_REGION', 'RESTIC_REST_USERNAME', 'RESTIC_REST_PASSWORD'}
vals, problems = {}, []
for n, raw in enumerate(open(src, encoding='utf-8').read().splitlines(), 1):
    if not raw.strip() or raw.lstrip().startswith('#'): continue
    k, sep, v = raw.partition('=')
    k, v = k.strip(), v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'': v = v[1:-1]
    if not sep or k not in allowed: problems.append(f'line {n}: key not allowed'); continue
    if any(c in v for c in '\0\r\n'): problems.append(f'{k}: control character'); continue
    vals[k] = v
repo = vals.get('RESTIC_REPOSITORY', '')
if not re.match(r'^(s3:https://|rest:https://)', repo): problems.append('RESTIC_REPOSITORY must be s3:https://... or rest:https://... (off-host, TLS)')
if len(vals.get('RESTIC_PASSWORD', '')) < 24: problems.append('RESTIC_PASSWORD must be at least 24 characters')
if repo.startswith('s3:') and not (vals.get('AWS_ACCESS_KEY_ID') and vals.get('AWS_SECRET_ACCESS_KEY')): problems.append('S3-compatible repository needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (restic names; any S3-compatible provider)')
if problems:
    print('\n'.join(problems)); sys.exit(1)
def write(path, text, mode):
    fd = os.open(path + '.new', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, 'w') as f: f.write(text)
    os.replace(path + '.new', path)
write(os.path.join(conf, 'password'), vals.pop('RESTIC_PASSWORD'), 0o400)
write(os.path.join(conf, 'restic.env'), ''.join(f'{k}={v}\n' for k, v in sorted(vals.items())), 0o600)
write(os.path.join(conf, 'kind'), 'remote\n', 0o600)
print('backup settings installed: ' + ', '.join(sorted(vals)) + ', RESTIC_PASSWORD (names only)')
PY
    then rm -rf "$tmp"; fail 'backup settings refused (see above); nothing installed'; return 1; fi
    rm -rf "$tmp"
    pass 'off-host repository settings installed root-only (values never printed)'
  fi
  chmod 0400 "$CONF/password"; chmod 0600 "$CONF/restic.env"
  install_restic || return 1
  init_repository || return 1
  install_schedule || return 1
  do_run || return 1
  do_drill
}

do_run() {
  identity || return 1
  [[ -f "$CONF/restic.env" ]] || { fail 'backups are not installed for this target'; return 1; }
  work="$STATE/work-$RUN_ID"; install -d -m 0700 "$work"
  rm -rf "$META"; install -d -m 0700 "$META"
  ln -s "$META" "$work/meta"
  local image; image="$(docker inspect -f '{{.Config.Image}}' "$APP")"
  # 1. Database first (see header).
  docker exec "$DB" sh -c 'exec pg_dump -U "${POSTGRES_USER:-postgres}" -Fc -d "$1"' sh "$DEST" > "$work/meta/$DEST.dump" \
    || { fail 'pg_dump failed'; return 1; }
  docker exec -i "$DB" pg_restore --list < "$work/meta/$DEST.dump" >/dev/null || { fail 'database dump is not readable'; return 1; }
  pass "database dump $(du -h "$work/meta/$DEST.dump" | cut -f1) ($DEST, custom format, verified readable)"
  local counts; counts="$(mail_counts psql_dest)" && [[ "$counts" == '{'* ]] || { fail 'could not count Mail rows'; return 1; }
  # 2. Keys: fingerprints and the sealed escrow only.
  local keys; keys="$(docker run --rm --network none --entrypoint node -w /app -v "$KEY_DIR:/keys:ro" "$image" scripts/mail/keyring.js inspect --file=/keys/keyring.json)" \
    || { fail 'keyring file is not valid'; return 1; }
  local escrow=false
  if [[ -f "$ESCROW" ]]; then cp "$ESCROW" "$work/meta/keyring-escrow.json"; escrow=true; fi
  python3 - "$work/meta/manifest.json" "$target" "$image" "$counts" "$keys" "$escrow" <<'PY'
import json, sys, datetime
path, target, image, counts, keys, escrow = sys.argv[1:]
json.dump({'format': 'cosmicforge-mail-backup/1', 'environment': target, 'createdAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
           'image': image, 'database': json.loads(counts), 'keys': json.loads(keys), 'escrowIncluded': escrow == 'true'}, open(path, 'w'))
PY
  [[ -s "$work/meta/manifest.json" ]] || { fail 'manifest not written'; return 1; }
  # 3. The store, read-only, then the snapshot.
  local out
  local store; store="$(store_path)"
  out="$(restic backup --json --host "$HOST_TAG" --tag cosmicforge-mail --tag "$target" "$store" "$META" 2>"$work/backup.err" | tail -1)" \
    || { fail "restic backup failed: $(tail -1 "$work/backup.err" | cut -c1-200)"; return 1; }
  local snap; snap="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(d.get("snapshot_id","")[:12], d.get("total_files_processed"), d.get("total_bytes_processed"))' "$out")"
  pass "snapshot $snap (id, files, bytes) in the $(repo_kind) repository"
  # 4. Retention and repository health.
  restic forget --host "$HOST_TAG" --tag cosmicforge-mail --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune >/dev/null 2>"$work/forget.err" \
    && pass 'retention applied (14 daily, 8 weekly, 12 monthly)' || { fail "retention failed: $(tail -1 "$work/forget.err" | cut -c1-200)"; return 1; }
  local check_args=(check)
  [[ "$(date -u +%u)" == 7 ]] && check_args+=(--read-data-subset=10%)
  restic "${check_args[@]}" >/dev/null 2>"$work/check.err" \
    && pass "repository check OK (${check_args[*]})" || { fail "repository check failed: $(tail -1 "$work/check.err" | cut -c1-200)"; return 1; }
  [[ "$escrow" == true ]] && pass 'recovery escrow included (keys recoverable with the offline private key)' \
    || info 'recovery escrow NOT included: no recovery public key installed, so mail content is not recoverable after host loss'
  rm -rf "$META"
  write_state last-backup.json "$(python3 -c 'import json,sys,datetime; print(json.dumps({"ok": True, "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "snapshot": sys.argv[1].split()[0], "repository": sys.argv[2], "escrowIncluded": sys.argv[3]=="true"}))' "$snap" "$(repo_kind)" "$escrow")"
}

do_drill() {
  identity || return 1
  [[ -f "$CONF/restic.env" ]] || { fail 'backups are not installed for this target'; return 1; }
  work="$STATE/drill-$RUN_ID"; install -d -m 0700 "$work"
  local image dbimage; image="$(docker inspect -f '{{.Config.Image}}' "$APP")"; dbimage="$(docker inspect -f '{{.Config.Image}}' "$DB")"
  # 1. Restore the latest snapshot into a scratch directory.
  restic restore latest --host "$HOST_TAG" --tag cosmicforge-mail --target "$work/restored" >/dev/null 2>"$work/restore.err" \
    || { fail "restore failed: $(tail -1 "$work/restore.err" | cut -c1-200)"; return 1; }
  local meta store
  meta="$work/restored$META"; store="$work/restored$(store_path)"
  [[ -s "$meta/$DEST.dump" && -s "$meta/manifest.json" && -d "$store" ]] || { fail 'restored snapshot is incomplete'; return 1; }
  pass "latest snapshot restored into a scratch directory ($(du -sh "$work/restored" | cut -f1))"
  # 2. Throwaway PostgreSQL (same image as the live one) on an internal network.
  drill_net="ca-mail-drill-${RUN_ID,,}"; drill_db="ca-mail-drill-db-${RUN_ID,,}"
  docker network create --internal "$drill_net" >/dev/null || { fail 'could not create the drill network'; return 1; }
  local pw; pw="$(head -c 18 /dev/urandom | base64 -w0 | tr '+/' 'xy')"
  POSTGRES_PASSWORD="$pw" docker run -d --name "$drill_db" --network "$drill_net" --network-alias drilldb -e POSTGRES_PASSWORD \
    --label ca.component=mail-restore-drill "$dbimage" >/dev/null || { fail 'could not start the throwaway PostgreSQL'; return 1; }
  local i ready=false; for ((i = 0; i < 60; i++)); do docker exec "$drill_db" pg_isready -U postgres >/dev/null 2>&1 && { ready=true; break; }; sleep 2; done
  [[ "$ready" == true ]] || { fail 'throwaway PostgreSQL did not start'; return 1; }
  sleep 3
  docker exec "$drill_db" createdb -U postgres restored || { fail 'could not create the scratch database'; return 1; }
  docker exec -i "$drill_db" pg_restore -U postgres --no-owner --no-privileges --exit-on-error -d restored < "$meta/$DEST.dump" >/dev/null 2>"$work/pg_restore.err" \
    || { fail "pg_restore into the throwaway database failed: $(tail -1 "$work/pg_restore.err" | cut -c1-200)"; return 1; }
  pass 'database restored into a throwaway PostgreSQL container (live databases untouched)'
  # 3. Row counts against the manifest.
  local restored_counts
  restored_counts="$(mail_counts docker exec -i "$drill_db" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d restored)"
  if python3 - "$meta/manifest.json" "$restored_counts" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))['database']['tables']; r = json.loads(sys.argv[2])['tables']
bad = sorted(k for k in set(m) | set(r) if m.get(k) != r.get(k))
print(f'{len(m)} Mail tables, {sum(m.values())} rows' if not bad else 'mismatch: ' + ', '.join(bad))
sys.exit(1 if bad else 0)
PY
  then pass 'restored Mail row counts equal the backup manifest'; else fail 'restored row counts differ from the manifest'; return 1; fi
  # 4. Every object and encrypted column decrypts and matches its SHA-256.
  local out rc=0
  out="$(DATABASE_URL="postgresql://postgres:$pw@drilldb:5432/restored" docker run --rm --network "$drill_net" -e DATABASE_URL --entrypoint node -w /app \
      -v "$store:/restore/store:ro" -v "$KEY_DIR:/run/secrets/cosmicforge-mail:ro" "$image" \
      scripts/mail/verify-restored-content.js --storage-dir=/restore/store --keyring-file=/run/secrets/cosmicforge-mail/keyring.json --environment="$target" 2>"$work/verify.err")" || rc=$?
  echo "$out" > "$STATE/last-drill-report.json"
  if [[ "$rc" == 0 ]] && python3 -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1]).get("ok") else 1)' "$out"; then
    pass "content verified: $(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print("%d objects and %d encrypted columns decrypted, SHA-256 matched, 0 failures" % (d["objectsChecked"], d["columnsChecked"]))' "$out")"
  else
    fail "content verification failed: $(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(json.dumps({"objects": d.get("objects"), "columns": d.get("columns")}))' "$out" 2>/dev/null || tail -1 "$work/verify.err" | cut -c1-200)"
    return 1
  fi
  # 5. Keys recoverable: the backed-up escrow matches the live keyring.
  local recoverable=false
  if [[ -f "$meta/keyring-escrow.json" ]]; then
    docker run --rm --network none --entrypoint node -w /app -v "$KEY_DIR:/keys:ro" -v "$meta:/meta:ro" "$image" \
      scripts/mail/keyring.js verify-escrow --file=/keys/keyring.json --escrow=/meta/keyring-escrow.json >/dev/null 2>&1 \
      && { recoverable=true; pass 'backed-up recovery escrow matches the live keyring (open it with the offline private key to recover)'; } \
      || fail 'backed-up escrow does NOT match the live keyring (re-run storage-setup to reseal after a key change)'
  else
    info 'no recovery escrow in the backup: the drill used the live keyring; after host loss the content would NOT be recoverable'
  fi
  write_state last-drill.json "$(python3 -c 'import json,sys,datetime; d=json.loads(sys.argv[1]); print(json.dumps({"ok": True, "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "objectsChecked": d["objectsChecked"], "columnsChecked": d["columnsChecked"], "keysRecoverable": sys.argv[2]=="true", "repository": sys.argv[3]}))' "$out" "$recoverable" "$(repo_kind)")"
}

do_status() {
  info "repository: $(repo_kind)$([[ "$(repo_kind)" == local ]] && echo ' (on this host, NOT off-host)')"
  local t
  for t in cosmicforge-mail-backup cosmicforge-mail-restore-drill; do
    info "$t@$target.timer: $(systemctl is-enabled "$t@$target.timer" 2>/dev/null || echo not-installed) / $(systemctl is-active "$t@$target.timer" 2>/dev/null || true); next: $(systemctl show -p NextElapseUSecRealtime --value "$t@$target.timer" 2>/dev/null || echo n/a)"
  done
  info "last backup: $(cat "$STATE/last-backup.json" 2>/dev/null || echo none)"
  info "last drill: $(cat "$STATE/last-drill.json" 2>/dev/null || echo none)"
  info "recovery escrow on the host: $([[ -f "$ESCROW" ]] && echo present || echo MISSING)"
  if [[ -f "$CONF/restic.env" ]]; then
    local snaps; snaps="$(restic snapshots --json --host "$HOST_TAG" --tag cosmicforge-mail --latest 3 2>/dev/null | python3 -c 'import json,sys; print(", ".join(s["short_id"]+" "+s["time"][:19] for s in json.load(sys.stdin)))' 2>/dev/null || echo unreadable)"
    info "latest snapshots: ${snaps:-none}"
  fi
}

case "$mode" in
  --install) do_install remote ;;
  --install-local) do_install local ;;
  --run) do_run || { write_state last-backup.json "{\"ok\": false, \"at\": \"$(date -u +%FT%TZ)\"}"; exit 1; } ;;
  --drill) do_drill || { write_state last-drill.json "{\"ok\": false, \"at\": \"$(date -u +%FT%TZ)\"}"; exit 1; } ;;
  --status) do_status ;;
esac
