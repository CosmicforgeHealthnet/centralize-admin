#!/usr/bin/env bash
# Run once as an authorized VPS administrator from a trusted, pinned checkout.
# No production configuration, application secrets or Docker services are changed.
set -euo pipefail
umask 077
[[ "$(id -u)" == 0 ]] || { echo "Run as the authorized VPS administrator (root)." >&2; exit 1; }
[[ $# == 1 && "$1" =~ ^[a-f0-9]{40}$ ]] || { echo "Usage: $0 REVIEWED_FULL_COMMIT_SHA" >&2; exit 2; }
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
[[ "$(git -C "$repo" rev-parse HEAD)" == "$1" ]] || { echo "Checkout does not match reviewed revision." >&2; exit 1; }
[[ "$(git -C "$repo" remote get-url origin)" == https://github.com/CosmicforgeHealthnet/centralize-admin.git ]] || { echo "Unexpected repository origin." >&2; exit 1; }
[[ -z "$(git -C "$repo" status --porcelain)" ]] || { echo "Require a clean reviewed checkout." >&2; exit 1; }
id cf-staging-deploy >/dev/null
[[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' admin-server-staging-app-1)" == admin-server-staging ]]
base=/opt/cosmicforge/product-admin-staging
install -d -o root -g root -m 0755 /opt/cosmicforge "$base"
# A single capability install/update is serialized with actual host operations.
exec 9>/run/lock/cf-product-admin-staging.lock
flock -n 9 || { echo "Another Product Admin operation is running." >&2; exit 1; }
tmp="$(mktemp -d "$base/.install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
git -C "$repo" archive "$1" infrastructure/product-admin/release/pa-staging-ops.sh \
  infrastructure/product-admin/release/pa-staging-db-bootstrap.py \
  infrastructure/product-admin/release/pa-staging-capability.py \
  infrastructure/product-admin/staging/network-policy.json \
  infrastructure/product-admin/staging/docker-compose.yml \
  infrastructure/product-admin/nginx/internal-deny.conf \
  infrastructure/product-admin/firewall/docker-user-rules.sh \
  infrastructure/scripts/product-admin-infra-check.mjs | tar -xf - -C "$tmp"
[[ -z "$(find "$tmp" -type l -print -quit)" ]] || { echo "Unexpected symlink." >&2; exit 1; }
chown -R root:root "$tmp"; chmod -R go-w "$tmp"; chmod 0755 "$tmp"
bash -n "$tmp/infrastructure/product-admin/release/pa-staging-ops.sh"
bash -n "$tmp/infrastructure/product-admin/firewall/docker-user-rules.sh"
python3 -I -m py_compile "$tmp/infrastructure/product-admin/release/pa-staging-capability.py" "$tmp/infrastructure/product-admin/release/pa-staging-db-bootstrap.py"
rule="$tmp/sudoers"
printf '%s\n' 'cf-staging-deploy ALL=(root) NOPASSWD: /usr/local/sbin/cf-product-admin-staging ""' > "$rule"
chmod 0440 "$rule"; visudo -cf "$rule"
install -o root -g root -m 0440 "$rule" /etc/sudoers.d/cf-product-admin-staging
rm "$rule"
# No mutable checkout is executed via sudo. Preserve the last approved bundle.
if [[ -e "$base/bundle" ]]; then
  [[ ! -L "$base/bundle" ]] || exit 1
  mv "$base/bundle" "$base/bundle.previous.$(date +%s)"
fi
mv "$tmp" "$base/bundle"
install -o root -g root -m 0755 "$base/bundle/infrastructure/product-admin/release/pa-staging-capability.py" /usr/local/sbin/cf-product-admin-staging
printf '%s\n' '{"op":"probe"}' | runuser -u cf-staging-deploy -- sudo -n /usr/local/sbin/cf-product-admin-staging
echo "Installed scoped staging capability for reviewed commit $1. No service or production changes made."
