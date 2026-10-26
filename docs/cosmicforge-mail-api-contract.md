# CosmicForge Mail API Contract (v1)

Base path: `/api/mail/v1` (HQ API, `services/central-admin-api`).
Machine-readable schema: `GET /api/mail/v1/openapi.json` (source:
`services/central-admin-api/src/modules/mail/openapi/mail.openapi.js`).

Generated client: `apps/central-admin-web/src/lib/generated/mail-api.ts` is
generated from that document (`cd services/central-admin-api && npm run
mail:client:generate`). It carries every schema as a TypeScript type, the
operation table (operationId -> method, path, success status), per-operation
request/response types, `mailPath()` and `createMailClient()`. The staff Mail
service (`src/lib/mail.service.ts`) issues every call through that table, so a
renamed or removed route is a TypeScript error. Contract drift fails CI:
`npm run mail:client:check` and `tests/mail-openapi-contract.test.js` (part of
`npm test`) check that the generated file is current, that documented success
statuses match the router, that every Mail call anywhere in the web app hits a
documented route and method, and, on real PostgreSQL, that live responses
validate against their schemas and that bodies violating a documented request
schema are refused by the runtime validation.

All endpoints except the provider webhook and `openapi.json` require
`Authorization: Bearer <admin access token>` (existing HQ login).
Authorization is evaluated server-side on every request (deny by default).
Admin tier (including `SUPER`) never grants access to mailbox content.

## Envelope

Success (existing `ApiResponse` convention):

```json
{ "success": true, "message": "OK", "data": { }, "meta": { "nextCursor": "..." } }
```

Error (existing `errorHandler` convention):

```json
{ "success": false, "code": "MAIL_FORBIDDEN", "retryable": false,
  "message": "...", "errors": [{ "code": "MAIL_FORBIDDEN", "field": "..." }],
  "correlationId": "..." }
```

| HTTP | code examples |
| --- | --- |
| 400 | `MAIL_VALIDATION_FAILED` |
| 401 | (existing auth) |
| 403 | `MAIL_FORBIDDEN`, `MAIL_SENDER_NOT_AUTHORIZED`, `MAIL_STEP_UP_REQUIRED`, `MAIL_IDENTITY_INACTIVE` |
| 404 | `MAIL_NOT_FOUND` (also returned for resources the caller may not see) |
| 409 | `MAIL_DRAFT_REVISION_CONFLICT`, `MAIL_INVALID_TRANSITION`, `MAIL_CONVERSATION_LOCKED`, `MAIL_ADDRESS_TAKEN` |
| 413 | `MAIL_ATTACHMENT_TOO_LARGE` |
| 422 | `MAIL_PREFLIGHT_FAILED` |
| 429 | `MAIL_QUOTA_EXCEEDED`, `MAIL_RATE_LIMITED` |
| 503 | `MAIL_DISABLED`, `MAIL_SENDING_DISABLED`, `MAIL_STORAGE_UNAVAILABLE` |

Feature flags (all default `false`): `MAIL_ENABLED`, `MAIL_SENDING_ENABLED`,
`MAIL_RECEIVING_ENABLED`, `MAIL_MARKETING_ENABLED`, `MAIL_WORKER_ENABLED`.
When `MAIL_ENABLED=false` every authenticated endpoint returns 503 `MAIL_DISABLED`.

Pagination: cursor based. `?limit=` (1-100, default 25) and `?cursor=`; the next
cursor is returned in `meta.nextCursor` (null when exhausted).

## Entitlements

`GET /me/entitlements` -> `data`:

```ts
{
  mailEnabled: boolean; sendingEnabled: boolean; marketingEnabled: boolean;
  identityActive: boolean;              // false when HQ account is not ACTIVE
  mailboxes: MailboxSummary[];          // only mailboxes the caller may open
  canManageDomains: boolean; canProvision: boolean; canApproveProvisioning: boolean;
  canManageSharedMembership: boolean;
  marketing: { organizationId: string; slug: string; name: string;
               canAuthor: boolean; canApprove: boolean }[];
}
```

## Types

```ts
type MailboxSummary = {
  id: string; name: string; type: "PERSONAL" | "SHARED";
  purpose: "GENERAL" | "SUPPORT" | "MARKETING";
  role: "OWNER" | "MANAGER" | "MEMBER" | "READER";
  canSend: boolean; primaryAddress: string | null;
  unreadCount: number; status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  organization: { id: string; slug: string; name: string };
};
type SenderIdentity = { addressId: string; address: string; displayName: string | null; kind: string };
type Party = { address: string; name: string | null };
type ThreadSummary = {
  id: string; mailboxId: string; subject: string; snippet: string;
  folder: "INBOX" | "ARCHIVE" | "TRASH" | "SPAM";
  lastMessageAt: string; messageCount: number; participants: Party[];
  isRead: boolean; isStarred: boolean; hasAttachments: boolean;
  labels: { id: string; name: string; color: string | null }[];
  conversationStatus: "OPEN" | "PENDING" | "RESOLVED" | "CLOSED" | null;
  assignedTo: { id: string; name: string } | null; slaDueAt: string | null;
  lastDeliveryStatus: MessageStatus | null;
  revision: number;                       // required for status changes
  lockedBy: { id: string; name: string } | null; lockExpiresAt: string | null;
  supportTicketRef: string | null; firstResponseAt: string | null;
};
type MessageStatus = "QUEUED" | "PROVIDER_ACCEPTED" | "DELIVERED" | "DELAYED" |
  "FAILED" | "BOUNCED" | "COMPLAINED" | "RECEIVED" | "QUARANTINED" |
  "OUTCOME_UNKNOWN";  // provider may or may not have sent it; never auto-retried
// Recipient statuses add PENDING, PROVIDER_ACCEPTED, INTERNAL_DELIVERED and OUTCOME_UNKNOWN.
// Only external (PENDING) recipients are sent through the provider; internal
// recipients receive a local copy and are never re-sent externally.
type Recipient = Party & { type: "TO" | "CC" | "BCC"; status: string };
type Message = {
  id: string; threadId: string; mailboxId: string;
  direction: "INBOUND" | "OUTBOUND" | "INTERNAL"; status: MessageStatus;
  subject: string; from: Party; replyTo: string | null;
  recipients: Recipient[];   // BCC only present for the sending mailbox
  sentAt: string | null; receivedAt: string | null; createdAt: string;
  html: string | null;       // already sanitized server side; remote images
                             // replaced unless ?remoteImages=allow
  text: string | null; remoteImagesBlocked: number;
  attachments: Attachment[]; sentBy: { id: string; name: string } | null;
  deliveryEvents: { type: string; recipient: string | null; occurredAt: string }[];
  quarantineReason: string | null;
};
type Attachment = { id: string; filename: string; contentType: string; sizeBytes: number;
  isInline: boolean; scanStatus: "PENDING" | "CLEAN" | "INFECTED" | "SCAN_FAILED" |
  "SCANNER_UNAVAILABLE"; downloadable: boolean };
type Draft = { id: string; mailboxId: string; mode: "NEW" | "REPLY" | "REPLY_ALL" | "FORWARD";
  threadId: string | null; inReplyToMessageId: string | null; senderAddressId: string | null;
  to: Party[]; cc: Party[]; bcc: Party[]; subject: string; html: string; text: string;
  revision: number; status: "ACTIVE" | "SENDING" | "SENT" | "DISCARDED";
  attachments: Attachment[]; updatedAt: string };
```

## Mailboxes, threads, messages

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/me/entitlements` | see above |
| GET | `/me/mailboxes` | `MailboxSummary[]` |
| GET | `/mailboxes/:mailboxId` | `MailboxSummary & { senderIdentities: SenderIdentity[]; signatureHtml: string \| null }` |
| GET | `/mailboxes/:mailboxId/threads?view=inbox\|sent\|archive\|trash\|spam\|starred\|unread\|all&labelId=&cursor=&limit=` | `ThreadSummary[]` |
| GET | `/threads/:threadId` | `ThreadSummary` |
| GET | `/threads/:threadId/messages?remoteImages=block\|allow` | `Message[]` oldest first |
| PATCH | `/threads/:threadId/state` | body `{ isRead?: boolean; isStarred?: boolean }` (per user) |
| POST | `/threads/:threadId/move` | body `{ folder: "INBOX"\|"ARCHIVE"\|"TRASH"\|"SPAM" }` |
| POST | `/mailboxes/:mailboxId/threads/bulk` | body `{ threadIds: string[]; action: "archive"\|"trash"\|"spam"\|"inbox"\|"read"\|"unread"\|"star"\|"unstar" }` -> `{ updated: number }` |
| GET/POST | `/mailboxes/:mailboxId/labels` | POST `{ name, color? }` |
| PUT/DELETE | `/threads/:threadId/labels/:labelId` | add/remove label |
| GET | `/mailboxes/:mailboxId/search?q=&from=&to=&subject=&after=&before=&labelId=&cursor=&limit=` | `ThreadSummary[]` (mailbox-scoped) |
| GET | `/search?q=...` | across all mailboxes the caller can read |

Search is **metadata-only**: subject, sender address/name and non-BCC recipients. Message
bodies, previews and internal notes are not indexed and are never stored in plaintext;
`MAIL_SEARCH_INDEX_BODIES` is ignored and `GET /status` reports
`search: { metadataOnly: true, bodySearch: "disabled", bodyIndexingRequestRefused }`.
`snippet` in `ThreadSummary` is decrypted per request for authorized readers.
| GET | `/contacts/suggest?q=` | `Party[]` from caller-visible correspondents + staff directory |

## Drafts and sending

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/mailboxes/:mailboxId/drafts` | caller's own drafts only |
| POST | `/mailboxes/:mailboxId/drafts` | body `{ mode?, threadId?, inReplyToMessageId?, senderAddressId?, to?, cc?, bcc?, subject?, html?, text? }` -> `Draft` (201). For REPLY/REPLY_ALL/FORWARD the server pre-fills recipients/subject. |
| GET | `/drafts/:draftId` | `Draft` |
| PATCH | `/drafts/:draftId` | body includes `revision` (required) + fields. Stale revision -> 409 `MAIL_DRAFT_REVISION_CONFLICT` with `errors[0].currentRevision`. |
| DELETE | `/drafts/:draftId` | discard |
| POST | `/drafts/:draftId/attachments` | `multipart/form-data` field `file` -> `Attachment` (201). Scanned before it can be sent. |
| DELETE | `/drafts/:draftId/attachments/:attachmentId` | |
| POST | `/drafts/:draftId/send` | body `{ revision }`. Header `Idempotency-Key` optional. Returns **202** `{ messageId, threadId, jobId, status: "QUEUED" }`. Never claims delivery. |

External (provider) delivery is gated at enqueue **and** again before every provider call. Denials: `503 MAIL_SENDING_DISABLED`; `503 MAIL_PROVIDER_UNAVAILABLE` (`reason: MAIL_PROVIDER_NOT_CONFIGURED`); `403 MAIL_SENDER_NOT_AUTHORIZED` with `errors[0].reason` one of `SENDER_DOMAIN_ALLOWLIST_EMPTY`, `SENDER_DOMAIN_NOT_ALLOWLISTED`, `SENDER_DOMAIN_NOT_VERIFIED`, `SENDER_DOMAIN_SENDING_DISABLED` (plus the existing identity/membership/grant reasons). An empty `MAIL_DOMAIN_ALLOWLIST` denies all external delivery; purely internal recipients are delivered locally and never reach the provider. A send blocked at dispatch ends `FAILED` with the reason in the recipient `lastEventDetail` and a `MAIL_SEND_BLOCKED_AT_DISPATCH` audit event.
| GET | `/messages/:messageId/status` | `{ status, recipients: Recipient[], deliveryEvents }` |
| GET | `/attachments/:attachmentId/download` | streams file with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`. 403 `MAIL_ATTACHMENT_QUARANTINED` when not CLEAN. |

## Shared mailbox / Support

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/mailboxes/:mailboxId/queue?status=OPEN\|PENDING\|RESOLVED\|CLOSED&assignee=me\|unassigned\|<id>` | `ThreadSummary[]` |
| POST | `/threads/:threadId/assign` | `{ assigneeAdminUserId: string \| null }` (assignee must be a mailbox member) |
| POST | `/threads/:threadId/status` | `{ status, revision }` -> 409 on stale revision |
| POST | `/threads/:threadId/lock` | soft collision lock (2 min). 409 `MAIL_CONVERSATION_LOCKED` with `errors[0].lockedBy` |
| DELETE | `/threads/:threadId/lock` | release |
| GET/POST | `/threads/:threadId/notes` | internal notes (never sent) `{ body, mentions?: string[] }` |
| PUT | `/threads/:threadId/ticket-link` | `{ ticketRef: string \| null }` |
| GET | `/threads/:threadId/activity` | Mail audit trail for the thread |
| GET | `/directory/staff?q=` | ACTIVE staff `{ id, name, email, department }[]` for member pickers (mail admins and shared-mailbox managers only) |
| GET | `/mailboxes/:mailboxId/members` | members (managers / owners) |
| POST | `/mailboxes/:mailboxId/members` | `{ adminUserId, role, canSend }` (mail admin or mailbox manager) |
| DELETE | `/mailboxes/:mailboxId/members/:membershipId` | revoke (effective next request) |
| PATCH | `/mailboxes/:mailboxId/settings` | `{ signatureHtml?, slaFirstResponseMinutes?, supportTicketLinkEnabled? }` |
| GET | `/support/mailboxes` | SUPPORT-purpose mailboxes the caller is a member of |

## Administration (domains, addresses, provisioning)

Requires `mail/admin` EDIT section grant (or `SUPER` tier). These endpoints never return message content.

| Method | Path |
| --- | --- |
| GET/POST | `/admin/organizations` |
| GET/POST | `/admin/domains` (`{ organizationId, domain }`) |
| POST | `/admin/domains/:domainId/verify` (provider check; disabled unless provider configured) |
| GET/POST | `/admin/addresses` (`{ domainId, localPart, kind, mailboxId?, aliasOfAddressId?, displayName? }`) |
| PATCH | `/admin/addresses/:addressId` (`{ status }`) |
| GET/POST | `/admin/mailboxes` (`{ organizationId, type, name, purpose?, ownerAdminUserId?, primaryAddressId? }`) |
| POST | `/admin/mailboxes/:mailboxId/suspend` / `/reactivate` |
| POST | `/admin/users/:adminUserId/offboard` (suspends personal mailbox, revokes memberships and sender grants; history retained) |
| POST/DELETE | `/admin/sender-grants` / `/admin/sender-grants/:grantId` |
| GET/POST | `/provisioning/requests` (any active employee may request; body `{ type, requestedAddress?, justification?, organizationId?, mailboxId? }` - the domain of `requestedAddress` must already be registered) |
| POST | `/provisioning/requests/:requestId/approve` / `/reject` |
| GET/POST | `/admin/legal-holds`, POST `/admin/legal-holds/:holdId/release` |
| POST | `/admin/attachments/:attachmentId/rescan` | Mail admin only. Re-runs policy + scanner for `PENDING`/`SCAN_FAILED`/`SCANNER_UNAVAILABLE`; returns `{ id, scanStatus, quarantined, downloadable }`. `INFECTED` → 403 `MAIL_ATTACHMENT_QUARANTINED` (`reason: NOT_RESCANNABLE`); concurrent change → 409 `MAIL_INVALID_TRANSITION`. Audited. |
| GET/POST | `/admin/retention-policies` |

## Step-up MFA and break-glass

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/security/step-up` | `{ code, purpose }` TOTP verification against the enrolled HQ 2FA secret. Returns `{ stepUpId, expiresAt }` (5 min, single use per purpose). Accounts without an enrolled secret receive 403 `MAIL_MFA_NOT_ENROLLED`. |
| POST | `/break-glass/requests` | `{ mailboxId, justification, caseReference, stepUpId }` (requires `mail/break-glass-request` grant) |
| POST | `/break-glass/requests/:id/approve` | `{ stepUpId, durationMinutes<=240 }` (requires `mail/break-glass-approve` grant, approver != requester) |
| POST | `/break-glass/requests/:id/reject` / `/revoke` | |
| GET | `/break-glass/requests` | requests the caller made or may decide |

Break-glass grants READER access only, are time bounded, and every read is audited.

## Webhook

`POST /api/mail/v1/webhooks/resend` - Svix-signed Resend webhook (raw body,
signature + timestamp tolerance verified before parsing). Returns 200 only after
the event and its processing job are durably stored. Duplicate deliveries return 200
with `duplicate: true`. Rejected when `MAIL_RECEIVING_ENABLED` and
`MAIL_SENDING_ENABLED` are both off (503).

## Marketing Email Studio (`/marketing/...`)

Requires `MAIL_MARKETING_ENABLED=true` and brand-scoped grants
(`mail-marketing` module, section `<orgSlug>` VIEW/EDIT, or `approve:<orgSlug>` for reviewers).

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/marketing/organizations` | brands the caller can access |
| GET | `/marketing/:orgId/sender-identities` | active non-personal brand addresses `{ addressId, address, displayName, kind, mailboxName, purpose, domainVerifiedForSending }[]` |
| GET/POST | `/marketing/:orgId/contacts` | POST `{ email, firstName?, lastName?, attributes?, consent?: { topic, source, evidence, policyVersion, doubleOptIn? } }` |
| POST | `/marketing/:orgId/contacts/import` | `multipart` CSV (`file`) + fields `topic`, `source`, `policyVersion`, `evidenceReference`, `audienceId?`. Max 5,000 rows. Rows without evidence are rejected. Returns per-row report. |
| GET/PATCH | `/marketing/:orgId/contacts/:contactId` | |
| POST | `/marketing/:orgId/contacts/:contactId/consents` | grant/record consent |
| POST | `/marketing/:orgId/contacts/:contactId/consents/:topic/withdraw` | |
| GET/POST | `/marketing/:orgId/suppressions`, POST `/marketing/:orgId/suppressions/:id/lift` |
| GET/POST | `/marketing/:orgId/audiences`, GET/PATCH `/marketing/:orgId/audiences/:audienceId` |
| POST/DELETE | `/marketing/:orgId/audiences/:audienceId/contacts` `{ contactIds }` |
| GET/POST | `/marketing/:orgId/audiences/:audienceId/segments`; GET `/marketing/:orgId/segments/:segmentId/preview` | definition `{ match: "all"\|"any", rules: [{ field, op, value }] }`; fields `email`, `email_domain`, `first_name`, `last_name`, `created_at`, `attributes.<key>`; ops `equals`, `not_equals`, `contains`, `ends_with`, `in`, `before`, `after`, `exists`. Preview returns `{ total, eligibleCount, excludedCount, excluded, sample }` |
| GET/POST | `/marketing/:orgId/templates`, GET `/marketing/:orgId/templates/:templateId` |
| POST | `/marketing/:orgId/templates/:templateId/versions` `{ subject, preheader?, blocks: Block[], brand? }` -> immutable version |
| POST | `/marketing/:orgId/templates/render` `{ subject, blocks, brand?, sampleData? }` -> `{ html, text, variables, warnings, accessibility }` |
| GET | `/marketing/:orgId/legacy-templates` | read-only view of existing `marketing_email_templates` |
| GET/POST | `/marketing/:orgId/campaigns`, GET/PATCH `/marketing/:orgId/campaigns/:campaignId` (PATCH requires `revision`) |
| POST | `/marketing/:orgId/campaigns/:campaignId/preflight` | `{ ok, checks: { id, ok, detail }[], eligibleCount, excludedCount }` |
| POST | `/marketing/:orgId/campaigns/:campaignId/submit` | DRAFT/REJECTED -> READY_FOR_REVIEW (creates immutable SUBMISSION snapshot) |
| POST | `/marketing/:orgId/campaigns/:campaignId/approve` | `{ revision, stepUpId, comment? }` reviewer != author -> APPROVED (APPROVAL snapshot) |
| POST | `/marketing/:orgId/campaigns/:campaignId/reject` | `{ revision, comment }` |
| GET | `/marketing/:orgId/campaigns/:campaignId/history` | approvals, snapshots, audit |

Any material PATCH to a READY_FOR_REVIEW or APPROVED campaign returns it to DRAFT,
increments `revision` and records an `INVALIDATED` approval. There is **no** send /
schedule endpoint in M6; dispatch (M7) is not implemented.

Template `Block`:

```ts
type Block =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "text"; text: string }               // supports **bold**, _italic_, {{variable}}
  | { type: "button"; label: string; url: string }
  | { type: "image"; src: string; alt: string; href?: string; width?: number }
  | { type: "divider" }
  | { type: "spacer"; height?: number }
  | { type: "footer"; text: string };              // unsubscribe link appended automatically
```

Allowed personalization variables: `first_name`, `last_name`, `email`, `brand_name`,
`unsubscribe_url`. Unknown variables fail rendering with `MAIL_TEMPLATE_INVALID_VARIABLE`.


## User preferences (migration 36)

`GET /me/preferences` and `PUT /me/preferences` (any active Mail user; own
preferences only). Body: `{ defaultSenderAddressId?: uuid | null,
notificationsEnabled?: boolean }` (at least one; unknown fields are refused).

- `defaultSenderAddressId` must be one of the caller's current sender
  identities in any mailbox they can send from (`403
  MAIL_SENDER_NOT_AUTHORIZED` otherwise). It is re-checked on every read and
  use: new drafts pre-select it only in the mailbox that owns it, and a
  revoked identity is reported as `null`.
- `notificationsEnabled: false` suppresses in-app **new-mail** notices only.
  Delivery failures, outcome-unknown, bounces/complaints, mailbox full,
  forwarding decisions, membership/request decisions, assignments, mentions
  and ops alerts are always sent.
- Every change writes a `MAIL_PREFERENCES_UPDATED` audit event (field names and
  values only).
- Before `20261102_mail_user_preferences.sql` is applied, GET answers the
  defaults with `available: false` and PUT answers `503
  MAIL_FEATURE_NOT_READY` (retryable).

## Specification gap closure (migration 35)

Feature endpoints answer `503 MAIL_FEATURE_NOT_READY` (retryable) until
`20261101_mail_spec_gap_closure.sql` is applied; core Mail does not depend on it.

| Endpoint | Purpose |
| --- | --- |
| `GET/POST /mailboxes/{id}/rules`, `PATCH/DELETE /rules/{id}`, `POST /mailboxes/{id}/rules/reorder` | Filters (MANAGE access; fixed operators only; uses the M1 `mail_rules` table) |
| `GET/POST /mailboxes/{id}/forwarding`, `POST /forwarding/{id}/disable` | Forwarding requests (owner/manager) |
| `GET /admin/forwarding`, `POST /admin/forwarding/{id}/approve|reject` | Approval by a different mail admin; external targets need an allowed domain and step-up `MAIL_FORWARDING_APPROVE` |
| `GET /messages/{id}/original-headers`, `GET /messages/{id}/raw` | Encrypted header / raw-MIME archive (audited; raw of quarantined mail: mail admins only) |
| `GET /admin/search-index`, `POST /admin/search-index/backfill` | Body-search index freshness and backfill (202) |
| `POST /admin/jobs/{id}/requeue` | Requeue a DEAD_LETTER/FAILED inbound or event job (step-up `MAIL_JOB_REQUEUE`; outbound sends are refused) |

`GET /search` and `GET /mailboxes/{id}/search`: `q` words must each appear in
the metadata or (with body search enabled) the body; see
`docs/cosmicforge-mail-body-search.md`. `GET /threads/{id}/messages` adds
`senderAuthentication: { verdict: PASS|NONE|SUSPICIOUS|FAIL, reasons, source }`
for inbound messages. Campaign reports add `replied` (evidence-based reply
attribution) and `rates.replyPercent`.
