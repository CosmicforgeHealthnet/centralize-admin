# CosmicForge Mail - Private Storage and KMS

> **Self-hosted is the production default.** Production runs on the Contabo VPS with the
> encrypted filesystem store and the keyring file (`MAIL_STORAGE_PROVIDER=filesystem`,
> `MAIL_KMS_PROVIDER=file`): see `docs/cosmicforge-mail-self-hosted-storage.md`. The S3 and
> AWS KMS path described below is an **optional** adapter and no longer required.

Status: the code is implemented and tested against local fakes. **No bucket, KMS key, IAM
role or credential has been provisioned.** Everything in `infrastructure/mail/storage/` is
an example to review and apply through an approved pipeline. Nothing in CI or the
application applies it.

## 1. Architecture

```
browser --(authenticated HQ API only)--> Mail API / worker
                                            |  AES-256-GCM envelope (cfmail1:)
                                            |  purpose + object-key bound AAD
                                            v
                                  S3-compatible private bucket
                                  (SSE-KMS at rest, TLS-only, versioned)

keyring (MAIL_ENCRYPTION_KEYS) = KMS-wrapped 256-bit data keys
   -> unwrapped once at startup via KMS Decrypt with an encryption context
      {purpose: cosmicforge-mail-keyring, environment, keyVersion}
   -> held in process memory only
```

There are two independent layers:

1. **Application encryption.** The Mail keyring encrypts every body, draft, attachment,
   preview and internal note before it leaves the process. The bucket and the database
   only ever hold ciphertext. A SHA-256 of the plaintext is checked on every read.
2. **Storage encryption.** The bucket applies SSE-KMS with a separate bucket key, which
   protects against media or snapshot loss.

**Access to content.** There are no public URLs and no presigned URLs. Attachments and
bodies are streamed only through authorized Mail API endpoints, which check mailbox
membership, the scan status and the legal-hold rules.

**Integrity.** Each object stores the SHA-256 of its envelope in
`x-amz-meta-cf-envelope-sha256`. Uploads also send `x-amz-checksum-sha256`, and the
envelope is verified again on read. Normal writes use `If-None-Match: *`, so objects
are never overwritten. Key rotation is the only path that rewrites an object.

**Failure handling.** Missing credentials, an unreachable bucket, a KMS error, a
refused configuration or an integrity failure all lead to `MAIL_STORAGE_UNAVAILABLE`
(HTTP 503) or `MAIL_STORAGE_INTEGRITY`. Content is never served unverified.

**Health.** `GET /api/mail/v1/admin/status` (mail admins only) reports:

- `storage`: a HEAD request on the bucket, plus a put/get/delete canary under
  `<prefix>/health/`, cached for `MAIL_S3_HEALTH_CACHE_MS`. Set
  `MAIL_S3_HEALTH_CANARY=false` for Object Lock buckets, which then use the HEAD
  request only.
- `encryption`: the provider, the number of key versions, the active version and the
  load error code. Key material is never included.
- `infrastructure.violations`: any configuration problems.

## 2. Configuration

| Variable | Purpose |
| --- | --- |
| `MAIL_DEPLOYMENT_ENV` | `development`, `test`, `staging` or `production`. If it is unset and `NODE_ENV=production`, the environment is treated as **production**. |
| `MAIL_STORAGE_PROVIDER` | `filesystem` (self-hosted, staging and production), `s3` (optional, any S3-compatible service) or `unavailable` |
| `MAIL_S3_ENDPOINT` / `MAIL_S3_REGION` / `MAIL_S3_BUCKET` / `MAIL_S3_PREFIX` | Bucket location. Must be https outside local development. |
| `MAIL_S3_ACCESS_KEY_ID` / `MAIL_S3_SECRET_ACCESS_KEY` / `MAIL_S3_SESSION_TOKEN` | Bucket credentials, from the environment's own secret store |
| `MAIL_S3_SSE` / `MAIL_S3_SSE_KMS_KEY_ID` | `AWS:KMS` plus the bucket key ARN (required in production), or `AES256` |
| `MAIL_S3_FORCE_PATH_STYLE`, `MAIL_S3_SEND_PRIVATE_ACL`, `MAIL_S3_CONDITIONAL_WRITES`, `MAIL_S3_CHECKSUM_HEADER` | Compatibility switches for non-AWS stores (see section 8) |
| `MAIL_KMS_PROVIDER` | `env` (raw keys, non-production only) or `aws-kms` |
| `MAIL_KMS_REGION` / `MAIL_KMS_ENDPOINT` / `MAIL_KMS_KEY_ID` | Keyring wrapping key. Use the alias `alias/cosmicforge-mail-<env>`. |
| `MAIL_KMS_KEY_ENVIRONMENT` | Required when `MAIL_KMS_KEY_ID` is a key ARN or id rather than an alias |
| `MAIL_KMS_ACCESS_KEY_ID` / `MAIL_KMS_SECRET_ACCESS_KEY` | KMS credentials. Fall back to the `MAIL_S3_*` credentials if unset. |
| `MAIL_ENCRYPTION_KEYS` / `MAIL_ENCRYPTION_ACTIVE_KEY` | Keyring entries, e.g. `v1:kms:<blob>,v2:kms:<blob>`, and the active version |

Run `npm run mail:config:validate` to check these rules offline (it makes no network
calls). It exits 1 when the API would refuse the configuration.

## 3. Staging / production separation (enforced)

`infrastructureViolations()` makes storage unavailable when any of these rules is
broken:

- **Production** requires `MAIL_STORAGE_PROVIDER=s3`, `MAIL_KMS_PROVIDER=aws-kms`,
  `MAIL_SCANNER_PROVIDER=clamd` and `MAIL_S3_SSE`. Memory and filesystem storage, env
  keys and test scanners are refused.
- **Staging** refuses memory storage. Filesystem storage is allowed for the pilot,
  provided it sits on an encrypted private volume.
- **Bucket name** (production and staging) must contain its own environment marker
  (`production`/`prod` or `staging`/`stg`) and must not contain the other
  environment's marker.
- **KMS key** (production and staging) must be an alias carrying the same marker, or
  a key ARN with `MAIL_KMS_KEY_ENVIRONMENT=<env>` declared.
- **Endpoints** for S3 and KMS must be https. Plain http is accepted only for
  localhost in development or test.
- **Wrapped data keys are bound to their environment** through the KMS encryption
  context. A staging key cannot be unwrapped by a production process, even with
  correct IAM permissions.

**Credentials** use the same variable names in both environments but must live in
**separate secret stores** and belong to **separate IAM principals**:

| Environment | Secret store path (example) | IAM role |
| --- | --- | --- |
| staging | `cosmicforge/staging/mail/*` | `cosmicforge-mail-api-staging` |
| production | `cosmicforge/production/mail/*` | `cosmicforge-mail-api-production` |

Never copy a production value into staging, or the reverse. The KMS key policies
reject cross-environment encryption contexts in any case.

## 4. Bucket, IAM and KMS policies

| File | Contents |
| --- | --- |
| `infrastructure/mail/storage/bucket-policy.json` | Denies non-TLS access, uploads without SSE-KMS or with the wrong KMS key, and public ACLs. Denies object access to anyone but the Mail API role, the rotation role and the break-glass admin role. |
| `infrastructure/mail/storage/iam-policy-mail-api.json` | Get/Put/Delete under `mail/*`, HeadBucket, and `kms:Decrypt` only with the Mail keyring encryption context for this environment |
| `infrastructure/mail/storage/iam-policy-key-admin.json` | `kms:GenerateDataKey` with the same context, for the person who mints new key versions |
| `infrastructure/mail/storage/kms-key-policy.json` | Context-conditioned decrypt and generate. Key deletion or disabling requires MFA. |
| `infrastructure/mail/storage/terraform/main.tf` | Example resources: a private bucket with versioning, Object Lock (governance), public access blocked, BucketOwnerEnforced and SSE-KMS with a bucket key, plus two KMS keys with yearly rotation |

Replace the `${...}` placeholders per environment and review them with the
infrastructure owner. Block Public Access must be on at both the account and the
bucket level.

## 5. Key rotation

There are two independent rotations:

1. **KMS master key rotation** (yearly and automatic, with `enable_key_rotation`).
   No application action is needed: wrapped data keys stay decryptable.
2. **Mail data key rotation** (new keyring version):

   ```bash
   # 1. Mint a wrapped key for this environment (prints only "v2:kms:<blob>")
   MAIL_DEPLOYMENT_ENV=staging npm run mail:kms:generate-data-key -- --version=v2
   # 2. Append it to MAIL_ENCRYPTION_KEYS in the secret store, set MAIL_ENCRYPTION_ACTIVE_KEY=v2,
   #    restart API + worker (new writes now use v2; v1 still decrypts).
   # 3. Rewrap existing data (dry run first; safe to interrupt and re-run)
   npm run mail:keys:rotate                                   # counts only
   npm run mail:keys:rotate -- --apply --operator=<adminUserId>
   # 4. When a later run reports "remaining": 0, v1 may be removed from the keyring
   #    (keep it if Object Lock / backups still hold v1 objects - see section 6).
   ```

The rotation command covers the following:

- **Objects:** message bodies and attachments, de-duplicated across mailbox copies.
- **Database columns:** draft bodies, message and thread previews, and support notes.

Column updates are compare-and-set, so concurrent edits are never lost. Each run is
recorded in `mail_audit_events` (`MAIL_KEY_ROTATION_*`) with counts only. For buckets
under Object Lock, run with `--skip-objects` and keep the old versions in the keyring
until their retention expires.

**Suspected key compromise:** mint a new version, make it active, run the rotation with
`--apply`, remove the compromised version, then revoke the old KMS grants.

## 6. Backup and disaster recovery

| Item | Target / mechanism |
| --- | --- |
| Object durability | S3 versioning plus Object Lock (governance, `retention_days`, default 30). Legal holds use per-object `s3:PutObjectLegalHold`, matched to `mail_legal_holds`. |
| Database (metadata, encrypted columns) | Existing Admin DB backups (`pg_dump` / provider PITR). The bucket and the DB must be restorable to a **consistent point**: restore both from the same window. |
| RPO | 15 minutes for the DB (PITR). Effectively 0 for objects, which are versioned and immutable. |
| RTO | 4 hours for Mail in staging, 2 hours in production (target, to confirm with the platform owner) |
| Keys | KMS keys with a 30-day deletion window and MFA-protected deletion. The wrapped keyring is held in two places: the secret store, and an offline sealed copy kept by the security owner. |
| Restore drill | Quarterly in staging. Restore the DB snapshot and bucket versions to a scratch environment, start the API with the restored keyring, check `admin/status` and read 10 sampled messages per mailbox type. |

Failure scenarios:

- **Bucket objects deleted or overwritten:** restore the previous versions (versioning,
  Object Lock).
- **KMS key disabled:** Mail fails closed with `MAIL_KMS_DENIED`. Re-enable the key; no
  data is lost.
- **KMS key scheduled for deletion:** cancel within the 30-day window. If it is
  actually deleted, every envelope wrapped by that key is **unrecoverable**. That is
  why deletion requires MFA, a second person, and confirmation that no keyring entry
  references the key.
- **Secret store loss:** restore `MAIL_ENCRYPTION_KEYS` from the sealed offline copy.
  It is only ciphertext and is useless without KMS access.
- **Region outage:** content is unavailable (fail closed) until the region recovers,
  unless cross-region replication and a multi-region KMS key are approved separately.

## 7. Retention and deletion interplay

- Deleting a Mail message or attachment removes the DB row. The `DELETE` on the object
  creates a delete marker, and locked versions remain until their retention expires.
- Retention periods must be agreed with records/legal before production. They should be
  at least as long as the Object Lock default, and no longer than the privacy policy
  allows.
- A database legal hold blocks deletion of messages and attachments. The matching
  Object Lock legal hold must be applied by the retention job, which does not exist yet
  (blocker B9).

## 8. Provider compatibility notes

| Store | Notes |
| --- | --- |
| AWS S3 | All features. Use virtual-host style (`MAIL_S3_FORCE_PATH_STYLE=false`) or path style. |
| MinIO | Path style. SSE needs KES/KMS configured; otherwise use `MAIL_S3_SSE=` in non-production only. |
| Cloudflare R2 | `MAIL_S3_REGION=auto`. R2 ignores ACL headers (`MAIL_S3_SEND_PRIVATE_ACL=false` is fine); encryption at rest is always on. Check conditional-write support. |
| Contabo / Ceph RGW | Path style. Verify `If-None-Match` and `x-amz-checksum-sha256` support in staging first; disable with `MAIL_S3_CONDITIONAL_WRITES=false` / `MAIL_S3_CHECKSUM_HEADER=false` if refused. SSE-KMS is usually unavailable, so production would need AWS S3 or another store with KMS. |

AWS KMS is the only KMS client implemented. Another KMS provider would need its own
adapter that implements `decrypt()` and `generateDataKey()` with an encryption context.
