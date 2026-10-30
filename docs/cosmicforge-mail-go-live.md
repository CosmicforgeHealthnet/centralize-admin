# CosmicForge Mail go-live: what to paste where

Everything below is installed by GitHub Actions; nobody needs a server shell. Values live
only in GitHub secrets and on the server in root-only files, and no workflow prints them.

There is no AWS. Storage, encryption keys and backups are self-hosted on the Contabo VPS;
see `docs/cosmicforge-mail-self-hosted-storage.md`.

## 1. Secrets (GitHub -> Settings -> Environments -> `production` -> Add secret)

### `CA_STAGING_MAIL_ENV` and `CA_PRODUCTION_MAIL_ENV`

These hold Resend and the Mail policy. Content is plain `KEY=value` lines. Only `MAIL_*`
and `RESEND_*` keys are accepted, and `*_ENABLED` switches go in the visible `flags` input
of the install workflow. Storage, key and scanner settings are **not** in these secrets:
`storage-setup` installs them.

Staging needs only one value of its own, because its other settings are not
secret and live in the committed profile `infrastructure/mail/env/staging.env`
(deployment `staging`, Resend, `karryam.com`, inbound owned by production,
public URLs). With `provider_credentials=shared-from-production` the install
workflow also takes `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`, and only those
two, from `CA_PRODUCTION_MAIL_ENV`: one Resend account and one webhook serve both
deployments. So the staging secret is just:

```dotenv
# CA_STAGING_MAIL_ENV
MAIL_TEST_RECIPIENT_ALLOWLIST=<your Gmail address>,<your Outlook address>
```

Staging refuses to send without it: every external recipient must be on this
list. Any line here overrides the profile.

```dotenv
# CA_PRODUCTION_MAIL_ENV
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
MAIL_PUBLIC_API_URL=https://liveca.cosmicforge-healthnet.com
MAIL_PUBLIC_APP_URL=https://centralize-admin.vercel.app
```

`MAIL_INBOUND_ACTIVE_ENVIRONMENT=production` on both, because the one Resend webhook points
at production: staging sends, production receives. The app refuses to send without
`RESEND_WEBHOOK_SECRET`, so staging carries the same secret as production. That is still
one webhook.

Production acknowledges and drops delivery events for staging's mail (they carry
`cf_env=staging`). Staging therefore asks Resend for the status of its own recent sends
(`GET /emails/{id}`) every two minutes and records it like a webhook event, so Sent shows
Delivered / Bounced / Failed. This polling is on only where the deployment does not own
the webhook (`MAIL_DELIVERY_STATUS_POLLING_ENABLED` overrides).

### `CA_STAGING_MAIL_BACKUP_ENV` and `CA_PRODUCTION_MAIL_BACKUP_ENV` (off-host backups)

```dotenv
RESTIC_REPOSITORY=s3:https://<endpoint>/<bucket>/<staging|production>
RESTIC_PASSWORD=<at least 24 random characters; keep a copy in your password manager>
AWS_ACCESS_KEY_ID=<access key>      # restic's variable names for ANY S3-compatible storage
AWS_SECRET_ACCESS_KEY=<secret key>
AWS_DEFAULT_REGION=<region>
```

Use any S3-compatible storage away from the VPS, for example Contabo Object Storage in
another region. A restic REST server (`rest:https://...`) also works. The `AWS_*` names
are just restic's names for any S3-compatible service; no AWS account is involved.

## 2. Recovery key (owner, once per environment, on your own computer)

Without this key, mail content cannot be recovered if the VPS is lost.

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out cosmicforge-mail-recovery-production.key
openssl pkey -in cosmicforge-mail-recovery-production.key -pubout -out production.pub
```

- Keep the **private** `.key` file offline, in two places (for example a password manager
  and an encrypted USB drive). Never upload it.
- Commit only the **public** file as `infrastructure/mail/recovery/production.pub`, and do
  the same for staging. A public key is safe to share.
- The next `storage-setup` run seals the keyring to it, and every backup then carries the
  escrow.

## 3. Resend

- `karryam.com` is already verified in public DNS (checked 2026-10-29): DKIM
  `resend._domainkey`, SPF and bounce MX on `send.`, DMARC `p=none`, and the root MX on
  Resend inbound.
- One API key for Centralize Admin, with full access (CA reads received mail and domain
  status).
- The one webhook is `https://liveca.cosmicforge-healthnet.com/api/mail/v1/webhooks/resend`.
  - Events: `email.received`, `email.sent`, `email.delivered`, `email.delivery_delayed`,
    `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`.
  - CA acknowledges Karryam's events without storing them.
  - Point the webhook there only after production runs the Mail release and the secret is
    installed. Before that, the endpoint answers 404 or 503.

## 4. Workflows (Actions tab)

| Workflow | Use |
|---|---|
| `CA Mail staging operations` | `storage-setup` / `storage-check` (self-hosted storage and keys), `services-*` (ClamAV + worker), `migrate-*`, `staging-checks`, `host-audit`. Set `target=production` for production; mutating operations need `APPLY_PRODUCTION_MAIL_CHANGES` (migrations: `APPLY_PRODUCTION_MAIL_MIGRATIONS`) |
| `CA Mail backups` | `install` (off-host secret) or `install-local`, then nightly backup + weekly restore drill; `run`, `drill`, `status` |
| `CA Mail settings install` | `target`; `mode=preview`, then `mode=apply` with `confirm=APPLY_MAIL_SETTINGS` / `APPLY_PRODUCTION_MAIL_SETTINGS`; switches in `flags`; staging: `provider_credentials=shared-from-production` |
| `Production - Build & Push & Deploy` | from `main`: `preflight`, then `deploy` with `confirm=DEPLOY_PRODUCTION` (immutable image, checks, automatic rollback, keeps the Mail storage mounts) |

## 5. Production order

1. Promote staging to `main`.
2. Production deploy.
3. `migrate-apply` (production).
4. `services-deploy` (production: ClamAV + worker).
5. `storage-setup` (production).
6. Backups `install`, which also runs the first backup and drill.
7. `CA Mail settings install` (production), then `staging-checks` (production).
8. Point the Resend webhook at production.
9. Enable the flags.

Each step needs the owner's explicit authorization.
