# CosmicForge Mail: self-hosted storage, keys and backups (no AWS)

Centralize Admin Mail runs entirely on the Contabo VPS. Mail content is stored in an
encrypted filesystem store on a dedicated Docker volume. The encryption keyring is a
root-only file generated on the server. Backups are encrypted with restic and sent to an
off-host repository, and a weekly restore drill decrypts every restored object. AWS
S3/KMS remains in the code as an optional adapter. Nothing requires it.

## 1. Audit: what was AWS-specific

| Where | What it did | Now |
|---|---|---|
| `mail.config.js` `infrastructureViolations` | production required `MAIL_STORAGE_PROVIDER=s3`, `MAIL_KMS_PROVIDER=aws-kms`, `MAIL_S3_SSE` | production accepts `filesystem` + `file` (self-hosted) **or** `s3` + `aws-kms`; raw keys in the container environment (`env`) are refused in production |
| `security/kms-keyring.js`, `security/aws-sigv4.js` | the only production key source (KMS Decrypt / GenerateDataKey) | kept as an optional provider; new `security/file-keyring.js` |
| `application.js` | asynchronous keyring loading only for aws-kms | also loads the keyring file (fails closed with `MAIL_KMS_CONFIG`) |
| `scripts/mail/generate-data-key.js` | KMS data keys | optional; `scripts/mail/keyring.js` manages self-hosted keys |
| `infrastructure/mail/storage/terraform`, IAM/bucket policies | AWS bucket and KMS keys | unused by the self-hosted path |
| `storage/s3-backend.js` | generic S3 API (works with MinIO, Contabo Object Storage) | unchanged, optional |
| docs | described AWS as mandatory | corrected (this page, the go-live page) |

Production-only rules that **remain** on purpose:

- ClamAV (`clamd`) is required.
- Memory storage is refused.
- Staging and production never share a store or keys. Bucket names carry an environment
  marker, and keyring files and filesystem stores are bound to their environment.

A pre-existing gap was also fixed: key rotation (`security/key-rotation.js`) did not
rewrap archived headers and raw MIME (`mail_message_archives`). They would have become
unreadable once an old key was retired.

## 2. Why the filesystem store, not MinIO

The filesystem backend already existed and was tested, and staging already runs it.

MinIO on the same single VPS would sit on the same disk. It would add a service, its
credentials and its upgrades, without adding durability. Durability comes from the
off-host encrypted backups (section 5). The MinIO community edition is also no longer
actively maintained.

If Mail later needs more than one host, the existing S3 adapter works unchanged against
any S3-compatible service, including MinIO and Contabo Object Storage.

## 3. Storage

- **Volume:** `admin-server-mail-store` (production) and `admin-server-staging-mail-store`
  (staging). It is mounted at `/var/lib/cosmicforge-mail` in the app and the Mail worker.
- **Content:** objects are AES-256-GCM envelopes. The AAD binds each envelope to its purpose
  and object key, and the SHA-256 of the plaintext is checked on every read. Objects are
  written once (`wx`), and the file and its directory are fsynced. Key rotation is the only
  rewrite, and it is atomic (temporary file, then rename).
- **Environment binding:** a marker file `.cosmicforge-mail-store.json` binds the store to its
  environment. A staging store mounted into production, or the reverse, is refused.
- **Own volume required:** on staging and production, a directory that is not its own mount
  is refused (`not-a-mounted-volume`). A container recreate or a new image can therefore
  never lose mail.
- **Free-space floor:** writes stop and health fails below `MAIL_STORAGE_MIN_FREE_MB`
  (default 1024).
- **Mounts on every deploy:** the mounts live in `<app root>/docker-compose.mail-storage.yml`.
  Every Compose call includes this file: the staging deploy and its rollback, the guarded
  production deploy and its rollback, the settings installer and the database cutover.

## 4. Keys (no KMS)

- **Location:** `/etc/cosmicforge-mail/<env>/keyring/keyring.json`, root:root `0400`, in a
  `0700` directory. It is mounted read-only at `/run/secrets/cosmicforge-mail`, with
  `MAIL_KMS_PROVIDER=file` and
  `MAIL_ENCRYPTION_KEYRING_FILE=/run/secrets/cosmicforge-mail/keyring.json`.
- **Format:** `cosmicforge-mail-keyring/1` declares its environment. The app refuses a
  keyring from another environment, or one readable by group/other.
- **Never exposed:** the keyring is generated on the server inside the app image
  (`scripts/mail/keyring.js generate`). It never passes through GitHub and is never in an
  `.env` file or container environment. Only fingerprints are printed.
- **Staging migration:** staging's existing environment keyring was imported unchanged
  (`import-env`), so anything already stored still decrypts.
- **Rotation:**
  1. `keyring.js add-key --activate`.
  2. Restart the app and the worker.
  3. `npm run mail:keys:rotate -- --apply`.
  4. Re-run storage-setup to reseal the escrow.
- **Recovery escrow:** the keyring is sealed to the owner's **offline** RSA public key
  (3072 bits or more; RSA-OAEP-SHA256 + AES-256-GCM) at
  `/etc/cosmicforge-mail/<env>/escrow/keyring-escrow.json`, and included in every backup.
  - Only the owner's private key, which never touches the server or GitHub, can open it.
  - Without a recovery key, the content is not recoverable after host loss. Status reports
    this as `escrow PENDING`.

## 5. Backups and restore drills

`ca-mail-backup.sh` uses restic 0.17.3: the official release binary, with a pinned SHA-256.

**Each nightly backup** (systemd timer) contains:

- a `pg_dump` of `cosmicforge_admin`, taken first;
- the store volume;
- the sealed escrow;
- a manifest with row counts, key fingerprints and the image.

restic encrypts everything before upload. The raw keyring is never backed up.

**Retention:** 14 daily, 8 weekly and 12 monthly snapshots. `restic check` runs on every
backup, and on Sundays it also reads a 10% subset of the data.

**The weekly restore drill** (non-destructive):

1. Restores the latest snapshot into a scratch directory.
2. Restores the dump into a **throwaway PostgreSQL container** on an internal network.
   Live databases are untouched.
3. Compares row counts with the manifest.
4. Runs `scripts/mail/verify-restored-content.js` in the app image. It decrypts **every**
   restored object and encrypted column and checks each SHA-256 against the database.
5. Checks the backed-up escrow against the live keyring.
6. Removes everything it created.

**Off-host repository:** the secret `CA_<ENV>_MAIL_BACKUP_ENV` (environment `production`)
holds:

```dotenv
RESTIC_REPOSITORY=s3:https://<endpoint>/<bucket>/<path>   # or rest:https://...
RESTIC_PASSWORD=<at least 24 random characters, kept also in your password manager>
AWS_ACCESS_KEY_ID=<access key>        # restic's names for ANY S3-compatible service
AWS_SECRET_ACCESS_KEY=<secret key>
AWS_DEFAULT_REGION=<region>
```

Any S3-compatible service works, for example Contabo Object Storage in another region
than the VPS, Backblaze B2 or Hetzner Storage Box via a restic REST server. Without that
secret, `install-local` keeps a repository on the VPS itself. It is useful for tests, and
status always reports it as **not off-host**.

**Workflow:** `CA Mail backups`, with operations `status`, `install`, `install-local`, `run`
and `drill`.

## 6. Recovery runbook (host lost)

1. Rebuild the CA stacks on the new host with the existing workflows (deploys, migrations,
   services).
2. On a trusted machine, run
   `node scripts/mail/keyring.js open --escrow=keyring-escrow.json --private-key=<offline key> --out=keyring.json`.
   The escrow comes from the latest snapshot (`restic restore latest`).
3. Place `keyring.json` at `/etc/cosmicforge-mail/<env>/keyring/keyring.json` (root:root
   `0400`).
4. Restore the dump into `cosmicforge_admin` and the store into the volume from the same
   snapshot.
5. Run `storage-setup`. It finds the keyring and keeps it. Then run `storage-check` and a
   restore drill.

Steps 3 and 4 are manual, owner-approved operations. A one-click "restore into live"
workflow is deliberately not provided.

## 7. Operations (GitHub Actions only)

| Workflow / operation | Effect |
|---|---|
| `CA Mail staging operations`, `storage-setup` (target staging/production) | volume, keyring (generate or import), escrow, mounts file, settings through the installer (backup, same-image recreate, rollback), `storage-check` |
| `... storage-check` | read-only: mounts, keyring from the file, environment binding, own volume, canary write/read/decrypt/delete, worker mounts |
| `CA Mail backups`, `install` / `install-local` / `run` / `drill` / `status` | section 5 |

Production storage-setup needs `confirm=APPLY_PRODUCTION_MAIL_CHANGES`, and production
backups need `confirm=APPLY_PRODUCTION_MAIL_BACKUP`.

## 8. Tests

- **Unit:** `tests/mail-self-hosted-storage.test.js` covers the keyring file, the CLI,
  escrow, the filesystem store, the app wiring and the restore verifier (with PostgreSQL).
  `tests/mail-infra.test.js` covers the new production rules.
- **End to end:** `MAIL_TEST_STORAGE=filesystem MAIL_TEST_KEYRING=file node --test
  tests/mail-postgres.test.js` runs the whole M1-M6 suite on the self-hosted backend and
  keyring.
- **Replica:** `.github/scripts/tests/ca-release-ops-replica.sh` runs storage-setup on
  staging and production, escrow seal/open, a local backup, a drill, a drill that catches
  a missing object, and mounts surviving a guarded deploy.
