#!/usr/bin/env bash
# Disposable replica for the release tooling, run UNMODIFIED:
#   .github/scripts/ca-production-deploy.sh  (guarded deploy, rollback, worker sync)
#   .github/scripts/ca-mail-env-install.sh   (Mail settings install, rollback)
#   .github/scripts/ca-host-ops.sh           (production env permissions)
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
for d in /var/www/admin-server /var/www/admin-server-staging; do
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
  docker network rm admin-server_default admin-server-staging_default >/dev/null 2>&1 || true
  docker volume rm -f admin-server_pg admin-server-staging_postgres_data_staging admin-server-staging-mail-store >/dev/null 2>&1 || true
  rm -rf /var/www/admin-server /var/www/admin-server-staging /var/www/admin-server-mail /home/cf-staging-deploy "$work" /var/backups/centralize-admin
  rm -f /run/lock/centralize-admin-production-deploy.lock /run/lock/centralize-admin-mail-env-*.lock /run/lock/centralize-admin-mail-staging.lock
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
  (cd "$work/app" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund pg@8.13.1 >/dev/null)
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
  write_stack /var/www/admin-server admin-server 14000
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

  log 'S1 staging pilot storage: volume, mount, keyring generated on the server'
  CA_MAIL_BUNDLE_DIR="$scripts" bash "$scripts/ca-mail-staging-ops.sh" --pilot-storage-setup < /dev/null > "$work/last.log" 2>&1 || true
  sed 's/^/    | /' "$work/last.log" | tail -25
  check 'pilot setup passed' grep -q 'PASS: pilot storage settings installed' "$work/last.log"
  check 'app mounts the pilot volume' grep -q 'PASS: staging app mounts admin-server-staging-mail-store at /var/lib/cosmicforge-mail' "$work/last.log"
  check 'filesystem storage configured' test "$(envval admin-server-staging-app-1 MAIL_STORAGE_PROVIDER)" = filesystem
  check 'keyring is one 32-byte key, v1 active' bash -c "[[ \"\$(docker exec admin-server-staging-app-1 printenv MAIL_ENCRYPTION_KEYS)\" =~ ^v1:[A-Za-z0-9+/]{43}=\$ && \"\$(docker exec admin-server-staging-app-1 printenv MAIL_ENCRYPTION_ACTIVE_KEY)\" == v1 ]]"
  local k1; k1="$(envval admin-server-staging-app-1 MAIL_ENCRYPTION_KEYS | sha256sum)"
  check 'keyring never written to any log' bash -c "! grep -rqF \"\$(docker exec admin-server-staging-app-1 printenv MAIL_ENCRYPTION_KEYS | cut -d: -f2)\" /var/backups/centralize-admin '$work/last.log'"
  check 'deploy override keeps the image and adds the mount' bash -c "grep -q 'image: ca-release-replica:base' /home/cf-staging-deploy/docker-compose.github-staging.yml && grep -q 'admin-server-staging-mail-store:/var/lib/cosmicforge-mail' /home/cf-staging-deploy/docker-compose.github-staging.yml"
  CA_MAIL_BUNDLE_DIR="$scripts" bash "$scripts/ca-mail-staging-ops.sh" --pilot-storage-setup < /dev/null > "$work/last.log" 2>&1 || true
  check 'rerun keeps the existing keyring' bash -c "grep -q 'keyring already exists; it is kept unchanged' '$work/last.log' && [[ \"\$(docker exec admin-server-staging-app-1 printenv MAIL_ENCRYPTION_KEYS | sha256sum)\" == '$k1' ]]"
  check 'production untouched by staging pilot' bash -c "! docker inspect -f '{{range .Mounts}}{{.Name}} {{end}}' admin-server-app-1 | grep -q mail-store"

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

  echo
  if (( failures )); then echo "RELEASE OPS REPLICA TESTS FAILED: $failures"; return 1; fi
  echo 'RELEASE OPS REPLICA TESTS PASSED'
}

case "${1:-}" in
  run) rc=0; run || rc=$?; [[ "${KEEP_REPLICA:-}" == 1 ]] || teardown; exit "$rc" ;;
  teardown) teardown ;;
  *) echo 'usage: CA_REPLICA_TEST=1 bash ca-release-ops-replica.sh run | teardown' >&2; exit 2 ;;
esac
