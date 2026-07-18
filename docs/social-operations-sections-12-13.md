# Social Operations Sections 12-13

Implementation date: 2026-07-16

This document records the Section 12 security/privacy/compliance foundation and Section 13 HealthNet escalation workflow foundation. It is technical documentation, not legal advice.

## Credential Encryption

Social Operations uses a versioned AES-256-GCM envelope from `src/modules/marketing/social-operations/security/encryption.service.js`.

Envelope fields:

- `alg`: `AES-256-GCM`
- `v`: envelope version
- `keyVersion`: active key version used for encryption
- `purpose`: encryption purpose
- `iv`, `tag`, `ciphertext`: base64 values

Keys are resolved through `SOCIAL_OPERATIONS_ENCRYPTION_KEYS_JSON` or `SOCIAL_ENCRYPTION_KEYS_JSON`, with active version from `SOCIAL_OPERATIONS_ENCRYPTION_ACTIVE_VERSION` or `SOCIAL_ENCRYPTION_ACTIVE_VERSION`. Production fails closed when no keyring is configured. Non-production may use a process-local ephemeral key for local synthetic execution; it is not a plaintext fallback and is not suitable for production persistence.

Credential rotation is implemented in `credential-rotation.service.js`. It decrypts the existing SocialAccountConnection credential envelope, re-encrypts with the active key, increments `credentialVersion`, and writes safe audit metadata only.

## OAuth, PKCE, and Redirects

OAuth state creation and consumption are implemented in `oauth-state.service.js`.

- Raw state is generated from at least 32 random bytes and returned only once to the caller.
- The database stores only a SHA-256 state hash.
- PKCE uses S256 and stores the verifier encrypted at rest.
- State TTL defaults to 10 minutes and is bounded.
- Consumption uses an atomic conditional update against `stateHash`, `provider`, `usedAt: null`, and non-expired state.
- Redirect URI matching is exact only through `redirect-uri.policy.js`.
- Localhost HTTP is allowed only in recognized development/test environments and only when the exact localhost URI is allow-listed.

## Serialization and Logs

Social DTO sanitization uses recursive secret stripping from `secret-safe-serializer.js` and response shaping from `sanitization.service.js`.

Structured log payload redaction is implemented in `log-redaction.service.js`. It redacts token, credential, verifier, webhook raw payload, private content, and attachment URL fields while preserving the logger's top-level human-readable `message`.

## Webhook Security

The app uses a route-specific raw parser for `POST /api/v1/marketing/social/webhooks/:provider`, preserving exact request bytes in `req.rawBody` before JSON parsing.

Ingestion order:

1. Enforce payload size.
2. Validate provider.
3. Run provider signature verification against original headers and raw bytes.
4. Reject invalid signatures before persistence.
5. Parse JSON only after verification.
6. Store `encryptedRawPayload` only.
7. Store safe routing metadata in `payloadMetadataJson`.
8. Decrypt only in `webhook-processing.service.js`.

Webhook payload redaction replaces the non-null payload field with an encrypted tombstone and sets `redactedAt`. Provider, event IDs, payload hash, status, attempts, and timestamps remain preserved.

## SSRF Protection

`ssrf-safe-fetch.service.js` provides the outbound remote-media validation foundation.

It requires HTTPS by default, exact host allow-listing, no embedded credentials, DNS resolution before use, rejection of loopback/private/link-local/multicast/reserved/metadata-service addresses, redirect revalidation, response size limits, content-type allow-listing, and injected fetchers for tests. Tests use mocked DNS and mocked fetch behavior only.

## Content Hashing and Redaction

Content hashing uses HMAC-SHA256 in `content-hash.service.js` with a dedicated `SOCIAL_CONTENT_HASH_KEY`. Production fails closed if the key is missing.

Redaction in `content-redaction.service.js` supports:

- `SocialMessage.content`
- `SocialMessage.attachmentsJson`
- `SocialComment.text`
- `SocialInternalNote.text`
- `SocialWebhookEvent.encryptedRawPayload`

Redaction is idempotent, preserves audit-bearing rows and provider IDs, sets `sensitiveDataState` to `REDACTED`, and writes safe audit metadata only.

## Retention Settings and Worker

Retention settings use `SocialOperationsSetting` keys:

- `retention.messagesDays`
- `retention.commentsDays`
- `retention.internalNotesDays`
- `retention.webhookPayloadDays`
- `retention.publicContentDays`
- `retention.auditDays`

Redaction settings:

- `redaction.messageFields`
- `redaction.commentFields`
- `redaction.internalNoteFields`
- `redaction.webhookFields`

Missing values are treated as unconfigured. The implementation does not invent legal retention durations.

`redaction-worker.js` is disabled by default through `SOCIAL_REDACTION_WORKER_ENABLED=false`. It supports dry-run mode, bounded batches, safe aggregate logs, and no provider calls.

## Audit and Action Jobs

Social sensitive writes use the existing immutable audit-log create path via `writeSocialAudit`. Social Operations static tests assert no `auditLog.update`, `auditLog.delete`, `auditLog.upsert`, or equivalent mutable audit calls exist.

`sensitive-payload.validator.js` validates `SocialActionJob.payloadJson` recursively before job create/upsert. It rejects token, credential, raw payload, message/comment content, attachment content, cookies, authorization, and oversized/deep payloads.

## Credential Separation

Social connector and connection services remain separate from Marketing Intelligence credential services. Static tests assert Social Operations source does not import Marketing Intelligence credential modules or query MI account tables.

## Classification and Escalation

`inbound-classification.service.js` implements deterministic synthetic classification for both public comments and private messages using the same HealthNet sensitive-data rules.

Priority:

1. `SELF_HARM_RISK`
2. `MEDICAL_EMERGENCY`
3. `PRIVACY_INCIDENT`
4. `PROTECTED_HEALTH_INFORMATION`
5. `PRESCRIPTION_REQUEST`
6. `CLINICAL_ADVICE_REQUEST`
7. `LEGAL_THREAT`
8. `PATIENT_COMPLAINT`
9. `MEDICAL_MISINFORMATION`
10. `GENERAL_INQUIRY`

The classifier returns safe reason codes and signal codes only. It does not quote raw content, call external AI, send replies, diagnose, or produce medical advice.

`escalation.service.js` creates or reuses restricted `SocialEscalation` rows for sensitive classifications. It marks source messages/comments as `FLAGGED`, emits safe domain events, writes safe audit metadata, and does not send provider replies or perform provider HTTP calls.

Task linkage uses the existing `Task` model. Closure correction `prisma/manual-migrations/20260717_make_task_assignee_nullable_for_safety.sql` makes `Task.assigneeId` nullable so restricted safety escalations can preserve a Task even when no eligible safety administrator is available.

Local backup before applying the migration:

```powershell
pg_dump -h localhost -p 5432 -U postgres -d cosmicforge_admin -F c -f C:\Users\favou\OneDrive\Desktop\ADMIN-Backend\backups\cosmicforge_admin_before_task_assignee_nullable_20260717_210753.dump
```

Backup result: success, 258361 bytes.

Existing assigned Tasks are preserved. The `tasks_assigneeId_fkey` foreign key remains in place and continues to reference `admin_users(id)` with delete restrict behavior.

## HealthNet Workflows

Medical emergency and self-harm:

- Create restricted escalation.
- Mark source content `FLAGGED`.
- Require `social_moderation_safety` EDIT access for assignment actors and assignees.
- Always create/link a Task.
- Assign the Task only when an active administrator has effective `marketing / social_moderation_safety / EDIT`.
- When no eligible safety administrator exists, create the Task with `assigneeId = null`, keep the escalation restricted/unresolved, and emit a safe operational alert.
- Later safety assignment is service-level only and revalidates Task/escalation linkage, eligible actor, active assignee, and the same safety permission before sending a safe assigned-task notification.
- Notification code skips null recipients.
- No diagnosis, counselling, generated crisis advice, provider reply, or hardcoded hotline is added.
- Templates are resolved only through approved saved-reply configuration and are not sent automatically.

Clinical advice and prescription requests:

- No diagnosis, treatment, dosing, or prescription guidance is generated.
- Only approved redirect templates may be resolved.
- Missing approved template blocks quick response availability.

PHI and privacy incident:

- Mark source `FLAGGED`.
- Restrict visibility.
- Exclude from ordinary bulk/export/analytics paths.
- Privacy incident emits `SOCIAL_PRIVACY_INCIDENT_FLAGGED` without content.

Complaint, legal threat, and misinformation:

- Create restricted escalation.
- Do not automatically hide/delete/modify provider content.
- Hide/delete requires RBAC plus explicit bounded justification and audit.
- No medical correction or clinical claim is generated automatically.

## Restricted Visibility and Exports

Restricted direct access uses a generic 403 response and audits successful restricted access. List/bulk views exclude restricted records by default. Analytics excludes `FLAGGED`, `CONFIRMED`, and `REDACTED` private content by default. Third-party payload helpers remove internal notes.

## Safe Templates

`safe-template.service.js` resolves only configured, ACTIVE `SocialSavedReply` records whose channel matches the intended channel and whose compliance setting is approved. It rejects unknown variables and never sends provider messages.

## Phase D Gate and Defaults

`phase-d-compliance-gate.service.js` verifies:

- explicit Phase D approval;
- non-placeholder policy version;
- legal/privacy review timestamps;
- data-subject procedure approval;
- emergency template approval;
- retention and redaction approval;
- configured retention/redaction keys;
- active required templates;
- restricted-visibility test confirmation;
- redaction worker presence;
- explicit inbox enablement.

Safe defaults:

- `SOCIAL_INBOX_ENABLED=false`
- `SOCIAL_PHASE_D_ENABLED=false`
- `SOCIAL_REDACTION_WORKER_ENABLED=false`

Missing flags are false. This implementation does not enable live provider inbox, live provider synchronization, provider webhook subscription activation, or Section 14 behavior.

## Validation Notes

Prisma:

- `npx prisma format --schema prisma/schema.prisma`: formatted successfully.
- `npx prisma validate --schema prisma/schema.prisma`: schema valid.
- `npx prisma generate --schema prisma/schema.prisma`: Prisma Client v7.6.0 generated to `src/generated/admin-client`.

Tests:

- Original focused Sections 12-13 synthetic tests: 38 passed, 0 failed.
- Task-assignee nullability focused correction tests: 31 passed, 0 failed.
- Full `npm test`: 282 passed, 0 failed.

Latest startup verification:

- `npm start` launched cleanly on local port 4417 for verification.
- `/health` returned 200.
- `/api/v1/marketing/social/connections` returned 401 without authentication.
- Social workers remained disabled with `SOCIAL_WORKERS_ENABLED != true`.
- Provider env summary reported no configured providers and no provider request was made.

Confirmations:

- No live inbox was enabled.
- No legal retention duration was invented.
- No AI-generated medical or safety response was added.
- Section 14 was not implemented.
