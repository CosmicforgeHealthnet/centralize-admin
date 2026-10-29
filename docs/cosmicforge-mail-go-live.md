# CosmicForge Mail go-live: what to paste where

Everything below is installed by GitHub Actions; nobody needs a server shell.
Values live only in GitHub secrets and the root-only server `.env`; no workflow prints them.

## 1. Secrets (GitHub -> Settings -> Environments -> `production` -> Add secret)

One secret per target. Content: plain `KEY=value` lines. Only `MAIL_*` and `RESEND_*`
keys are accepted. No `*_ENABLED` switches here; switches are set with the visible
`flags` input of the install workflow.

### `CA_STAGING_MAIL_ENV` (staging pilot: no AWS needed)

```dotenv
MAIL_DEPLOYMENT_ENV=staging
MAIL_PROVIDER=resend
MAIL_PROVIDER_ENVIRONMENT_TAG=staging
RESEND_API_KEY=<CA Resend API key, full access>
MAIL_DOMAIN_ALLOWLIST=karryam.com
MAIL_RESERVED_SENDER_ADDRESSES=no-reply@karryam.com
MAIL_TEST_RECIPIENT_ALLOWLIST=<your Gmail address>,<your Outlook address>
MAIL_INBOUND_ACTIVE_ENVIRONMENT=production
MAIL_MIXED_RECIPIENT_MODE=external-only
MAIL_UNKNOWN_RECIPIENT_POLICY=reject
MAIL_SCANNER_PROVIDER=clamd
MAIL_CLAMD_HOST=clamav
MAIL_CLAMD_PORT=3310
MAIL_PUBLIC_API_URL=https://stagingca.cosmicforge-healthnet.com
MAIL_PUBLIC_APP_URL=https://centralize-admin-staging.vercel.app
```

Staging uses encrypted filesystem storage and an environment keyring (the code allows
both on staging only). Run `CA Mail staging operations` with `operation=pilot-storage-setup`
and `confirm=APPLY_STAGING_MAIL_CHANGES` once: it creates the volume
`admin-server-staging-mail-store`, mounts it at `/var/lib/cosmicforge-mail` in the app and the
worker, and generates the keyring on the server, so it never passes through GitHub. A rerun
keeps the existing keyring. Staging releases keep the mount.
`MAIL_INBOUND_ACTIVE_ENVIRONMENT=production` because the one Resend webhook points at
production: staging sends, production receives.

### `CA_PRODUCTION_MAIL_ENV`

```dotenv
MAIL_DEPLOYMENT_ENV=production
MAIL_PROVIDER=resend
MAIL_PROVIDER_ENVIRONMENT_TAG=production
RESEND_API_KEY=<CA Resend API key, full access>
RESEND_WEBHOOK_SECRET=<whsec_... of the single webhook>
MAIL_DOMAIN_ALLOWLIST=karryam.com
MAIL_RESERVED_SENDER_ADDRESSES=no-reply@karryam.com
MAIL_INBOUND_ACTIVE_ENVIRONMENT=production
MAIL_MIXED_RECIPIENT_MODE=external-only
MAIL_UNKNOWN_RECIPIENT_POLICY=reject
MAIL_PROVIDER_DAILY_LIMIT=<plan daily limit>
MAIL_PROVIDER_MONTHLY_LIMIT=<plan monthly limit>
MAIL_SCANNER_PROVIDER=clamd
MAIL_CLAMD_HOST=clamav
MAIL_CLAMD_PORT=3310
MAIL_STORAGE_PROVIDER=s3
MAIL_S3_REGION=<region>
MAIL_S3_BUCKET=cosmicforge-mail-production-private
MAIL_S3_SSE=AWS:KMS
MAIL_S3_SSE_KMS_KEY_ID=<terraform output bucket_sse_key_arn>
MAIL_S3_HEALTH_CANARY=false
MAIL_S3_ACCESS_KEY_ID=<IAM access key id>
MAIL_S3_SECRET_ACCESS_KEY=<IAM secret access key>
MAIL_KMS_PROVIDER=aws-kms
MAIL_KMS_REGION=<region>
MAIL_KMS_KEY_ID=alias/cosmicforge-mail-production
MAIL_PUBLIC_API_URL=https://liveca.cosmicforge-healthnet.com
MAIL_PUBLIC_APP_URL=https://centralize-admin.vercel.app
```

`MAIL_ENCRYPTION_KEYS` / `MAIL_ENCRYPTION_ACTIVE_KEY` are generated on the server with the
installed KMS credentials (`mail:kms:generate-data-key`), not pasted.

## 2. AWS (production only), minimum

`terraform -chdir=infrastructure/mail/storage/terraform apply -var environment=production -var region=<region>`
creates the private, versioned, Object-Lock bucket `cosmicforge-mail-production-private`, the
keyring key `alias/cosmicforge-mail-production` and the bucket SSE key. Then create one IAM
user (for example `cosmicforge-mail-production-api`) with
`infrastructure/mail/storage/iam-policy-mail-api.json`, its resource ARNs set to that bucket
and the two keys, and one access key for it. Nothing else in AWS is needed.

## 3. Resend

- `karryam.com`: verified, with DKIM (`resend._domainkey`), SPF and bounce MX on `send.`,
  DMARC `p=none` and root MX on Resend inbound. These were checked in public DNS on 2026-10-29.
- One API key for Centralize Admin (full access: CA reads received mail and domain status).
- The one webhook: `https://liveca.cosmicforge-healthnet.com/api/mail/v1/webhooks/resend`,
  events `email.received`, `email.sent`, `email.delivered`, `email.delivery_delayed`,
  `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`. CA acknowledges
  Karryam's events without storing them. Point it there only after production runs the Mail
  release and the secret is installed (before that the endpoint answers 404/503).

## 4. Workflows (Actions tab)

| Workflow | Use |
|---|---|
| `CA Mail settings install` | `target`, `mode=preview` then `mode=apply` with `confirm=APPLY_MAIL_SETTINGS` / `APPLY_PRODUCTION_MAIL_SETTINGS`; switches in `flags` |
| `CA Mail staging operations` | `staging-checks`, `host-audit`, `secure-production-env`, `pilot-storage-setup`, `services-*`, `migrate-*` (`target=production` needs `APPLY_PRODUCTION_MAIL_MIGRATIONS`) |
| `Production - Build & Push & Deploy` | from `main`: `preflight`, then `deploy` with `confirm=DEPLOY_PRODUCTION` (immutable image, checks, automatic rollback) |
