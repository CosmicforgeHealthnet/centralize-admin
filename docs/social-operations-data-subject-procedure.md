# Social Operations Data-Subject Procedure

Implementation date: 2026-07-16

This is a technical workflow for Social Operations data-subject handling. It is not legal advice. Legal retention durations, legal hold decisions, and notification obligations require approved configuration and privacy/legal review.

## Scope

Covered local Social Operations records include:

- social account connections and publishing identities;
- contacts and source-tagged linked subject references;
- conversations, messages, comments, and internal notes;
- provider content references and engagement metrics;
- webhook events and encrypted payloads;
- escalations and linked Tasks, including restricted safety Tasks that may be temporarily unassigned until an authorized safety administrator is available;
- immutable audit metadata.

Cross-database patient/customer/user links are represented as source-tagged string references such as `linkedSubjectSource` and `linkedSubjectId`; they are not Prisma foreign keys.

## Intake

1. Record the request through the approved operational channel.
2. Verify the requester's identity using the approved administrative process.
3. Determine the subject reference set:
   - Social contact provider IDs;
   - linked subject source and ID;
   - related social conversations/comments/messages;
   - related escalations and Tasks.
4. Check for legal hold or active investigation markers before modifying records.
5. Do not export private content through general analytics or bulk routes.

## Export

Use privacy-filtered query helpers by default.

Default export excludes:

- `FLAGGED`, `CONFIRMED`, and `REDACTED` content;
- restricted escalations unless a distinct restricted export approval exists;
- internal notes;
- raw webhook payloads;
- tokens, credentials, and encrypted byte buffers.

Any future restricted export requires:

- distinct RBAC authorization;
- explicit purpose;
- bounded result set;
- audit before export;
- audit after export;
- no automatic third-party delivery.

## Correction

For local metadata corrections:

1. Update safe local fields only after authorization.
2. Preserve provider IDs and immutable audit rows.
3. If provider-side correction is required, create a provider action only where an approved connector capability and RBAC policy exists.
4. Do not place private content into audit metadata.

## Local Deletion Versus Redaction

Deleting a local pointer means removing or unlinking a local reference when the row is not audit-bearing and policy permits.

Redacting local private content means:

- compute or preserve deterministic HMAC content hash;
- set message/comment/note text fields to null;
- redact private attachment references;
- set `sensitiveDataState` to `REDACTED`;
- set `redactedAt`;
- preserve provider IDs, timestamps, status, moderation state, relations, and audit metadata.

Webhook redaction replaces `encryptedRawPayload` with an encrypted tombstone and sets `redactedAt`. It does not set plaintext tombstones.

## Anonymization

Where approved, anonymization should remove or replace direct local identifiers while preserving non-identifying aggregate metrics and immutable audit references. Source-tagged linked subject references must be handled according to approved cross-service procedure.

No legal retention duration is defined in code. Retention windows come from approved `SocialOperationsSetting` keys.

## Legal Hold

Before redaction or deletion:

1. Check approved legal hold markers or case-management instructions.
2. If a hold applies, stop destructive local changes.
3. Preserve audit metadata and provider references.
4. Record a safe operational note that a hold prevented redaction, without copying private content.

## Audit Preservation

Immutable audit records are preserved. Audit metadata must not contain:

- message/comment/note content;
- tokens or credentials;
- webhook raw payloads;
- attachment URLs;
- full provider payloads.

Audit rows are not updated or deleted by Social Operations services.

## Provider-Side Limits

Provider-side deletion or correction may be unavailable or asynchronous. A local redaction does not guarantee provider-side deletion. Provider-side actions require:

- approved connector capability;
- correct Social RBAC;
- explicit reason where moderation or deletion is involved;
- provider action audit before and after execution.

This foundation does not activate live provider inbox, provider-side deletion, or government/regulator reporting.

## Completion

After approved export, correction, redaction, or anonymization:

1. Verify local records no longer expose private content through DTOs.
2. Verify analytics/bulk exports exclude restricted/private rows by default.
3. Verify webhook payload tombstones remain encrypted.
4. Verify audit metadata remains safe and immutable.
5. Record the technical completion outcome in the approved administrative channel.
