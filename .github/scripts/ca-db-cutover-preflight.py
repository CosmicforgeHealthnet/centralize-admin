#!/usr/bin/env python3
"""Read-only staging preflight for ca-db-isolation-cutover.sh.

Runs ON THE VPS as the restricted staging deploy user, piped over the existing
staging SSH connection by .github/workflows/ca-db-cutover-preflight.yml.
It changes nothing: it only runs `docker inspect`, `docker compose config`,
read-only `psql` catalog queries and a read-only Prisma check inside the app.

It prints ONE JSON line of states, counts, booleans and names (container,
database and environment-variable NAMES). Secret values, URLs, hostnames and
record contents never leave the server. Production is NOT inspected: the
staging deploy credentials do not carry production authority.
"""
import json
import os
import re
import subprocess

ROOT = '/var/www/admin-server-staging'
APP, DB = 'admin-server-staging-app-1', 'admin-server-staging-db-1'
SOURCE, DEST = 'rtc_db_staging', 'cosmicforge_admin'
PROJECT, VOLUME = 'admin-server-staging', 'admin-server-staging_postgres_data_staging'
OVERRIDE = os.path.expanduser('~/docker-compose.github-staging.yml')
ENV = {'HOME': os.path.expanduser('~'), 'PATH': '/usr/local/bin:/usr/bin:/bin'}
LINE = re.compile(r'^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*?)(\r?\n?)$', re.S)
report = {'readOnly': True, 'problems': []}


def run(args, cwd=None, stdin=None):
    try:
        p = subprocess.run(args, cwd=cwd, env=ENV, capture_output=True, text=True, input=stdin, timeout=120)
        return p.returncode, p.stdout, p.stderr
    except (OSError, subprocess.TimeoutExpired):
        return 1, '', ''


def inspect(name, fmt):
    code, out, _ = run(['docker', 'inspect', '-f', fmt, name])
    return out.strip() if code == 0 else None


def psql(db, sql, *params):
    args = ['docker', 'exec', '-i', DB, 'sh', '-c',
            'db="$1"; shift; exec psql -X -qAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$db" "$@"', 'sh', db]
    for i, value in enumerate(params):
        args += ['-v', f'p{i}={value}']
    code, out, _ = run(args, stdin=sql)
    return out.strip() if code == 0 else None


def problem(text):
    report['problems'].append(text)


# Identity -------------------------------------------------------------------
identity = {}
for c in (APP, DB):
    identity[c] = {
        'exists': inspect(c, '{{.Id}}') is not None,
        'running': inspect(c, '{{.State.Running}}') == 'true',
        'projectOk': inspect(c, '{{index .Config.Labels "com.docker.compose.project"}}') == PROJECT,
    }
identity['dbVolumeOk'] = (inspect(DB, '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}') or '').split() == [VOLUME]
running_image = inspect(APP, '{{.Image}}')
tagged = inspect(APP, '{{.Config.Image}}')
code, out, _ = run(['docker', 'image', 'inspect', '-f', '{{.Id}}', tagged or 'missing'])
identity['imageTagMatchesRunning'] = code == 0 and out.strip() == running_image
identity['overrideFilePresent'] = os.path.isfile(OVERRIDE)
identity['rtcContainerPresent'] = inspect('cosmicforge-db', '{{.Id}}') is not None
report['identity'] = identity
if not all(v['exists'] and v['running'] and v['projectOk'] for k, v in identity.items() if isinstance(v, dict)):
    problem('staging container identity')
if not identity['dbVolumeOk']:
    problem('staging database volume is not exactly ' + VOLUME)
if not identity['imageTagMatchesRunning']:
    problem('app image tag no longer points at the running image')

code, out, _ = run(['docker', 'compose', 'version', '--short'])
report['composeVersion'] = out.strip() if code == 0 else None

# Compose resolution vs running settings (names only) -----------------------------
env_path = os.path.join(ROOT, '.env')
report['envReadable'] = os.access(env_path, os.R_OK)
if report['envReadable']:
    keys, dollar = {}, set()
    with open(env_path, encoding='utf-8') as f:
        for line in f:
            m = LINE.match(line)
            if not m:
                continue
            keys[m.group(2)] = keys.get(m.group(2), 0) + 1
            raw = m.group(4).strip()
            if not (len(raw) >= 2 and raw[0] == raw[-1] == "'") and re.search(r'\$', raw.replace('$$', '')):
                dollar.add(m.group(2))
    report['envKeys'] = len(keys)
    report['dollarKeys'] = sorted(dollar)
    report['databaseUrlLines'] = keys.get('DATABASE_URL', 0)
    report['duplicateKeys'] = sorted(k for k, n in keys.items() if n > 1)
    files = ['-f', 'docker-compose.yml', '-f', OVERRIDE]
    code, out, err = run(['docker', 'compose', *files, 'config', '--format', 'json'], cwd=ROOT)
    report['composeConfigOk'] = code == 0
    report['interpolationWarnings'] = sum(1 for l in err.splitlines() if 'variable is not set' in l)
    if code == 0:
        cfg = json.loads(out)
        def envof(svc):
            e = (cfg['services'].get(svc) or {}).get('environment') or {}
            return {k: (None if v is None else str(v).replace('$$', '$')) for k, v in e.items()}
        def container_env(name):
            raw = inspect(name, '{{json .Config.Env}}') or '[]'
            return dict(x.split('=', 1) for x in json.loads(raw) if '=' in x)
        c_app, r_app = envof('app'), container_env(APP)
        c_db, r_db = envof('db'), container_env(DB)
        report['appSettingsCompose'] = len(c_app)
        report['appKeysThatWouldChangeOnRecreate'] = sorted(k for k, v in c_app.items() if r_app.get(k) != v)
        report['dbKeysDifferingFromCompose'] = sorted(k for k, v in c_db.items() if r_db.get(k) != v)
        report['composeAppImageMatchesRunning'] = str((cfg['services'].get('app') or {}).get('image', '')).replace('$$', '$') == tagged
        def target(url):
            m = re.match(r'^[a-z]+://[^@/]*@?([^:/?]+)(?::\d+)?/([^?]*)', url or '')
            return (m.group(1), m.group(2)) if m else (None, None)
        rh, rdb = target(r_app.get('DATABASE_URL'))
        ch, cdb = target(c_app.get('DATABASE_URL'))
        report['runningDatabase'] = rdb if rh == 'db' else 'UNEXPECTED_HOST'
        report['composeDatabase'] = cdb if ch == 'db' else 'UNEXPECTED_HOST'
        # Keys containing `$` are rewritten with their running value by the
        # root script; any other difference means .env changed since deploy.
        hard = [k for k in report['appKeysThatWouldChangeOnRecreate'] if k not in dollar]
        report['dollarKeysRunningDiffers'] = sorted(set(report['appKeysThatWouldChangeOnRecreate']) & dollar)
        report['appCreatedByCompose'] = inspect(APP, '{{index .Config.Labels "com.docker.compose.version"}}')
        if hard:
            problem('recreating the app would change settings: ' + ','.join(hard))
        if not report['composeAppImageMatchesRunning']:
            problem('compose app image differs from the running image')
    else:
        problem('docker compose config failed as the deploy user')
else:
    problem('.env is not readable by the deploy user (root script will still read it)')

# Databases (catalog only) -----------------------------------------------------------
names = psql('postgres', "SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE NOT datistemplate;")
report['databases'] = names.split(',') if names else None
level = """
SELECT pg_get_userbyid(datdba) || '|' || coalesce((SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
       || ':' || a.privilege_type, ',' ORDER BY 1) FROM aclexplode(coalesce(datacl, acldefault('d', datdba))) a), '')
       || '|' || (SELECT count(*) FROM pg_db_role_setting s WHERE s.setdatabase = d.oid)
       || '|' || pg_database_size(datname)
       || '|' || (SELECT count(*) FROM pg_stat_activity WHERE datname = d.datname)
       || '|' || coalesce(shobj_description(d.oid, 'pg_database'), '')
  FROM pg_database d WHERE datname = :'p0';"""
dbinfo = {}
for name in [SOURCE, DEST]:
    row = psql('postgres', level, name)
    if row:
        owner, acl, settings, size, sessions, comment = row.split('|', 5)
        dbinfo[name] = {'ownerSameAsSource': None, 'aclEntries': len(acl.split(',')) if acl else 0, 'settings': int(settings),
                        'sizeMB': round(int(size) / 1048576, 1), 'sessions': int(sessions),
                        'createdByCutoverScript': comment.startswith('ca-cutover:'), '_owner': owner, '_acl': acl}
if SOURCE in dbinfo:
    src_owner, src_acl = dbinfo[SOURCE]['_owner'], dbinfo[SOURCE]['_acl']
    for name, info in dbinfo.items():
        info['ownerSameAsSource'] = info.pop('_owner') == src_owner
        info['aclSameAsSource'] = info.pop('_acl') == src_acl
else:
    problem('source database not found')
report['databaseInfo'] = dbinfo
if DEST in dbinfo:
    report['existingDestWillBe'] = 'renamed to cosmicforge_admin_previous_copy_<time> (preserved)' if dbinfo[DEST]['sessions'] == 0 else 'BLOCKED: has sessions'
    if dbinfo[DEST]['sessions']:
        problem('existing cosmicforge_admin has active sessions')
counts = psql(SOURCE, "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname='public') || '|' || (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'admin\\_%') || '|' || (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'marketing\\_%');")
if counts:
    t, a, m = counts.split('|')
    report['sourceTables'] = {'public': int(t), 'admin': int(a), 'marketing': int(m)}
users = psql(SOURCE, "SELECT count(*) FROM public.admin_users;")
report['sourceAdminUsers'] = int(users) if users and users.isdigit() else None

# Disk ---------------------------------------------------------------------------------
def free_mb(path):
    code, out, _ = run(['df', '-Pk', path])
    try:
        return int(out.splitlines()[1].split()[3]) // 1024
    except (IndexError, ValueError):
        return None
report['freeMB'] = {'root': free_mb('/'), 'varBackups': free_mb('/var/backups') if os.path.isdir('/var/backups') else None}
dockerroot = run(['docker', 'info', '-f', '{{.DockerRootDir}}'])[1].strip()
report['freeMB']['dockerRoot'] = free_mb(dockerroot) if dockerroot else None

# App on its current database (read-only Prisma query + HTTP health) ---------------------
check = r"""
const { prisma } = require('./src/shared/config/database');
(async () => {
  const rows = await prisma.$queryRawUnsafe('SELECT current_database() AS name');
  await prisma.adminUser.count();
  const r = await fetch('http://127.0.0.1:' + Number(process.env.PORT || 4000) + '/health', { signal: AbortSignal.timeout(4000) });
  process.stdout.write(JSON.stringify({ connected: rows[0]?.name, health: r.ok }));
})().catch(() => process.stdout.write('{"connected":null,"health":false}')).finally(() => prisma.$disconnect());
"""
code, out, _ = run(['docker', 'exec', '-i', '-w', '/app', APP, 'node', '-'], stdin=check)
try:
    app_check = json.loads(out.strip().splitlines()[-1])
except (ValueError, IndexError):
    app_check = {'connected': None, 'health': False}
report['appConnectedDatabase'] = app_check.get('connected')
report['appPrismaAndHealthOk'] = bool(app_check.get('connected')) and bool(app_check.get('health'))

report['state'] = ('already_on_cosmicforge_admin' if report.get('appConnectedDatabase') == DEST else
                   'on_legacy_source' if report.get('appConnectedDatabase') == SOURCE else 'unknown')
report['readyForRootCutover'] = not report['problems'] and report['appPrismaAndHealthOk']
print('CA_DB_CUTOVER_PREFLIGHT ' + json.dumps(report, sort_keys=True))
