#!/usr/bin/env bash
# Disposable replica for the release tooling, run UNMODIFIED:
#   .github/scripts/ca-production-deploy.sh  (guarded deploy, rollback, worker sync)
#   .github/scripts/ca-mail-env-install.sh   (Mail settings install, rollback)
#   .github/scripts/ca-host-ops.sh           (production env permissions)
#   .github/scripts/ca-mail-staging-ops.sh   (--storage-setup / --storage-check:
#                                             self-hosted Mail storage + keys)
#   .github/scripts/ca-mail-backup.sh        (local restic repository: backup,
#                                             restore drill, detected failures)
# The replica app image carries the REAL Mail storage/key code and scripts.
# Registry login/pull is stubbed by a PATH shim (images exist locally); the
# public URL check is pointed at the replica through the replica-only seam.
# NEVER run on the VPS (refuses unless CA_REPLICA_TEST=1 on a host without
# non-replica admin-server containers or directories).
#
#   sudo CA_REPLICA_TEST=1 bash ca-release-ops-replica.sh run
set -Eeuo pipefail
export LC_ALL=C
here="$(cd "$(dirname "$0")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
work=/var/tmp/ca-release-ops-replica

[[ "${CA_REPLICA_TEST:-}" == 1 && "$(id -u)" -eq 0 ]] || { echo 'Set CA_REPLICA_TEST=1 and run as root in a disposable machine.' >&2; exit 2; }
for d in /var/www/admin-server /var/www/admin-server-staging /etc/cosmicforge-mail /var/lib/cosmicforge-mail-backup; do
  [[ ! -e "$d" || -e "$d/.ca-replica" ]] || { echo "Refusing: $d is not a replica." >&2; exit 2; }
done
for c in $(docker ps -a --format '{{.Names}}' | grep -E '^admin-server' || true); do
  [[ "$(docker inspect -f '{{index .Config.Labels "ca.replica"}}' "$c")" == 1 ]] || { echo "Refusing: $c is not a replica container." >&2; exit 2; }
done

failures=0
check() { local n="$1"; shift; if "$@"; then echo "ok   - $n"; else echo "FAIL - $n"; failures=$((failures + 1)); fi; }
log() { printf '\n### %s\n' "$*"; }
SAFE=(env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin)
pcompose() { (cd /var/www/admin-server && "${SAFE[@]}" docker compose "$@"); }
scompose() { (cd /var/www/admin-server-staging && "${SAFE[@]}" docker compose -f docker-compose.yml -f /home/cf-staging-deploy/docker-compose.github-staging.yml "$@"); }
started() { docker inspect -f '{{.State.StartedAt}}' "$1"; }
image_of() { docker inspect -f '{{.Config.Image}}' "$1"; }
envval() { docker exec "$1" printenv "$2"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }

teardown() {
  local c
  for c in admin-server-app-1 admin-server-db-1 admin-server-staging-app-1 admin-server-staging-db-1 admin-server-mail-mail-worker ca-replica-envmount; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  for c in $(docker ps -aq --filter label=ca.component=mail-restore-drill); do docker rm -f "$c" >/dev/null 2>&1 || true; done
  for n in $(docker network ls -q --filter name=ca-mail-drill-); do docker network rm "$n" >/dev/null 2>&1 || true; done
  docker network rm admin-server_default admin-server-staging_default >/dev/null 2>&1 || true
  docker volume rm -f admin-server_postgres_data admin-server-staging_postgres_data_staging admin-server-staging-mail-store admin-server-mail-store >/dev/null 2>&1 || true
  rm -rf /var/www/admin-server /var/www/admin-server-staging /var/www/admin-server-mail /home/cf-staging-deploy "$work" /var/backups/centralize-admin \
    /etc/cosmicforge-mail /var/lib/cosmicforge-mail-backup /usr/local/lib/cosmicforge-mail-backup
  rm -f /run/lock/centralize-admin-production-deploy.lock /run/lock/centralize-admin-mail-env-*.lock /run/lock/centralize-admin-mail-*.lock /run/lock/cosmicforge-mail-backup-*.lock
  id cf-staging-deploy >/dev/null 2>&1 && userdel cf-staging-deploy >/dev/null 2>&1 || true
}

build_images() {
  mkdir -p "$work/app/src/shared/config" "$work/app/scripts/mail"
  cat > "$work/app/Dockerfile" <<'EOF'
FROM node:22-alpine
WORKDIR /app
COPY node_modules ./node_modules
COPY src ./src
COPY scripts ./scripts
COPY server.js ./
ARG VARIANT=good
ENV REPLICA_VARIANT=$VARIANT
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
console.log('[MailWorker] MAIL_ENABLED and MAIL_WORKER_ENABLED must both be true; exiting without processing.');
EOF
  cat > "$work/app/scripts/mail/validate-infrastructure.js" <<'EOF'
const on = (v) => String(v || '').toLowerCase() === 'true';
const violations = on(process.env.MAIL_ENABLED) && !process.env.RESEND_API_KEY ? ['RESEND_API_KEY missing'] : [];
process.stdout.write(JSON.stringify({ mailEnabled: on(process.env.MAIL_ENABLED), providerKeyPresent: Boolean(process.env.RESEND_API_KEY), violations }) + '\n');
process.exit(violations.length ? 1 : 0);
EOF
  cat > "$work/app/server.js" <<'EOF'
const http = require('http');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const bad = process.env.REPLICA_VARIANT === 'bad' || process.env.RESEND_API_KEY === 'break-the-app';
const origin = 'https://centralize-admin.vercel.app';
http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(req.headers.origin === origin ? 204 : 500, req.headers.origin === origin ? { 'access-control-allow-origin': origin } : {}); return res.end(); }
    if (req.url === '/health') { if (bad) { res.writeHead(500); return res.end(); } await pool.query('SELECT 1'); res.writeHead(200); return res.end('{}'); }
    if (req.url === '/api/auth/login' && req.method === 'POST') {
      let b = ''; for await (const c of req) b += c;
      const r = await pool.query('SELECT 1 FROM admin_users WHERE email = $1', [JSON.parse(b || '{}').email]);
      res.writeHead(r.rowCount ? 403 : 401); return res.end('{}');
    }
    res.writeHead(404); res.end();
  } catch { res.writeHead(500); res.end(); }
}).listen(4000);
EOF
  # The REAL Mail storage/key code and scripts (storage-setup, storage-check,
  # keyring CLI, restore verifier run inside this image).
  local api; api="$(cd "$scripts/../.." && pwd)/services/central-admin-api"
  mkdir -p "$work/app/src/modules" "$work/app/src/shared" "$work/app/src/generated"
  cp -r "$api/src/modules/mail" "$work/app/src/modules/"
  cp -r "$api/src/shared/auth" "$api/src/shared/utils" "$work/app/src/shared/"
  cp -r "$api/src/generated/admin-client" "$work/app/src/generated/"
  cp "$api/scripts/mail/keyring.js" "$api/scripts/mail/verify-restored-content.js" "$work/app/scripts/mail/"
  (cd "$work/app" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund pg@8.13.1 xss@1.0.15 @prisma/client-runtime-utils@7.10.1 >/dev/null)
  docker build -q -t ghcr.io/cosmicforgehealthnet/admin-backend:production-1111111111111111111111111111111111111111 "$work/app" >/dev/null
  docker build -q --build-arg VARIANT=bad -t ghcr.io/cosmicforgehealthnet/admin-backend:production-2222222222222222222222222222222222222222 "$work/app" >/dev/null
  docker build -q -t ca-release-replica:base "$work/app" >/dev/null
}

write_stack() { # dir project port volume
  local vol="${4:-pg}"
  mkdir -p "$1"; touch "$1/.ca-replica"
  cat > "$1/docker-compose.yml" <<EOF
services:
  app:
    image: ca-release-replica:base
    env_file: .env
    ports: ["127.0.0.1:$3:4000"]
    labels: { ca.replica: "1" }
    depends_on: [db]
  db:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: caadmin, POSTGRES_PASSWORD: Sup3r, POSTGRES_DB: cosmicforge_admin }
    volumes: [$vol:/var/lib/postgresql/data]
    labels: { ca.replica: "1" }
volumes:
  $vol:
EOF
  cat > "$1/.env" <<'EOF'
DATABASE_URL=postgresql://caadmin:Sup3r@db:5432/cosmicforge_admin
JWT_SECRET=Xy7-keep-me
MAIL_PROVIDER=fake
EOF
  chmod 640 "$1/.env"
}

seed() { # container
  for _ in $(seq 1 60); do docker exec "$1" pg_isready -h 127.0.0.1 -U caadmin -d cosmicforge_admin >/dev/null 2>&1 && break; sleep 1; done
  sleep 2
  docker exec -i "$1" psql -qAt -U caadmin -d cosmicforge_admin -c "CREATE TABLE IF NOT EXISTS admin_users(email text); INSERT INTO admin_users VALUES ('a@replica.example');" >/dev/null
}

make_shim() {
  local real; real="$(command -v docker)"
  mkdir -p "$work/shim"
  cat > "$work/shim/docker" <<EOF
#!/usr/bin/env bash
case "\$1" in
  login|logout) cat >/dev/null 2>&1; exit 0 ;;
  pull) img="\${@: -1}"; exec $real image inspect "\$img" >/dev/null ;;
esac
exec $real "\$@"
EOF
  chmod 755 "$work/shim/docker"
}

setup() {
  teardown
  build_images
  make_shim
  write_stack /var/www/admin-server admin-server 14000 postgres_data
  mkdir -p /etc/cosmicforge-mail /var/lib/cosmicforge-mail-backup
  touch /etc/cosmicforge-mail/.ca-replica /var/lib/cosmicforge-mail-backup/.ca-replica
  pcompose -p admin-server up -d >/dev/null 2>&1
  seed admin-server-db-1
  write_stack /var/www/admin-server-staging admin-server-staging 14001 postgres_data_staging
  mkdir -p /home/cf-staging-deploy
  printf 'services:\n  app:\n    image: ca-release-replica:base\n    pull_policy: never\n' > /home/cf-staging-deploy/docker-compose.github-staging.yml
  scompose -p admin-server-staging up -d >/dev/null 2>&1
  seed admin-server-staging-db-1
  # Production Mail worker (project admin-server-mail), same image as the app.
  mkdir -p /var/www/admin-server-mail
  cat > /var/www/admin-server-mail/docker-compose.yml <<'EOF'
name: admin-server-mail
services:
  mail-worker:
    image: ca-release-replica:base
    container_name: admin-server-mail-mail-worker
    command: ["node", "src/mail-worker.js"]
    restart: "on-failure:5"
    env_file: [/var/www/admin-server/.env]
    labels: { ca.replica: "1" }
EOF
  (cd /var/www/admin-server-mail && "${SAFE[@]}" docker compose up -d >/dev/null 2>&1)
  sleep 4
}

deploy() { # image -> runs the deploy with a params file, like the workflow
  local p; p="$(mktemp)"
  printf 'IMAGE_TAG=%s\nGHCR_USER=replica\nGHCR_TOKEN=not-a-token\n' "$1" > "$p"
  env CA_REPLICA_PUBLIC_API=http://127.0.0.1:14000 PATH="$work/shim:$PATH" bash "$scripts/ca-production-deploy.sh" --deploy "$p" < /dev/null 2>&1 | tee "$work/last.log" | sed 's/^/    | /'
  return "${PIPESTATUS[0]}"
}

install() { # mode target values flags
  local v; v="$(mktemp)"; printf '%s\n' "$3" > "$v"
  bash "$scripts/ca-mail-env-install.sh" "$1" "$2" "$v" "${4:-}" < /dev/null 2>&1 | tee "$work/last.log" | sed 's/^/    | /'
  return "${PIPESTATUS[0]}"
}


# Store / read one Mail object through the app's own storage (real code).
mailput() { # container text -> {"key","sha256"}
  docker exec -i -w /app "$1" node - "$2" <<'NODE'
const { loadMailConfig } = require('./src/modules/mail/mail.config');
const { createMailApplication } = require('./src/modules/mail/application');
(async () => {
  const mail = createMailApplication({ client: {}, config: loadMailConfig(process.env), logger: { info() {}, warn() {}, error() {} } });
  await mail.ready();
  const put = await mail.storage.put('body', Buffer.from(process.argv[2]), { purpose: 'mail-body' });
  process.stdout.write(JSON.stringify({ key: put.key, sha256: put.sha256 }));
})().catch((e) => { process.stdout.write('ERROR ' + (e.code || e.message)); process.exitCode = 1; });
NODE
}
mailget() { # container json-from-mailput -> plaintext
  docker exec -i -w /app "$1" node - "$2" <<'NODE'
const { loadMailConfig } = require('./src/modules/mail/mail.config');
const { createMailApplication } = require('./src/modules/mail/application');
(async () => {
  const ref = JSON.parse(process.argv[2]);
  const mail = createMailApplication({ client: {}, config: loadMailConfig(process.env), logger: { info() {}, warn() {}, error() {} } });
  await mail.ready();
  process.stdout.write((await mail.storage.get(ref.key, { purpose: 'mail-body', sha256: ref.sha256 })).toString() + '\n');
})().catch((e) => { process.stdout.write('ERROR ' + (e.code || e.message)); process.exitCode = 1; });
NODE
}
export -f mailget
mail_tables() { # db container: the Mail columns the backup and drill read
  docker exec -i "$1" psql -qAt -v ON_ERROR_STOP=1 -U caadmin -d cosmicforge_admin >/dev/null <<'SQL'
CREATE TABLE mail_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), content_object_key varchar(512), content_sha256 char(64), encrypted_snippet bytea);
CREATE TABLE mail_attachments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), storage_key varchar(512), sha256 char(64));
CREATE TABLE mail_drafts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), encrypted_body bytea);
SQL
}
seed_mail() { # app db: 3 messages, 3 attachments and a draft through the real storage
  local i out
  for i in 1 2 3; do
    out="$(docker exec -i -w /app "$1" node - "$i" <<'NODE'
const { loadMailConfig } = require('./src/modules/mail/mail.config');
const { createMailApplication } = require('./src/modules/mail/application');
(async () => {
  const mail = createMailApplication({ client: {}, config: loadMailConfig(process.env), logger: { info() {}, warn() {}, error() {} } });
  await mail.ready();
  const n = process.argv[2];
  const body = await mail.storage.put('body', Buffer.from(JSON.stringify({ text: 'replica secret body ' + n })), { purpose: 'mail-body' });
  const att = await mail.storage.put('attachment', require('crypto').randomBytes(2048), { purpose: 'mail-attachment' });
  const snippet = mail.encryption.encrypt(Buffer.from('replica secret snippet ' + n), 'mail-snippet').toString('hex');
  const draft = mail.encryption.encrypt(Buffer.from('replica secret draft ' + n), 'mail-draft').toString('hex');
  process.stdout.write([body.key, body.sha256, att.key, att.sha256, snippet, draft].join(' '));
})().catch((e) => { process.stdout.write('ERROR ' + (e.code || e.message)); process.exitCode = 1; });
NODE
)"
    read -r bk bs ak as sn dr <<<"$out"
    docker exec -i "$2" psql -qAt -v ON_ERROR_STOP=1 -U caadmin -d cosmicforge_admin >/dev/null <<SQL
INSERT INTO mail_messages (content_object_key, content_sha256, encrypted_snippet) VALUES ('$bk', '$bs', decode('$sn', 'hex'));
INSERT INTO mail_attachments (storage_key, sha256) VALUES ('$ak', '$as');
INSERT INTO mail_drafts (encrypted_body) VALUES (decode('$dr', 'hex'));
SQL
  done
}

run() {
  mkdir -p "$work"; setup
  local s0 good=ghcr.io/cosmicforgehealthnet/admin-backend:production-1111111111111111111111111111111111111111
  local bad=ghcr.io/cosmicforgehealthnet/admin-backend:production-2222222222222222222222222222222222222222
  s0="$(started admin-server-staging-app-1)"

  log 'P1 preflight (read-only)'
  env CA_REPLICA_PUBLIC_API=http://127.0.0.1:14000 bash "$scripts/ca-production-deploy.sh" --preflight < /dev/null > "$work/last.log" 2>&1
  check 'preflight passes on a healthy production' grep -q 'PASS: baseline: Prisma, AdminUser, health, synthetic login 401' "$work/last.log"
  check 'preflight checks public health and CORS' grep -q 'PASS: baseline: http://127.0.0.1:14000/health 200 and CORS' "$work/last.log"

  log 'P2 a mutable or foreign image tag is refused'
  local p; p="$(mktemp)"; printf 'IMAGE_TAG=ghcr.io/cosmicforgehealthnet/admin-backend:latest\n' > "$p"
  ! bash "$scripts/ca-production-deploy.sh" --deploy "$p" > "$work/last.log" 2>&1
  check ':latest refused' grep -q 'not an immutable production image' "$work/last.log"

  log 'P3 deploy a good immutable image'
  deploy "$good"
  check 'production runs the new image' test "$(image_of admin-server-app-1)" = "$good"
  check 'release override pins the image' grep -q "image: $good" /var/www/admin-server/docker-compose.release.yml
  check 'base compose and .env untouched' bash -c "grep -q 'image: ca-release-replica:base' /var/www/admin-server/docker-compose.yml && grep -q '^JWT_SECRET=Xy7-keep-me$' /var/www/admin-server/.env"
  check 'Mail worker synced to the same image' test "$(image_of admin-server-mail-mail-worker)" = "$good"
  check 'staging never touched' test "$(started admin-server-staging-app-1)" = "$s0"
  check 'no other container changed' grep -q 'PASS: every other container' "$work/last.log"
  check 'registry token not written to the log' bash -c "! grep -rq 'not-a-token' /var/backups/centralize-admin"

  log 'P4 deploy a broken image: automatic rollback, verified'
  ! deploy "$bad"
  check 'failure detected' grep -q 'new image: internal checks failed' "$work/last.log"
  check 'rollback verified' grep -q 'deploy rolled back; previous image verified' "$work/last.log"
  check 'production back on the previous image' test "$(docker inspect -f '{{.Image}}' admin-server-app-1)" = "$(docker image inspect -f '{{.Id}}' "$good")"
  check 'production healthy after rollback' bash -c 'curl -fsS http://127.0.0.1:14000/health >/dev/null'
  check 'worker follows the rolled-back image' test "$(docker inspect -f '{{.Image}}' admin-server-mail-mail-worker)" = "$(docker image inspect -f '{{.Id}}' "$good")"

  log 'P5 Mail enabled but the worker exits with code 0: never reported healthy, release rolled back'
  printf 'MAIL_ENABLED=true\n' >> /var/www/admin-server/.env
  pcompose -f docker-compose.yml -f docker-compose.release.yml up -d --no-deps --force-recreate app >/dev/null 2>&1; sleep 4
  ! deploy "$good"
  check 'an exited worker is refused while Mail is enabled' grep -q 'an exited worker is never healthy' "$work/last.log"
  check 'worker failure rolls the release back' grep -q 'deploy rolled back; previous image verified' "$work/last.log"
  check 'no PASS for an exited worker' bash -c "! grep -q 'PASS: production Mail worker' '$work/last.log'"
  sed -i '/^MAIL_ENABLED=true$/d' /var/www/admin-server/.env
  pcompose -f docker-compose.yml -f docker-compose.release.yml up -d --no-deps --force-recreate app >/dev/null 2>&1; sleep 4
  deploy "$good"
  check 'Mail off again: release completes with an idle worker' grep -q 'idle by configuration' "$work/last.log"

  log 'E1 settings preview (read-only)'
  local e0; e0="$(sha /var/www/admin-server-staging/.env)"
  install --preview staging $'MAIL_PROVIDER=resend\nRESEND_API_KEY=re_test_a$b\nMAIL_S3_BUCKET=ca-mail-staging-bucket'
  check 'preview lists names only' bash -c "grep -q 'RESEND_API_KEY' '$work/last.log' && ! grep -q 're_test' '$work/last.log'"
  check 'preview changed nothing' test "$(sha /var/www/admin-server-staging/.env)" = "$e0"

  log 'E2 refused inputs change nothing'
  ! install --apply staging 'DATABASE_URL=postgresql://evil@db/x'
  check 'non-Mail key refused' grep -q 'key not allowed' "$work/last.log"
  ! install --apply staging 'MAIL_ENABLED=true'
  check 'switch in the secret refused' grep -q 'switches are set with the visible' "$work/last.log"
  ! install --apply staging 'MAIL_DEPLOYMENT_ENV=production'
  check 'wrong deployment environment refused' grep -q 'MAIL_DEPLOYMENT_ENV must be staging' "$work/last.log"
  check '.env still unchanged' test "$(sha /var/www/admin-server-staging/.env)" = "$e0"

  log 'E3 apply: literal values, other settings unchanged'
  install --apply staging $'MAIL_PROVIDER=resend\nRESEND_API_KEY=re_test_a$b\nMAIL_S3_BUCKET=ca-mail-staging-bucket' 'MAIL_ENABLED=false'
  check 'apply passed' grep -q 'PASS: staging Mail settings installed' "$work/last.log"
  check 'value with $ reaches the app literally' test "$(envval admin-server-staging-app-1 RESEND_API_KEY)" = 're_test_a$b'
  check 'existing key updated in place' test "$(envval admin-server-staging-app-1 MAIL_PROVIDER)" = resend
  check 'flag installed' test "$(envval admin-server-staging-app-1 MAIL_ENABLED)" = false
  check 'other secret unchanged' test "$(envval admin-server-staging-app-1 JWT_SECRET)" = 'Xy7-keep-me'
  check 'written single-quoted' grep -qx "RESEND_API_KEY='re_test_a\$b'" /var/www/admin-server-staging/.env
  check 'no value in any log' bash -c "! grep -rq 're_test_a' /var/backups/centralize-admin/*/run.log"
  check 'production untouched by a staging install' grep -q '^MAIL_PROVIDER=fake$' /var/www/admin-server/.env

  log 'E4 a setting that breaks the app is rolled back'
  local e1; e1="$(sha /var/www/admin-server-staging/.env)"
  ! install --apply staging 'RESEND_API_KEY=break-the-app'
  check 'rollback verified' grep -q 'settings rolled back; app verified' "$work/last.log"
  check '.env restored byte for byte' test "$(sha /var/www/admin-server-staging/.env)" = "$e1"
  check 'app back on the previous value' test "$(envval admin-server-staging-app-1 RESEND_API_KEY)" = 're_test_a$b'

  log 'E5 enabling Mail with validator violations is refused and rolled back'
  # Without a provider key the (replica) validator reports a violation once Mail is on.
  sed -i "/^RESEND_API_KEY=/d" /var/www/admin-server-staging/.env; scompose up -d --no-deps --force-recreate app >/dev/null 2>&1; sleep 3
  ! install --apply staging '' 'MAIL_ENABLED=true'
  check 'enable with violations refused' grep -q 'Mail would be enabled while the validator reports violations' "$work/last.log"
  check 'Mail stays off' test "$(envval admin-server-staging-app-1 MAIL_ENABLED)" = false

  log 'S1 staging storage-setup: env keyring imported into a root-only file, data stays readable'
  local sk sdir=/var/www/admin-server-staging
  sk="$(head -c 32 /dev/urandom | base64 -w0)"
  # Pilot state as it exists on staging today: store volume, env keyring.
  docker volume create --label ca.environment=staging --label ca.component=mail-store admin-server-staging-mail-store >/dev/null
  printf 'services:\n  app:\n    image: ca-release-replica:base\n    pull_policy: never\n    volumes: ["admin-server-staging-mail-store:/var/lib/cosmicforge-mail"]\nvolumes:\n  admin-server-staging-mail-store:\n    external: true\n' > /home/cf-staging-deploy/docker-compose.github-staging.yml
  printf "MAIL_DEPLOYMENT_ENV='staging'\nMAIL_STORAGE_PROVIDER='filesystem'\nMAIL_STORAGE_LOCAL_DIR='/var/lib/cosmicforge-mail'\nMAIL_KMS_PROVIDER='env'\nMAIL_ENCRYPTION_KEYS='v1:%s'\nMAIL_ENCRYPTION_ACTIVE_KEY='v1'\n" "$sk" >> "$sdir/.env"
  scompose -p admin-server-staging up -d --force-recreate app >/dev/null 2>&1; sleep 3
  local before; before="$(mailput admin-server-staging-app-1 'pilot-era content')"
  check 'pilot-era object stored with the env keyring' bash -c "[[ '$before' == *'\"key\":\"body/'* ]]"
  bundle="$work/bundle"; mkdir -p "$bundle"; cp "$scripts"/ca-mail-staging-ops.sh "$scripts"/ca-mail-env-install.sh "$bundle/"; cp "$scripts/../../infrastructure/mail/clamav/clamd.conf" "$scripts/../../infrastructure/mail/clamav/freshclam.conf" "$bundle/"
  CA_MAIL_BUNDLE_DIR="$bundle" bash "$bundle/ca-mail-staging-ops.sh" --storage-setup < /dev/null > "$work/last.log" 2>&1 || true
  sed 's/^/    | /' "$work/last.log" | tail -22
  check 'storage-setup passed' grep -q 'PASS: in the app: keyring loaded from the file (1 version(s)); store on its own volume, bound to staging' "$work/last.log"
  check 'existing env keyring imported (same keys)' grep -q 'PASS: existing env keyring imported' "$work/last.log"
  check 'app now uses the keyring file; env keys cleared' bash -c "[[ \"\$(docker exec admin-server-staging-app-1 printenv MAIL_KMS_PROVIDER)\" == file && -z \"\$(docker exec admin-server-staging-app-1 printenv MAIL_ENCRYPTION_KEYS)\" ]]"
  check 'keyring file root:root 0400 in a root-only 0700 directory' bash -c "[[ \$(stat -c '%U:%G %a' /etc/cosmicforge-mail/staging/keyring/keyring.json) == 'root:root 400' && \$(stat -c %a /etc/cosmicforge-mail/staging/keyring) == 700 ]]"
  check 'pilot-era object still decrypts with the imported file keyring' bash -c "mailget admin-server-staging-app-1 '$before' | grep -qx 'pilot-era content'"
  check 'key material never in any log' bash -c "! grep -rqF '$sk' '$work/last.log' \$(find /var/backups/centralize-admin -name '*.log' -o -name '*.out' -o -name '*.json' 2>/dev/null)"
  check 'deploy override pins the image only; mounts file carries store + read-only keyring' bash -c "! grep -q volumes /home/cf-staging-deploy/docker-compose.github-staging.yml && grep -q 'admin-server-staging-mail-store:/var/lib/cosmicforge-mail' $sdir/docker-compose.mail-storage.yml && grep -q '/etc/cosmicforge-mail/staging/keyring:/run/secrets/cosmicforge-mail:ro' $sdir/docker-compose.mail-storage.yml"
  local kf; kf="$(sha /etc/cosmicforge-mail/staging/keyring/keyring.json)"
  CA_MAIL_BUNDLE_DIR="$bundle" bash "$bundle/ca-mail-staging-ops.sh" --storage-setup < /dev/null > "$work/last.log" 2>&1 || true
  check 'rerun keeps the keyring file byte-identical' bash -c "grep -q 'keyring file exists and is kept' '$work/last.log' && [[ \$(sha256sum /etc/cosmicforge-mail/staging/keyring/keyring.json | cut -d' ' -f1) == '$kf' ]]"
  check 'production untouched by staging storage' bash -c "! docker inspect -f '{{range .Mounts}}{{.Name}}{{.Source}} {{end}}' admin-server-app-1 | grep -q 'mail-store\|cosmicforge-mail'"

  log 'S2 recovery escrow sealed to an offline RSA key, verified, recoverable'
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$work/recovery.key" 2>/dev/null
  openssl pkey -in "$work/recovery.key" -pubout -out "$bundle/recovery-staging.pub"
  CA_MAIL_BUNDLE_DIR="$bundle" bash "$bundle/ca-mail-staging-ops.sh" --storage-setup < /dev/null > "$work/last.log" 2>&1 || true
  check 'escrow sealed and verified' grep -q 'PASS: recovery escrow sealed and verified against the keyring' "$work/last.log"
  check 'escrow holds no key in clear' bash -c "! grep -qF \"\$(python3 -c 'import json;print(json.load(open(\"/etc/cosmicforge-mail/staging/keyring/keyring.json\"))[\"keys\"][\"v1\"])')\" /etc/cosmicforge-mail/staging/escrow/keyring-escrow.json"
  mkdir -p "$work/recover"; cp "$work/recovery.key" "$work/recover/"; cp /etc/cosmicforge-mail/staging/escrow/keyring-escrow.json "$work/recover/"
  docker run --rm --network none --entrypoint node -w /app -v "$work/recover:/r" ca-release-replica:base scripts/mail/keyring.js open --escrow=/r/keyring-escrow.json --private-key=/r/recovery.key --out=/r/recovered.json > /dev/null
  check 'escrow opened with the private key gives back the exact keyring' bash -c "python3 -c 'import json,sys; a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2])); sys.exit(0 if a[\"keys\"]==b[\"keys\"] and a[\"active\"]==b[\"active\"] else 1)' $work/recover/recovered.json /etc/cosmicforge-mail/staging/keyring/keyring.json"

  log 'B1 backups (local restic repository): backup, restore drill decrypts everything'
  mail_tables admin-server-staging-db-1
  seed_mail admin-server-staging-app-1 admin-server-staging-db-1
  bash "$scripts/ca-mail-backup.sh" --install-local staging < /dev/null > "$work/last.log" 2>&1 || true
  sed 's/^/    | /' "$work/last.log" | tail -18
  check 'restic installed from the pinned release' grep -qE 'PASS: restic 0.17.3 installed|INFO: restic 0.17.3 already installed' "$work/last.log"
  check 'repository initialised, snapshot taken, retention + check OK' bash -c "grep -q 'PASS: repository initialised' '$work/last.log' && grep -q 'PASS: snapshot ' '$work/last.log' && grep -q 'PASS: repository check OK' '$work/last.log'"
  check 'local repository reported as NOT off-host' grep -q 'NOT an off-host backup' "$work/last.log"
  check 'drill: database restored into a throwaway container, counts equal' bash -c "grep -q 'PASS: database restored into a throwaway PostgreSQL' '$work/last.log' && grep -q 'PASS: restored Mail row counts equal the backup manifest' '$work/last.log'"
  check 'drill: every object and encrypted column decrypted and matched' grep -qE 'PASS: content verified: [1-9][0-9]* objects and [1-9][0-9]* encrypted columns decrypted, SHA-256 matched, 0 failures' "$work/last.log"
  check 'drill: escrow in the backup matches the live keyring' grep -q 'PASS: backed-up recovery escrow matches the live keyring' "$work/last.log"
  check 'no drill container, network or dump left behind' bash -c "[[ -z \$(docker ps -aq --filter label=ca.component=mail-restore-drill) && -z \$(docker network ls -q --filter name=ca-mail-drill-) && ! -e /var/lib/cosmicforge-mail-backup/staging/meta ]]"
  check 'repository is encrypted (no plaintext row or key in it)' bash -c "! grep -rqaF 'replica secret body' /var/lib/cosmicforge-mail-backup/staging/local-repo && ! grep -rqaF \"\$(python3 -c 'import json;print(json.load(open(\"/etc/cosmicforge-mail/staging/keyring/keyring.json\"))[\"keys\"][\"v1\"])')\" /var/lib/cosmicforge-mail-backup/staging/local-repo"
  bash "$scripts/ca-mail-backup.sh" --status staging < /dev/null > "$work/last.log" 2>&1 || true
  check 'status reports last backup and drill' bash -c "grep -q '\"ok\": true' '$work/last.log' && grep -q 'repository: local' '$work/last.log'"

  log 'B2 a backup missing an object is caught by the drill'
  local victim; victim="$(docker exec -i admin-server-staging-db-1 psql -qAt -U caadmin -d cosmicforge_admin -c 'SELECT storage_key FROM mail_attachments LIMIT 1')"
  mv "$(docker volume inspect -f '{{.Mountpoint}}' admin-server-staging-mail-store)/$victim" "$work/victim"
  bash "$scripts/ca-mail-backup.sh" --run staging < /dev/null > "$work/last.log" 2>&1 || true
  bash "$scripts/ca-mail-backup.sh" --drill staging < /dev/null > "$work/last.log" 2>&1 || true
  check 'drill fails and names the missing object count' bash -c "grep -q 'FAIL: content verification failed' '$work/last.log' && grep -q '\"missing\": 1' '$work/last.log'"
  check 'failed drill recorded' bash -c "grep -q '\"ok\": false' /var/lib/cosmicforge-mail-backup/staging/last-drill.json"
  mv "$work/victim" "$(docker volume inspect -f '{{.Mountpoint}}' admin-server-staging-mail-store)/$victim"
  bash "$scripts/ca-mail-backup.sh" --run staging < /dev/null > /dev/null 2>&1 || true
  bash "$scripts/ca-mail-backup.sh" --drill staging < /dev/null > "$work/last.log" 2>&1 || true
  check 'after repair the next backup + drill pass again' grep -q 'PASS: content verified' "$work/last.log"

  log 'S3 production storage-setup: new server-generated keyring, kept by a guarded deploy'
  # As CA_PRODUCTION_MAIL_ENV would: production never runs on the fake provider.
  install --apply production "$(printf 'MAIL_DEPLOYMENT_ENV=production\nMAIL_PROVIDER=resend')" > /dev/null 2>&1 || true
  CA_MAIL_BUNDLE_DIR="$bundle" bash "$bundle/ca-mail-staging-ops.sh" --storage-setup --target=production < /dev/null > "$work/last.log" 2>&1 || true
  sed 's/^/    | /' "$work/last.log" | tail -14
  check 'production keyring generated on the server' grep -q 'PASS: new keyring generated on the server' "$work/last.log"
  check 'production storage check passed in the app' grep -q 'PASS: in the app: keyring loaded from the file (1 version(s)); store on its own volume, bound to production' "$work/last.log"
  check 'production worker mounts the same store and keyring' grep -q 'PASS: Mail worker mounts the same store and the keyring read-only' "$work/last.log"
  check 'escrow pending reported without a recovery key' grep -q 'escrow PENDING' "$work/last.log"
  check 'staging and production keyrings differ' bash -c "[[ \$(sha256sum /etc/cosmicforge-mail/production/keyring/keyring.json | cut -d' ' -f1) != \$(sha256sum /etc/cosmicforge-mail/staging/keyring/keyring.json | cut -d' ' -f1) ]]"
  deploy "$good" > /dev/null 2>&1 || true
  check 'guarded deploy keeps the store + keyring mounts' bash -c "docker inspect -f '{{range .Mounts}}{{.Name}}|{{.Destination}} {{end}}' admin-server-app-1 | grep -q 'admin-server-mail-store|/var/lib/cosmicforge-mail' && docker inspect -f '{{range .Mounts}}{{.Source}}|{{.Destination}} {{end}}' admin-server-app-1 | grep -q '/etc/cosmicforge-mail/production/keyring|/run/secrets/cosmicforge-mail'"
  CA_MAIL_BUNDLE_DIR="$bundle" bash "$bundle/ca-mail-staging-ops.sh" --storage-check --target=production < /dev/null > "$work/last.log" 2>&1 || true
  check 'storage check still passes after the deploy' grep -q 'PASS: in the app: keyring loaded from the file' "$work/last.log"
  # The staging store refuses to serve production and vice versa.
  check 'a store volume bound to staging refuses production' bash -c "docker run --rm --network none --entrypoint node -w /app -v admin-server-staging-mail-store:/s ca-release-replica:base -e \"require('./src/modules/mail/storage/mail-storage').filesystemBackend('/s',{environment:'production'}).health().then(h=>process.exit(h.detail==='store-belongs-to-another-environment'?0:1))\""

  log 'H1 production env permissions'
  id cf-staging-deploy >/dev/null 2>&1 || useradd -M -s /usr/sbin/nologin cf-staging-deploy
  chown root:cf-staging-deploy /var/www/admin-server/.env; chmod 640 /var/www/admin-server/.env
  cp -p /var/www/admin-server/.env /var/www/admin-server/.env.save
  bash "$scripts/ca-host-ops.sh" --host-audit > "$work/last.log" 2>&1 || true
  check 'audit detects the readable production env file' grep -q 'FAIL: the staging deploy account can read a production env file' "$work/last.log"
  docker run -d --name ca-replica-envmount --label ca.replica=1 -v /var/www/admin-server:/srv:ro ca-release-replica:base sleep 600 >/dev/null
  bash "$scripts/ca-host-ops.sh" --secure-production-env > "$work/last.log" 2>&1 || true
  check 'refuses while a container bind-mounts the env file' bash -c "grep -q 'bind-mounts /var/www/admin-server, which contains' '$work/last.log' && [[ \$(stat -c %a /var/www/admin-server/.env) == 640 ]]"
  docker rm -f ca-replica-envmount >/dev/null
  bash "$scripts/ca-host-ops.sh" --secure-production-env > "$work/last.log" 2>&1
  check 'both production env files now root:root 600' bash -c '[[ $(stat -c "%U:%G %a" /var/www/admin-server/.env) == "root:root 600" && $(stat -c "%U:%G %a" /var/www/admin-server/.env.save) == "root:root 600" ]]'
  bash "$scripts/ca-host-ops.sh" --host-audit > "$work/last.log" 2>&1
  check 'audit passes afterwards' grep -q 'PASS: no production env file is readable by the staging deploy account' "$work/last.log"
  check 'staging env file not touched' test "$(stat -c %a /var/www/admin-server-staging/.env)" = 640

  log 'H2 staging deploy account can read the staging .env (staging deploys)'
  chown root:root /var/www/admin-server-staging/.env; chmod 600 /var/www/admin-server-staging/.env
  bash "$scripts/ca-host-ops.sh" --host-audit > "$work/last.log" 2>&1 || true
  check 'audit flags an unreadable staging .env (deploys would fail)' grep -q 'FAIL: the staging deploy account cannot read the staging .env' "$work/last.log"
  bash "$scripts/ca-host-ops.sh" --staging-env-access > "$work/last.log" 2>&1 || true
  check 'staging .env root:cf-staging-deploy 0640, readable by the deploy account' bash -c "[[ \$(stat -c '%U:%G %a' /var/www/admin-server-staging/.env) == 'root:cf-staging-deploy 640' ]] && runuser -u cf-staging-deploy -- test -r /var/www/admin-server-staging/.env"
  check 'production env files still root-only' bash -c "[[ \$(stat -c '%U:%G %a' /var/www/admin-server/.env) == 'root:root 600' ]] && ! runuser -u cf-staging-deploy -- test -r /var/www/admin-server/.env"

  echo
  if (( failures )); then echo "RELEASE OPS REPLICA TESTS FAILED: $failures"; return 1; fi
  echo 'RELEASE OPS REPLICA TESTS PASSED'
}

case "${1:-}" in
  run) rc=0; run || rc=$?; [[ "${KEEP_REPLICA:-}" == 1 ]] || teardown; exit "$rc" ;;
  teardown) teardown ;;
  *) echo 'usage: CA_REPLICA_TEST=1 bash ca-release-ops-replica.sh run | teardown' >&2; exit 2 ;;
esac
