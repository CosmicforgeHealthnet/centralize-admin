# CosmicForge Mail: staging infrastructure inspection workflow

`.github/workflows/mail-activation-staging.yml` currently performs **only a read-only inspection** through the existing `staging` GitHub environment and its existing restricted `STAGING_SSH_KEY`. No new environment, SSH key or required reviewer is needed. It does not activate Mail, run migrations, install infrastructure, or alter Resend.

## Phase 1: read-only inspection (`phase=inspect`)

It changes nothing: no migration, no flag, no restart, no Resend call, and no write to storage.

| Area | What is reported | How |
|---|---|---|
| Containers | app running; Mail worker containers (running/total); image tags | `docker ps` on the host |
| Flags | every `MAIL_*_ENABLED` flag and its effective value; must all be off | app container env |
| Secrets / variables | present or absent, by name only | app container env |
| Config | violations now, and violations if sending, receiving and the worker were switched on (evaluated only, nothing is switched) | `mail.config` rules |
| Database | is `cosmicforge_admin`; session read-only; Mail schema per migration (core, 35, 36, 37); ledger (`social_manual_migrations`) vs the 37-entry manifest, checksum mismatches, Mail orders 27-37; row counts of the main Mail tables | `default_transaction_read_only=on` session; reads only |
| Encryption | KMS provider; keyring entries (wrapped/raw); active key in keyring | structure only, nothing unwrapped or decrypted |
| Storage / KMS | provider; bucket set (and named for staging); credentials present; https; TCP reach of the endpoint | no signed request (the S3 health check writes a canary, so it waits for an approved phase) |
| ClamAV | provider; clamd `PING` | the scanner's own health check |

The report lists **blockers**. It goes to the job summary and is kept as the `staging-mail-inspection`
artifact for 14 days. The script (`services/central-admin-api/scripts/mail/activation-inspect.js`)
prints states, counts and setting names only. Failures are reported as fixed error codes, never exception
text, and config violations have addresses, URLs and host names redacted. `tests/mail-activation-inspect.test.js`
checks that no secret, key, bucket, address or host value appears in its output, including when a database
connection or the script itself fails.

### How the first inspection runs

1. After the workflow change is merged into `staging`, the **Staging Mail Inspection (existing staging environment)** job runs automatically once because the workflow file changed. It uses the existing `staging` environment and restricted deployment SSH key already proved by the normal Admin API pipeline.
2. To run it again manually, choose `staging` in GitHub Actions → *Staging Mail Inspection (existing staging environment)*, select `inspect`, and type `inspect staging read-only`.
3. Read the GitHub Actions job summary and the `staging-mail-inspection` artifact. The result reports missing prerequisites but does not install or enable them. The infrastructure operator must independently verify a database backup, migrations 27–37, S3/KMS, scanner, worker, staging-only secrets, safe recipient allowlist, and provider/webhook state before an activation workflow is authored.

**The normal API auto-deployment is separate and already uses the `staging` environment.** This inspection does not redeploy the backend or modify the container.

## Later phases (not implemented)

Later infrastructure steps require explicit safety checks and a separate reviewed implementation after the inspection results are known:
1. backup, then apply the Mail migrations 27-37 with the existing `db:admin:prepare` path;
2. a live storage/KMS read-write check;
3. provisioning;
4. the worker;
5. switching flags on one at a time.

Webhook and Resend changes are not part of this workflow.
