#!/usr/bin/env python3
"""Read-only live state of the CA database isolation, for issue #28.

Runs ON THE VPS as the restricted staging deploy user (piped over the existing
staging SSH connection by .github/workflows/ca-db-live-state.yml). It changes
nothing: /proc and stat reads, `docker inspect`, catalog-only `psql`, and a
read-only Prisma + HTTP check inside the STAGING app.

Production is only observed with `docker inspect` (running state, start time,
database NAME from the runtime environment) and catalog-only database names and
session counts. No `docker exec` into the production app, nothing restarted.

Prints ONE JSON line: states, counts, booleans and names. No secret, URL,
hostname, password or record content leaves the server.
"""
import json
import os
import re
import subprocess

ENV = {'HOME': os.path.expanduser('~'), 'PATH': '/usr/local/bin:/usr/bin:/bin'}
LOCK = '/run/lock/centralize-admin-db-isolation.lock'
OLD_PIDS = (2330363, 2330398)
ENVS = {
    'staging': {'app': 'admin-server-staging-app-1', 'db': 'admin-server-staging-db-1',
                'legacy': 'rtc_db_staging'},
    'production': {'app': 'admin-server-app-1', 'db': 'admin-server-db-1', 'legacy': 'rtc_db'},
}
DEST = 'cosmicforge_admin'
SOCIAL = ('LINKEDIN_SOCIAL_ENABLED', 'META_SOCIAL_ENABLED', 'TIKTOK_SOCIAL_ENABLED', 'X_SOCIAL_ENABLED')
report = {'readOnly': True}


def run(args, stdin=None, timeout=120):
    try:
        p = subprocess.run(args, env=ENV, capture_output=True, text=True, input=stdin, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except (OSError, subprocess.TimeoutExpired):
        return 1, '', ''


def inspect(name, fmt):
    code, out, _ = run(['docker', 'inspect', '-f', fmt, name])
    return out.strip() if code == 0 else None


# Identity and authority of the SSH account (names only) ---------------------
code, out, _ = run(['id', '-un'])
report['account'] = out.strip()
code, out, _ = run(['id', '-Gn'])
report['groups'] = sorted(out.split())
report['uidIsRoot'] = os.getuid() == 0
code, _, _ = run(['sudo', '-n', 'true'], timeout=15)
report['passwordlessSudo'] = code == 0
report['canReadStagingEnv'] = os.access('/var/www/admin-server-staging/.env', os.R_OK)
report['canReadProductionEnv'] = os.access('/var/www/admin-server/.env', os.R_OK)
report['canListBackupDir'] = os.access('/var/backups/centralize-admin', os.R_OK | os.X_OK)


# The interrupted root migration process and its lock -------------------------
def proc_info(pid):
    base = f'/proc/{pid}'
    if not os.path.isdir(base):
        return {'alive': False}
    info = {'alive': True}
    try:
        with open(base + '/cmdline', 'rb') as f:
            info['cmdline'] = [a.decode(errors='replace') for a in f.read().split(b'\0') if a]
    except OSError:
        info['cmdline'] = None
    try:
        with open(base + '/stat') as f:
            fields = f.read().rsplit(')', 1)[1].split()
        info['state'], info['ppid'], info['ttyNr'] = fields[0], int(fields[1]), int(fields[4])
    except (OSError, IndexError, ValueError):
        pass
    code, out, _ = run(['ps', '-o', 'etimes=', '-p', str(pid)])
    info['elapsedSeconds'] = int(out.strip()) if code == 0 and out.strip().isdigit() else None
    return info


report['oldProcesses'] = {str(p): proc_info(p) for p in OLD_PIDS}
others = []
for entry in os.listdir('/proc'):
    if not entry.isdigit():
        continue
    try:
        with open(f'/proc/{entry}/cmdline', 'rb') as f:
            cmd = f.read().replace(b'\0', b' ').decode(errors='replace')
    except OSError:
        continue
    if 'ca-db-isolation' in cmd and 'ca-db-live-state' not in cmd:
        others.append({'pid': int(entry), 'cmd': cmd.strip()[:160]})
report['isolationProcesses'] = others

lock = {'exists': os.path.exists(LOCK)}
if lock['exists']:
    st = os.stat(LOCK)
    lock['inode'] = st.st_ino
    lock['mtime'] = int(st.st_mtime)
    holders = []
    try:
        with open('/proc/locks') as f:
            for line in f:
                parts = line.split()
                # e.g. "1: FLOCK  ADVISORY  WRITE 2330363 00:19:1234 0 EOF"
                if len(parts) >= 6 and parts[1] == 'FLOCK' and parts[5].rsplit(':', 1)[-1] == str(st.st_ino):
                    holders.append(int(parts[4]) if parts[4].isdigit() else parts[4])
    except OSError:
        holders = None
    lock['heldByPids'] = holders
    lock['held'] = bool(holders)
report['lock'] = lock


# Applications and databases --------------------------------------------------
def db_name_of(container):
    raw = inspect(container, '{{json .Config.Env}}') or '[]'
    env = dict(x.split('=', 1) for x in json.loads(raw) if '=' in x)
    m = re.match(r'^[a-z]+://[^@/]*@?([^:/?]+)(?::\d+)?/([^?]*)', env.get('DATABASE_URL') or '')
    db = (m.group(2) if m.group(1) == 'db' else 'UNEXPECTED_HOST') if m else None

    def flag(k):
        v = env.get(k)
        if v is None:
            return 'unset'
        n = v.strip().lower()
        return n if n in ('true', 'false', '') else 'other'
    social = {k: flag(k) for k in SOCIAL}
    mail = {k: flag(k) for k in sorted(env) if k.startswith('MAIL_') and k.endswith('_ENABLED')}
    return db, social, mail


def psql(container, db, sql):
    args = ['docker', 'exec', '-i', container, 'sh', '-c',
            'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$1"', 'sh', db]
    code, out, _ = run(args, stdin=sql)
    return out.strip() if code == 0 else None


for name, e in ENVS.items():
    r = {}
    for role in ('app', 'db'):
        c = e[role]
        r[role] = {
            'exists': inspect(c, '{{.Id}}') is not None,
            'running': inspect(c, '{{.State.Running}}') == 'true',
            'status': inspect(c, '{{.State.Status}}'),
            'startedAt': inspect(c, '{{.State.StartedAt}}'),
            'restartCount': inspect(c, '{{.RestartCount}}'),
            'health': inspect(c, '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'),
        }
    r['runtimeDatabase'], r['socialFlags'], r['mailFlags'] = db_name_of(e['app'])
    rows = psql(e['db'], 'postgres', """
SELECT d.datname || '|' || (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname)
       || '|' || coalesce(shobj_description(d.oid, 'pg_database'), '')
  FROM pg_database d WHERE NOT d.datistemplate AND d.datname <> 'postgres' ORDER BY 1;""")
    dbs = {}
    for line in (rows or '').splitlines():
        dn, sessions, comment = line.split('|', 2)
        dbs[dn] = {'sessions': int(sessions),
                   'cutoverMarker': (comment.split(':', 2)[2] if comment.startswith('ca-cutover:') else None)}
    r['databases'] = dbs if rows is not None else None
    for dn in (e['legacy'], DEST):
        if dn in dbs:
            n = psql(e['db'], dn, 'SELECT count(*) FROM public.admin_users;')
            dbs[dn]['adminUsers'] = int(n) if n and n.isdigit() else None
    report[name] = r

# Staging app: read-only Prisma query, HTTP health, synthetic failed login ----
check = r"""
const { prisma } = require('./src/shared/config/database');
(async () => {
  const out = {};
  const rows = await prisma.$queryRawUnsafe('SELECT current_database() AS name');
  out.connected = rows[0]?.name;
  out.adminUsers = await prisma.adminUser.count();
  const port = Number(process.env.PORT || 4000);
  const h = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(4000) });
  out.health = h.status;
  // A synthetic account that cannot exist (reserved .invalid TLD): proves the
  // login route reaches the database and rejects; no real user is touched.
  const l = await fetch('http://127.0.0.1:' + port + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ca-db-synthetic-probe@example.invalid', password: 'not-a-real-password' }),
    signal: AbortSignal.timeout(8000) });
  out.syntheticLoginStatus = l.status;
  process.stdout.write(JSON.stringify(out));
})().catch(e => process.stdout.write(JSON.stringify({ error: e.code || e.name }))).finally(() => prisma.$disconnect());
"""
code, out, _ = run(['docker', 'exec', '-i', '-w', '/app', ENVS['staging']['app'], 'node', '-'], stdin=check)
try:
    report['stagingAppCheck'] = json.loads(out.strip().splitlines()[-1])
except (ValueError, IndexError):
    report['stagingAppCheck'] = {'error': 'no output'}

print('CA_DB_LIVE_STATE ' + json.dumps(report, sort_keys=True))
