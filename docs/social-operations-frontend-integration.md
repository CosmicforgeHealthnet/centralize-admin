# Social Operations Frontend Integration

Audit date: 2026-07-17

The frontend repository was not available in this workspace. Frontend completion is blocked.

## Backend Contract

Base path:

```text
/api/v1/marketing/social
```

Important frontend requirements:

- Render backend capability responses exactly.
- Distinguish `PROCESSING`, `AWAITING_USER_ACTION`, `PUBLISHED`, retryable failure, and permanent failure.
- Never show provider credential fields or encrypted envelope fields.
- Treat TikTok upload-to-draft as user action required, not published.
- Preserve immutable approvals by showing revisions and requiring reapproval after edits.
- Respect restricted visibility and generic 403 behavior.
- Do not expose tokens in browser storage, screenshots, logs, or network DTOs.

## Required E2E Tests

- OAuth connect flow.
- Identity discovery.
- Capability display.
- Draft creation.
- Multiple target variants.
- Media upload.
- Validation errors.
- Approval workflow.
- Edit-after-approval revision.
- Scheduling.
- Publication status transitions.
- Per-target failures and retry/cancel.
- Imported provider content.
- Comments and inbox where approved.
- Restricted visibility.
- Redaction.
- Connection reauthorization.
- Operations dashboard.

## Current Status

`FRONTEND_ACCESS_REQUIRED`. No frontend repository, staging frontend domain, browser E2E result, or capability alignment evidence was available.

