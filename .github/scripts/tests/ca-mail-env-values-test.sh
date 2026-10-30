#!/usr/bin/env bash
# Tests for .github/scripts/ca-mail-env-values.py (no secrets, no network):
# which settings are assembled for each target, that only the two shared
# Resend keys ever come from the production secret, the refusals, and that
# no value is ever printed on stderr (the workflow log).
set -euo pipefail
cd "$(dirname "$0")/../../.."
S=.github/scripts/ca-mail-env-values.py
P=infrastructure/mail/env/staging.env
PROD=$'MAIL_DEPLOYMENT_ENV=production\nMAIL_PROVIDER_ENVIRONMENT_TAG=production\nMAIL_PUBLIC_API_URL=https://liveca.example\nRESEND_API_KEY=re_PRODSECRET\nRESEND_WEBHOOK_SECRET=whsec_PRODSECRET'
pass=0
ok() { pass=$((pass + 1)); echo "PASS $1"; }
no() { echo "FAIL $1"; exit 1; }
run() { env -i PATH="$PATH" PROFILE="$P" "$@" python3 "$S"; }

out="$(run TARGET=staging CREDENTIALS=shared-from-production STAGING_VALUES='MAIL_TEST_RECIPIENT_ALLOWLIST=tester@example.com' PRODUCTION_VALUES="$PROD" 2>/dev/null)"
grep -qx 'RESEND_API_KEY=re_PRODSECRET' <<<"$out" && grep -qx 'RESEND_WEBHOOK_SECRET=whsec_PRODSECRET' <<<"$out" && ok 'shared: the two Resend keys come from production' || no 'shared keys'
grep -qx 'MAIL_DEPLOYMENT_ENV=staging' <<<"$out" && grep -qx 'MAIL_PROVIDER_ENVIRONMENT_TAG=staging' <<<"$out" && grep -qx 'MAIL_PUBLIC_API_URL=https://stagingca.cosmicforge-healthnet.com' <<<"$out" \
  && ok 'shared: nothing else is taken from production (environment, tag, URLs stay staging)' || no 'leak'
grep -qx 'MAIL_TEST_RECIPIENT_ALLOWLIST=tester@example.com' <<<"$out" && grep -qx 'MAIL_INBOUND_ACTIVE_ENVIRONMENT=production' <<<"$out" && ok 'staging secret and profile both installed' || no 'merge'
! grep -q '_ENABLED=' <<<"$out" && ok 'no switch comes from any source' || no 'switch'
err="$(run TARGET=staging CREDENTIALS=shared-from-production STAGING_VALUES='MAIL_TEST_RECIPIENT_ALLOWLIST=tester@example.com' PRODUCTION_VALUES="$PROD" 2>&1 >/dev/null)"
! grep -q 'PRODSECRET\|tester@example.com' <<<"$err" && grep -q 'RESEND_API_KEY: CA_PRODUCTION_MAIL_ENV (shared)' <<<"$err" && ok 'stderr names sources, never values' || no 'stderr'
out="$(run TARGET=staging CREDENTIALS=secret STAGING_VALUES=$'MAIL_TEST_RECIPIENT_ALLOWLIST=a@b.example\nMAIL_DOMAIN_ALLOWLIST=other.example\nRESEND_API_KEY=re_STAGING' PRODUCTION_VALUES="$PROD" 2>/dev/null)"
grep -qx 'MAIL_DOMAIN_ALLOWLIST=other.example' <<<"$out" && grep -qx 'RESEND_API_KEY=re_STAGING' <<<"$out" && ! grep -q PRODSECRET <<<"$out" && ok 'secret mode: staging secret overrides the profile; production never read' || no 'secret mode'
out="$(run TARGET=production CREDENTIALS=secret PRODUCTION_VALUES="$PROD" 2>/dev/null)"
[[ "$(wc -l <<<"$out")" == 5 ]] && ! grep -q stagingca <<<"$out" && ok 'production: exactly its own secret, no staging profile' || no 'production'
refuse() { local why="$1"; shift; if run "$@" >/dev/null 2>&1; then no "refused: $why"; else ok "refused: $why"; fi; }
refuse 'shared for production' TARGET=production CREDENTIALS=shared-from-production PRODUCTION_VALUES="$PROD"
refuse 'staging secret also carries a shared key' TARGET=staging CREDENTIALS=shared-from-production STAGING_VALUES='RESEND_API_KEY=x' PRODUCTION_VALUES="$PROD"
refuse 'production lacks a shared key' TARGET=staging CREDENTIALS=shared-from-production STAGING_VALUES='' PRODUCTION_VALUES='RESEND_API_KEY=x'
refuse 'empty staging secret, no shared credentials, no flags' TARGET=staging CREDENTIALS=secret STAGING_VALUES='' PRODUCTION_VALUES="$PROD"
refuse 'key outside MAIL_/RESEND_' TARGET=staging CREDENTIALS=secret STAGING_VALUES='DATABASE_URL=x'
refuse 'duplicate key' TARGET=staging CREDENTIALS=secret STAGING_VALUES=$'MAIL_PROVIDER=resend\nMAIL_PROVIDER=fake'
refuse 'wrong deployment environment' TARGET=staging CREDENTIALS=secret STAGING_VALUES='MAIL_DEPLOYMENT_ENV=production'
refuse 'unknown credentials mode' TARGET=staging CREDENTIALS=other STAGING_VALUES='MAIL_PROVIDER=resend'
! grep -qE '^RESEND_|_ENABLED=' "$P" && ok 'committed profile holds no secret and no switch' || no 'profile'
echo "ca-mail-env-values: $pass passed"
