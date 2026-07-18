# Social Operations Sections 6-7 Closure

## Repository

- Repository root: `C:\Users\favou\OneDrive\Desktop\ADMIN-Backend`
- Branch: `fix/marketing-admin-db-target`
- Latest commit: `7b5fd6b fix: target marketing module to admin database`
- Initial Git status before Section 6-7 edits:

```text
 M package-lock.json
 M package.json
 M prisma/schema.prisma
 M src/app.js
 M src/generated/admin-client/edge.js
 M src/generated/admin-client/index-browser.js
 M src/generated/admin-client/index.d.ts
 M src/generated/admin-client/index.js
 M src/generated/admin-client/package.json
 M src/generated/admin-client/schema.prisma
 M src/modules/marketing/marketing.routes.js
 M src/modules/payments/payments.service.js
 M src/modules/users/users.service.js
 M src/server.js
 M src/shared/events/bootstrap.js
 M src/shared/events/events.js
?? .env.example
?? docs/
?? prisma/manual-migrations/20260714_add_marketing_intelligence_phase1.sql
?? prisma/manual-migrations/20260715_add_marketing_connection_token_expiry.sql
?? prisma/manual-migrations/20260716_add_marketing_attributions_phase1.sql
?? prisma/manual-migrations/20260716_add_social_operations_section_5.sql
?? prisma/manual-migrations/20260717_extend_marketing_ad_platforms.sql
?? prisma/manual-migrations/20260718_add_marketing_connection_credentials_currency.sql
?? prisma/manual-migrations/20260719_finalize_marketing_intelligence_connections.sql
?? prisma/manual-migrations/20260720_fix_marketing_intelligence_currency_width.sql
?? src/modules/marketing/intelligence/
?? src/modules/marketing/social-operations/
```

## Files

Files created for Sections 6-7:

- `src/modules/marketing/social-operations/connectors/connector.constants.js`
- `src/modules/marketing/social-operations/connectors/connector.errors.js`
- `src/modules/marketing/social-operations/connectors/connector.contract.js`
- `src/modules/marketing/social-operations/connectors/connector.validators.js`
- `src/modules/marketing/social-operations/connectors/connector-capability.service.js`
- `src/modules/marketing/social-operations/connectors/publish-result.mapper.js`
- `src/modules/marketing/social-operations/connectors/tiktok-publish-result.mapper.js`
- `src/modules/marketing/social-operations/connectors/meta-publishing.connector.js`
- `src/modules/marketing/social-operations/connectors/tiktok-publishing.connector.js`
- `src/modules/marketing/social-operations/connectors/x-publishing.connector.js`
- `src/modules/marketing/social-operations/connectors/linkedin-publishing.connector.js`
- `src/modules/marketing/social-operations/connectors/connector.registry.js`
- `src/modules/marketing/social-operations/governance/social-operations.sections.js`
- `src/modules/marketing/social-operations/governance/social-operations.rbac.js`
- `src/modules/marketing/social-operations/governance/governance-settings.service.js`
- `src/modules/marketing/social-operations/governance/approval-governance.service.js`
- `src/modules/marketing/social-operations/governance/provider-write-audit.service.js`
- `src/modules/marketing/social-operations/governance/emergency-publish-governance.service.js`
- `src/modules/marketing/social-operations/governance/restricted-visibility.policy.js`
- `src/modules/marketing/social-operations/governance/job-execution.policy.js`
- `src/modules/marketing/social-operations/__tests__/connector-contract.test.js`
- `src/modules/marketing/social-operations/__tests__/connector-capabilities.test.js`
- `src/modules/marketing/social-operations/__tests__/connector-normalization.test.js`
- `src/modules/marketing/social-operations/__tests__/social-operations-rbac.test.js`
- `src/modules/marketing/social-operations/__tests__/governance-policies.test.js`
- `src/modules/marketing/social-operations/__tests__/job-execution-policy.test.js`
- `docs/social-operations-sections-6-7.md`

Files modified for Sections 6-7:

- `src/modules/marketing/social-operations/index.js`
- `src/generated/admin-client/*` was refreshed by `npx prisma generate`; no Section 6-7 Prisma model or migration change was made.

## Connector Contract

The connector contract has 18 methods and one `platform` property. Required methods:

```text
discoverIdentities
getCapabilities
validatePost
uploadMedia
publishPost
getPublishStatus
updatePost
deletePost
listComments
replyToComment
moderateComment
listConversations
sendMessage
listContent
getContent
listContentMetrics
verifyWebhook
normalizeWebhookEvent
```

Registered providers:

```text
META
TIKTOK
X
LINKEDIN
```

The registry validates every connector through `assertConnectorContract`, rejects unknown providers, rejects duplicate platforms, and returns stable connector instances. The registry is the only non-connector file importing all four concrete provider connector modules.

## Capabilities

Capability statuses:

```text
AVAILABLE
READ_ONLY
REQUIRES_REAUTHORIZATION
REQUIRES_PLATFORM_APPROVAL
RATE_LIMITED
NATIVE_ONLY
UNSUPPORTED_ACCOUNT_TYPE
DISABLED_BY_POLICY
```

Each capability entry has this shape:

```js
{
  status: "AVAILABLE",
  reason: null,
}
```

Capability entries are emitted for each gated operation and all statuses are validated against the approved constant.

Provider-specific gates:

- Meta personal Instagram identities are `UNSUPPORTED_ACCOUNT_TYPE`.
- Meta Facebook Page and Instagram Professional identities are not rejected as unsupported account types.
- Meta message sending is gated by customer-initiated window state.
- TikTok comments, comment replies, conversations and messages are `NATIVE_ONLY`.
- TikTok `UPLOAD_TO_DRAFT` maps to `AWAITING_USER_ACTION`, never directly to `PUBLISHED`.
- TikTok direct submission maps to `PROCESSING` until confirmed; `SUBMITTED` is never returned.
- X upload, publish and DM operations require paid/provider approval and return `REQUIRES_PLATFORM_APPROVAL` with `X_PAID_ACCESS_REQUIRED` when approval is absent.
- LinkedIn list conversations and send message are `NATIVE_ONLY`.
- LinkedIn member publishing is `DISABLED_BY_POLICY` with `LINKEDIN_MEMBER_PUBLISHING_DEFERRED`; organization publishing is not rejected as unsupported.

Marketing Intelligence credential isolation:

- Social connector files do not import Marketing Intelligence credential modules.
- Social connector files do not import Prisma clients.
- Social connector files do not import provider SDKs or network clients.
- No Marketing Intelligence advertising connection is treated as an organic Social Operations publishing connection.

## RBAC

RBAC middleware signature used:

```js
requireSection(module, section, mode = "VIEW")
```

Only `VIEW` and `EDIT` modes are used. No fourth middleware argument is used.

Social Operations RBAC sections:

```text
social_content
social_content_submit
social_approvals
social_publish
social_publish_emergency_override
social_schedule
social_publish_retry
social_publish_cancel
social_publish_delete
social_inbox
social_inbox_reply
social_inbox_assign
social_inbox_resolve
social_inbox_note
social_inbox_tag
social_moderation_hide
social_moderation_delete
social_moderation_escalate
social_moderation_safety
social_moderation_restricted
social_connections
social_analytics
social_settings
social_operations
```

Action-to-section mapping:

```text
CONTENT_VIEW -> marketing social_content VIEW
CONTENT_CREATE -> marketing social_content EDIT
CONTENT_EDIT -> marketing social_content EDIT
CONTENT_SUBMIT -> marketing social_content_submit EDIT
APPROVAL_VIEW -> marketing social_approvals VIEW
APPROVAL_DECIDE -> marketing social_approvals EDIT
PUBLISH -> marketing social_publish EDIT
PUBLISH_EMERGENCY_OVERRIDE -> marketing social_publish_emergency_override EDIT
SCHEDULE -> marketing social_schedule EDIT
PUBLISH_RETRY -> marketing social_publish_retry EDIT
PUBLISH_CANCEL -> marketing social_publish_cancel EDIT
PUBLISH_DELETE -> marketing social_publish_delete EDIT
INBOX_VIEW -> marketing social_inbox VIEW
INBOX_REPLY -> marketing social_inbox_reply EDIT
INBOX_ASSIGN -> marketing social_inbox_assign EDIT
INBOX_RESOLVE -> marketing social_inbox_resolve EDIT
INBOX_NOTE -> marketing social_inbox_note EDIT
INBOX_TAG -> marketing social_inbox_tag EDIT
MODERATION_HIDE -> marketing social_moderation_hide EDIT
MODERATION_DELETE -> marketing social_moderation_delete EDIT
MODERATION_ESCALATE -> marketing social_moderation_escalate EDIT
MODERATION_SAFETY -> marketing social_moderation_safety EDIT
RESTRICTED_CONTENT_VIEW -> marketing social_moderation_restricted VIEW
RESTRICTED_CONTENT_EDIT -> marketing social_moderation_restricted EDIT
CONNECTION_VIEW -> marketing social_connections VIEW
CONNECTION_EDIT -> marketing social_connections EDIT
ANALYTICS_VIEW -> marketing social_analytics VIEW
SETTINGS_VIEW -> marketing social_settings VIEW
SETTINGS_EDIT -> marketing social_settings EDIT
OPERATIONS_VIEW -> marketing social_operations VIEW
OPERATIONS_EDIT -> marketing social_operations EDIT
```

Emergency override adaptation:

- Emergency publishing uses the dedicated `social_publish_emergency_override` section with `EDIT`.
- No `EMERGENCY_OVERRIDE` mode is invented or passed to the RBAC middleware.

## Governance

Self-approval:

- Same actor and author is denied by default.
- Same actor and author is denied when the setting is false or malformed.
- Same actor and author is allowed only when the setting is explicitly true.
- Different actor and author is allowed.

Approved-content edit policy:

- Editing an approved, scheduled, publishing or published target requires a new draft revision.
- Target status returns to `DRAFT`.
- Reapproval is required.
- The previous immutable revision reference is preserved.

Emergency publishing:

- Empty and whitespace-only reasons are rejected.
- Audit happens before enqueue.
- Enqueue does not run if audit fails.
- The audit metadata includes the dedicated `PUBLISH_EMERGENCY_OVERRIDE` grant.

Provider-write audit wrapper:

- Intent is recorded before the provider callback.
- Success is recorded after a successful provider callback.
- Failure is recorded after a failed provider callback.
- Audit metadata redacts tokens, authorization headers, credentials, secrets, passwords, raw payloads and private message/comment content.

Restricted visibility:

- Ordinary inbox access alone cannot view restricted data.
- Restricted `VIEW` grant can view.
- Restricted `EDIT` grant can modify where later services allow it.
- Safety actions require `social_moderation_safety` with `EDIT`.
- Restricted records are denied before serialization rather than partially redacted.

Job execution authorization:

- Revalidates current connection state.
- Revalidates current identity state and connection ownership.
- Requires the connector capability to be currently `AVAILABLE`.
- Treats `RATE_LIMITED` as retryable only when a safe retry time is known.
- Enforces provider and identity blocks from Social Operations settings.
- Requires the job revision to match the currently approved revision.
- Does not recheck historic `requestedById`, `approvedById` or author RBAC grants.
- The policy file does not import the RBAC middleware.

## Validation

Prisma commands:

```text
npx prisma format --schema prisma/schema.prisma
Result: exit 0; Formatted prisma\schema.prisma in 193ms.

npx prisma validate --schema prisma/schema.prisma
Result: exit 0; The schema at prisma\schema.prisma is valid.

npx prisma generate --schema prisma/schema.prisma
Result: exit 0; Generated Prisma Client (v7.6.0) to .\src\generated\admin-client in 1.49s.
```

Focused Sections 6-7 tests:

```text
Command: node --test src/modules/marketing/social-operations/__tests__/connector-contract.test.js src/modules/marketing/social-operations/__tests__/connector-capabilities.test.js src/modules/marketing/social-operations/__tests__/connector-normalization.test.js src/modules/marketing/social-operations/__tests__/social-operations-rbac.test.js src/modules/marketing/social-operations/__tests__/governance-policies.test.js src/modules/marketing/social-operations/__tests__/job-execution-policy.test.js
Total: 29
Passed: 29
Failed: 0
Skipped: 0
Duration: 304.5455ms
```

Full suite:

```text
Command: npm test
Total: 172
Passed: 172
Failed: 0
Skipped: 0
Duration: 14153.9657ms
```

## Startup Verification

Command:

```text
npm start
```

Observed startup:

```text
PostgreSQL connected via Prisma
Main database connected
[MarketingIntelligence] Provider env summary: {"META":"not_configured","TIKTOK":"not_configured","X":"not_configured","LINKEDIN":"not_configured","GOOGLE_ADS":"not_configured"}
[MarketingIntelligence] Scheduled sync disabled (MARKETING_INTELLIGENCE_SYNC_ENABLED != true)
Admin server running on port 4000 [development]
```

Endpoint checks:

```text
GET /health -> 200
GET /api/marketing/campaigns -> 401
GET /api/v1/marketing/intelligence/performance -> 401
GET /api/social-operations -> 404
GET /api/marketing/social-operations -> 401 from parent Marketing auth middleware; static route scan found no Social Operations mount
```

Startup conclusions:

- Backend started cleanly.
- Prisma client loaded successfully.
- Existing Marketing routes remained registered.
- Marketing Intelligence routes remained registered and auth-protected.
- No Social Operations HTTP route was mounted.
- No Social connector performed a network call.
- No Social provider SDK initialized.
- No Social publishing worker started.
- No Social action worker started.
- No Social cron or scheduler was added.
- No Social Operations credentials were read during startup.
- Importing `src/modules/marketing/social-operations` emitted only the expected connector/governance export data and no database, credential or network side effects.

## Known Limitations

- Live Meta, TikTok, X and LinkedIn integrations remain out of scope.
- Provider OAuth, token refresh, media upload, publishing, polling, content sync, inbox sync, metrics sync and webhook processing remain out of scope.
- Webhook signature verification intentionally throws a typed unavailable/configuration error until real cryptographic verification is implemented.
- Provider write audit uses existing audit infrastructure only; no audit schema change was made.
- No Social Operations HTTP routes, controllers, workers, schedulers, database migrations or Prisma model changes were implemented for Sections 6-7.
