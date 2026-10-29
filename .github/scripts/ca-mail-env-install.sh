#!/usr/bin/env bash
# Install Centralize Admin Mail settings (Resend, AWS S3/KMS, Mail policy) into
# the staging or production .env WITHOUT printing any value. Root, Contabo VPS,
# via .github/workflows/ca-mail-env-install.yml.
#
#   --preview <staging|production> <values-file> [flags]   read-only plan (names)
#   --apply   <staging|production> <values-file> [flags]   install + verify
#
# values-file: KEY=value lines from a GitHub secret (0600; deleted after reading).
#   Allowed keys: MAIL_* and RESEND_* only, never *_ENABLED (switches go in
#   `flags`), never DATABASE_URL or anything else. Values must be one line
#   without single quotes; they are written single-quoted (literal for Compose).
# flags: optional comma list of MAIL_*_ENABLED=true|false (visible, audited).
#
# apply: root-only backup of .env -> atomic rewrite (owner/mode kept) -> Compose
# check -> recreate ONLY the app (same image) -> runtime DB, Prisma, health,
# synthetic login 401 -> every OTHER setting byte-identical -> the app's own Mail
# config validator (names only) -> Mail worker recreated on the same image.
# Rolls back (.env restored, app recreated, verified) on any failure, and when
# Mail would be enabled while the validator reports violations.
set -Eeuo pipefail
umask 077
export LC_ALL=C
readonly SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly RUN_ID

mode="${1:-}" target="${2:-}" values="${3:-}" flags="${4:-}"
case "$mode" in --preview|--apply) ;; *) echo 'Usage: ca-mail-env-install.sh --preview|--apply staging|production <values-file> [flags]' >&2; exit 2 ;; esac
[[ -f "$values" ]] || { echo 'values file missing' >&2; exit 2; }
[[ "$(id -u)" -eq 0 ]] || { echo 'Run as root.' >&2; exit 2; }
case "$target" in
  staging)
    ROOT=/var/www/admin-server-staging; APP=admin-server-staging-app-1; PROJECT=admin-server-staging
    COMPOSE_EXTRA=(-f /home/cf-staging-deploy/docker-compose.github-staging.yml)
    WORKER_ROOT=/var/www/admin-server-staging-mail; WORKER=admin-server-staging-mail-mail-worker ;;
  production)
    ROOT=/var/www/admin-server; APP=admin-server-app-1; PROJECT=admin-server
    COMPOSE_EXTRA=(); [[ -f /var/www/admin-server/docker-compose.release.yml ]] && COMPOSE_EXTRA=(-f /var/www/admin-server/docker-compose.release.yml)
    WORKER_ROOT=/var/www/admin-server-mail; WORKER=admin-server-mail-mail-worker ;;
  *) echo 'target must be staging or production' >&2; exit 2 ;;
esac

# Read the values into a private in-memory copy and delete the file at once.
work="$(mktemp -d /run/ca-mail-env-XXXXXX)"; chmod 700 "$work"
cp "$values" "$work/values"; rm -f "$values"

mkdir -p /run/lock
exec 7>"/run/lock/centralize-admin-mail-env-$target.lock"
flock -n 7 || { echo 'Another Mail settings install for this target is running. Nothing changed.' >&2; rm -rf "$work"; exit 1; }
exec 9>/run/lock/centralize-admin-db-isolation.lock
flock -n 9 || { echo 'The CA database isolation cutover is running. Nothing changed.' >&2; rm -rf "$work"; exit 1; }

run_dir="/var/backups/centralize-admin/mail-env-$target-$RUN_ID"
mkdir -p /var/backups/centralize-admin; chmod 700 /var/backups/centralize-admin; mkdir -m 700 "$run_dir"
exec > >(tee -a "$run_dir/run.log") 2>&1
echo "CA Mail settings $mode for $target, run $RUN_ID"

declare -a SUMMARY=()
pass() { SUMMARY+=("PASS  $*"); echo "PASS: $*"; }
fail() { SUMMARY+=("FAIL  $*"); echo "FAIL: $*" >&2; }
info() { SUMMARY+=("INFO  $*"); echo "INFO: $*"; }

armed=false
on_exit() {
  local code=$?
  trap - EXIT
  if [[ "$armed" == true ]]; then rollback || true; code=1; fi
  rm -rf "$work"
  echo; echo '==================== SUMMARY ===================='
  local l; for l in "${SUMMARY[@]}"; do echo "$l"; done
  echo "Run directory (root-only): $run_dir"
  echo '================================================='
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

compose() { (cd "$ROOT" && env -i HOME=/root PATH="$SAFE_PATH" docker compose -f docker-compose.yml "${COMPOSE_EXTRA[@]}" "$@"); }
recreate_app() { compose up -d --no-deps --no-build --pull never --force-recreate app; }

verify_app() {
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

# All value handling happens in python, in memory; only names/booleans printed.
envtool() {
  env -i PATH="$SAFE_PATH" WORK="$work" ROOT="$ROOT" APP="$APP" TARGET="$target" FLAGS="$flags" python3 - "$@" <<'PY'
import hashlib, json, os, re, secrets, subprocess, sys, tempfile
cmd = sys.argv[1]
work, root, app, target = os.environ['WORK'], os.environ['ROOT'], os.environ['APP'], os.environ['TARGET']
LINE = re.compile(r'^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*?)(\r?\n?)$', re.S)
KEY = re.compile(r'^(MAIL|RESEND)_[A-Z0-9_]+$')

def out(o, code=0):
    print(json.dumps(o, sort_keys=True)); sys.exit(code)

def wanted():
    vals, problems = {}, []
    for n, raw in enumerate(open(os.path.join(work, 'values'), encoding='utf-8').read().splitlines(), 1):
        if not raw.strip() or raw.lstrip().startswith('#'):
            continue
        k, sep, v = raw.partition('=')
        k = k.strip()
        if not sep or not KEY.fullmatch(k):
            problems.append(f'line {n}: key not allowed (only MAIL_* / RESEND_*)'); continue
        if k.endswith('_ENABLED'):
            problems.append(f'{k}: switches are set with the visible `flags` input, not the secret'); continue
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
            v = v[1:-1]
        if "'" in v or '\0' in v or '\r' in v or '\n' in v:
            problems.append(f'{k}: value contains a quote or control character'); continue
        if k in vals:
            problems.append(f'{k}: given twice'); continue
        vals[k] = v
    for item in filter(None, (x.strip() for x in os.environ.get('FLAGS', '').split(','))):
        k, sep, v = item.partition('=')
        k, v = k.strip(), v.strip().lower()
        if not (KEY.fullmatch(k) and k.startswith('MAIL_') and k.endswith('_ENABLED')) or v not in ('true', 'false'):
            problems.append(f'flag {k or item}: must be MAIL_*_ENABLED=true|false'); continue
        vals[k] = v
    if vals.get('MAIL_DEPLOYMENT_ENV', target) != target:
        problems.append(f'MAIL_DEPLOYMENT_ENV must be {target} for this target')
    if not vals:
        problems.append('nothing to install')
    return vals, problems

def running_env():
    so = subprocess.run(['docker', 'inspect', '-f', '{{json .Config.Env}}', app], capture_output=True, text=True, check=True).stdout
    return dict(x.split('=', 1) for x in json.loads(so) if '=' in x)

def env_lines():
    return open(os.path.join(root, '.env'), encoding='utf-8').read().splitlines(keepends=True)

def plan():
    vals, problems = wanted()
    counts = {}
    for line in env_lines():
        m = LINE.match(line)
        if m: counts[m.group(2)] = counts.get(m.group(2), 0) + 1
    for k in vals:
        if counts.get(k, 0) > 1: problems.append(f'{k}: defined more than once in .env; resolve first')
    run = running_env()
    status = {k: ('unchanged' if run.get(k) == v else 'changed' if k in run else 'added') for k, v in vals.items()}
    return vals, problems, status

if cmd == 'plan':
    vals, problems, status = plan()
    out({'ok': not problems, 'problems': problems, 'keys': status}, 0 if not problems else 1)

if cmd == 'snapshot':  # salted fingerprints of every running setting
    salt = secrets.token_hex(16)
    run = running_env()
    json.dump({'salt': salt, 'env': {k: hashlib.sha256((salt + k + '\0' + v).encode()).hexdigest() for k, v in run.items()}},
              open(os.path.join(work, 'snapshot.json'), 'w'))
    out({'ok': True})

if cmd == 'write':
    vals, problems, _ = plan()
    if problems: out({'ok': False, 'problems': problems}, 1)
    path = os.path.join(root, '.env'); st = os.stat(path)
    lines, seen = env_lines(), set()
    new = []
    for line in lines:
        m = LINE.match(line)
        if m and m.group(2) in vals:
            k = m.group(2); seen.add(k)
            new.append(f"{m.group(1)}{k}{m.group(3)}'{vals[k]}'{m.group(5) or chr(10)}")
        else:
            new.append(line)
    rest = [k for k in vals if k not in seen]
    if rest:
        if new and not new[-1].endswith('\n'): new[-1] += '\n'
        new.append('# Mail settings installed by .github/scripts/ca-mail-env-install.sh\n')
        new += [f"{k}='{vals[k]}'\n" for k in rest]
    fd, tmp = tempfile.mkstemp(prefix='.ca-env-', dir=root)
    with os.fdopen(fd, 'w', encoding='utf-8') as f: f.writelines(new)
    os.chown(tmp, st.st_uid, st.st_gid); os.chmod(tmp, st.st_mode & 0o7777); os.replace(tmp, path)
    out({'ok': True, 'written': sorted(vals)})

if cmd == 'postcheck':  # installed keys equal intended; everything else unchanged
    vals, _ = wanted()
    snap = json.load(open(os.path.join(work, 'snapshot.json')))
    salt, before = snap['salt'], snap['env']
    run = running_env()
    now = {k: hashlib.sha256((salt + k + '\0' + v).encode()).hexdigest() for k, v in run.items()}
    wrong = sorted(k for k, v in vals.items() if run.get(k) != v)
    drift = sorted(k for k in set(before) | set(now) if k not in vals and before.get(k) != now.get(k))
    out({'ok': not wrong and not drift, 'notApplied': wrong, 'otherSettingsChanged': drift}, 0 if not wrong and not drift else 1)
PY
}

json_get() { python3 -c 'import json,sys; d=json.load(sys.stdin); v=d.get(sys.argv[1]); print(json.dumps(v) if not isinstance(v,str) else v)' "$1"; }

identity() {
  [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$APP" 2>/dev/null)" == "$PROJECT" ]] \
    && [[ "$(docker inspect -f '{{.State.Running}}' "$APP")" == true && -f "$ROOT/.env" && -f "$ROOT/docker-compose.yml" ]]
}

validator() { # the app's own Mail config check, names and booleans only
  docker exec -w /app "$APP" node scripts/mail/validate-infrastructure.js 2>/dev/null | tail -1 || true
}

sync_worker() {
  docker inspect "$WORKER" >/dev/null 2>&1 || { info "no $target Mail worker deployed; nothing to sync"; return 0; }
  local -a files=(-f docker-compose.yml)
  [[ -f "$WORKER_ROOT/docker-compose.release.yml" ]] && files+=(-f docker-compose.release.yml)
  (cd "$WORKER_ROOT" && env -i HOME=/root PATH="$SAFE_PATH" docker compose "${files[@]}" up -d --no-deps --no-build --pull never --force-recreate mail-worker) >/dev/null
  sleep 8
  local st code; st="$(docker inspect -f '{{.State.Status}}' "$WORKER")"; code="$(docker inspect -f '{{.State.ExitCode}}' "$WORKER")"
  [[ "$st" == running || ( "$st" == exited && "$code" == 0 ) ]] && pass "Mail worker recreated with the new settings ($st)" \
    || { fail "Mail worker: status $st exit $code"; return 1; }
}

rollback() {
  armed=false
  echo 'ROLLBACK: restoring the previous .env and app.' >&2
  cp -p "$run_dir/original.env" "$ROOT/.env"
  if recreate_app >&2 && verify_app 45; then
    fail "settings rolled back; app verified on the previous settings"
    sync_worker || true
  else
    fail "ROLLBACK DID NOT VERIFY. Original .env: $run_dir/original.env"
  fi
}

identity || { fail "$target identity ($APP in $PROJECT)"; exit 1; }
pass "$target identity ($APP, $PROJECT)"
plan_json="$(envtool plan)" || { fail "settings refused: $(json_get problems <<<"$plan_json")"; exit 1; }
info "keys (names only): $(json_get keys <<<"$plan_json")"
if [[ "$mode" == --preview ]]; then
  info "current Mail validator: $(validator)"
  pass 'preview only; nothing changed'
  exit 0
fi

verify_app 5 || { fail "$target app does not verify before the change"; exit 1; }
image_before="$(docker inspect -f '{{.Image}}' "$APP")"
envtool snapshot >/dev/null
cp -p "$ROOT/.env" "$run_dir/original.env"
armed=true
envtool write >/dev/null || { fail 'could not write .env'; exit 1; }
compose config -q || { fail 'Compose cannot resolve the new configuration'; exit 1; }
recreate_app
[[ "$(docker inspect -f '{{.Image}}' "$APP")" == "$image_before" ]] || { fail 'app image changed'; exit 1; }
verify_app 60 || { fail 'app did not verify with the new settings'; exit 1; }
pass 'app recreated (same image) and verified: runtime DB, Prisma, health, synthetic login 401'
post="$(envtool postcheck)" || { fail "settings check: $post"; exit 1; }
pass 'installed settings are exactly the intended values; every other setting unchanged'
v="$(validator)"
info "Mail validator after install: $v"
if python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d.get("mailEnabled") and d.get("violations") else 1)' "$v" 2>/dev/null; then
  fail 'Mail would be enabled while the validator reports violations'; exit 1
fi
armed=false
sync_worker
pass "$target Mail settings installed"
