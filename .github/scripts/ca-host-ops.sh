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
#                            include) for the CA staging API vhost, and recent
#                            Nginx 413 counts for the Mail upload path.
#   --nginx-upload-apply     Staging CA API vhost only: back up its file, add the
#                            managed upload-limit snippet include, nginx -t,
#                            reload; any failure restores the backup.
#   --nginx-upload-rollback  Restore the newest backup taken by apply.
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
case "$mode" in --host-audit|--secure-production-env|--staging-env-access|--nginx-upload-diagnose|--nginx-upload-apply|--nginx-upload-rollback) ;; *) echo 'Usage: ca-host-ops.sh --host-audit|--secure-production-env|--staging-env-access|--nginx-upload-diagnose|--nginx-upload-apply|--nginx-upload-rollback' >&2; exit 2 ;; esac
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
readonly SNIPPET=/etc/nginx/snippets/ca-mail-upload-limits.conf
readonly INCLUDE_LINE="include $SNIPPET;"
readonly NGINX_BACKUPS=/var/backups/centralize-admin/nginx
readonly TPL="${CA_MAIL_BUNDLE_DIR:-$(dirname "$0")}/ca-mail-upload-limits.conf.tpl"

# Prints only directive lines relevant to uploads; never certificates, keys or tokens.
nginx_effective() { nginx -T 2>/dev/null; }
vhost_file() { # -> the single file whose server block names the CA staging host
  local f; local -a hits=()
  while IFS= read -r f; do hits+=("$f"); done < <(nginx_effective | awk -v host="$CA_STAGING_VHOST" '/^# configuration file /{file=$4; sub(":$","",file)} $1=="server_name" && index($0,host){print file}' | sort -u)
  (( ${#hits[@]} == 1 )) || { echo "ambiguous-or-missing (${#hits[@]} files)"; return 1; }
  echo "${hits[0]}"
}
nginx_upload_diagnose() {
  info "nginx version: $(nginx -v 2>&1)"
  local f; f="$(vhost_file)" || { fail "CA staging vhost file: $f"; return 1; }
  pass "CA staging vhost file: $f"
  info "client_max_body_size directives (file: line): $(nginx_effective | awk '/^# configuration file /{file=$4; sub(":$","",file)} $1=="client_max_body_size"{print file": "$0}' | tr '\n' ';')"
  info "global/http default applies when none is set: 1m (Nginx built-in)"
  info "vhost proxy_pass lines: $(grep -E '^\s*(location|proxy_pass|include|client_max_body_size|server_name)\b' "$f" | grep -v -E 'ssl_|key|cert' | sed 's/^\s*//' | tr '\n' ';')"
  [[ -f "$SNIPPET" ]] && info "managed snippet present: $(grep -c location "$SNIPPET") locations" || info 'managed snippet not installed'
  grep -qF "$INCLUDE_LINE" "$f" && info 'vhost includes the managed snippet' || info 'vhost does NOT include the managed snippet'
  local log; for log in /var/log/nginx/access.log /var/log/nginx/error.log; do
    [[ -r "$log" ]] || continue
    info "$(basename "$log"): last-24h-ish tail counts => 413 on attachments: $(tail -n 20000 "$log" | grep -E 'drafts/[^ ]+/attachments' | grep -cE '" 413 |client intended to send too large body' || true)"
  done
  info 'sampled log lines were counted only; no addresses, tokens or bodies were printed'
}
nginx_upload_apply() {
  [[ -f "$TPL" ]] || { fail "snippet template missing from bundle ($TPL)"; return 1; }
  local f; f="$(vhost_file)" || { fail "CA staging vhost file: $f"; return 1; }
  [[ "$f" == /etc/nginx/* ]] || { fail "unexpected vhost path $f"; return 1; }
  local real="$f"; [[ -L "$f" ]] && real="$(readlink -f "$f")"
  # The one proxied "location / {" block (the vhost also has a Certbot HTTP
  # redirect block whose "location /" has no proxy_pass).
  local span lstart lend
  span="$(awk '
    function count(str, ch,   parts) { return split(str, parts, ch) - 1 }
    /^[ \t]*location[ \t]+\/[ \t]*\{/ && !inloc { inloc = 1; start = NR; depth = 0; proxied = 0 }
    inloc { depth += count($0, "{") - count($0, "}"); if ($1 == "proxy_pass") proxied = 1
            if (depth <= 0) { if (proxied) { found++; fs = start; fe = NR } inloc = 0 } }
    END { if (found == 1) print fs, fe; else print "0 0" }' "$real")"
  read -r lstart lend <<<"$span"
  (( lstart > 0 && lend > lstart )) || { fail 'BLOCKED: vhost does not have exactly one proxied "location / {"; nothing changed'; return 1; }
  local body="$NGINX_BACKUPS/.body.$$"; mkdir -p "$NGINX_BACKUPS"; chmod 700 "$NGINX_BACKUPS"
  sed -n "$((lstart + 1)),$((lend - 1))p" "$real" | grep -vE '^[[:space:]]*(client_max_body_size|client_body_timeout|proxy_read_timeout|proxy_send_timeout)\b' > "$body"
  grep -qE '^[[:space:]]*proxy_pass[[:space:]]+http://(localhost|127\.0\.0\.1):[0-9]+/?;' "$body" || { rm -f "$body"; fail 'BLOCKED: unexpected upstream form in the proxied location; nothing changed'; return 1; }
  grep -qE 'proxy_pass[^;]*\$' "$body" && { rm -f "$body"; fail 'BLOCKED: variable proxy_pass is not supported; nothing changed'; return 1; }
  info "proxied location body copied for the upload paths: $(sed 's/^[[:space:]]*//' "$body" | tr '\n' ' ' | cut -c1-300)"
  local generated="$NGINX_BACKUPS/.snippet.$$"
  awk -v bodyfile="$body" '/__LOCATION_BODY__/ { while ((getline l < bodyfile) > 0) print "    " l; close(bodyfile); next } { print }' "$TPL" > "$generated"
  # Idempotent: an already-applied, unchanged configuration is not re-backed-up
  # (a second backup would capture the fixed state and defeat rollback).
  if grep -qF "$INCLUDE_LINE" "$real" && [[ -f "$SNIPPET" ]] && cmp -s "$generated" "$SNIPPET"; then
    rm -f "$body" "$generated"
    nginx_effective | grep -q 'client_max_body_size 26m' && pass 'already applied: effective config allows 26m on the Mail attachment upload path (no change made)' || fail 'include present but effective limit not active'
    return 0
  fi
  local stamp; stamp="$(date -u +%Y%m%dT%H%M%SZ)"; local bdir="$NGINX_BACKUPS/$stamp"; mkdir -p "$bdir"
  cp -a "$real" "$bdir/vhost.conf"; printf '%s\n' "$real" > "$bdir/vhost.path"
  [[ -f "$SNIPPET" ]] && cp -a "$SNIPPET" "$bdir/snippet.conf" || true
  nginx_effective > "$bdir/effective-before.txt" 2>/dev/null || true; chmod 600 "$bdir"/*
  info "backup of the effective configuration and vhost file: $bdir (root-only)"
  mkdir -p /etc/nginx/snippets
  cp "$generated" "$SNIPPET"; chmod 644 "$SNIPPET"; rm -f "$body" "$generated"
  if ! grep -qF "$INCLUDE_LINE" "$real"; then
    awk -v inc="    $INCLUDE_LINE" -v target="$lstart" 'NR == target { print inc } { print }' "$real" > "$NGINX_BACKUPS/.vhost-new.$$" && cat "$NGINX_BACKUPS/.vhost-new.$$" > "$real" && rm -f "$NGINX_BACKUPS/.vhost-new.$$"
  fi
  if ! nginx -t >"$bdir/nginx-t.txt" 2>&1; then
    cp -a "$bdir/vhost.conf" "$real"; [[ -f "$bdir/snippet.conf" ]] && cp -a "$bdir/snippet.conf" "$SNIPPET" || rm -f "$SNIPPET"
    fail "nginx -t failed; previous configuration restored ($(tail -n 2 "$bdir/nginx-t.txt" | tr '\n' ' '))"; return 1
  fi
  pass 'nginx -t passed'
  if ! { systemctl reload nginx 2>/dev/null || nginx -s reload; }; then
    cp -a "$bdir/vhost.conf" "$real"; [[ -f "$bdir/snippet.conf" ]] && cp -a "$bdir/snippet.conf" "$SNIPPET" || rm -f "$SNIPPET"
    nginx -t >/dev/null 2>&1 && { systemctl reload nginx 2>/dev/null || nginx -s reload; }
    fail 'reload failed; previous configuration restored'; return 1
  fi
  nginx_effective | grep -q 'client_max_body_size 26m' && pass 'effective config now allows 26m on the Mail attachment upload path' || { fail 'effective config does not show the 26m limit'; return 1; }
  info "rollback: dispatch operation nginx-upload-rollback (restores $bdir) or restore it manually"
}
nginx_upload_rollback() {
  local latest; latest="$(ls -1d "$NGINX_BACKUPS"/*/ 2>/dev/null | sort | tail -n 1 || true)"
  [[ -n "$latest" && -f "$latest/vhost.conf" ]] || { fail 'no backup found'; return 1; }
  local real; real="$(cat "$latest/vhost.path")"
  cp -a "$latest/vhost.conf" "$real"
  if [[ -f "$latest/snippet.conf" ]]; then cp -a "$latest/snippet.conf" "$SNIPPET"; else rm -f "$SNIPPET"; fi
  nginx -t >/dev/null 2>&1 || { fail 'nginx -t failed after restore'; return 1; }
  { systemctl reload nginx 2>/dev/null || nginx -s reload; } && pass "restored $latest and reloaded" || fail 'reload failed'
}

case "$mode" in
  --host-audit) host_audit ;;
  --secure-production-env) secure_production_env ;;
  --staging-env-access) staging_env_access ;;
  --nginx-upload-diagnose) nginx_upload_diagnose ;;
  --nginx-upload-apply) nginx_upload_apply ;;
  --nginx-upload-rollback) nginx_upload_rollback ;;
esac
