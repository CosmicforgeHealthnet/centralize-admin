# CosmicForge Mail: shared Resend account integration (one key set, one webhook)

Date: 2026-10-27. Scope: **application-level** integration only. GitHub Actions activation, server permissions,
migrations, backups, storage/KMS, ClamAV and the Mail worker belong to the infrastructure workstream ("Agent 1") and
are not changed here. Nothing in this document has been executed against Resend, the staging server or production.

**Status: code-ready for controlled staging testing once the infrastructure workstream reports ready. Not operational.**

## 1. The shared setup this code is built for

| Item | Value |
|---|---|
| Resend account | one, with one verified root domain `karryam.com` (sending + receiving) |
| API key `CosmicForge Admin Mail` (Full Access) | `RESEND_API_KEY` in CA staging **and** production (same value, owner's decision) |
| API key `KarryGo Notifications` (Sending Access) | KarryGo Notification Service + Partner Web SMTP password |
| Webhook | exactly **one** for the account. Staging acceptance: `https://stagingca.cosmicforge-healthnet.com/api/mail/v1/webhooks/resend`; later, after approval, the same webhook object re-pointed to `https://api.cosmicforge-healthnet.com/api/mail/v1/webhooks/resend` |
| Webhook signing secret | `RESEND_WEBHOOK_SECRET`, same value in whichever CA deployment the webhook points at |

`stagingca.cosmicforge-healthnet.com` resolves to the Contabo staging host the CI deploy targets (`173.249.30.55`);
`api.cosmicforge-healthnet.com` resolves to a different host (`72.61.20.94`).

## 2. What already existed (reused, unchanged)

- Resend REST adapter (`adapters/resend.adapter.js`) behind the provider contract (`adapters/provider-contract.js`):
  input validation, normalized errors, 429/5xx/timeout handling, idempotency keys, quota observation.
- Svix-signed webhook (`webhooks/resend-webhook.verifier.js` + controller): raw body, signature with rotation
  overlap, timestamp tolerance, size limit, `svix-id` dedup, event + job committed in one transaction before 200.
- Outbound: durable queue, per-dispatch re-authorization, ambiguous-outcome handling, delivery-event attribution.
- Inbound: fetch from provider, exact-address routing (no catch-all), unknown-recipient policy, scanning,
  encryption, threading, notifications, reconciliation.
- From PR #21: reserved `no-reply@karryam.com` (not grantable, not a staff identity, inbound discarded), events
  from reserved/unprovisioned senders acknowledged and not stored, the four department mailboxes and the
  `mail:provision:karryam` procedure.

## 3. What this change adds (and why)

Using the same key and webhook in two CA deployments plus KarryGo created three new failure modes:

| Risk | Change |
|---|---|
| Staging tests could mail real customers and burn the shared quota (which KarryGo OTPs depend on). | `MAIL_TEST_RECIPIENT_ALLOWLIST` (addresses, `@domain` or `domain`). When set, compose refuses unapproved external recipients with 422 `RECIPIENT_NOT_APPROVED`, and the provider contract refuses them again before any provider call (`PERMANENT`, nothing submitted). Broadcasts are blocked and audience sync refuses unapproved contacts while it is active. **Staging cannot enable sending without it** (`mail:config:validate` / readiness `infrastructure: MISCONFIGURED`). |
| Both deployments hold the same key, so the inbound **reconciler** of the deployment the webhook does not point at would list and ingest every received email: staging and production would compete for the same inbound mail. | `MAIL_INBOUND_ACTIVE_ENVIRONMENT` (`staging` or `production`, same value in both deployments). A deployment that is not the owner answers `email.received` with 503 `MAIL_INBOUND_NOT_ACTIVE_HERE` (nothing stored; Resend retries, and after a cutover delivers to the owner), defers queued inbound jobs and never runs reconciliation. **Staging and production cannot enable receiving without declaring it.** |
| Delivery events for mail sent by the other CA deployment (e.g. a late staging send after cutover) would be stored as unmatched events, with recipient addresses. | Every CA send now carries Resend tags `cf_app=cosmicforge-mail`, `cf_env=<MAIL_DEPLOYMENT_ENV>`. An event with CA's app tag and another `cf_env` is acknowledged `200 {ignored, reason: OTHER_DEPLOYMENT}` and not stored. Untagged events behave as before. |
| Campaigns sent from the Resend dashboard (e.g. `marketing.karryam.com`) emit broadcast events to the one webhook; CA stored them (recipient included) and then dropped them as `UNKNOWN_BROADCAST`. | A broadcast event whose `broadcast_id` CA never dispatched is acknowledged `200 {ignored, reason: FOREIGN_BROADCAST}` and not stored. CA's own broadcasts are unaffected. |

Delivery: the allowlist, the tags on sends and the worker-side inbound ownership (deferral + no reconciliation)
are in this change. The **webhook-side** rules (`OTHER_DEPLOYMENT`, `FOREIGN_BROADCAST`, 503 for a non-owner) are
in a separate follow-up PR stacked on the parallel webhook-hardening branch `claude/eager-tesla-itid0x`
(commit `09ccdca`: sender domain must be allowlisted, sender-less events must match a CA email id, 503 when the
ownership lookup fails, minimised inbound recipient storage). Merge that branch first, then the follow-up.

Webhook classification after the signature check, once both are merged (first match wins):

| Event | Result |
|---|---|
| unknown event type | 200 ignored (existing) |
| `email.*` (not received) tagged `cf_app=cosmicforge-mail` with another `cf_env` | 200 ignored `OTHER_DEPLOYMENT`, not stored |
| broadcast event for a broadcast CA did not dispatch | 200 ignored `FOREIGN_BROADCAST`, not stored |
| `email.*` (not received) from a reserved sender (`no-reply@karryam.com`, KarryGo OTPs), a sender domain not on `MAIL_DOMAIN_ALLOWLIST` (HealthNet, other brands), an address CA never provisioned, or with no `from` and an email id CA never sent | 200 ignored `FOREIGN_SENDER`, not stored |
| ownership lookup fails | 503, not stored (provider retries) |
| `email.received` while receiving is disabled | 503 (existing) |
| `email.received` on a deployment that is not the inbound owner | 503 `MAIL_INBOUND_NOT_ACTIVE_HERE`, not stored |
| everything else | stored + job, 200 (existing) |
| inbound mail addressed only to `no-reply@karryam.com` | processed and discarded, audited (PR #21) |

Unverified until the first live test: whether Resend echoes `tags` in webhook payloads. If it does not, the
`OTHER_DEPLOYMENT` rule is a no-op and the remaining rules still apply (an untagged event for the other deployment
matches no message and changes no mailbox).

## 4. Secrets and configuration for the infrastructure workstream (names only)

Install in the **`staging`** protected GitHub environment / staging backend env file, and separately in
**`production`** when promotion is approved. Never in the repository, logs or PR text.

| Variable | Staging | Production | Notes |
|---|---|---|---|
| `RESEND_API_KEY` | secret: `CosmicForge Admin Mail` key | same secret value | Full Access (CA reads received mail and domain status) |
| `RESEND_WEBHOOK_SECRET` | secret: the webhook's signing secret | same value | install before the webhook is pointed at that deployment |
| `RESEND_WEBHOOK_SECRET_PREVIOUS` | only during a secret rotation | same | |
| `MAIL_PROVIDER` | `resend` | `resend` | |
| `MAIL_DEPLOYMENT_ENV` | `staging` | `production` | also the `cf_env` tag value |
| `MAIL_PROVIDER_ENVIRONMENT_TAG` | optional: `staging` | optional: `production` | per-deployment marker; when set it must equal `MAIL_DEPLOYMENT_ENV` |
| `MAIL_DOMAIN_ALLOWLIST` | `karryam.com` | `karryam.com` | |
| `MAIL_RESERVED_SENDER_ADDRESSES` | `no-reply@karryam.com` | same | |
| `MAIL_TEST_RECIPIENT_ALLOWLIST` | approved test inboxes only | **empty** | required on staging before `MAIL_SENDING_ENABLED=true` |
| `MAIL_INBOUND_ACTIVE_ENVIRONMENT` | `staging` (during acceptance) | `staging` until cutover, then both `production` | required before `MAIL_RECEIVING_ENABLED=true` |
| `MAIL_PROVIDER_DAILY_LIMIT` / `MAIL_PROVIDER_MONTHLY_LIMIT` | account plan limits | same | shared with KarryGo |
| `MAIL_RECONCILIATION_ENABLED` | `true` with receiving | `true` with receiving | effective only on the inbound owner |
| `MAIL_ENABLED`, `MAIL_SENDING_ENABLED`, `MAIL_RECEIVING_ENABLED`, `MAIL_WORKER_ENABLED` | progressive, per `docs/cosmicforge-mail-karryam-resend-activation.md` §7 | off until promotion | |

KarryGo (KarryGo repository, its own deployment secrets): `NOTIFICATION_SMTP_HOST=smtp.resend.com`,
`NOTIFICATION_SMTP_PORT=465`, `NOTIFICATION_SMTP_TLS_MODE=tls`, `NOTIFICATION_SMTP_USERNAME=resend`,
`NOTIFICATION_SMTP_PASSWORD` (secret: `KarryGo Notifications` key), `NOTIFICATION_EMAIL_FROM="Karryam <no-reply@karryam.com>"`;
Partner Web, only if deployed: `PARTNER_SMTP_HOST`, `PARTNER_SMTP_PORT`, `PARTNER_SMTP_TLS_MODE`, `PARTNER_SMTP_USERNAME`,
`PARTNER_SMTP_PASSWORD` (secret), `PARTNER_SMTP_FROM=no-reply@karryam.com`, `PARTNER_SMTP_FROM_NAME=Karryam`
(see KarryGo `deploy/notification-service/RESEND_KARRYAM_CUTOVER.md` on branch `feat/karryam-resend-smtp-cutover-20261027`).

Quota: the account limit is shared by KarryGo OTPs and both CA deployments. Besides the allowlist, cap CA staging
with `PUT /api/mail/v1/admin/quotas` (`STAFF_MAIL` and `SUPPORT` `dailyHardLimit`, e.g. 20) so tests can never
starve OTP delivery.

## 5. KarryGo and Partner Web audit (KarryGo repository)

- Notification Service `SMTPEmailSender`: compatible with Resend SMTP as is (implicit TLS on 465 or STARTTLS on
  587, TLS >= 1.2, PLAIN auth, display-name From, Date header, 5xx = permanent, others retried, timeout).
  Note: `NOTIFICATION_SMTP_TLS_MODE=none` is still accepted by config validation; it would send the API key in
  clear text. Never use it with Resend (flagged, not changed).
- Notification Service records the provider message id as the literal `smtp`; Resend SMTP event correlation back
  to KarryGo deliveries is not available (documented on the KarryGo branch). CA never treats these events as its own.
- Partner Web `smtp_otp_sender.go`: compatible, but its message had **no Date or Message-ID header**. Fixed in a
  separate KarryGo PR (no config, sender or OTP logic change).
- No code in KarryGo (or cfmeet) consumes Resend webhooks; CA is the only webhook consumer in these repositories.

## 6. Before configuring (or re-pointing) the single webhook

1. In the Resend dashboard, record the existing webhook (if any): endpoint URL, subscribed events, status, and the
   last 7 days of deliveries. Identify any consumer other than CA (none exists in the KarryGo, cfmeet or CA code,
   but a no-code tool, n8n or another account user could). If one exists, stop: two consumers cannot share one
   endpoint without a fan-out that the owner must approve.
2. Do not create a second webhook. Edit the existing one (or create it if none exists) only in an approved step
   of the infrastructure workflow.
3. Events: `email.received`, `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`,
   `email.complained`, `email.failed`, `email.suppressed`. Not `email.opened`/`email.clicked` (not recorded for
   private mail).
4. Install `RESEND_WEBHOOK_SECRET` in the target deployment first; it must be the inbound owner
   (`MAIL_INBOUND_ACTIVE_ENVIRONMENT`) with Mail enabled, otherwise the endpoint answers 503.
5. Verify with Resend's test delivery: 200 for a delivered/sent event; a tampered body gets 401.

## 7. Staging -> production webhook cutover runbook (not now; needs explicit approval)

Preconditions: production deployed with its own database, storage, KMS key, scanner and worker; production
readiness `READY` with `MAIL_INBOUND_ACTIVE_ENVIRONMENT=staging` (so it answers inbound with 503 and ignores
nothing it should process); production `RESEND_WEBHOOK_SECRET` = the webhook's secret.

1. **Freeze staging outbound:** set staging `MAIL_SENDING_ENABLED=false` (queued mail defers, nothing is lost).
   Wait until staging has no `OUTBOUND` jobs in flight (`/admin/jobs`).
2. **Drain staging inbound:** confirm staging has no pending `PROCESS_INBOUND` jobs and the Resend webhook shows
   no failing deliveries.
3. **Switch ownership:** set `MAIL_INBOUND_ACTIVE_ENVIRONMENT=production` in **both** deployments and restart them
   (staging now answers `email.received` with 503; production accepts).
4. **Re-point the same webhook** in Resend to `https://api.cosmicforge-healthnet.com/api/mail/v1/webhooks/resend`.
   Deliveries that failed or are retried at that moment go to production, which owns them.
5. **Verify:** Resend test event -> production 200; one approved external email to `support@karryam.com` lands in
   production only; production readiness stays `READY`; staging receives nothing.
6. **Replay gap:** run production reconciliation once (`MAIL_RECONCILIATION_ENABLED=true`, lookback 24-72 h) so mail
   that arrived during the switch is ingested; it dedupes by provider id and Message-ID.
7. **Staging afterwards:** keep receiving off (or owner=production). Staging may send again only to the test
   allowlist; its events reach production, which ignores them as `OTHER_DEPLOYMENT` (if tags are echoed) or as
   unmatched.

Rollback: re-point the webhook to the staging URL, set `MAIL_INBOUND_ACTIVE_ENVIRONMENT=staging` in both, restart,
run staging reconciliation for the gap. Emergency stop at any time: `MAIL_RECEIVING_ENABLED=false` (503, provider
retries) and/or `MAIL_EMERGENCY_STOP_ALL=true` in the affected deployment. KarryGo is unaffected by every step.

## 8. Dependencies on the infrastructure workstream

Migrations 27-37 applied and verified; private S3-compatible storage + KMS; ClamAV; one Mail worker; the secrets
and variables in section 4; provisioning (`mail:provision:karryam`) and staff memberships; the webhook step in
section 6. Then controlled tests per `docs/cosmicforge-mail-karryam-resend-activation.md` §8 with the approved
recipients only.
