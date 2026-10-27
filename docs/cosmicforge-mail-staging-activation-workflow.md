# CosmicForge Mail: staging activation workflow

`.github/workflows/mail-activation-staging.yml` activates Mail on staging in reviewed, approval-gated
phases through GitHub Actions. Nobody needs direct VPS access. Only phase 1 exists.

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
prints states, counts and setting names only. `tests/mail-activation-inspect.test.js` checks that no
secret, key, bucket or host value appears in its output.

### Before the first run (infrastructure owner)

1. Create the GitHub environment **`staging-mail-activation`**:
   - add required reviewers (the approval gate);
   - set deployment branches to `staging` only;
   - add the `STAGING_SSH_KEY` secret (the `cf-staging-deploy` key).

   If the environment is missing, GitHub creates an unprotected one without the secret. The job then
   stops at the key check without connecting anywhere.
2. Run the workflow from `staging`: Actions → *Staging Mail Activation (approval-gated)*, with phase
   `inspect` and the confirmation text `inspect staging read-only`.
3. A required reviewer approves the environment deployment, and the job runs.

## Later phases (not implemented)

Each later phase is added as its own reviewed PR, and only after the inspection results are reviewed:
1. backup, then apply the Mail migrations 27-37 with the existing `db:admin:prepare` path;
2. a live storage/KMS read-write check;
3. provisioning;
4. the worker;
5. switching flags on one at a time.

Webhook and Resend changes are not part of this workflow.
