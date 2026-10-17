#!/usr/bin/env bash
set -euo pipefail
# Run from a local clone of CosmicforgeHealthnet/centralize-admin
# on the chore/fullstack-centralize-admin branch.
test -d services/main-admin || { echo "Run from the monorepo root on the migration branch" >&2; exit 1; }
test "$(git branch --show-current)" = "chore/fullstack-centralize-admin" || { echo "Checkout the migration branch first" >&2; exit 1; }
test -z "$(git status --porcelain)" || { echo "Commit or stash local changes first" >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone --depth 1 https://github.com/CosmicforgeHealthnet/main-admin-frontend.git "$tmp/frontend"
mkdir -p web/main-admin-frontend
find web/main-admin-frontend -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {} +
cp -a "$tmp/frontend/." web/main-admin-frontend/
rm -rf web/main-admin-frontend/.git
git add -A web/main-admin-frontend
git commit -m "feat: import main admin frontend into monorepo"
echo "Frontend imported. Run npm ci and npm run build in web/main-admin-frontend; validate backend and workflows before merging into staging."
