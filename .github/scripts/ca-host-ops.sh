#!/usr/bin/env bash
# Centralize Admin host operations (root, Contabo VPS), via
# .github/workflows/ca-mail-staging-ops.yml.
#
#   --host-audit             READ-ONLY: who can read the CA .env files, the
#                            deploy account's groups, how each CA Compose app
#                            gets its image and settings (names only).
#   --secure-production-env  Make every production CA env file root-only
#                            (root:root 0600, no ACL), so the staging deploy
#                            account can no longer read production secrets.
#                            Production Compose runs as root and is unaffected.
#   --staging-env-access     The staging deploy (staging.yml) runs Compose as the
#                            deploy account, which must read the STAGING .env:
#                            /var/www/admin-server-staging/.env becomes
#                            root:cf-staging-deploy 0640 (no ACL). Nothing else.
#
#   --nginx-upload-diagnose  READ-ONLY: sanitized effective Nginx upload limits
#                            (client_max_body_size, server_name, upstream, our
#                            include) for one CA API vhost, recent Nginx 413
#                            counts for the Mail upload path, and unauthenticated
#                            probes of the public upload route (expect 401/413).
#   --nginx-upload-apply     One CA API vhost only: back up its file and snippet,
#                            add the managed upload-limit snippet include,
#                            nginx -t, reload, verify the effective config and
#                            the live route; any failure restores the backup.
#   --nginx-upload-rollback  Restore the newest backup taken by apply (same target).
#
#   The nginx-upload operations take --target=staging (default, the
#   stagingca host) or --target=production (the liveca host). The targets are
#   independent: own server block, own snippet file, own backup directory, and
#   apply proves every other file under /etc/nginx is unchanged.
#
# Never prints a value from an env file. Touches only /var/www/admin-server/.env*
# (secure-production-env) or /var/www/admin-server-staging/.env (staging-env-access).
set -Eeuo pipefail
umask 077
export LC_ALL=C

readonly PROD_DIR=/var/www/admin-server
readonly STAGING_DIR=/var/www/admin-server-staging
readonly DEPLOY_USER=cf-staging-deploy

mode="${1:-}"
case "$mode" in --host-audit|--secure-production-env|--staging-env-access|--nginx-upload-diagnose|--nginx-upload-apply|--nginx-upload-rollback) ;; *) echo 'Usage: ca-host-ops.sh --host-audit|--secure-production-env|--staging-env-access|--nginx-upload-diagnose|--nginx-upload-apply|--nginx-upload-rollback [--target=staging|production]' >&2; exit 2 ;; esac
target=staging
for arg in "${@:2}"; do
  case "$arg" in
    --target=staging|--target=production) target="${arg#--target=}" ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[[ "$target" == staging || "$mode" == --nginx-upload-* ]] || { echo '--target applies only to the nginx-upload operations.' >&2; exit 2; }
[[ "$(id -u)" -eq 0 ]] || { echo 'Run as root.' >&2; exit 2; }

declare -a SUMMARY=()
pass() { SUMMARY+=("PASS  $*"); echo "PASS: $*"; }
fail() { SUMMARY+=("FAIL  $*"); echo "FAIL: $*" >&2; }
info() { SUMMARY+=("INFO  $*"); echo "INFO: $*"; }
finish() {
  local code=$?
  echo; echo '==================== SUMMARY ===================='
  local l; for l in "${SUMMARY[@]}"; do echo "$l"; done
  echo '================================================='
  exit "$code"
}
trap finish EXIT

deploy_can_read() { # file -> yes|no|no-user
  id "$DEPLOY_USER" >/dev/null 2>&1 || { echo no-user; return; }
  if command -v runuser >/dev/null; then
    runuser -u "$DEPLOY_USER" -- test -r "$1" && echo yes || echo no
  else
    su -s /bin/sh "$DEPLOY_USER" -c "test -r '$1'" && echo yes || echo no
  fi
}

has_acl() { command -v getfacl >/dev/null && getfacl -cp "$1" 2>/dev/null | grep -qvE '^(user|group|other)::|^$' && echo yes || echo no; }

env_files() { # dir -> env-like files directly in it (never recursing)
  find "$1" -maxdepth 1 -type f \( -name '.env' -o -name '.env.*' -o -name '*.env' \) ! -name '.env.example' 2>/dev/null | sort
}

describe() { # file -> owner:group mode acl deploy-readable
  printf '%s %s:%s %s acl=%s deploy_user_can_read=%s\n' "$1" "$(stat -c %U "$1")" "$(stat -c %G "$1")" "$(stat -c %a "$1")" "$(has_acl "$1")" "$(deploy_can_read "$1")"
}

compose_app_summary() { # dir app -> image source and env_file usage (names only)
  local dir="$1" app="$2" img
  img="$(docker inspect -f '{{.Config.Image}}' "$app" 2>/dev/null || echo missing)"
  printf '%s: running image tag %s; compose files %s\n' "$app" "$img" \
    "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$app" 2>/dev/null || echo unknown)"
  if [[ -f "$dir/docker-compose.yml" ]]; then
    awk '/^  app:/{a=1;next} /^  [a-z]/{a=0} a && /(image|build|env_file):/{gsub(/^ +/,""); print "  app " $0}' "$dir/docker-compose.yml" | sed -E 's/(image: *[^:]+:).*/\1<tag>/' | sort -u
  fi
}

host_audit() {
  info "deploy account $DEPLOY_USER groups: $(id -nG "$DEPLOY_USER" 2>/dev/null || echo missing)"
  info "docker group members: $(getent group docker | cut -d: -f4)"
  local f
  for f in $(env_files "$PROD_DIR"); do info "production env file: $(describe "$f")"; done
  for f in $(env_files "$STAGING_DIR"); do info "staging env file: $(describe "$f")"; done
  info "staging compose dir readable by deploy account: $(deploy_can_read "$STAGING_DIR/docker-compose.yml")"
  local line
  while IFS= read -r line; do info "$line"; done < <(compose_app_summary "$PROD_DIR" admin-server-app-1; compose_app_summary "$STAGING_DIR" admin-server-staging-app-1)
  info "docker compose: $(docker compose version --short 2>/dev/null || echo missing); docker-compose: $(command -v docker-compose >/dev/null && docker-compose version --short 2>/dev/null || echo missing)"
  info "production release override present: $([[ -f "$PROD_DIR/docker-compose.release.yml" ]] && echo yes || echo no)"
  local prod_readable=no
  for f in $(env_files "$PROD_DIR"); do [[ "$(deploy_can_read "$f")" == yes ]] && prod_readable=yes; done
  if [[ "$prod_readable" == yes ]]; then
    fail "the staging deploy account can read a production env file"
  else
    pass "no production env file is readable by the staging deploy account"
  fi
  if [[ -f "$STAGING_DIR/.env" ]]; then
    [[ "$(deploy_can_read "$STAGING_DIR/.env")" == yes ]] && pass 'the staging deploy account can read the staging .env (needed by staging deploys)' \
      || fail 'the staging deploy account cannot read the staging .env: staging deploys fail (run staging-env-access)'
  fi
  if id -nG "$DEPLOY_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    info "RESIDUAL: $DEPLOY_USER is in the docker group, which can inspect any container's environment (root-equivalent). Removing it requires replacing the staging deploy with a root-owned, command-restricted deploy entry point."
  fi
}

secure_production_env() {
  [[ -d "$PROD_DIR" && -f "$PROD_DIR/docker-compose.yml" ]] || { fail "$PROD_DIR is not the production CA deployment"; return 1; }
  local f changed=0 backup id src
  # Refuse if a container reads an env file through a bind mount: its process
  # may not be root, and would lose access on its next restart.
  for id in $(docker ps -q --no-trunc); do
    while read -r src; do
      [[ -n "$src" ]] || continue
      for f in $(env_files "$PROD_DIR"); do
        if [[ "$f" == "$src" || "$f" == "${src%/}/"* ]]; then
          fail "container $(docker inspect -f '{{.Name}}' "$id" | sed 's|^/||') bind-mounts $src, which contains $f; nothing changed"
          return 1
        fi
      done
    done < <(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{"\n"}}{{end}}{{end}}' "$id")
  done
  pass 'no running container bind-mounts a production env file'
  backup="/var/backups/centralize-admin/env-permissions-$(date -u +%Y%m%dT%H%M%SZ).txt"
  mkdir -p /var/backups/centralize-admin; chmod 700 /var/backups/centralize-admin
  for f in $(env_files "$PROD_DIR"); do
    describe "$f" >> "$backup"
    if [[ "$(stat -c '%U:%G %a' "$f")" != 'root:root 600' || "$(has_acl "$f")" == yes ]]; then
      command -v setfacl >/dev/null && setfacl -b "$f"
      chown root:root "$f"; chmod 600 "$f"
      changed=$((changed + 1))
    fi
    [[ "$(stat -c '%U:%G %a' "$f")" == 'root:root 600' && "$(deploy_can_read "$f")" != yes ]] \
      || { fail "could not secure $f"; return 1; }
    pass "$(describe "$f")"
  done
  info "previous ownership/modes recorded in $backup (root-only); $changed file(s) changed"
  # Production must still start: Compose (as root) still resolves the app settings.
  (cd "$PROD_DIR" && env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin docker compose config -q) \
    && pass 'production Compose still resolves its configuration as root' || { fail 'production Compose cannot read its configuration'; return 1; }
}

staging_env_access() {
  local f="$STAGING_DIR/.env" backup
  [[ -f "$f" && -f "$STAGING_DIR/docker-compose.yml" ]] || { fail "$STAGING_DIR is not the staging CA deployment"; return 1; }
  id "$DEPLOY_USER" >/dev/null 2>&1 && getent group "$DEPLOY_USER" >/dev/null || { fail "$DEPLOY_USER account or group missing"; return 1; }
  backup="/var/backups/centralize-admin/env-permissions-$(date -u +%Y%m%dT%H%M%SZ).txt"
  mkdir -p /var/backups/centralize-admin; chmod 700 /var/backups/centralize-admin
  describe "$f" >> "$backup"
  command -v setfacl >/dev/null && setfacl -b "$f"
  chown "root:$DEPLOY_USER" "$f"; chmod 640 "$f"
  [[ "$(stat -c '%U:%G %a' "$f")" == "root:$DEPLOY_USER 640" && "$(deploy_can_read "$f")" == yes ]] \
    && pass "$(describe "$f")" || { fail "could not set $f"; return 1; }
  info "previous ownership/mode recorded in $backup (root-only); production env files not touched"
  local p; for p in $(env_files "$PROD_DIR"); do
    [[ "$(deploy_can_read "$p")" == no ]] || { fail "a production env file is readable by $DEPLOY_USER ($p)"; return 1; }
  done
  pass 'production env files still unreadable by the staging deploy account'
}

# ---------------------------------------------------------------- Nginx uploads
readonly CA_STAGING_VHOST=stagingca.cosmicforge-healthnet.com
readonly CA_PRODUCTION_VHOST=liveca.cosmicforge-healthnet.com
if [[ "$target" == production ]]; then
  readonly VHOST_HOST=$CA_PRODUCTION_VHOST OTHER_HOST=$CA_STAGING_VHOST
  readonly SNIPPET=/etc/nginx/snippets/ca-mail-upload-limits-production.conf
  readonly NGINX_BACKUPS=/var/backups/centralize-admin/nginx-production
  readonly PROBE_ORIGIN=https://centralize-admin.vercel.app
else
  # Paths kept from the first (staging-only) release so its backups stay restorable.
  readonly VHOST_HOST=$CA_STAGING_VHOST OTHER_HOST=$CA_PRODUCTION_VHOST
  readonly SNIPPET=/etc/nginx/snippets/ca-mail-upload-limits.conf
  readonly NGINX_BACKUPS=/var/backups/centralize-admin/nginx
  readonly PROBE_ORIGIN=https://centralize-admin-staging.vercel.app
fi
readonly INCLUDE_LINE="include $SNIPPET;"
readonly TPL="${CA_MAIL_BUNDLE_DIR:-$(dirname "$0")}/ca-mail-upload-limits.conf.tpl"
readonly UPLOAD_PROBE_PATH=/api/mail/v1/drafts/00000000-0000-4000-8000-000000000000/attachments
readonly OTHER_PROBE_PATH=/api/mail/v1/mailboxes/00000000-0000-4000-8000-000000000000/threads
readonly MIB=$((1024 * 1024))

nginx_effective() { nginx -T 2>/dev/null; }
# The lines nginx -T prints for one file (as named by its include).
effective_file() { nginx_effective | awk -v f="$1" '/^# configuration file /{cur=$4; sub(":$","",cur); next} cur==f'; }
# True when the effective text of one file has a matching line. Counts instead
# of grep -q so an early exit cannot SIGPIPE the writer under pipefail.
effective_has() { # file grep-flag pattern
  local n; n="$(effective_file "$1" | grep -c "$2" -- "$3" || true)"; (( n > 0 ))
}
vhost_file() { # -> the single file with a server block naming $VHOST_HOST (exact server_name token)
  local f; local -a hits=()
  while IFS= read -r f; do hits+=("$f"); done < <(nginx_effective | awk -v host="$VHOST_HOST" '
    /^# configuration file /{file=$4; sub(":$","",file)}
    $1=="server_name"{for(i=2;i<=NF;i++){t=$i; sub(/;$/,"",t); if(t==host) print file}}' | sort -u)
  (( ${#hits[@]} == 1 )) || { echo "ambiguous-or-missing (${#hits[@]} files)"; return 1; }
  echo "${hits[0]}"
}
# In one file: the server block that names $VHOST_HOST and has exactly one
# proxied "location / {". Prints "server_start server_end loc_start loc_end
# names_other_host" or "0 0 0 0 0" (none, or more than one candidate).
server_span() {
  awk -v host="$VHOST_HOST" -v other="$OTHER_HOST" '
    function count(s, ch,   p) { return split(s, p, ch) - 1 }
    {
      line = $0; sub(/#.*/, "", line); t = line; sub(/^[ \t]+/, "", t)
      n = split(t, w, /[ \t;]+/)
      if (!insrv && depth == 0 && t ~ /^server[ \t]*\{/) { insrv = 1; ss = NR; named = 0; foreign = 0; locs = 0; inloc = 0 }
      if (insrv) {
        if (w[1] == "server_name") for (i = 2; i <= n; i++) { if (w[i] == host) named = 1; if (w[i] == other) foreign = 1 }
        if (!inloc && t ~ /^location[ \t]+\/[ \t]*\{/) { inloc = 1; lstart = NR; ldepth = depth; proxied = 0 }
        if (inloc && w[1] == "proxy_pass") proxied = 1
      }
      depth += count(line, "{") - count(line, "}")
      if (inloc && depth <= ldepth) { if (proxied) { locs++; ls = lstart; le = NR } inloc = 0 }
      if (insrv && depth == 0) {
        if (named && locs > 0) { cand++; if (locs == 1) out = ss " " NR " " ls " " le " " foreign }
        insrv = 0
      }
    }
    END { if (cand == 1 && out != "") print out; else print "0 0 0 0 0" }' "$1"
}
# Hash of every file under /etc/nginx except the target vhost and target snippet.
others_digest() { # real-vhost-path
  find /etc/nginx -type f ! -path "$1" ! -path "$SNIPPET" -print0 | sort -z | xargs -0 -r sha256sum | sha256sum | cut -c1-64
}
# Unauthenticated multipart POST of random bytes to the public host, resolved to
# this machine. Prints "<status> <Access-Control-Allow-Origin or ->", or "na".
probe() { # path bytes origin
  command -v curl >/dev/null || { echo na; return 0; }
  local body hdr code acao
  body="$(mktemp)"; hdr="$(mktemp)"
  head -c "$2" /dev/urandom > "$body"
  code="$(curl -sk -o /dev/null -D "$hdr" --max-time 90 --resolve "$VHOST_HOST:443:127.0.0.1" -H "Origin: $3" \
    -F "file=@$body;type=application/pdf;filename=probe.pdf" -w '%{http_code}' "https://$VHOST_HOST$1" 2>/dev/null || true)"
  acao="$(grep -i '^access-control-allow-origin:' "$hdr" | head -n 1 | cut -d' ' -f2- | tr -d '\r' || true)"
  rm -f "$body" "$hdr"
  [[ -n "$code" && "$code" != 000 ]] || { echo na; return 0; }
  echo "$code ${acao:--}"
}
reload_nginx() { systemctl reload nginx 2>/dev/null || nginx -s reload; }
restore_backup() { # backup-dir real-vhost-path
  cp -a "$1/vhost.conf" "$2"
  if [[ -f "$1/snippet.conf" ]]; then cp -a "$1/snippet.conf" "$SNIPPET"; else rm -f "$SNIPPET"; fi
  nginx -t >/dev/null 2>&1 && reload_nginx
}

nginx_upload_diagnose() {
  info "target: $target ($VHOST_HOST)"
  info "nginx version: $(nginx -v 2>&1)"
  local f; f="$(vhost_file)" || { fail "CA $target vhost file: $f"; return 1; }
  local real; real="$(readlink -f "$f")"
  pass "CA $target vhost file: $f (real path $real)"
  local ss se ls le foreign
  read -r ss se ls le foreign <<<"$(server_span "$real")"
  if (( ss > 0 )); then
    pass "server block for $VHOST_HOST: lines $ss-$se, proxied location / at $ls-$le"
    (( foreign == 0 )) && pass "the server block does not also serve $OTHER_HOST" || fail "the server block also names $OTHER_HOST (targets not independent)"
    info "server block directives: $(sed -n "${ss},${se}p" "$real" | sed 's/#.*//; s/^[[:space:]]*//' \
      | grep -E '^(listen|server_name|location|proxy_pass|proxy_set_header|proxy_http_version|client_max_body_size|include|error_page|access_log|error_log|return)\b' \
      | grep -vE 'ssl_|letsencrypt|\.pem|\.key' | tr '\n' ' ')"
    info "add_header names in the server block: $(sed -n "${ss},${se}p" "$real" | sed 's/#.*//' | awk '$1=="add_header"{print $2}' | sort -u | tr '\n' ' ')"
  else
    fail "no single server block for $VHOST_HOST with exactly one proxied location / in $real"
  fi
  info "client_max_body_size directives (file: line): $(nginx_effective | awk '/^# configuration file /{file=$4; sub(":$","",file)} $1=="client_max_body_size"{print file": "$0}' | tr '\n' ';')"
  info 'global/http default applies when none is set: 1m (Nginx built-in)'
  if [[ -f "$SNIPPET" ]]; then info "managed snippet $SNIPPET present: $(grep -c '^location' "$SNIPPET") locations"; else info "managed snippet $SNIPPET not installed"; fi
  grep -qF "$INCLUDE_LINE" "$real" && info 'vhost includes the managed snippet' || info 'vhost does NOT include the managed snippet'
  local -a logs=(/var/log/nginx/access.log /var/log/nginx/error.log)
  (( ss > 0 )) && while IFS= read -r l; do logs+=("$l"); done < <(sed -n "${ss},${se}p" "$real" | sed 's/#.*//' | awk '$1=="access_log"||$1=="error_log"{sub(/;$/,"",$2); if ($2 ~ /^\//) print $2}' | sort -u)
  local log; for log in "${logs[@]}"; do
    [[ -r "$log" ]] || continue
    info "$log: last 20000 lines => 413 on attachments: $(tail -n 20000 "$log" | grep -E 'drafts/[^ ]+/attachments' | grep -cE '" 413 |client intended to send too large body' || true)"
  done
  info 'log lines were counted only; no addresses, tokens or bodies were printed'
  info "probe (unauthenticated, random bytes) 200 KiB upload: $(probe "$UPLOAD_PROBE_PATH" $((200 * 1024)) "$PROBE_ORIGIN")"
  info "probe 3 MiB upload: $(probe "$UPLOAD_PROBE_PATH" $((3 * MIB)) "$PROBE_ORIGIN")"
  info "probe 3 MiB to another Mail route: $(probe "$OTHER_PROBE_PATH" $((3 * MIB)) "$PROBE_ORIGIN")"
  info 'probe format: <HTTP status> <Access-Control-Allow-Origin>; 401 = reached the API (no session), 413 = refused by Nginx'
}

nginx_upload_apply() {
  info "target: $target ($VHOST_HOST)"
  [[ -f "$TPL" ]] || { fail "snippet template missing from bundle ($TPL)"; return 1; }
  local f; f="$(vhost_file)" || { fail "CA $target vhost file: $f"; return 1; }
  local real; real="$(readlink -f "$f")"
  [[ "$real" == /etc/nginx/* ]] || { fail "unexpected vhost path $real"; return 1; }
  local ss se lstart lend foreign
  read -r ss se lstart lend foreign <<<"$(server_span "$real")"
  (( ss > 0 && lstart > ss && lend > lstart )) || { fail "BLOCKED: no single $VHOST_HOST server block with exactly one proxied \"location / {\"; nothing changed"; return 1; }
  (( foreign == 0 )) || { fail "BLOCKED: the $VHOST_HOST server block also names $OTHER_HOST; nothing changed"; return 1; }
  pass "server block for $VHOST_HOST in $real: lines $ss-$se, proxied location / at $lstart-$lend"
  mkdir -p "$NGINX_BACKUPS"; chmod 700 "$NGINX_BACKUPS"
  local body="$NGINX_BACKUPS/.body.$$"
  sed -n "$((lstart + 1)),$((lend - 1))p" "$real" | grep -vE '^[[:space:]]*(client_max_body_size|client_body_timeout|proxy_read_timeout|proxy_send_timeout)\b' | grep -vE '^[[:space:]]*error_page[^;]*[[:space:]]413([[:space:]]|;)' > "$body" || true
  grep -qE '^[[:space:]]*proxy_pass[[:space:]]+http://(localhost|127\.0\.0\.1):[0-9]+/?;' "$body" || { rm -f "$body"; fail 'BLOCKED: unexpected upstream form in the proxied location; nothing changed'; return 1; }
  grep -qE 'proxy_pass[^;]*\$' "$body" && { rm -f "$body"; fail 'BLOCKED: variable proxy_pass is not supported; nothing changed'; return 1; }
  info "proxied location body copied for the upload paths: $(sed 's/^[[:space:]]*//' "$body" | tr '\n' ' ' | cut -c1-300)"
  local generated="$NGINX_BACKUPS/.snippet.$$"
  awk -v bodyfile="$body" '/__LOCATION_BODY__/ { while ((getline l < bodyfile) > 0) print "    " l; close(bodyfile); next } { print }' "$TPL" > "$generated"
  rm -f "$body"
  # Idempotent: an already-applied, unchanged configuration is not re-backed-up
  # (a second backup would capture the fixed state and defeat rollback).
  if grep -qF "$INCLUDE_LINE" "$real" && [[ -f "$SNIPPET" ]] && cmp -s "$generated" "$SNIPPET"; then
    rm -f "$generated"
    if effective_has "$SNIPPET" -E '^[[:space:]]*client_max_body_size 26m;'; then
      pass "already applied: effective config allows 26m on the $target Mail attachment upload path (no change made)"
      info "probe 3 MiB upload: $(probe "$UPLOAD_PROBE_PATH" $((3 * MIB)) "$PROBE_ORIGIN")"
      return 0
    fi
    fail 'include present but effective limit not active'; return 1
  fi
  local before_upload before_other digest
  before_upload="$(probe "$UPLOAD_PROBE_PATH" $((3 * MIB)) "$PROBE_ORIGIN")"
  before_other="$(probe "$OTHER_PROBE_PATH" $((3 * MIB)) "$PROBE_ORIGIN")"
  info "before: 3 MiB upload => $before_upload; 3 MiB to another Mail route => $before_other"
  digest="$(others_digest "$real")"
  local stamp; stamp="$(date -u +%Y%m%dT%H%M%SZ)"; local bdir="$NGINX_BACKUPS/$stamp"; mkdir -p "$bdir"
  cp -a "$real" "$bdir/vhost.conf"; printf '%s\n' "$real" > "$bdir/vhost.path"
  if [[ -f "$SNIPPET" ]]; then cp -a "$SNIPPET" "$bdir/snippet.conf"; fi
  nginx_effective > "$bdir/effective-before.txt" 2>/dev/null || true; chmod 600 "$bdir"/*
  info "backup of the effective configuration, vhost file and snippet: $bdir (root-only)"
  mkdir -p /etc/nginx/snippets
  cp "$generated" "$SNIPPET"; chmod 644 "$SNIPPET"; rm -f "$generated"
  if ! grep -qF "$INCLUDE_LINE" "$real"; then
    awk -v inc="    $INCLUDE_LINE" -v target="$lstart" 'NR == target { print inc } { print }' "$real" > "$NGINX_BACKUPS/.vhost-new.$$" && cat "$NGINX_BACKUPS/.vhost-new.$$" > "$real" && rm -f "$NGINX_BACKUPS/.vhost-new.$$"
  fi
  if ! nginx -t >"$bdir/nginx-t.txt" 2>&1; then
    cp -a "$bdir/vhost.conf" "$real"; if [[ -f "$bdir/snippet.conf" ]]; then cp -a "$bdir/snippet.conf" "$SNIPPET"; else rm -f "$SNIPPET"; fi
    fail "nginx -t failed; previous configuration restored, Nginx was not reloaded ($(tail -n 2 "$bdir/nginx-t.txt" | tr '\n' ' '))"; return 1
  fi
  pass 'nginx -t passed'
  if ! reload_nginx; then
    restore_backup "$bdir" "$real" || true
    fail 'reload failed; previous configuration restored'; return 1
  fi
  pass 'nginx reloaded'
  local -a problems=()
  effective_has "$f" -F "$INCLUDE_LINE" || problems+=('vhost include not in the effective config')
  effective_has "$SNIPPET" -E '^[[:space:]]*client_max_body_size 26m;' || problems+=('26m limit not in the effective config')
  effective_has "$SNIPPET" -E '^[[:space:]]*error_page 413 @ca_mail_upload_too_large;' || problems+=('JSON 413 handler not in the effective config')
  [[ "$(others_digest "$real")" == "$digest" ]] || problems+=('a file other than the target vhost/snippet changed under /etc/nginx')
  sleep 2
  local after_upload after_other over_ok over_foreign
  after_upload="$(probe "$UPLOAD_PROBE_PATH" $((3 * MIB)) "$PROBE_ORIGIN")"
  after_other="$(probe "$OTHER_PROBE_PATH" $((3 * MIB)) "$PROBE_ORIGIN")"
  over_ok="$(probe "$UPLOAD_PROBE_PATH" $((27 * MIB)) "$PROBE_ORIGIN")"
  over_foreign="$(probe "$UPLOAD_PROBE_PATH" $((27 * MIB)) https://untrusted.example)"
  info "after: 3 MiB upload => $after_upload; 3 MiB to another Mail route => $after_other"
  info "after: 27 MiB upload from $PROBE_ORIGIN => $over_ok; from an untrusted origin => $over_foreign"
  if [[ "$after_upload" == na ]]; then
    info 'live probe unavailable on this host (curl/loopback); verify through the public hostname'
  else
    [[ "${after_upload%% *}" != 413 ]] || problems+=('3 MiB upload is still refused by Nginx')
    [[ "${after_upload%% *}" == "${before_upload%% *}" || "${before_upload%% *}" == 413 ]] || problems+=("3 MiB upload status changed unexpectedly ($before_upload -> $after_upload)")
    [[ "$before_other" == na || "${after_other%% *}" == "${before_other%% *}" ]] || problems+=("another route changed ($before_other -> $after_other)")
    [[ "$over_ok" == "413 $PROBE_ORIGIN" ]] || problems+=("over-ceiling 413 lacks the trusted-origin CORS header ($over_ok)")
    [[ "$over_foreign" == "413 -" ]] || problems+=("over-ceiling 413 sent CORS to an untrusted origin ($over_foreign)")
  fi
  if (( ${#problems[@]} )); then
    local p; for p in "${problems[@]}"; do fail "$p"; done
    if restore_backup "$bdir" "$real"; then fail "verification failed; previous configuration restored from $bdir and reloaded"
    else fail "verification failed AND automatic restore of $bdir failed: run nginx-upload-rollback --target=$target"; fi
    return 1
  fi
  pass "effective config allows 26m on the $target Mail attachment upload path only; other routes unchanged; JSON 413 with trusted-origin CORS above the ceiling"
  info "rollback: dispatch nginx-upload-rollback with target=$target (restores $bdir)"
}

nginx_upload_rollback() {
  info "target: $target ($VHOST_HOST)"
  local latest; latest="$(find "$NGINX_BACKUPS" -mindepth 1 -maxdepth 1 -type d -name '20*' 2>/dev/null | sort | tail -n 1 || true)"
  [[ -n "$latest" && -f "$latest/vhost.conf" && -f "$latest/vhost.path" ]] || { fail "no $target backup found in $NGINX_BACKUPS"; return 1; }
  local real; real="$(cat "$latest/vhost.path")"
  [[ "$real" == /etc/nginx/* && -f "$real" ]] || { fail "backup names an unexpected vhost path ($real)"; return 1; }
  local cur; cur="$(vhost_file)" && [[ "$(readlink -f "$cur")" != "$real" ]] && { fail "BLOCKED: the $target vhost is now $cur, not the backed-up $real; nothing changed"; return 1; }
  local current="$NGINX_BACKUPS/.pre-rollback.$$"; mkdir -p "$current"
  cp -a "$real" "$current/vhost.conf"; if [[ -f "$SNIPPET" ]]; then cp -a "$SNIPPET" "$current/snippet.conf"; fi
  cp -a "$latest/vhost.conf" "$real"
  if [[ -f "$latest/snippet.conf" ]]; then cp -a "$latest/snippet.conf" "$SNIPPET"; else rm -f "$SNIPPET"; fi
  if ! nginx -t >/dev/null 2>&1; then
    cp -a "$current/vhost.conf" "$real"; if [[ -f "$current/snippet.conf" ]]; then cp -a "$current/snippet.conf" "$SNIPPET"; else rm -f "$SNIPPET"; fi
    rm -rf "$current"; fail 'nginx -t failed with the backup; current configuration kept, nothing reloaded'; return 1
  fi
  rm -rf "$current"
  reload_nginx && pass "restored $latest for $target and reloaded" || { fail 'reload failed'; return 1; }
  info "probe 3 MiB upload: $(probe "$UPLOAD_PROBE_PATH" $((3 * MIB)) "$PROBE_ORIGIN")"
}

case "$mode" in
  --host-audit) host_audit ;;
  --secure-production-env) secure_production_env ;;
  --staging-env-access) staging_env_access ;;
  --nginx-upload-diagnose) nginx_upload_diagnose ;;
  --nginx-upload-apply) nginx_upload_apply ;;
  --nginx-upload-rollback) nginx_upload_rollback ;;
esac
