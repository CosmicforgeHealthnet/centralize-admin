#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
classifier="$script_dir/staging-api-change-scope.sh"
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

case_number=0
run_case() {
  local name="$1"
  local expected="$2"
  shift 2
  case_number=$((case_number + 1))
  local repository="$tmp_root/case-$case_number"
  mkdir -p "$repository"
  git -C "$repository" init --quiet --initial-branch=main
  git -C "$repository" config user.name "Deployment Scope Test"
  git -C "$repository" config user.email "deployment-scope@example.invalid"
  printf 'base\n' > "$repository/base.txt"
  git -C "$repository" add --all
  git -C "$repository" commit --quiet -m base
  local base_sha
  base_sha="$(git -C "$repository" rev-parse HEAD)"

  local relative_path
  for relative_path in "$@"; do
    mkdir -p "$repository/$(dirname -- "$relative_path")"
    printf 'fixture\n' > "$repository/$relative_path"
  done
  git -C "$repository" add --all
  git -C "$repository" commit --quiet -m "$name"
  local head_sha actual
  head_sha="$(git -C "$repository" rev-parse HEAD)"
  actual="$(bash "$classifier" "$base_sha" "$head_sha" "$repository")"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $name expected $expected, got $actual" >&2
    exit 1
  fi
  echo "PASS: $name => api_changed=$actual"

  if [[ "$name" == "frontend-only" ]]; then
    if bash "$classifier" not-a-full-sha "$head_sha" "$repository" >/dev/null 2>&1; then
      echo "FAIL: invalid base SHA was accepted" >&2
      exit 1
    fi
    echo "PASS: invalid base SHA fails closed"
  fi
}

run_case frontend-only false "apps/central-admin-web/src/components/mail/MailShell.tsx"
run_case docs-only false "docs/admin-mail/acceptance.md" "services/central-admin-api/docs/readme.md"
run_case tests-only false "services/central-admin-api/tests/bridge.test.ts" "services/central-admin-api/src/authz.test.ts" "services/central-admin-api/src/server.e2e.ts" "services/central-admin-api/src/__fixtures__/session.json"
run_case workflow-only false ".github/workflows/staging.yml"
run_case workflow-and-frontend false ".github/workflows/staging.yml" "apps/central-admin-web/src/app/dashboard/mail/page.tsx"
run_case backend-source true "services/central-admin-api/src/server.ts"
run_case backend-migration true "services/central-admin-api/prisma/migrations/001_initial/migration.sql"
run_case image-build-input true "Dockerfile"
run_case image-ignore-input true ".dockerignore"
run_case mixed-code-tests-docs true "services/central-admin-api/src/server.ts" "services/central-admin-api/tests/server.test.ts" "docs/rollout.md"

echo "All staging API deployment scope checks passed."
