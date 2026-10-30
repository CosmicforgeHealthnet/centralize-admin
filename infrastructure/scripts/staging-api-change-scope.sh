#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <base-commit-sha> <head-commit-sha> [repository-directory]" >&2
  exit 2
fi

base_sha="$1"
head_sha="$2"
repository="${3:-.}"

if [[ ! "$base_sha" =~ ^[[:xdigit:]]{40}$ || ! "$head_sha" =~ ^[[:xdigit:]]{40}$ ]]; then
  echo "Expected full 40-character base and head commit SHAs; refusing deployment classification." >&2
  exit 2
fi

if ! git -C "$repository" cat-file -e "${base_sha}^{commit}" 2>/dev/null; then
  echo "Base SHA is not an available commit; refusing deployment classification." >&2
  exit 2
fi
if ! git -C "$repository" cat-file -e "${head_sha}^{commit}" 2>/dev/null; then
  echo "Head SHA is not an available commit; refusing deployment classification." >&2
  exit 2
fi
if ! git -C "$repository" merge-base --is-ancestor "$base_sha" "$head_sha"; then
  echo "Base SHA is not an ancestor of head SHA; refusing deployment classification." >&2
  exit 2
fi

changed_paths="$(mktemp)"
trap 'rm -f "$changed_paths"' EXIT
git -C "$repository" diff --name-only --no-renames -z "$base_sha" "$head_sha" -- > "$changed_paths"

while IFS= read -r -d '' path; do
  # Documentation and test-only edits in the API package do not create or
  # replace a runtime image. A mixed change still qualifies when it contains
  # at least one deployable source/configuration path.
  case "$path" in
    docs/*|*/docs/*|documentation/*|*/documentation/*|*.md|*.mdx|*.rst|*.adoc|*.txt|*.pdf|\
    */test/*|*/tests/*|*/__tests__/*|*/__snapshots__/*|*/fixtures/*|*/__fixtures__/*|\
    *.test.*|*.spec.*|*.e2e.*|*.integration.*|*-test.*|*.fixture.*|*.fixtures.*)
      continue
      ;;
  esac

  # The production image build context copies the API service and uses the
  # root Dockerfile. Keep this list narrow so frontend, docs, tests, and this
  # workflow's own changes cannot authorize SSH or image publication.
  case "$path" in
    services/central-admin-api/*|Dockerfile|.dockerignore)
      printf 'true\n'
      exit 0
      ;;
  esac
done < "$changed_paths"

printf 'false\n'
