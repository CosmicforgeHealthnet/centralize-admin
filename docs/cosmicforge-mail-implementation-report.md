# CosmicForge Mail - M1-M6 Implementation Report

Date: 2026-10-24. Branch: `claude/gallant-ramanujan-0h6e6b` (based on `origin/staging`).
Nothing was merged, deployed, migrated on a real database, or enabled live.

## 1. Repository baseline

- Audited baseline: `0f49a25407a46e70e6a62c7ddcc9169d5afe3678`. Staging HEAD at start:
  `a433f65` (one docs-only commit after the baseline; no Mail code existed).
- The reference PDF (`CosmicForge_Mail_Implementation_Specification.pdf`) was not available in
  the environment; the implementation follows the assignment text and the repository.
- Reused: AdminUser + `authenticate`, AdminSectionGrant (HR grant UI issues the new `mail` /
  `mail-marketing` grants), `ApiResponse` / `ApiError` / `errorHandler`, existing `Notification`
  table, the manual-migration manifest/ledger/replay tooling, the test network guard, React Query
  + axios client, existing Help/Marketing layouts.
- Deviations (deliberate):
  - Inbound/outbound/event jobs share one durable table `mail_outbox_jobs` (column `queue`).
  - Each local recipient mailbox gets its own message copy (body/attachments stored once). This is
    how BCC privacy and per-mailbox threading are guaranteed.
  - Mail routes skip the global `xss()` body mutation and use Mail's own context-aware sanitizer
    (the global filter corrupts email bodies); Mail JSON bodies allow 1 MB instead of 10 kb.
  - No TOTP verification existed in the codebase; Mail adds its own step-up endpoint that checks a
    real code against the enrolled `twoFactorSecret` (base32). Enrollment itself is out of scope.
  - Marketing tables use the `marketing_email_*` prefix; the Studio template table is
    `marketing_email_studio_templates` so the legacy `marketing_email_templates` stays untouched.

## 2. Workstream completion

| Milestone | Status | Main files |
| --- | --- | --- |
| M1 schema, migration, authz, contracts | COMPLETE AND TESTED | `prisma/schema.prisma`, `manual-migrations/20261024_add_cosmicforge_mail_m1_m6.sql`, `src/modules/mail/authz/*`, `openapi/mail.openapi.js`, `docs/cosmicforge-mail-api-contract.md` |
| M2 Resend adapter, webhooks, storage, workers | COMPLETE AND TESTED offline; live Resend BLOCKED BY EXTERNAL CONFIGURATION | `adapters/*`, `webhooks/*`, `storage/*`, `scanning/*`, `jobs/*`, `pipelines/*`, `src/mail-worker.js`, `src/app.js` |
| M3 corporate mailbox backend | COMPLETE AND TESTED | `services/mailbox.service.js`, `compose.service.js`, `mail-admin.service.js`, `message-store.service.js` |
| M4 webmail frontend | IMPLEMENTED; lint/tsc/build pass; browser smoke-tested against a local API | `apps/central-admin-web/src/app/dashboard/mail/**`, `src/components/mail/**` |
| M5 shared support email | COMPLETE AND TESTED (API); UI smoke-tested | `services/support.service.js`, `app/dashboard/help/email/**` |
| M6 Marketing Email Studio | COMPLETE AND TESTED (API); UI renders against real API | `marketing/*`, `app/dashboard/marketing/email-marketing/**`, `components/marketing/email-marketing/**` |

### Tests

- `src/modules/mail/__tests__/mail-security.unit.test.js` (12 tests): webhook signatures (valid,
  tampered bytes, re-serialised JSON, stale timestamp, wrong secret, oversize, unknown type), HTML
  sanitizer (scripts, handlers, forms, SVG, CSS url, remote pixels), address/header injection,
  AEAD encryption with key rotation, encrypted storage + checksum, RFC 6238 TOTP vectors,
  attachment policy + EICAR + fail-closed scanning, template renderer, CSV parsing/formula
  neutralisation, flags default off, Resend adapter error classification and SSRF guard, backoff.
- `tests/mail-postgres.test.js` (14 subtests, real PostgreSQL 16 replay DB with all migrations and
  triggers): provisioning, SUPER/admin denial, PENDING identity rejection, draft 409 conflicts,
  sender spoofing, header injection, 202 send + durable job, internal delivery with BCC isolation,
  exactly-once provider send, ambiguous timeout reconciliation, crashed-lease recovery, permanent
  failure, provider outage -> dead letter, webhook dedupe/replay, delivery + bounce status,
  inbound routing/threading/sanitising/quarantine/unknown recipients, provider echo dedupe,
  search/label/bulk tenant scoping, per-user state, cursor pagination, support assignment/notes/
  status revision/locks/attribution/revocation, step-up + break-glass (single use, replay, read-only,
  expiry, audited reads), legal hold (API + DB trigger), immutable audit, offboarding retention,
  marketing brand isolation/consent/suppression/CSV/segments, template immutability, preflight,
  reviewer separation, step-up approval, approval invalidation, no dispatch, disabled flags.
- `tests/mail-app-wiring.test.js`: raw-body webhook bytes reach the verifier through `app.js`,
  Mail JSON not globally escaped, 1 MB Mail limit with 413, other routes unchanged; static check
  that Mail never imports Main/Dispatch DB clients or other modules' internals.
- Updated `tests/social-operations-section16-migration-ci.test.js` (manifest count 26 -> 27).
- Final runs: `npm run test:mail` 29/29 pass; full `npm test` 975 tests, 974 pass, 0 fail, 1 skipped
  (pre-existing skip); `npm run test:social-operations` 222/222 pass. Baseline before this work:
  946 tests, 945 pass, 1 skipped. CI safety scripts (config validate x3, manifest verify, admin
  guard, prepare, schema assert, migration safety, secret scan, static checks, network guard) pass.
- Browser smoke (Playwright, local API with fake provider, HealthNet Main DB unreachable): login,
  Mail nav from entitlements, inbox, sanitized thread with blocked-image banner and clean
  attachment, compose -> 202 -> recipient receives, mobile 390 px without horizontal scroll,
  SUPER sees "No mailbox assigned", Support channel queue with SLA, Email Marketing overview and
  M7 automation notice. This found and fixed one bug (CORS did not allow `Idempotency-Key`).

### Remaining gaps

- No automated frontend component/accessibility test framework exists in the app; accessibility
  was implemented (labels, roles, focus handling, shortcuts) but not audited with a tool.
- Retention policies are stored and enforced for deletion via legal holds; a scheduled retention
  sweeper is not implemented (no deletion happens automatically).
- Marketing double opt-in confirmation endpoint exists; sending the confirmation email is M7.
- Ticket links store a reference; the existing tickets page does not yet read `?ref=`.

## 3. Database and migrations

36 tables (all new): `mail_organizations`, `mail_domains`, `mail_mailboxes`, `mail_addresses`,
`mail_memberships`, `mail_sender_grants`, `mail_provision_requests`, `mail_threads`,
`mail_messages`, `mail_message_recipients`, `mail_user_thread_states`, `mail_drafts`,
`mail_labels`, `mail_thread_labels`, `mail_rules`, `mail_attachments`, `mail_internal_notes`,
`mail_outbox_jobs`, `mail_webhook_events`, `mail_delivery_events`, `mail_audit_events`,
`mail_retention_policies`, `mail_legal_holds`, `mail_step_up_verifications`,
`mail_break_glass_requests`, `marketing_email_contacts`, `marketing_email_consents`,
`marketing_email_suppressions`, `marketing_email_audiences`, `marketing_email_audience_contacts`,
`marketing_email_segments`, `marketing_email_studio_templates`, `marketing_email_template_versions`,
`marketing_email_campaigns`, `marketing_email_campaign_snapshots`, `marketing_email_campaign_approvals`.

Integrity: unique normalized addresses and domains, `(domain, local_part)` uniqueness, one personal
mailbox per owner, partial unique active membership / sender grant / suppression, alias CHECK
(alias must target another address) + service-level "no alias of alias" (loops impossible),
owner-by-type CHECK, normalized-email CHECKs, draft revision, job attempts, approval requires
step-up, break-glass distinct approver and <= 4 h window, unique provider event ids, unique
outbound idempotency keys, unique `(mailbox, Message-ID)`, Restrict FKs to `admin_users`
(offboarding cannot cascade-delete history), append-only triggers on audit events, campaign
snapshots and template versions, legal-hold delete trigger on messages/attachments, GIN FTS index.

Artifacts: migration (manifest order 27), `manifest.json`, regenerated committed Prisma client,
`docs/sql/cosmicforge-mail-m1-m6-rollback.sql`. Validation: `prisma validate`, `prisma format`
no-op, manifest verify, migration safety scan, replay verify (zero drift), rollback verified on a
replay database (151 -> 115 tables, no other objects touched).
Procedure: `docs/cosmicforge-mail-staging-migration-runbook.md`.

## 4. API inventory

Base `/api/mail/v1`; full list in `docs/cosmicforge-mail-api-contract.md` and
`GET /api/mail/v1/openapi.json` (OpenAPI 3.1). Groups: me/entitlements, mailboxes/threads/
messages/labels/search/contacts, drafts/attachments/send/status/download, support queue/assign/
status/lock/notes/ticket-link/activity/members/settings/directory, admin organizations/domains/
addresses/mailboxes/offboard/sender-grants/legal-holds/retention/status, provisioning, step-up,
break-glass, webhook, public consent confirm, marketing (organizations, sender identities,
contacts, consents, import, suppressions, audiences, segments, templates, versions, render,
legacy templates, campaigns, preflight, submit, approve, reject, history, snapshots).

Authorization: bearer HQ token + ACTIVE identity on every route; mailbox content only via active
membership or approved break-glass; admin endpoints via `mail/admin` grant (SUPER implicit, no
content); break-glass and marketing scopes via explicit grants only. Send returns **202** with
`jobId`; provider acceptance is `PROVIDER_ACCEPTED`, never `DELIVERED`. Only external recipients
are sent through the provider, using a persisted per-job batch plan with one stable
`Idempotency-Key` per batch. Resend keeps keys for 24 hours only, so ambiguous sends are retried
with the same key only inside a 23-hour window; after that (or on a 409
`invalid_idempotent_request`, or a crash on the final attempt) the recipients become
`OUTCOME_UNKNOWN` for human review. This is at-most-once-with-review, **not** guaranteed
exactly-once delivery. Expired leases are recovered; exhausted jobs dead-letter. See section 9.

## 5. Frontend deliverables

Routes: `/dashboard/mail`, `/dashboard/mail/[mailboxId]`, `/dashboard/mail/[mailboxId]/thread/[threadId]`,
`/dashboard/mail/compose`, `/dashboard/mail/settings`, `/dashboard/help/email` (+`/channel`, now
real data), `/dashboard/marketing/email-marketing` (+ campaigns, campaign detail, audiences,
contacts, templates, template editor, automation). Components in `src/components/mail/` and
`src/components/marketing/email-marketing/`. Sidebar gains Mail from backend entitlements;
Marketing sub-nav gains Email Marketing (legacy sections unchanged). Responsive three-pane /
single-pane layouts; lint 0 errors (197 pre-existing warnings), `tsc` clean, `next build` passes.

## 6. Security and reliability

Controls: deny-by-default object authorization, SUPER privacy denial, explicit break-glass with
TOTP step-up for requester and a different approver, READER-only time-boxed access with audited
reads, per-request revocation, server-resolved From identities, quotas and per-user send rate
limits, header-injection guards, strict address parsing, Svix signature + timestamp + size checks
on exact raw bytes, event dedupe, AES-256-GCM content encryption with purpose-bound AAD and
checksum verification, no public attachment URLs, attachment type policy + malware scanning
(fail closed), sanitized HTML + remote image blocking + sandboxed iframe rendering, SSRF allowlist
for attachment downloads, CSV formula protection, consent evidence + suppression + brand isolation,
immutable approval snapshots, append-only audit, legal holds, Mail caches cleared on login/logout/
401/403 and never written to browser storage.

Resilience: provider outage -> retries -> dead letter (no false success); worker crash -> lease
recovery + reconciliation; storage/keyring/scanner missing -> 503/quarantine; Mail never touches the
HealthNet Main DB (verified statically and in the browser run with Main DB unreachable).

**Release blocker (security):** the existing HQ frontend stores the access token in
`localStorage` (and a JS-readable cookie). Any XSS anywhere in the admin web app could read it and
then read private mail. Mail mitigates (sandboxed rendering, sanitization, no mail in storage), but
private mail should not go to production before the HQ session moves to httpOnly cookies /
short-lived tokens. This requires a broader auth migration and was not attempted here.

Other blockers: TOTP enrollment UI/flow does not exist (step-up returns `MAIL_MFA_NOT_ENROLLED`
until `twoFactorSecret` is provisioned); production KMS-backed keyring and private object storage
are not provisioned (filesystem adapter is for staging only); ClamAV service not provisioned.

## 7. Deployment readiness

Flags (all default false): `MAIL_ENABLED`, `MAIL_SENDING_ENABLED`, `MAIL_RECEIVING_ENABLED`,
`MAIL_MARKETING_ENABLED`, `MAIL_WORKER_ENABLED`. Secrets/config: `RESEND_API_KEY`,
`RESEND_WEBHOOK_SECRET`, `MAIL_ENCRYPTION_KEYS`, `MAIL_STORAGE_PROVIDER`/`MAIL_STORAGE_LOCAL_DIR`,
`MAIL_SCANNER_PROVIDER` (+ clamd host), `MAIL_DOMAIN_ALLOWLIST`. Worker: `npm run mail:worker` as
one separate container. Approvals still needed: Admin DB owner (migration window), Resend account
owner (test domain, API key, webhook endpoint + receiving route), domain/DNS owner (test domain
only), security (session hardening, KMS, scanner), brand owners (marketing grants and consent
policy versions). Production remains blocked on section 6.

## 8. Git delivery

Branch `claude/gallant-ramanujan-0h6e6b` (from `origin/staging`), commits:
schema+migration, backend module, frontend, fixes+docs. No PR was opened, nothing merged to
`staging`, nothing deployed, no real database migrated, no DNS/MX/Resend configuration changed,
no secrets committed. Production is untouched.

## 9. Post-implementation review and remediation

Reviewed after merging the latest `staging` (two frontend-only commits, no conflicts).

### Bugs found and fixed

1. **Mixed-recipient duplicate external delivery (high).** The outbound processor built the
   Resend `to`/`cc` lists from every non-BCC recipient, including internal recipients that had
   already received a local copy. They were sent again through the provider; if the company MX
   does not route back to Resend this produced a duplicate (or a copy in a legacy mail system).
   Fix: a deterministic plan built only from `PENDING` (external) recipients. Internal To/CC/BCC
   are never sent externally. Resend requires `to` and documents no way to set visible headers
   separately from recipients, so external CC is promoted to `to` when there is no external To,
   and BCC-only mail is sent as one request per recipient.
   Limitation: external recipients see only external To/Cc in the headers.
2. **Unsafe retry outside Resend's idempotency window (high).** Ambiguous sends were retried with
   the same key indefinitely, but Resend only keeps keys for 24 hours, so a late retry could send
   twice. Fix: `firstAttemptAt` is persisted per batch before each provider call. After
   `MAIL_PROVIDER_IDEMPOTENCY_WINDOW_HOURS` (default and max 23) the batch is never re-sent and
   becomes `OUTCOME_UNKNOWN` (new message and recipient status, audited, sender notified).
3. **All HTTP 409s treated as retryable (medium).** Resend's `invalid_idempotent_request` (same key,
   different payload) is now `OUTCOME_UNKNOWN`. `concurrent_idempotent_requests` stays retryable.
4. **Queued mail bypassed later revocation (medium).** Dispatch now re-checks, before every
   provider call:
   - the sender is ACTIVE;
   - the membership is still active with send rights;
   - the sender identity is still approved;
   - the mailbox and address are still active;
   - the domain is VERIFIED with sending VERIFIED (the domain kill-switch);
   - the domain is on the allowlist.

   Batches that fail any check are cancelled as FAILED with the reason, and the sender is notified.
5. **Lease-expiry dead letters left messages QUEUED forever (medium).** Jobs that exhausted
   attempts during crash recovery never called the dead-letter handler. They now do, and
   attempted-but-unanswered batches become `OUTCOME_UNKNOWN`.
6. **HTML attribute injection in the sanitizer (high, contained).** A `safeAttrValue` override
   returned attribute values unescaped, so `<td width='x" onmouseover="alert(1)'>` produced a live
   event handler. The frontend's script-less sandboxed iframe was the only thing containing it.
   Values are now escaped (`escapeAttrValue`), and a regression test covers five payloads.
7. **Mail to one's own address did not appear in the inbox (low).** Self-addressed mail now marks
   the sender's thread as inbound (still a single copy).

Schema: `OUTCOME_UNKNOWN` was added to both status enums and `provider_message_id` to recipients.
These are folded into the still-unapplied migration
`20261024_add_cosmicforge_mail_m1_m6.sql`, with the manifest checksum regenerated. It had never
been applied to any real database.

### Documented sending / revocation policy

- Revocation, offboarding, address suspension, domain kill-switch or allowlist removal take
  effect for every batch not yet accepted by the provider. Accepted mail cannot be recalled.
- `MAIL_SENDING_ENABLED=false` while mail is queued: jobs retry and, if still disabled when
  attempts are exhausted, the message is marked FAILED (never reported as sent).
- Ambiguous provider outcomes are retried with the identical payload and key inside the window.
  Afterwards they are `OUTCOME_UNKNOWN` and require human review. Resend offers no lookup by
  idempotency key, so automatic resolution is not possible. A later provider delivery event can
  still resolve an unknown recipient to DELIVERED.

### Security review evidence (tests in `tests/mail-postgres.test.js` unless noted)

| Area | Result | Evidence |
| --- | --- | --- |
| Private mailbox access / SUPER | Pass | SUPER and mail admins get 404 on threads, search returns nothing, and they cannot add themselves to personal mailboxes |
| Shared membership revocation | Pass | Revoked member gets 404 on the next request; queued mail is cancelled at dispatch |
| Sender spoofing | Pass | Draft sender change to another mailbox's address is 403. From is resolved server-side and re-checked at dispatch |
| Attachment authorization | Pass | Non-members get 404; quarantined/infected files get 403; drafts are author-only |
| Sanitized rendering | Fixed (bug 6) | Unit tests cover scripts, handlers, forms, SVG, CSS url(), remote pixels and attribute injection |
| Webhook signatures | Pass | Unit tests for tampered bytes, re-serialised JSON, stale timestamp, wrong secret and oversize; integration tests for 401, duplicate and replay |
| Tenant-scoped search | Pass | Mailbox IDs are enforced in SQL; cross-mailbox search returns 404 |
| Marketing cross-brand | Pass | Other brand returns 404; cross-brand audience members are rejected; SUPER without a grant returns 404 |
| Step-up | Pass | Real TOTP required; replay, single use, purpose binding and not-enrolled are all rejected |
| Legal hold / retention | Pass / gap | API returns 409 and a DB trigger blocks deletes. No retention sweeper exists, so nothing is auto-deleted |
| Worker failure | Fixed (bugs 2, 5) | Crash recovery, final-attempt crash leads to `OUTCOME_UNKNOWN`, outage leads to dead letter then FAILED |
| Global auth / RBAC | Unchanged | `auth.middleware.js` and `rbac.middleware.js` were not modified |

### Release blocker status

| Item | Status |
| --- | --- |
| JavaScript-readable access token (`localStorage` + non-httpOnly cookie) | **Open, production blocker.** Mail mitigates (sandboxed rendering, sanitizer, in-memory cache cleared on login/logout/401/403) but cannot fix it |
| Secure httpOnly session migration | **Not started**; needs a separate auth migration across the admin app |
| TOTP enrollment | **Missing.** No enrollment flow exists, so step-up returns `MAIL_MFA_NOT_ENROLLED` and break-glass / campaign approval cannot be used yet |
| Private object storage + KMS | **Not provisioned.** Filesystem + env keyring is staging-only; fails closed when unset |
| Malware scanner | **Not provisioned** (clamd adapter implemented); without it every attachment is quarantined |
| Real Resend staging credentials | **Not provided**; adapter tested offline only |
| Verified staging test domain | **Not provided** |
| DNS / receiving route confirmation | **Not done** (out of scope; the app makes no DNS changes) |
| Staging Admin DB migration approval | **Pending**; runbook ready, nothing applied |
| Frontend automated E2E / accessibility | **Missing** as CI suites. Manual Playwright smoke run only, no axe audit |
| M6 gaps | No dispatch (M7 by design), no double-opt-in confirmation email, no retention sweeper, tickets page does not read `?ref=` |
