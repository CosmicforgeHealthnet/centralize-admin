# Social Operations Sections 8-9 Closure

## Summary

- Repository root: `C:\Users\favou\OneDrive\Desktop\ADMIN-Backend`
- Branch: `fix/marketing-admin-db-target`
- Latest commit before work: `7b5fd6b fix: target marketing module to admin database`
- API base path: `/api/v1/marketing/social`
- Legacy route surface not reused: `/api/marketing/social/*`
- Migration created: no
- Provider SDK installed: no
- Provider network calls implemented: no
- Worker or scheduler started: no
- Reconciliation enabled flag: `SOCIAL_RECONCILIATION_ENABLED=false` by default

## Route Map

Public verified routes:

```text
GET  /oauth/:provider/callback       OAuth state verification
GET  /webhooks/:provider             Provider challenge validation
POST /webhooks/:provider             HMAC signature-verified ingest
```

Authenticated route groups:

```text
Connections: GET /connections; POST /connections/:provider/oauth/start; POST /connections/:id/test; POST /connections/:id/reauthorize; POST /connections/:id/disable; POST /connections/:id/enable; POST /connections/:id/discover-identities
Identities: GET /identities; POST /identities/:id/refresh-capabilities; POST /identities/:id/sync-content
Posts: POST /posts; GET /posts; GET /posts/:id; PATCH /posts/:id; DELETE /posts/:id; POST /posts/:id/duplicate; GET /posts/:id/versions; POST /posts/:id/submit
Approvals: POST /posts/:id/approve; POST /posts/:id/reject; POST /posts/:id/request-changes
Publishing: POST /posts/:id/publish; POST /posts/:id/schedule; GET /publications; GET /publications/:id; GET /posts/:id/publications; POST /publications/:id/retry; POST /publications/:id/cancel; POST /publications/:id/delete-provider-post
Content: GET /content; GET /content/:id; GET /content/:id/comments; GET /content/:id/metrics
Media: POST /media; GET /media; GET /media/:id; GET /media/:id/status; POST /media/:id/reprocess; GET /media/:id/usage; DELETE /media/:id
Inbox: GET /conversations; GET /conversations/:id; GET /conversations/:id/messages; POST /conversations/:id/reply; POST /conversations/:id/assign; POST /conversations/:id/snooze; POST /conversations/:id/resolve; POST /conversations/:id/notes; POST /conversations/:id/tags
Comments: GET /comments; GET /comments/:id; POST /comments/:id/reply; POST /comments/:id/assign; POST /comments/:id/notes; POST /comments/:id/hide; POST /comments/:id/delete; POST /comments/:id/escalate
Saved replies: GET /saved-replies; POST /saved-replies
Operations: GET /operations; GET /operations/:id; POST /operations/:id/retry; POST /operations/:id/cancel
Analytics: GET /analytics/posts; GET /analytics/inbox; GET /analytics/export
Settings: GET /settings; PATCH /settings
```

Total route definitions: 71.

## RBAC Map

All authenticated routes use:

```js
requireSection(module, section, mode = "VIEW")
```

No fourth middleware argument is used. No `EMERGENCY_OVERRIDE` mode is used.

Route actions map through the Section 7 manifest:

```text
Connections and identities -> social_connections VIEW/EDIT
Content/post reads -> social_content VIEW
Content/post writes -> social_content EDIT
Submit -> social_content_submit EDIT
Approvals -> social_approvals EDIT
Publish now/list/read -> social_publish EDIT/VIEW through manifest action
Schedule -> social_schedule EDIT
Retry/cancel/delete provider post -> social_publish_retry/social_publish_cancel/social_publish_delete EDIT
Inbox read/snooze -> social_inbox VIEW
Inbox reply/assign/resolve/note/tag -> dedicated social_inbox_* EDIT sections
Comment moderation -> social_moderation_hide/delete/escalate EDIT
Analytics -> social_analytics VIEW
Saved reply create and settings write -> social_settings EDIT
Operations read/write -> social_operations VIEW/EDIT
```

## Public Verification

- OAuth callback verifies a hashed `SocialOAuthState` before marking the state used.
- OAuth callback does not create a connected provider because live provider exchange remains out of scope.
- Meta webhook GET validates `hub.mode`, `hub.verify_token`, and `hub.challenge`.
- Webhook POST uses raw request bytes and verifies an HMAC SHA-256 signature before parsing or persisting.
- Missing or invalid webhook signatures return `401`.

## Webhook Ingestion Flow

1. Capture exact raw bytes for `/api/v1/marketing/social/webhooks/:provider`.
2. Verify provider signature before JSON parsing.
3. Parse only after verification.
4. Compute `payloadHash`.
5. Extract safe event metadata.
6. Store `SocialWebhookEvent` immediately with `status = RECEIVED`, `signatureValid = true`, encrypted raw payload, hash, provider, event ID, and received timestamp.
7. Deduplicate by `(provider, eventId)` when present.
8. Deduplicate by `(provider, payloadHash)` as fallback.
9. Acknowledge provider immediately.
10. Background processing is exposed as a service, not started automatically.

## Idempotency

- Webhook events deduplicate on existing schema unique keys.
- Message processing upserts by `(conversationId, providerMessageId)`.
- Comment processing upserts by `(identityId, providerCommentId)`.
- Engagement processing upserts by `(identityId, providerEventId)`.
- Provider content upserts by `(identityId, providerContentId)`.
- `processedAt` is written only after domain event publish succeeds.
- Failed processing increments attempts, sets `nextAttemptAt`, and leaves `processedAt` null.
- Retries are bounded by `DEFAULT_MAX_WEBHOOK_ATTEMPTS = 6`.

## Domain Events

Implemented local, testable Social event publisher:

```text
SOCIAL_POST_SUBMITTED
SOCIAL_POST_APPROVED
SOCIAL_POST_REJECTED
SOCIAL_PUBLICATION_STARTED
SOCIAL_PUBLICATION_SUCCEEDED
SOCIAL_PUBLICATION_FAILED
SOCIAL_MESSAGE_RECEIVED
SOCIAL_COMMENT_RECEIVED
SOCIAL_ITEM_ASSIGNED
SOCIAL_SLA_BREACHED
SOCIAL_REAUTHORIZATION_REQUIRED
SOCIAL_WEBHOOK_SUBSCRIPTION_DEGRADED
SOCIAL_PRIVACY_INCIDENT_FLAGGED
```

Event payloads are sanitized before publishing and do not include credentials, authorization headers, encrypted webhook payloads, or raw provider responses.

## Operations Sanitization

Operations status responses omit:

```text
payloadJson
credentials
message content
comment content
webhook payload
provider authorization headers
tokens
encrypted payloads
raw provider responses
```

Connection list responses use explicit safe metadata selects and omit encrypted credentials, access tokens, refresh tokens, provider authorization headers, and raw OAuth responses.

## Reconciliation

- Reconciliation foundation lives in `src/modules/marketing/social-operations/services/reconciliation.service.js`.
- Startup does not register or run a Social scheduler.
- `SOCIAL_RECONCILIATION_ENABLED=false` by default.
- `POST /identities/:id/sync-content` enqueues a `SYNC_PROVIDER_CONTENT` `SocialActionJob` only.
- The request cycle never polls providers.
- `SocialIdentitySyncState` stores durable checkpoints and cursors per identity.
- `runReconciliationOnce` reports disabled/no provider calls unless the flag is explicitly enabled.

## Database

No migration was created. Section 5 already provided the required models and constraints:

```text
SocialAccountConnection
SocialPublishingIdentity
SocialOAuthState
SocialPost
SocialPostRevision
SocialPostTarget
SocialPostApproval
SocialPublication
SocialPublishingJob
SocialActionJob
SocialWebhookEvent
SocialMessage
SocialComment
SocialEngagementEvent
SocialProviderContent
SocialProviderContentMetricSnapshot
SocialIdentitySyncState
SocialEscalation
SocialSavedReply
SocialMediaAsset
SocialOperationsSetting
```

## Current Limitations

- Live provider OAuth token exchange remains out of scope.
- Live provider API calls remain out of scope.
- Connector write/read methods still fail through typed unavailable capability errors unless a future provider runtime is implemented.
- Webhook provider-specific cryptographic variants use the shared HMAC verification foundation for this section.
- Social reconciliation is not scheduled automatically.
- Media upload uses a local metadata/storage stub and does not duplicate the production storage pipeline.

## Validation

```text
npx prisma format
Result: exit 0; Formatted prisma\schema.prisma in 165ms.

npx prisma validate
Result: exit 0; schema valid.

npx prisma generate
Result: exit 0; generated Prisma Client v7.6.0 to .\src\generated\admin-client in 2.63s.
```

Focused tests:

```text
npm test -- tests/social-operations-section8-routes.test.js          4 passed, 0 failed, 0 skipped, 7701.6041ms
npm test -- tests/social-operations-section8-rbac.test.js            3 passed, 0 failed, 0 skipped, 1684.045ms
npm test -- tests/social-operations-section8-sanitization.test.js    3 passed, 0 failed, 0 skipped, 363.8665ms
npm test -- tests/social-operations-section8-governance.test.js      5 passed, 0 failed, 0 skipped, 310.2313ms
npm test -- tests/social-operations-section9-webhooks.test.js        3 passed, 0 failed, 0 skipped, 1000.9667ms
npm test -- tests/social-operations-section9-idempotency.test.js     2 passed, 0 failed, 0 skipped, 1159.0147ms
npm test -- tests/social-operations-section9-reconciliation.test.js  3 passed, 0 failed, 0 skipped, 1275.7338ms
```

Combined focused total: 23 passed, 0 failed, 0 skipped.

Full suite:

```text
npm test
195 passed, 0 failed, 0 skipped, 17871.0491ms
```

Startup:

```text
npm start
PostgreSQL connected via Prisma
Main database connected
[MarketingIntelligence] Provider env summary: {"META":"not_configured","TIKTOK":"not_configured","X":"not_configured","LINKEDIN":"not_configured","GOOGLE_ADS":"not_configured"}
[MarketingIntelligence] Scheduled sync disabled (MARKETING_INTELLIGENCE_SYNC_ENABLED != true)
Admin server running on port 4000 [development]
```

Startup probes:

```text
GET /health -> 200
GET /api/v1/marketing/social/connections -> 401
GET /api/v1/marketing/social/webhooks/META?hub.mode=subscribe&hub.verify_token=section-8-9-verify&hub.challenge=ok -> 200
POST /api/v1/marketing/social/webhooks/META with missing signature -> 401
GET /api/marketing/campaigns -> 401
GET /api/v1/marketing/intelligence/performance -> 401
```
