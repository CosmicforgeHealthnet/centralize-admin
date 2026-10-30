# CosmicForge Mail M7: broadcasts and automation

Status: code complete and tested offline. Nothing was sent. Real provider-backed
pilot testing is **pending authorization** (see the M10 pilot runbook).

## 1. What M7 adds

| Capability | Flag (all default `false`) | Where it runs |
| --- | --- | --- |
| Broadcast scheduling and dispatch | `MAIL_BROADCAST_DISPATCH_ENABLED` | API (schedule), `MARKETING` worker (dispatch) |
| Marketing automation execution | `MAIL_AUTOMATION_ENABLED` | `MARKETING` worker |
| Double opt-in confirmation emails | `MAIL_MARKETING_CONFIRMATION_EMAILS_ENABLED` | `MARKETING` worker |
| Emergency stop (keeps all records) | `MAIL_EMERGENCY_STOP_MARKETING`, `MAIL_EMERGENCY_STOP_ALL` | API + worker |

Every flag also requires `MAIL_ENABLED=true` and `MAIL_MARKETING_ENABLED=true`.
The `MARKETING` queue is served only by a worker started with
`MAIL_WORKER_QUEUES` containing `marketing`. Run it as **one** separate
replica; leases make extra replicas safe but there is no need for more.

## 2. Provider facts this design relies on (Resend, checked 2026-10-25)

- `POST /broadcasts` (`segment_id`, `from`, `subject`, `reply_to`, `html`,
  `text`, `name`, `send=false` creates a draft), `POST /broadcasts/{id}/send`,
  `GET /broadcasts/{id}` (status `draft | scheduled | queued | sent | canceled`),
  `POST /broadcasts/{id}/cancel` (`queued -> canceled`, `scheduled -> draft`),
  `DELETE /broadcasts/{id}` (draft/scheduled only).
- Contacts (`POST /contacts`, `GET|PATCH /contacts/{id|email}`) and their
  `unsubscribed` flag are **global to a Resend account**. Segments:
  `POST /segments`, `POST|DELETE /contacts/{id}/segments/{segment_id}`.
- `Idempotency-Key` is supported **only** on `POST /emails` and
  `/emails/batch`, kept 24 hours. Broadcast calls are not idempotent.
- Default rate limit: 10 requests/second per team; `429` with `retry-after`.
- Webhooks: `email.*` events carry `broadcast_id`; `contact.updated` carries
  `unsubscribed`; `email.suppressed` exists. Broadcast HTML uses
  `{{{RESEND_UNSUBSCRIBE_URL}}}` and `{{{contact.first_name}}}` merge tags.

Consequences in code:

- **One Resend account (API key) per brand.** `RESEND_MARKETING_API_KEY__<SLUG>`.
  A shared key works only with `MAIL_BROADCAST_ALLOW_SHARED_PROVIDER_ACCOUNT=true`,
  because with a shared account one brand's unsubscribe silently affects
  another brand, and contacts mix across brands.
- **Per-brand webhook endpoint** `POST /api/mail/v1/webhooks/resend/brand/:slug`
  verified with `RESEND_WEBHOOK_SECRET__<SLUG>`. Events from one brand's
  endpoint can never change another brand's records.
- **No blind retries of broadcast calls.** See section 4.

## 3. Broadcast lifecycle

Campaign: `DRAFT -> READY_FOR_REVIEW -> APPROVED -> SCHEDULED -> QUEUED ->
SENDING -> COMPLETE | PARTIAL | FAILED | CANCELLED | OUTCOME_UNKNOWN`.
The dispatch has its own status, with `PREPARING` and `PAUSED` added.

1. **Approve (M6, extended).** The approver's MFA step-up is consumed. The
   approval snapshot is stored (immutable). M7 also stores the exact
   reviewed recipient set in `marketing_campaign_approved_contacts`
   (append-only, enforced by a trigger). Preflight now requires the brand
   **postal address**, which is rendered into the mandatory footer and
   covered by the content hash.
2. **Schedule** (`POST .../campaigns/:id/schedule`, author or reviewer).
   - Input is either `sendAt` (local wall-clock time) plus an IANA
     `timeZone`, or `sendAtUtc` with an offset.
   - A local time that does not exist (spring-forward gap) is rejected; an
     ambiguous one (fall-back) uses the first occurrence and says so.
   - Minimum lead time is `MAIL_BROADCAST_MIN_LEAD_SECONDS` (so it can still
     be cancelled); maximum is 60 days ahead.
   - The approval must be younger than `MAIL_CAMPAIGN_APPROVAL_TTL_DAYS`.
   - A campaign is dispatched once (unique). Any edit returns it to review.
3. **Dispatch** (worker, job `BROADCAST_DISPATCH`). The phases and their
   persisted progress are:
   - **verify**: approval snapshot hash, no later invalidation, approval
     age, sender is an active brand identity, sending gate (allowlist,
     verified domain, kill-switch).
   - **recipients**: approved set ∩ eligible now (consent granted and
     confirmed, not suppressed, contact active), minus contacts mailed by
     this brand within the campaign frequency cap. Contacts added after
     approval are never sent. Hard caps apply: `MAIL_BROADCAST_MAX_RECIPIENTS`
     and the brand settings (`maxBroadcastRecipients`, `dailyBroadcastCap`).
     Exceeding a cap fails the whole dispatch before any provider call.
   - **segment**: one provider segment per dispatch, named `cf-dispatch-<id>`
     and found by name on retry.
   - **sync**: each recipient is re-checked, then created in or added to the
     segment, idempotent by email. A contact the provider already marks
     unsubscribed is withdrawn locally and excluded.
   - **recheck**: anyone who withdrew since sync is removed from the segment.
   - **create**: a draft broadcast named `cf-dispatch-<id>`, found by name on
     retry. Content is the approved snapshot with placeholders mapped to
     provider merge tags.
   - **send**: `provider_send_attempted_at` is stored before the call.
4. **Reconcile** (job `BROADCAST_RECONCILE`): the worker polls the provider
   status until `sent`/`canceled`, then finalises `COMPLETED`, `PARTIAL`
   (some recipients failed sync, or a cancel arrived after delivery started),
   `CANCELLED` or `FAILED`.
5. **Delivery events** update recipients without regressing (a late
   `email.sent` never overwrites `DELIVERED`).
   - Bounces and complaints suppress the address for that brand only.
   - `contact.updated` with `unsubscribed=true` withdraws all of the brand's
     consents, adds an `UNSUBSCRIBED` suppression, exits automations and
     stops unsent broadcast recipients.
   - Opens and clicks are stored but reported as **indicative**.

Pause and resume work before the provider handoff. A brand-wide pause
(`/dispatch/pause`, any author or reviewer) defers every broadcast and
automation without consuming retry attempts. Resuming needs a reviewer and
an MFA step-up (`MARKETING_BROADCAST_OVERRIDE`). Cancel is complete before
the handoff. After the handoff it calls the provider cancel, which stops only
unsent mail; the UI and API say that sent mail cannot be recalled.

## 4. Ambiguity and restart rules

| Situation | Behaviour |
| --- | --- |
| Worker crash mid-phase | Lease expires; another worker resumes from the persisted phase |
| Segment/broadcast create response lost | Found by name on retry; at most one used |
| Contact sync timeout | Retry looks the contact up by email first |
| Send response lost | Provider status read: `draft` -> safe to send again; `queued/sent` -> accepted; unreadable for > 1 hour -> `OUTCOME_UNKNOWN` |
| Retries exhausted after handoff attempt | `OUTCOME_UNKNOWN`, recipients `OUTCOME_UNKNOWN`, owners notified |
| Flag off / emergency stop / brand pause | Job deferred (no attempt consumed), records kept |

`OUTCOME_UNKNOWN` is never shown as delivered and is never retried
automatically. A human reviews the provider dashboard before any resend.

## 5. Automation

- **Definitions** are bounded, acyclic graphs of `send_email`, `delay`
  (1 min to 90 days), `condition` and `exit` steps. Limits: at most 30 steps
  and 10 sends. Conditions use contact fields, approved event fields or the
  previous send's delivery/engagement.
- **Triggers**:
  - `CONSENT_GRANTED`: welcome flows.
  - `PRODUCT_EVENT`: only the approved, versioned registry in
    `marketing/automation/event-registry.js`. The payload is minimised to the
    listed fields, and a product event is never consent.
  - `SCHEDULE`: daily, weekly or monthly in an IANA time zone. Only the
    latest due occurrence runs; missed occurrences are not backfilled.
- **Review**:
  - Authors save a DRAFT version and submit it.
  - A different reviewer publishes it with an MFA step-up
    (`MARKETING_AUTOMATION_PUBLISH`), optionally pinning the definition hash.
  - Submitted versions are immutable (DB trigger).
  - Enrollments stay on the version they started with.
  - Only reviewers activate.
  - Events that occurred before the latest activation never enroll.
- **Execution**:
  - Each step is a durable job.
  - Every send re-checks topic consent, suppression, contact status, the
    automation frequency cap (wait, not skip), the brand daily cap, the postal
    address, the unsubscribe configuration and the sending gate.
  - Sends use one `Idempotency-Key` per enrollment step and follow the 23-hour
    window rule: an ambiguous outcome is retried with the same key, and once
    outside the window it becomes `OUTCOME_UNKNOWN`.
  - Sends carry `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058)
    headers.

## 6. Recipient-facing endpoints

- **Unsubscribe and preference page**:
  - `GET /api/mail/v1/public/unsubscribe/:token` shows the page; it never
    changes consent.
  - `POST` to the same URL unsubscribes: a form post, or an RFC 8058
    one-click post.
  - Tokens are HMAC-signed with `MAIL_MARKETING_UNSUBSCRIBE_SECRET` (a
    previous secret is accepted during rotation). They are bound to brand,
    contact and topic, and contain no email address.
  - Pages use a strict CSP, no scripts, a masked email and no-store.
- **Double opt-in**: the email links to `GET /public/consent/confirm/:token`,
  a landing page that does not confirm; the `POST` confirms. The token is
  sealed with AES-GCM in the job payload. Admin API responses no longer
  return the token in production or when confirmation emails are on.

## 7. Database (migration 30, `20261027_mail_m7_broadcasts_automation.sql`)

New tables: `marketing_brand_settings`, `marketing_campaign_approved_contacts`,
`marketing_broadcast_dispatches`, `marketing_broadcast_recipients`,
`marketing_automations`, `marketing_automation_versions`,
`marketing_automation_enrollments`, `marketing_automation_step_runs`,
`marketing_trigger_events`.

New enum values: `MailJobQueue.MARKETING`, `MarketingEmailCampaignStatus.OUTCOME_UNKNOWN`
(added with `IF NOT EXISTS`, and not used in the same file).

Constraints and triggers: trigger-type and limit checks; published versions
require a distinct reviewer and a step-up; `SENDING`/`COMPLETED` require a
provider broadcast id; versions are immutable after submit; approved
recipient sets are append-only.

## 8. Tests (offline; network guard on)

- `tests/mail-m7-postgres.test.js` covers, on a replayed PostgreSQL 16:
  - pilot flow, time zones, eligibility at dispatch, report rates;
  - unsubscribe, complaint and provider unsubscribe, including the
    cross-brand webhook rejection;
  - ambiguous create/send, crash recovery and `OUTCOME_UNKNOWN`;
  - cancel early and late, pause, brand pause with step-up resume, and
    emergency stop;
  - approval expiry, sender revocation, domain kill-switch, caps and
    frequency cap;
  - automation review, MFA, version binding, consent withdrawal, pause,
    product events, ambiguous sends, schedules, double opt-in and public
    unsubscribe.
- `tests/mail-m7-unit.test.js` covers: flags; Resend endpoint and payload
  conformance; error classification; per-brand keys; definition validation
  (cycles, unreachable steps, unsupported types); the event registry;
  DST handling; tokens; merge-tag mapping; idempotency-window rules; the
  fake provider lifecycle; OpenAPI parity.
- `apps/central-admin-web/e2e/marketing-broadcast.spec.ts` covers scheduling,
  the cancel warning, unknown outcomes, brand resume with 2FA, automation
  publish with 2FA, author separation and mobile layout.

## 9. Not done / pending authorization

- Live Resend broadcast pilot: needs a brand Resend account, key and webhook
  secret, a verified test domain, a test audience and explicit approval. See
  `docs/cosmicforge-mail-m10-pilot-runbook.md`.
- Large audiences (> 100k) would need Resend contact imports instead of
  per-contact sync. The hard ceiling stays at 100,000.
- Topic preferences use CosmicForge consent per topic. Provider topics
  (`topic_id`) are not used because the segment already contains only
  eligible contacts.
