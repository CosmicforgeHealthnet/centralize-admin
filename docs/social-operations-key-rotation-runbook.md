# Social Operations Key Rotation Runbook

Audit date: 2026-07-17

This runbook contains procedures only. It does not contain actual keys.

## Key Generation

1. Generate 32 bytes of cryptographically secure random key material per environment.
2. Encode as base64 or 64-character hex.
3. Assign a non-secret key version label such as an ISO date or monotonically increasing version.
4. Store the full keyring in the approved secret manager under `SOCIAL_OPERATIONS_ENCRYPTION_KEYS_JSON` or `SOCIAL_ENCRYPTION_KEYS_JSON`.
5. Store the active version in `SOCIAL_OPERATIONS_ENCRYPTION_ACTIVE_VERSION` or `SOCIAL_ENCRYPTION_ACTIVE_VERSION`.

## Secure Storage

- Use deployment encrypted environment storage or the approved secret manager.
- Keep staging and production keyrings separate.
- Do not store key material in `.env.example`, docs, tests, CI logs, screenshots, commits, or tickets.
- Old keys remain available while any envelope encrypted with that version may exist.

## Active Version Change

1. Add the new key to the environment keyring without removing old keys.
2. Set the active version to the new version.
3. Restart the target service in staging first.
4. Run synthetic envelope decrypt/encrypt checks.
5. Rotate connection credentials by re-encrypting existing envelopes with the active version.

## Credential Rotation

Use `rotateSocialConnectionCredentials()` for Social account connections. The function decrypts with the old key version, re-encrypts with the active key, increments `credentialVersion`, and writes safe audit metadata without plaintext.

## Rollback

1. Restore the previous active key version in the secret manager.
2. Restart affected services.
3. Verify old and newly rotated envelopes can decrypt.
4. Do not delete the new key until all envelopes are known to be migrated back or forward.

## Backup Responsibility

The infrastructure/security owner backs up key material using the approved secret backup process. Database backups are not sufficient without corresponding retained key versions.

## Disaster Recovery

1. Restore the database.
2. Restore the exact keyring versions that existed at backup time.
3. Restore `SOCIAL_CONTENT_HASH_KEY`.
4. Verify representative credential, webhook, message, comment, and note envelopes.

## Key Compromise Procedure

1. Disable affected provider connections.
2. Add a new key version.
3. Rotate all Social credentials.
4. Reauthorize provider identities where needed.
5. Redact or rotate webhook secrets if payload confidentiality is affected.
6. Record safe audit metadata only.
7. Notify security/privacy owners.

## Audit Procedure

- Confirm active key version is explicit.
- Confirm old key versions are retained.
- Confirm production does not use test/dev key labels.
- Confirm no key material appears in source, logs, docs, CI output, or audit metadata.

## Verification Procedure

- Old envelope decrypts.
- Rotated envelope uses new `keyVersion`.
- Plaintext is never persisted.
- DTOs remain secret-free.
- Logs contain no secret values.

## Current Readiness

Synthetic key-rotation behavior is covered by automated tests. A real staging-only key-rotation test is blocked until staging secret manager and database access are available.
