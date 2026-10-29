#!/usr/bin/env bash
# Centralize Admin (CA) ONLY: move CA staging, then CA production, from their
# legacy-named databases (rtc_db_staging / rtc_db) to `cosmicforge_admin`
# INSIDE THE SAME CA-owned PostgreSQL container. Run as root on the VPS.
#
#   bash ca-db-isolation-cutover.sh --apply-both     staging, pause, production
#   bash ca-db-isolation-cutover.sh --staging-only   staging only
#   bash ca-db-isolation-cutover.sh --production-only [--confirm STAGING_LOGIN_OK --confirm CUTOVER_PRODUCTION]
#                                                    production only; staging must
#                                                    already run verified on cosmicforge_admin
#   bash ca-db-isolation-cutover.sh --preflight      read-only checks, no change
#
# --production-only resumes after a run whose staging part completed (for
# example when the operator's terminal was lost at the STAGING_LOGIN_OK
# prompt). It never touches staging. Its two confirmations are typed at the
# terminal or, for an approved non-interactive run (GitHub Actions), passed as
# the exact phrases with --confirm. Staging can never be confirmed that way.
#
# Guarantees (each is a hard gate; any failure stops before the next step):
# - Never addresses RTC's `cosmicforge-db`, any other project, any volume.
#   Unrelated containers are snapshotted and must be unchanged at the end.
# - Never deletes or overwrites a database. The legacy database, its volume,
#   a previous `cosmicforge_admin` copy (renamed, preserved) and every backup
#   are kept. Nothing is dropped except this run's own scratch restore check.
# - Fixes the Compose `$` interpolation problem without changing behaviour:
#   only `.env` lines whose value Compose currently interpolates are rewritten,
#   single-quoted, with exactly the value the running container already has.
#   The script proves the effective configuration is unchanged before use.
# - Each environment: identity checks -> confirmation -> stop ONLY its app ->
#   wait for zero sessions -> fresh verified backup + scratch restore check ->
#   template clone -> database owner/ACL/settings copied -> schema, catalog
#   ownership/ACL, sequences and every table count compared -> `.env`
#   repointed (atomic, owner/mode kept) -> Compose resolution checked ->
#   recreate ONLY the app with the SAME image -> runtime DB, Prisma AdminUser
#   and HTTP health verified. Any failure restores the previous app (the
#   untouched stopped container when possible) and verifies the recovery.
# - Production starts only after staging passed AND you type STAGING_LOGIN_OK
#   after a real staging Admin login. It has its own backup and rollback.
# - Safe to rerun: an environment already on `cosmicforge_admin` is verified
#   and skipped; this script's own failed copy is preserved and retried.
# - Duplicate `.env` keys are consolidated only for an explicit list of keys,
#   only when every definition is provably equivalent for the application and
#   the final one equals the running value. Anything else stops the run.
# - Authentication gate: a login for an account that cannot exist
#   (@example.invalid) must be rejected with 401 before and after the switch,
#   proving the login path reaches the database. No real account is used.
# - No secret, URL or record content is printed or written outside the
#   root-only backup directory (which holds the original `.env` copy).
set -Eeuo pipefail
umask 077
export LC_ALL=C

readonly SCRIPT_VERSION=4
readonly DEST=cosmicforge_admin
readonly RTC_DB_CONTAINER=cosmicforge-db
readonly STAGING_OVERRIDE=/home/cf-staging-deploy/docker-compose.github-staging.yml
readonly BACKUP_BASE=/var/backups/centralize-admin
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly RUN_ID
readonly SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

usage() {
  echo 'Usage (root): bash ca-db-isolation-cutover.sh --apply-both | --staging-only | --preflight' >&2
  echo '              bash ca-db-isolation-cutover.sh --production-only [--confirm STAGING_LOGIN_OK --confirm CUTOVER_PRODUCTION]' >&2
  exit 2
}
mode_arg="${1:-}"
case "$mode_arg" in
  --apply-both|--staging-only|--preflight|--production-only) ;;
  *) usage ;;
esac
shift
# Pre-supplied confirmations (exact phrases), --production-only only.
declare -A PRECONFIRMED=()
while (( $# )); do
  case "$1" in
    # Accepted for compatibility with the earlier instructions; preserving the
    # previous staging copy is now always done (rename only, never deleted).
    --recover-failed-staging-clone) [[ "$mode_arg" == --apply-both || "$mode_arg" == --staging-only ]] || usage ;;
    --confirm)
      [[ "$mode_arg" == --production-only ]] || { echo '--confirm is accepted only with --production-only.' >&2; exit 2; }
      case "${2:-}" in
        STAGING_LOGIN_OK|CUTOVER_PRODUCTION) PRECONFIRMED["$2"]=1; shift ;;
        *) echo 'Unexpected confirmation phrase.' >&2; exit 2 ;;
      esac ;;
    *) echo 'Unexpected arguments.' >&2; exit 2 ;;
  esac
  shift
done
if [[ "$(id -u)" -ne 0 ]]; then echo 'Run as root.' >&2; exit 2; fi
for tool in docker python3 flock sha256sum df; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 2; }
done
docker compose version >/dev/null 2>&1 || { echo 'Missing docker compose v2.' >&2; exit 2; }
needs_tty=true
[[ "$mode_arg" == --preflight ]] && needs_tty=false
[[ "$mode_arg" == --production-only && -n "${PRECONFIRMED[STAGING_LOGIN_OK]:-}" && -n "${PRECONFIRMED[CUTOVER_PRODUCTION]:-}" ]] && needs_tty=false
if [[ "$needs_tty" == true ]] && ! { : </dev/tty; } 2>/dev/null; then
  echo 'An interactive terminal is required for the confirmation prompts. Download the script and run it with bash (do not pipe it into bash).' >&2
  exit 2
fi

mkdir -p /run/lock
exec 9>/run/lock/centralize-admin-db-isolation.lock
lock_busy=false
if ! flock -n 9; then
  holder="$(awk -v ino="$(stat -c %i /run/lock/centralize-admin-db-isolation.lock)" '$2 == "FLOCK" { n = split($6, a, ":"); if (a[n] == ino) print $5 }' /proc/locks | head -1)"
  if [[ "$mode_arg" != --preflight ]]; then
    echo 'Another CA DB isolation run is active (it holds /run/lock/centralize-admin-db-isolation.lock); refusing overlap. Nothing was changed.' >&2
    [[ -n "$holder" ]] && echo "Lock holder PID: $holder ($( { tr '\0' ' ' < "/proc/$holder/cmdline"; } 2>/dev/null | cut -c1-120))" >&2
    exit 1
  fi
  # The read-only preflight may observe while another run is active.
  lock_busy=true
  exec 9>&-
fi

backup_dir="$BACKUP_BASE/cutover-$RUN_ID"
mkdir -p "$BACKUP_BASE"
chmod 700 "$BACKUP_BASE"
mkdir -m 700 "$backup_dir"
exec > >(tee -a "$backup_dir/run.log") 2>&1
echo "CA database isolation v$SCRIPT_VERSION, run $RUN_ID, mode $mode_arg"
echo "Root-only run directory: $backup_dir"

declare -a SUMMARY=()
pass() { SUMMARY+=("PASS  $*"); echo "PASS: $*"; }
fail() { SUMMARY+=("FAIL  $*"); echo "FAIL: $*" >&2; }
info() { SUMMARY+=("INFO  $*"); echo "INFO: $*"; }
print_summary() {
  echo
  echo '==================== SUMMARY ===================='
  local line
  for line in "${SUMMARY[@]}"; do echo "$line"; done
  echo "Run directory (root-only): $backup_dir"
  echo '================================================='
}

# --------------------------------------------------------------------------
# Rollback state. Armed only while one environment's app is being changed.
# --------------------------------------------------------------------------
armed=false
arm_mode='' arm_root='' arm_app='' arm_source='' arm_env_backup='' recreated=false

compose_files() {
  local mode="$1"
  if [[ "$mode" == staging ]]; then
    printf '%s\n' -f docker-compose.yml -f "$STAGING_OVERRIDE"
    # Mail storage mounts (ca-mail-staging-ops --storage-setup), if present.
    [[ -f /var/www/admin-server-staging/docker-compose.mail-storage.yml ]] && printf '%s\n' -f /var/www/admin-server-staging/docker-compose.mail-storage.yml
  else
    printf '%s\n' -f docker-compose.yml
    # Image pinned by .github/scripts/ca-production-deploy.sh (if deployed).
    [[ -f /var/www/admin-server/docker-compose.release.yml ]] && printf '%s\n' -f /var/www/admin-server/docker-compose.release.yml
    [[ -f /var/www/admin-server/docker-compose.mail-storage.yml ]] && printf '%s\n' -f /var/www/admin-server/docker-compose.mail-storage.yml
  fi
  return 0
}

# Compose runs with a minimal environment so the operator's shell variables
# can never leak into interpolation.
compose() {
  local mode="$1" root="$2"; shift 2
  local -a files
  mapfile -t files < <(compose_files "$mode")
  (cd "$root" && env -i HOME=/root PATH="$SAFE_PATH" docker compose "${files[@]}" "$@")
}

recreate_app() {
  compose "$1" "$2" up -d --no-deps --no-build --pull never --force-recreate app
}

psql_db() { # container database [psql args...] ; SQL on stdin
  local container="$1" database="$2"; shift 2
  docker exec -i "$container" sh -c \
    'db="$1"; shift; exec psql -X -qAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$db" "$@"' sh "$database" "$@"
}

db_exists() {
  [[ "$(psql_db "$1" postgres -v "n=$2" <<'SQL'
SELECT count(*) FROM pg_database WHERE datname = :'n';
SQL
)" == 1 ]]
}

# --------------------------------------------------------------------------
# Environment-file and Compose analysis (python, in memory; prints only key
# names, counts and booleans).
# --------------------------------------------------------------------------
envtool() {
  env -i HOME=/root PATH="$SAFE_PATH" STAGING_OVERRIDE="$STAGING_OVERRIDE" python3 - "$@" <<'PY'
import hashlib, json, os, re, secrets, shutil, subprocess, sys, tempfile
from urllib.parse import urlsplit, urlunsplit, unquote

cmd, mode, root, app, *rest = sys.argv[1:]
files = ['-f', 'docker-compose.yml'] + (['-f', os.environ['STAGING_OVERRIDE']] if mode == 'staging' else
       (['-f', '/var/www/admin-server/docker-compose.release.yml'] if os.path.isfile('/var/www/admin-server/docker-compose.release.yml') else []))
ENV = {'HOME': '/root', 'PATH': os.environ['PATH']}
LINE = re.compile(r'^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*?)(\r?\n?)$', re.S)
# Duplicate keys are consolidated ONLY for these explicitly reviewed keys.
# Any other duplicate stops the run. Compose (v1 and v2) uses the LAST
# definition; the earlier, shadowed lines are removed during the backed-up
# rewrite and the remaining line keeps exactly the running value.
#
# Google OAuth (seen on staging): the final definition must equal the running
# value; earlier lines have no effect on any reader of this file.
GOOGLE_DUPLICATES = {'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'}
# Social integration switches (seen on production). They turn integrations on
# or off, so EVERY definition must mean the same thing to the application, not
# only the final one: a conflicting earlier line is refused, never silently
# dropped. Equivalence uses the application's own parser, boolValue() in
# services/central-admin-api/src/modules/marketing/social-operations/config/
# social-operations-env.validator.js: unset/empty -> false; otherwise
# trim().toLowerCase() must be exactly "true" or "false" (anything else is a
# configuration error and is refused here). Values are never changed: the kept
# line is the final one, byte for byte, and must equal the running value.
SOCIAL_FLAG_DUPLICATES = {'LINKEDIN_SOCIAL_ENABLED', 'META_SOCIAL_ENABLED',
                          'TIKTOK_SOCIAL_ENABLED', 'X_SOCIAL_ENABLED'}
DUPLICATE_SAFELIST = GOOGLE_DUPLICATES | SOCIAL_FLAG_DUPLICATES

def out(obj, code=0):
    print(json.dumps(obj, sort_keys=True)); sys.exit(code)

def run(args, cwd=None):
    p = subprocess.run(args, cwd=cwd, env=ENV, capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr

def decode(v):  # `docker compose config` doubles literal dollars
    return None if v is None else str(v).replace('$$', '$')

def compose_config():
    code, so, se = run(['docker', 'compose', *files, 'config', '--format', 'json'], cwd=root)
    if code != 0:
        out({'ok': False, 'problems': ['compose config failed']}, 1)
    cfg = json.loads(so)
    warnings = sum(1 for l in se.splitlines() if 'variable is not set' in l)
    svc = cfg.get('services', {})
    def envof(name):
        e = (svc.get(name) or {}).get('environment') or {}
        if isinstance(e, list):
            e = dict(x.split('=', 1) if '=' in x else (x, None) for x in e)
        return {k: decode(v) for k, v in e.items()}
    return cfg, envof('app'), envof('db'), decode((svc.get('app') or {}).get('image')), warnings

def container_env(name):
    code, so, _ = run(['docker', 'inspect', '-f', '{{json .Config.Env}}', name])
    if code != 0:
        out({'ok': False, 'problems': ['container not found']}, 1)
    return dict(x.split('=', 1) for x in json.loads(so) if '=' in x)

def container_image(name):
    return run(['docker', 'inspect', '-f', '{{.Config.Image}}', name])[1].strip()

def read_lines(path):
    with open(path, encoding='utf-8') as f:
        return f.read().splitlines(keepends=True)

def raw_has_dollar(raw):
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] == "'":
        return False
    return bool(re.search(r'(?<!\$)\$(?!\$)', raw.replace('$$', '')))

def dotenv_scan(lines):
    keys, dollar, multiline = {}, [], False
    for line in lines:
        m = LINE.match(line)
        if not m:
            continue
        k, raw = m.group(2), m.group(4)
        keys[k] = keys.get(k, 0) + 1
        s = raw.strip()
        if s[:1] in ('"', "'") and (len(s) < 2 or s[-1] != s[0]):
            multiline = True
        if raw_has_dollar(raw):
            dollar.append(k)
    return keys, sorted(set(dollar)), multiline

def effective_values(names, env_file=None):
    """Exactly what Compose resolves for each .env key (handles $, quotes,
    comments), using a throwaway compose file; nothing is started."""
    names = [n for n in names if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', n)]
    env_file = env_file or os.path.join(root, '.env')
    with tempfile.TemporaryDirectory(dir='/run') as d:
        probe = os.path.join(d, 'probe.yml')
        with open(probe, 'w') as f:
            f.write('services:\n  probe:\n    image: busybox\n    environment:\n')
            for n in names:
                f.write(f'      {n}: ${{{n}}}\n')
        code, so, _ = run(['docker', 'compose', '--project-directory', root, '--env-file', env_file,
                           '-p', 'caprobe', '-f', probe, 'config', '--format', 'json'])
        if code != 0:
            out({'ok': False, 'problems': ['env resolution failed']}, 1)
        env = json.loads(so)['services']['probe'].get('environment') or {}
        return {k: decode(v) for k, v in env.items()}

def occurrence_values(lines, key):
    """Compose's reading of EACH definition of `key` on its own (only used
    for keys without `$`, so no definition depends on another line)."""
    values = []
    with tempfile.TemporaryDirectory(dir='/run') as d:
        for line in lines:
            m = LINE.match(line)
            if not m or m.group(2) != key:
                continue
            one = os.path.join(d, 'one.env')
            with open(one, 'w', encoding='utf-8') as f:
                f.write(line if line.endswith('\n') else line + '\n')
            values.append(effective_values([key], one).get(key))
    return values

def app_bool(v):
    """boolValue() of the social-operations validator, as a string."""
    if v is None or v == '':
        return 'false'
    n = v.strip().lower()
    return n if n in ('true', 'false') else None

def duplicate_verdict(k, lines, dollar, c_app, r_app, effective=None):
    """None when the duplicate key may be consolidated, else the reason
    (key names and reasons only, never values)."""
    if k not in DUPLICATE_SAFELIST:
        return 'unsafe duplicate key (not on the reviewed list)'
    if k in dollar:
        return 'unsafe duplicate key (a definition contains $)'
    if k not in c_app or k not in r_app:
        return 'unsafe duplicate key (not part of the running app settings)'
    if c_app[k] != r_app[k] or (effective is not None and effective.get(k) != r_app[k]):
        return 'unsafe duplicate key (final definition differs from the running value)'
    if k in SOCIAL_FLAG_DUPLICATES:
        running = app_bool(r_app[k])
        if running is None:
            return 'unsafe duplicate key (running value is not a valid boolean for the app)'
        meanings = [app_bool(v) for v in occurrence_values(lines, k)]
        if len(meanings) < 2 or any(m != running for m in meanings):
            return 'conflicting duplicate key (definitions disagree; resolve manually, no switch is changed)'
    return None

def db_target(url):
    u = urlsplit(url or '')
    return u.hostname, unquote(u.path.lstrip('/'))

def repoint(url, dest):
    u = urlsplit(url)
    return urlunsplit(u._replace(path='/' + dest))

def created_by(name):
    return run(['docker', 'inspect', '-f', '{{index .Config.Labels "com.docker.compose.version"}}', name])[1].strip()

def legacy_compose():
    """An old docker-compose 1.x reads .env differently (no $ expansion, quotes kept)."""
    exe = shutil.which('docker-compose', path=os.environ['PATH'])
    if not exe:
        return None
    v = run([exe, 'version', '--short'])[1].strip().lstrip('v')
    return v if v.startswith('1.') else None

def inspect(expected):
    problems = []
    cfg, c_app, c_db, c_image, warnings = compose_config()
    r_app, r_db = container_env(app), container_env(rest[0])
    lines = read_lines(os.path.join(root, '.env'))
    keys, dollar, multiline = dotenv_scan(lines)
    # A difference is acceptable ONLY for keys whose .env value contains `$`:
    # the rewrite then writes the running value literally. Any other
    # difference (e.g. .env edited since the last deploy) blocks.
    app_mismatch = sorted(k for k, v in c_app.items() if r_app.get(k) != v)
    db_mismatch = sorted(k for k, v in c_db.items() if r_db.get(k) != v)
    hard_app = [k for k in app_mismatch if k not in dollar]
    hard_db = [k for k in db_mismatch if k not in dollar]
    if hard_app: problems.append('app env would change on recreation: ' + ','.join(hard_app))
    if hard_db: problems.append('db env differs from compose: ' + ','.join(hard_db))
    if c_image != container_image(app): problems.append('compose app image differs from running image')
    if keys.get('DATABASE_URL', 0) != 1: problems.append('.env must define DATABASE_URL exactly once')
    if multiline: problems.append('.env has a multi-line value; refusing to edit')
    dup = sorted(k for k, n in keys.items() if n > 1)
    duplicates = {}
    for k in dup:
        reason = duplicate_verdict(k, lines, dollar, c_app, r_app)
        duplicates[k] = {'definitions': keys[k], 'consolidate': reason is None, 'reason': reason}
        if reason:
            if reason.startswith('conflicting'):
                problems.append('.env has conflicting duplicate key: ' + k)
            else:
                problems.append('.env has unsafe duplicate key: ' + k)
    # Safe duplicate lines are reconciled only during the backed-up rewrite.
    rh, rdb = db_target(r_app.get('DATABASE_URL'))
    ch, cdb = db_target(c_app.get('DATABASE_URL'))
    state = 'unknown'
    if rh == ch == 'db' and rdb == cdb == expected:
        state = 'source'
    elif rh == ch == 'db' and rdb == cdb == 'cosmicforge_admin':
        state = 'dest'
    else:
        problems.append('app DATABASE_URL target is neither the expected source nor cosmicforge_admin')
    out({'ok': not problems, 'problems': problems, 'state': state, 'dollarKeys': dollar, 'duplicateKeys': duplicates,
         'dollarKeysRunningDiffers': sorted(set(app_mismatch + db_mismatch) & set(dollar)),
         'interpolationWarnings': warnings, 'appKeys': len(c_app),
         'appCreatedByCompose': created_by(app), 'legacyDockerCompose': legacy_compose()}, 0 if not problems else 1)

def salted(values, salt):
    return {k: hashlib.sha256((salt + '\0' + k + '\0' + (v or '')).encode()).hexdigest() for k, v in values.items()}

def snapshot(path):
    _, c_app, _, _, _ = compose_config()
    r_app = container_env(app)
    salt = secrets.token_hex(16)
    keep = {k: r_app.get(k) for k in c_app}
    expected = dict(keep)
    expected['DATABASE_URL'] = repoint(keep['DATABASE_URL'], 'cosmicforge_admin')
    with open(path, 'w') as f:
        json.dump({'salt': salt, 'before': salted(keep, salt), 'after': salted(expected, salt)}, f)
    os.chmod(path, 0o600)
    out({'ok': True})

def postcheck(path, which):
    snap = json.load(open(path))
    _, c_app, _, _, _ = compose_config()
    r_app = container_env(app)
    now = salted({k: r_app.get(k) for k in c_app}, snap['salt'])
    diff = sorted(set(now) ^ set(snap[which]) | {k for k in now if snap[which].get(k) != now[k]})
    out({'ok': not diff, 'changedKeys': diff}, 0 if not diff else 1)

BARE_SAFE = re.compile(r'[^\s\'"#$\\`]*')

def rewrite(source, dest):
    path = os.path.join(root, '.env')
    st = os.stat(path)
    original = open(path, 'rb').read()
    lines = read_lines(path)
    keys, dollar, _ = dotenv_scan(lines)
    before = effective_values(list(keys))
    _, c_app_before, c_db_before, _, _ = compose_config()
    r_app, r_db = container_env(app), container_env(rest[0])
    duplicates = {k: n for k, n in keys.items() if n > 1}
    for k in duplicates:
        reason = duplicate_verdict(k, lines, dollar, c_app_before, r_app, before)
        if reason:
            out({'ok': False, 'problems': [reason + ': ' + k]}, 1)
    # Compose already resolved the final occurrence; remove shadowed entries.
    earlier = {k: n - 1 for k, n in duplicates.items()}
    h, d = db_target(r_app.get('DATABASE_URL'))
    if h != 'db' or d != source:
        out({'ok': False, 'problems': ['running DATABASE_URL does not target the expected source']}, 1)
    # Truth for a rewritten key is what is RUNNING (app first, then db);
    # unused keys keep Compose's current value.
    target = dict(before)
    for k in dollar:
        target[k] = r_app[k] if k in r_app else r_db[k] if k in r_db else before.get(k)
    target['DATABASE_URL'] = repoint(r_app['DATABASE_URL'], dest)
    legacy = legacy_compose()
    newlines, frozen, quoted = [], [], []
    for line in lines:
        m = LINE.match(line)
        if not m:
            newlines.append(line); continue
        k = m.group(2)
        if earlier.get(k, 0):
            earlier[k] -= 1
            continue
        if k in dollar or k == 'DATABASE_URL':
            v = target.get(k)
            if v is None or "'" in v or '\n' in v or '\r' in v:
                out({'ok': False, 'problems': [f'cannot safely write value of {k}']}, 1)
            if k in dollar: frozen.append(k)
            if BARE_SAFE.fullmatch(v):
                written = v              # read identically by every Compose version
            else:
                if legacy:
                    out({'ok': False, 'problems': [f'{k} needs quoting but docker-compose {legacy} reads quotes literally']}, 1)
                written = f"'{v}'"       # Compose v2: single quotes are literal
                quoted.append(k)
            newlines.append(f"{m.group(1)}{k}{m.group(3)}{written}{m.group(5)}")
        else:
            newlines.append(line)
    fd, tmp = tempfile.mkstemp(prefix='.ca-env-', dir=root)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.writelines(newlines)
        os.chown(tmp, st.st_uid, st.st_gid)
        os.chmod(tmp, st.st_mode & 0o7777)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    problems = []
    after = effective_values(list(keys))
    for k in keys:
        if after.get(k) != target.get(k):
            problems.append('effective value would change: ' + k)
    after_keys, still, _ = dotenv_scan(read_lines(path))
    if still: problems.append('unquoted $ remains in: ' + ','.join(still))
    if any(n > 1 for n in after_keys.values()):
        problems.append('duplicate .env keys remained after normalization')
    for k in duplicates:
        if after.get(k) != r_app.get(k):
            problems.append('consolidated key would change: ' + k)
    _, c_app, c_db, _, warnings = compose_config()
    exp_app = {k: r_app.get(k) for k in c_app_before}
    exp_app['DATABASE_URL'] = repoint(r_app['DATABASE_URL'], dest)
    if {k: c_app.get(k) for k in exp_app} != exp_app or set(c_app) != set(exp_app):
        problems.append('compose would not start the app with the previous settings plus the new database')
    if {k: c_db.get(k) for k in c_db_before} != {k: r_db.get(k) for k in c_db_before}:
        problems.append('compose db settings would change')
    if problems:
        with open(path, 'wb') as f: f.write(original)
        os.chown(path, st.st_uid, st.st_gid); os.chmod(path, st.st_mode & 0o7777)
        out({'ok': False, 'problems': problems, 'restored': True}, 1)
    out({'ok': True, 'frozenKeys': sorted(frozen), 'quotedKeys': sorted(quoted),
         'deduplicatedKeys': sorted(duplicates), 'interpolationWarningsAfter': warnings})

if cmd == 'inspect': inspect(rest[1])
elif cmd == 'snapshot': snapshot(rest[1])
elif cmd == 'postcheck': postcheck(rest[1], rest[2])
elif cmd == 'rewrite': rewrite(rest[1], rest[2])
else: out({'ok': False, 'problems': ['unknown command']}, 2)
PY
}

json_field() { python3 -c 'import json,sys; v=json.load(sys.stdin).get(sys.argv[1]); print(json.dumps(v) if isinstance(v,(list,dict,bool)) else ("" if v is None else v))' "$1"; }

# --------------------------------------------------------------------------
# Instance identity (read-only).
# --------------------------------------------------------------------------
env_params() { # sets project app db source root volume
  if [[ "$1" == staging ]]; then
    project=admin-server-staging; app=admin-server-staging-app-1; db=admin-server-staging-db-1
    source=rtc_db_staging; root=/var/www/admin-server-staging; volume=admin-server-staging_postgres_data_staging
  else
    project=admin-server; app=admin-server-app-1; db=admin-server-db-1
    source=rtc_db; root=/var/www/admin-server; volume=admin-server_postgres_data
  fi
}

identity_ok() { # mode -> 0 when every identity guard passes (prints reasons)
  local mode="$1" project app db source root volume ok=0
  env_params "$mode"
  [[ "$app" != "$RTC_DB_CONTAINER" && "$db" != "$RTC_DB_CONTAINER" ]] || return 1
  local c
  for c in "$app" "$db"; do
    if ! docker inspect "$c" >/dev/null 2>&1; then echo "  $mode: container $c missing"; return 1; fi
    [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$c")" == "$project" ]] || { echo "  $mode: $c not in compose project $project"; ok=1; }
    [[ "$(docker inspect -f '{{.State.Running}}' "$c")" == true ]] || { echo "  $mode: $c not running"; ok=1; }
  done
  [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$app")" == app ]] || { echo "  $mode: $app is not compose service app"; ok=1; }
  [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$db")" == db ]] || { echo "  $mode: $db is not compose service db"; ok=1; }
  local vols
  vols="$(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$db")"
  [[ "$vols" == "$volume " ]] || { echo "  $mode: $db storage volume is not exactly $volume"; ok=1; }
  [[ -f "$root/.env" && -f "$root/docker-compose.yml" ]] || { echo "  $mode: $root/.env or docker-compose.yml missing"; ok=1; }
  [[ "$mode" != staging || -f "$STAGING_OVERRIDE" ]] || { echo "  staging: image override file missing"; ok=1; }
  local running tagged
  running="$(docker inspect -f '{{.Image}}' "$app")"
  tagged="$(docker inspect -f '{{.Config.Image}}' "$app")"
  [[ "$(docker image inspect -f '{{.Id}}' "$tagged" 2>/dev/null)" == "$running" ]] || { echo "  $mode: the app's image tag no longer points at the running image"; ok=1; }
  db_exists "$db" "$source" || { echo "  $mode: source database $source not found"; ok=1; }
  return "$ok"
}

# Read-only state: prints source|dest|unknown and the analysis JSON to a file.
env_state() {
  local mode="$1" report="$2" project app db source root volume
  env_params "$mode"
  if envtool inspect "$mode" "$root" "$app" "$db" "$source" > "$report"; then
    json_field state < "$report"
  else
    echo unknown
  fi
}

verify_app() { # app expected_db [attempts]
  local app="$1" expected="$2" attempts="${3:-45}" i
  for ((i = 1; i <= attempts; i++)); do
    if docker exec -i -e EXPECTED_DB="$expected" -w /app "$app" node - >/dev/null 2>&1 <<'NODE'
const { prisma } = require('./src/shared/config/database');
(async () => {
  const u = new URL(process.env.DATABASE_URL);
  if (u.hostname !== 'db' || decodeURIComponent(u.pathname.slice(1)) !== process.env.EXPECTED_DB) throw new Error('target');
  const rows = await prisma.$queryRawUnsafe('SELECT current_database() AS name');
  if (rows[0]?.name !== process.env.EXPECTED_DB) throw new Error('connected');
  await prisma.adminUser.count();
  const r = await fetch('http://127.0.0.1:' + Number(process.env.PORT || 4000) + '/health', { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error('health');
})().catch(() => { process.exitCode = 1; }).finally(() => prisma.$disconnect());
NODE
    then return 0; fi
    sleep 2
  done
  return 1
}

# Authentication gate: a login for an account that cannot exist (reserved
# .invalid TLD) must be rejected with exactly 401 by the running app. That
# proves the login route works and looks the account up in the database the
# app is connected to. Nothing is written for an unknown account and no real
# account or password is involved. Prints the HTTP status (or an error name).
login_probe_status() { # app
  docker exec -i -w /app "$1" node - 2>/dev/null <<'NODE' || true
fetch('http://127.0.0.1:' + Number(process.env.PORT || 4000) + '/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ca-db-synthetic-probe@example.invalid', password: 'not-a-real-password' }),
  signal: AbortSignal.timeout(8000),
}).then(r => process.stdout.write(String(r.status))).catch(e => process.stdout.write(e.name || 'error'));
NODE
}

auth_ok() { # app -> 0 when the synthetic login is rejected with 401
  local i status
  for ((i = 0; i < 3; i++)); do
    status="$(login_probe_status "$1")"
    [[ "$status" == 401 ]] && return 0
    sleep 2
  done
  echo "  synthetic login on $1 answered ${status:-nothing} (expected 401)" >&2
  return 1
}

# --------------------------------------------------------------------------
# Database operations inside ONE CA-owned PostgreSQL container.
# --------------------------------------------------------------------------
sessions_on() { psql_db "$1" postgres -v "n=$2" <<'SQL'
SELECT count(*) FROM pg_stat_activity WHERE datname = :'n' AND pid <> pg_backend_pid();
SQL
}

db_comment() { psql_db "$1" postgres -v "n=$2" <<'SQL'
SELECT coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = :'n';
SQL
}

rename_db() { # container from to
  psql_db "$1" postgres -v "f=$2" -v "t=$3" <<'SQL' >/dev/null
SELECT format('ALTER DATABASE %I RENAME TO %I', :'f', :'t') \gexec
SQL
}

database_level() { # container db -> normalized owner/ACL/settings/encoding lines
  psql_db "$1" postgres -v "n=$2" <<'SQL'
SELECT 'owner|' || pg_get_userbyid(datdba) || '|enc|' || pg_encoding_to_char(encoding) || '|' || datcollate || '|' || datctype || '|allowconn|' || datallowconn
  FROM pg_database WHERE datname = :'n';
SELECT 'acl|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || '|' || a.privilege_type || '|' || a.is_grantable
  FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname = :'n' ORDER BY 1;
SELECT 'set|' || coalesce(r.rolname, '*') || '|' || array_to_string(s.setconfig, chr(31))
  FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase LEFT JOIN pg_roles r ON r.oid = s.setrole
  WHERE d.datname = :'n' ORDER BY 1;
SQL
}

copy_database_level() { # container source dest
  local c="$1" src="$2" dst="$3"
  psql_db "$c" postgres -v "src=$src" -v "dst=$dst" <<'SQL' >/dev/null || return 1
SELECT format('ALTER DATABASE %I OWNER TO %I', :'dst', pg_get_userbyid(datdba)) FROM pg_database WHERE datname = :'src' \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'dst') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM %I', :'dst', pg_get_userbyid(datdba)) FROM pg_database WHERE datname = :'src' \gexec
SELECT format('GRANT %s ON DATABASE %I TO %s%s', a.privilege_type, :'dst',
              CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END,
              CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
  FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname = :'src' \gexec
SQL
  # Database-level settings (rare). Values come from the catalog itself;
  # only a conservative character set is accepted.
  local line role kv key value
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    role="${line%%|*}"; kv="${line#*|}"
    key="${kv%%=*}"; value="${kv#*=}"
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_.]*$ || ! "$value" =~ ^[A-Za-z0-9_.,:\"\$\ /+-]*$ ]]; then
      echo 'BLOCKED: unusual database-level setting; copy it manually.' >&2; return 1
    fi
    if [[ "$role" == '*' ]]; then
      printf 'ALTER DATABASE "%s" SET %s TO %s;\n' "$dst" "$key" "$value"
    else
      printf 'ALTER ROLE "%s" IN DATABASE "%s" SET %s TO %s;\n' "$role" "$dst" "$key" "$value"
    fi
  done < <(psql_db "$c" postgres -v "n=$src" <<'SQL'
SELECT coalesce(r.rolname, '*') || '|' || unnest(s.setconfig)
  FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase LEFT JOIN pg_roles r ON r.oid = s.setrole
  WHERE d.datname = :'n';
SQL
) | psql_db "$c" postgres >/dev/null
}

catalog_fingerprint() { # container db -> owner/ACL/extension/sequence catalog
  psql_db "$1" "$2" <<'SQL'
SELECT x FROM (
  SELECT 'rel|' || n.nspname || '|' || c.relname || '|' || c.relkind::text || '|' || pg_get_userbyid(c.relowner) || '|' || coalesce(c.relacl::text, '') AS x
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp%'
  UNION ALL
  SELECT 'nsp|' || nspname || '|' || pg_get_userbyid(nspowner) || '|' || coalesce(nspacl::text, '')
    FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'
  UNION ALL
  SELECT 'proc|' || n.nspname || '|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || pg_get_userbyid(p.proowner) || '|' || coalesce(p.proacl::text, '')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  UNION ALL
  SELECT 'type|' || n.nspname || '|' || t.typname || '|' || pg_get_userbyid(t.typowner)
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_toast%'
  UNION ALL
  SELECT 'ext|' || extname || '|' || extversion FROM pg_extension
  UNION ALL
  SELECT 'defacl|' || pg_get_userbyid(d.defaclrole) || '|' || coalesce(n.nspname, '') || '|' || d.defaclobjtype::text || '|' || d.defaclacl::text
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  UNION ALL
  SELECT 'seq|' || schemaname || '.' || sequencename || '|' || coalesce(last_value::text, 'null') FROM pg_sequences
) s ORDER BY x;
SQL
}

table_counts() { psql_db "$1" "$2" <<'SQL'
SELECT format('SELECT %L || ''|'' || count(*)::text FROM %I.%I', schemaname || '.' || tablename, schemaname, tablename)
  FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1 \gexec
SQL
}

schema_dump() { docker exec "$1" sh -c 'exec pg_dump -U "${POSTGRES_USER:-postgres}" --schema-only --no-owner --no-acl -d "$1"' sh "$2"; }

compare_schema_objects() {
  python3 - "$1" "$2" <<'PYSCHEMA'
import re, sys
from pathlib import Path
pattern = re.compile(r'^-- Name: (.*); Type: ([^;]+); Schema: ([^;]+); Owner: (.*)$')
def objects(filename):
    catalog, current = {}, None
    for line in Path(filename).read_text(errors='replace').splitlines():
        m = pattern.fullmatch(line)
        if m:
            current = (m.group(2), m.group(3), m.group(1))
            if current in catalog: raise ValueError('duplicate schema object')
            catalog[current] = []
            continue
        if line.lstrip().startswith('--') or not line.strip(): continue
        if line.startswith('\\restrict ') or line.startswith('\\unrestrict '): continue
        if current is not None: catalog[current].append(line.rstrip())
    return {k: '\n'.join(v) for k, v in catalog.items()}
try:
    a, b = objects(sys.argv[1]), objects(sys.argv[2])
    missing, added = set(a) - set(b), set(b) - set(a)
    changed = {k for k in set(a) & set(b) if a[k] != b[k]}
    if not a or missing or added or changed:
        print('schema objects differ: missing=%d added=%d changed=%d' % (len(missing), len(added), len(changed))); sys.exit(1)
    print('%d schema objects match' % len(a))
except (OSError, ValueError):
    print('schema comparison unavailable'); sys.exit(1)
PYSCHEMA
}

# Called in `x || fail` lists, where `set -e` does not apply: every step is
# checked explicitly and an empty result is never accepted as a match.
compare_databases() { # container a b dir label
  local c="$1" a="$2" b="$3" dir="$4" label="$5" result side
  for side in a b; do
    local name="$a"; [[ "$side" == b ]] && name="$b"
    schema_dump "$c" "$name" > "$dir/$label-$side-schema.sql" || { echo "  $label: schema dump failed" >&2; return 1; }
    catalog_fingerprint "$c" "$name" > "$dir/$label-$side-catalog.txt" || { echo "  $label: catalog query failed" >&2; return 1; }
    table_counts "$c" "$name" > "$dir/$label-$side-counts.unsorted" || { echo "  $label: row count query failed" >&2; return 1; }
    sort "$dir/$label-$side-counts.unsorted" > "$dir/$label-$side-counts.txt"
    [[ -s "$dir/$label-$side-schema.sql" && -s "$dir/$label-$side-catalog.txt" && -s "$dir/$label-$side-counts.txt" ]] \
      || { echo "  $label: empty comparison input; refusing" >&2; return 1; }
  done
  result="$(compare_schema_objects "$dir/$label-a-schema.sql" "$dir/$label-b-schema.sql")" || { echo "  $label: $result" >&2; return 1; }
  echo "  $label: $result"
  cmp -s "$dir/$label-a-catalog.txt" "$dir/$label-b-catalog.txt" || { echo "  $label: ownership/ACL/sequence catalog differs" >&2; return 1; }
  echo "  $label: $(wc -l < "$dir/$label-a-catalog.txt") ownership/ACL/extension/sequence entries match"
  cmp -s "$dir/$label-a-counts.txt" "$dir/$label-b-counts.txt" || { echo "  $label: table row counts differ" >&2; return 1; }
  echo "  $label: $(wc -l < "$dir/$label-a-counts.txt") tables, every row count matches"
}

# --------------------------------------------------------------------------
# Unrelated-container protection.
# --------------------------------------------------------------------------
snapshot_others() {
  local id
  for id in $(docker ps -aq --no-trunc); do
    docker inspect -f '{{.Id}}|{{.Name}}|{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}' "$id"
  done | grep -vE '\|/(admin-server-staging-app-1|admin-server-app-1)\|' | sort
}

# --------------------------------------------------------------------------
# Rollback.
# --------------------------------------------------------------------------
rollback() {
  [[ "$armed" == true ]] || return 0
  armed=false
  echo "ROLLBACK: restoring the previous $arm_mode application." >&2
  local ok=false
  if [[ "$recreated" == false ]]; then
    # The original container was only stopped: start it unchanged.
    cp -p "$arm_env_backup" "$arm_root/.env" 2>/dev/null || true
    docker start "$arm_app" >/dev/null 2>&1 && ok=true
  else
    cp -p "$arm_env_backup" "$arm_root/.env" && recreate_app "$arm_mode" "$arm_root" >&2 && ok=true
  fi
  if [[ "$ok" == true ]] && verify_app "$arm_app" "$arm_source" 45; then
    if auth_ok "$arm_app"; then info "$arm_mode after rollback: synthetic login rejected with 401 (login path works)"; fi
    fail "$arm_mode cutover rolled back; app verified healthy on $arm_source again"
  else
    fail "$arm_mode ROLLBACK DID NOT VERIFY. Original .env: $arm_env_backup. Legacy database $arm_source is untouched; restore that file and run 'docker compose up -d --no-deps app' in $arm_root."
  fi
}

on_exit() {
  local code=$?
  trap - EXIT INT TERM
  if [[ "$armed" == true ]]; then rollback; fi
  if [[ -n "${others_before:-}" ]]; then
    if [[ "$(snapshot_others)" == "$others_before" ]]; then
      pass 'all other containers (RTC cosmicforge-db, CA databases, KarryGo, CFMeet, ...) unchanged'
    else
      fail 'another container changed state during the run; inspect docker ps'
    fi
  fi
  [[ "$code" -eq 0 ]] || fail "stopped with exit code $code; production was not started after any staging failure"
  print_summary
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

confirm() { # prompt expected
  local answer
  if [[ -n "${PRECONFIRMED[$2]:-}" ]]; then
    echo "${1}$2 (supplied by the operator with --confirm)"
    return 0
  fi
  if ! { : </dev/tty; } 2>/dev/null; then
    echo "${1}(no terminal and not supplied with --confirm: not confirmed)"
    return 1
  fi
  read -r -p "$1" answer </dev/tty
  [[ "$answer" == "$2" ]]
}

# --------------------------------------------------------------------------
# One environment.
# --------------------------------------------------------------------------
cutover() {
  local mode="$1" project app db source root volume
  env_params "$mode"
  local dir="$backup_dir/$mode"
  mkdir -m 700 "$dir"
  echo
  echo "=================== $mode ==================="

  identity_ok "$mode" || { fail "$mode identity checks"; return 1; }
  pass "$mode containers, compose project, storage volume and image identity"

  local state
  state="$(env_state "$mode" "$dir/inspect.json")"
  if [[ "$state" == dest ]]; then
    if verify_app "$app" "$DEST" 5 && auth_ok "$app"; then
      pass "$mode already uses $DEST (verified runtime DB, AdminUser, health, synthetic login 401); skipped"
      return 0
    fi
    fail "$mode is configured for $DEST but does not verify; not changing it"; return 1
  fi
  if [[ "$state" != source ]]; then
    fail "$mode configuration check: $(json_field problems < "$dir/inspect.json")"; return 1
  fi
  pass "$mode app runs on $source; recreating it keeps every setting (keys with \$ are written with their running value)"
  local dollar warnings
  dollar="$(json_field dollarKeys < "$dir/inspect.json")"
  warnings="$(json_field interpolationWarnings < "$dir/inspect.json")"
  info "$mode duplicate .env keys (names, definitions, verdict): $(json_field duplicateKeys < "$dir/inspect.json")"
  info "$mode .env keys Compose currently interpolates (\$): $dollar; interpolation warnings: $warnings; of these, running value differs from Compose's: $(json_field dollarKeysRunningDiffers < "$dir/inspect.json"); app created by Compose $(json_field appCreatedByCompose < "$dir/inspect.json"); legacy docker-compose 1.x: $(json_field legacyDockerCompose < "$dir/inspect.json")"
  verify_app "$app" "$source" 5 || { fail "$mode app does not verify on $source before the change"; return 1; }
  pass "$mode app verified on $source before the change"
  auth_ok "$app" || { fail "$mode authentication baseline: synthetic login is not rejected with 401 on $source; not changing anything"; return 1; }
  pass "$mode authentication baseline: synthetic login rejected with 401 on $source"

  # Destination and capacity.
  local preserve=''
  if db_exists "$db" "$DEST"; then
    [[ "$(sessions_on "$db" "$DEST")" == 0 ]] || { fail "$mode existing $DEST has active sessions"; return 1; }
    local comment; comment="$(db_comment "$db" "$DEST")"
    if [[ "$mode" == staging ]]; then
      preserve="${DEST}_previous_copy_$(date -u +%Y%m%d_%H%M%S)"
    elif [[ "$comment" == ca-cutover:*:incomplete ]]; then
      preserve="${DEST}_failed_attempt_$(date -u +%Y%m%d_%H%M%S)"
    else
      fail "production already has a $DEST this script did not create; not touching it"; return 1
    fi
  fi
  local size avail_backup avail_docker
  size="$(psql_db "$db" postgres -v "n=$source" <<'SQL'
SELECT pg_database_size(:'n');
SQL
)"
  avail_backup="$(( $(df -Pk "$BACKUP_BASE" | awk 'NR==2 {print $4}') * 1024 ))"
  avail_docker="$(( $(df -Pk "$(docker info -f '{{.DockerRootDir}}')" | awk 'NR==2 {print $4}') * 1024 ))"
  if (( avail_backup < 3 * size + 524288000 || avail_docker < 3 * size + 524288000 )); then
    fail "$mode free disk space is too low for backup + clone"; return 1
  fi
  pass "$mode disk space ($((size / 1048576)) MB database)"

  if [[ "$mode" == staging ]]; then
    echo "About to stop ONLY admin-server-staging-app-1 (brief staging downtime), back up $source and switch staging to $DEST."
    confirm 'Type CUTOVER_STAGING to continue: ' CUTOVER_STAGING || { info 'staging not started (no confirmation); nothing changed'; exit 0; }
  fi

  # Keep the previous effective settings and their per-key fingerprints.
  cp -p "$root/.env" "$dir/original.env"
  envtool snapshot "$mode" "$root" "$app" "$db" "$dir/settings-fingerprint.json" >/dev/null || { fail "$mode settings snapshot"; return 1; }
  local image_before; image_before="$(docker inspect -f '{{.Image}}' "$app")"

  if [[ -n "$preserve" ]]; then
    rename_db "$db" "$DEST" "$preserve"
    pass "$mode preserved the earlier $DEST as $preserve (renamed, nothing deleted)"
  fi

  # From here a failure restores the previous app automatically.
  armed=true arm_mode="$mode" arm_root="$root" arm_app="$app" arm_source="$source" arm_env_backup="$dir/original.env" recreated=false
  docker stop -t 30 "$app" >/dev/null
  local i n=1
  for ((i = 0; i < 30; i++)); do
    n="$(sessions_on "$db" "$source")"; [[ "$n" == 0 ]] && break; sleep 2
  done
  [[ "$n" == 0 ]] || { fail "$mode: $n sessions still use $source after stopping the app"; return 1; }
  pass "$mode app stopped; no sessions on $source (write-free)"

  # Fresh backup after writers stopped, plus a scratch restore check.
  docker exec "$db" sh -c 'exec pg_dump -U "${POSTGRES_USER:-postgres}" -Fc -d "$1"' sh "$source" > "$dir/$source.dump"
  [[ -s "$dir/$source.dump" ]] && docker exec -i "$db" pg_restore --list < "$dir/$source.dump" > /dev/null
  sha256sum "$dir/$source.dump" > "$dir/$source.dump.sha256"
  local scratch="ca_cutover_restore_check_${RUN_ID//[^0-9]/}"
  scratch="${scratch:0:60}"
  psql_db "$db" postgres -v "n=$scratch" -v "c=ca-cutover:$RUN_ID:restore-check" <<'SQL' >/dev/null
SELECT format('CREATE DATABASE %I TEMPLATE template0', :'n') \gexec
SELECT format('COMMENT ON DATABASE %I IS %L', :'n', :'c') \gexec
SQL
  docker exec -i "$db" sh -c 'exec pg_restore -U "${POSTGRES_USER:-postgres}" --exit-on-error --single-transaction -d "$1"' sh "$scratch" < "$dir/$source.dump" >/dev/null
  table_counts "$db" "$source" | sort > "$dir/backup-source-counts.txt"
  table_counts "$db" "$scratch" | sort > "$dir/backup-restored-counts.txt"
  if ! cmp -s "$dir/backup-source-counts.txt" "$dir/backup-restored-counts.txt"; then
    fail "$mode fresh backup restore check: row counts differ"; return 1
  fi
  # Drop ONLY this run's own scratch database (exact name and marker).
  [[ "$scratch" =~ ^ca_cutover_restore_check_[0-9]+$ && "$(db_comment "$db" "$scratch")" == "ca-cutover:$RUN_ID:restore-check" ]]
  psql_db "$db" postgres -v "n=$scratch" <<'SQL' >/dev/null
SELECT format('DROP DATABASE %I', :'n') \gexec
SQL
  pass "$mode fresh backup $(du -h "$dir/$source.dump" | cut -f1) written, checksummed, restored to a scratch database and row counts matched"

  # Clone (physical template copy inside the same CA PostgreSQL instance).
  local created=false
  for ((i = 0; i < 10; i++)); do
    if docker exec "$db" sh -c 'exec createdb -U "${POSTGRES_USER:-postgres}" -T "$1" "$2"' sh "$source" "$DEST" 2>"$dir/createdb.err"; then
      created=true; break
    fi
    grep -q 'being accessed by other users' "$dir/createdb.err" || break
    sleep 3
  done
  [[ "$created" == true ]] || { fail "$mode clone of $source failed"; return 1; }
  psql_db "$db" postgres -v "n=$DEST" -v "c=ca-cutover:$RUN_ID:incomplete" <<'SQL' >/dev/null
SELECT format('COMMENT ON DATABASE %I IS %L', :'n', :'c') \gexec
SQL
  copy_database_level "$db" "$source" "$DEST" || { fail "$mode database-level owner/ACL/settings copy"; return 1; }
  database_level "$db" "$source" > "$dir/dblevel-source.txt"
  database_level "$db" "$DEST" > "$dir/dblevel-dest.txt"
  if [[ ! -s "$dir/dblevel-source.txt" ]] || ! cmp -s "$dir/dblevel-source.txt" "$dir/dblevel-dest.txt"; then
    fail "$mode database owner/ACL/settings differ after copy"; return 1
  fi
  pass "$mode $DEST created; database owner, privileges and settings match $source"
  compare_databases "$db" "$source" "$DEST" "$dir" clone || { fail "$mode clone verification"; return 1; }
  pass "$mode clone verified: schema objects, ownership/ACLs, sequences and every table row count"

  # Repoint the app (and freeze interpolated values) with proof of no drift.
  local rw
  if ! rw="$(envtool rewrite "$mode" "$root" "$app" "$db" "$source" "$DEST")"; then
    fail "$mode .env rewrite refused (restored): $(json_field problems <<<"$rw")"; return 1
  fi
  pass "$mode .env repointed to $DEST; frozen \$ keys: $(json_field frozenKeys <<<"$rw"); deduplicated keys: $(json_field deduplicatedKeys <<<"$rw"); interpolation warnings now: $(json_field interpolationWarningsAfter <<<"$rw")"

  recreated=true
  recreate_app "$mode" "$root"
  verify_app "$app" "$DEST" 45 || { fail "$mode app did not verify on $DEST"; return 1; }
  auth_ok "$app" || { fail "$mode authentication gate failed on $DEST"; return 1; }
  pass "$mode authentication gate: synthetic login rejected with 401 on $DEST"
  [[ "$(docker inspect -f '{{.Image}}' "$app")" == "$image_before" ]] || { fail "$mode app image changed"; return 1; }
  envtool postcheck "$mode" "$root" "$app" "$db" "$dir/settings-fingerprint.json" after >/dev/null \
    || { fail "$mode app settings other than the database changed"; return 1; }
  psql_db "$db" postgres -v "n=$DEST" -v "c=ca-cutover:$RUN_ID:active from $source" <<'SQL' >/dev/null
SELECT format('COMMENT ON DATABASE %I IS %L', :'n', :'c') \gexec
SQL
  armed=false
  pass "$mode app runs on $DEST: runtime DB, Prisma AdminUser, HTTP health, login path, same image, every other setting unchanged"
  info "$mode legacy $source, its volume and $dir are preserved"
}

final_check() {
  local mode="$1" project app db source root volume
  env_params "$mode"
  if verify_app "$app" "$DEST" 5 && auth_ok "$app"; then pass "final: $mode on $DEST (runtime DB, AdminUser, health, login path)"; else info "final: $mode not verified on $DEST"; fi
}

# --------------------------------------------------------------------------
# Main.
# --------------------------------------------------------------------------
others_before="$(snapshot_others)"
docker inspect "$RTC_DB_CONTAINER" >/dev/null 2>&1 && info "RTC $RTC_DB_CONTAINER present; it is never addressed"

if [[ "$mode_arg" == --preflight ]]; then
  if [[ "$lock_busy" == true ]]; then
    info "another CA DB isolation run is active (lock holder PID ${holder:-unknown}); this preflight only reads"
  else
    info 'no other CA DB isolation run is active (lock free)'
  fi
  for m in staging production; do
    mkdir -m 700 "$backup_dir/$m"
    if identity_ok "$m"; then pass "$m identity"; else fail "$m identity"; continue; fi
    st="$(env_state "$m" "$backup_dir/$m/inspect.json")"
    if [[ "$st" == unknown ]]; then
      fail "$m configuration: $(json_field problems < "$backup_dir/$m/inspect.json")"
    else
      pass "$m state: $st; \$ keys: $(json_field dollarKeys < "$backup_dir/$m/inspect.json"); warnings: $(json_field interpolationWarnings < "$backup_dir/$m/inspect.json")"
    fi
    info "$m duplicate .env keys (names, definitions, verdict): $(json_field duplicateKeys < "$backup_dir/$m/inspect.json")"
    env_params "$m"
    if verify_app "$app" "$DEST" 3; then
      if auth_ok "$app"; then pass "$m runs verified on $DEST (synthetic login 401)"; else info "$m runs on $DEST but the synthetic login is not 401"; fi
    elif verify_app "$app" "$source" 3; then
      if auth_ok "$app"; then pass "$m runs verified on $source (synthetic login 401)"; else info "$m runs on $source but the synthetic login is not 401"; fi
    else
      info "$m app does not verify on $DEST or $source"
    fi
  done
  exit 0
fi

if [[ "$mode_arg" == --production-only ]]; then
  # Resume after a completed staging switch. Staging is verified, never changed.
  echo
  echo '=================== staging (verify only; not changed in this mode) ==================='
  mkdir -m 700 "$backup_dir/staging"
  identity_ok staging || { fail 'staging identity checks; production refused (nothing changed)'; exit 1; }
  st="$(env_state staging "$backup_dir/staging/inspect.json")"
  [[ "$st" == dest ]] || { fail "staging configuration does not durably target $DEST (state $st: $(json_field problems < "$backup_dir/staging/inspect.json")); production refused (nothing changed)"; exit 1; }
  verify_app admin-server-staging-app-1 "$DEST" 5 || { fail "staging app does not verify on $DEST; production refused (nothing changed)"; exit 1; }
  auth_ok admin-server-staging-app-1 || { fail 'staging synthetic login is not rejected with 401; production refused (nothing changed)'; exit 1; }
  pass "staging runs on $DEST: configuration, runtime DB, Prisma AdminUser, health and synthetic login 401"
  echo
  echo 'Confirm only after a REAL staging Admin login and dashboard check have succeeded.'
  confirm 'Type STAGING_LOGIN_OK to start production (anything else stops): ' STAGING_LOGIN_OK \
    || { info 'production not started (no STAGING_LOGIN_OK)'; exit 0; }
  echo 'Production will stop ONLY admin-server-app-1 briefly.'
  confirm 'Type CUTOVER_PRODUCTION to continue: ' CUTOVER_PRODUCTION \
    || { info 'production not started (no CUTOVER_PRODUCTION)'; exit 0; }
  # Called directly so `set -e` stays in force and any failure rolls back.
  cutover production
  final_check staging
  final_check production
  info 'Mail flags unchanged (OFF). Old databases, volumes and backups kept.'
  exit 0
fi

# Read-only production preview so a production blocker is known up front.
mkdir -m 700 "$backup_dir/production-preview"
if identity_ok production; then
  prod_preview_state="$(env_state production "$backup_dir/production-preview/inspect.json")"
  info "production preview: identity OK, state $prod_preview_state (read-only; production is changed only after STAGING_LOGIN_OK)"
  if [[ "$prod_preview_state" == unknown ]]; then
    info "production preview blockers (key names only): $(json_field problems < "$backup_dir/production-preview/inspect.json")"
  fi
  info "production preview duplicate .env keys: $(json_field duplicateKeys < "$backup_dir/production-preview/inspect.json")"
else
  info 'production preview: identity checks currently fail; production will be refused until fixed (staging can still proceed)'
fi

# Called directly (never in an && / || list) so `set -e` stays in force:
# any failing command stops the run and triggers the verified rollback.
cutover staging
if [[ "$mode_arg" == --staging-only ]]; then
  info 'production not started (--staging-only)'; final_check staging; exit 0
fi

echo
echo 'STAGING IS DONE. Log in to the real staging Admin site now and check it works.'
if ! confirm 'Type STAGING_LOGIN_OK to start production (anything else stops): ' STAGING_LOGIN_OK; then
  info 'production not started (no STAGING_LOGIN_OK)'; final_check staging; exit 0
fi
echo 'Production will stop ONLY admin-server-app-1 briefly.'
confirm 'Type CUTOVER_PRODUCTION to continue: ' CUTOVER_PRODUCTION || { info 'production not started (no confirmation)'; exit 0; }
cutover production
final_check staging
final_check production
info 'Mail flags unchanged (OFF). Old databases, volumes and backups kept.'
