# CosmicForge Mail: Karryam on one Resend domain (`karryam.com`) - readiness and activation runbook

Date: 2026-10-27. Branch: `claude/gallant-ramanujan-0h6e6b` (from `staging` @ `c01dc4d`), draft PR to `staging`.
Nothing in this document has been executed against Resend, Hostinger DNS or the shared staging database.

## 0. Status at a glance

| Part | Code-complete | Deployed to staging | Live-tested |
|---|---|---|---|
| Four shared Karryam mailboxes (`info@`, `support@`, `marketing@`, `partnership@`) | Yes (existing model + new provisioning procedure) | Code: after this PR merges. Data: **no** (needs DB access) | No |
| Personal employee mailboxes (`david@karryam.com`) | Yes (existing HR/IT request workflow; re-tested) | Code only | No |
| Reserved `no-reply@karryam.com` (KarryGo-owned) | Yes (new: send-as blocked, inbound discarded, foreign webhook events not stored) | Code: after merge | No |
| Outbound: compose -> gate -> queue -> Resend adapter -> events | Yes (existing; re-tested with the four identities) | Code yes, Mail **off** | No |
| Inbound: MX -> `email.received` -> verify -> job -> fetch -> route -> scan/encrypt -> store -> thread | Yes (existing + no-reply policy) | Code yes, Mail **off** | No |
| Shared webhook with KarryGo events | Yes (new filter) | Code: after merge | No |
| Admin UI (IT -> Mail Administration, user Mail) | No change needed (section 9) | Yes | No |
| Staging DB migrations 27-37 | Files ready, manifest verified | **Unknown / not applied by this work** | No |
| Storage (S3 + KMS), ClamAV, Mail worker | Code ready | **Not provisioned** (live readiness: `encryption NOT_CONFIGURED`, `scanner NOT_CONFIGURED`) | No |

**This is not "waiting for Resend only".** Before any Resend step can be accepted, the staging database,
storage/KMS, scanner and worker items in section 3 must be done by their owners.

Live probe (2026-10-27, read-only) of the staging API that runs this Mail code:

```
GET https://stagingca.cosmicforge-healthnet.com/api/mail/v1/health/ready  -> 200
{"ready":false,"enabled":false,"state":"DISABLED","dependencies":{"schema":"NOT_CHECKED","encryption":"NOT_CONFIGURED",
 "storage":"NOT_CHECKED","scanner":"NOT_CONFIGURED","provider":"NOT_CONFIGURED","webhooks":"NOT_CONFIGURED","infrastructure":"OK"},
 "session":{"mode":"legacy","hardened":false,"required":false,"status":"WARNING","reason":"JS_READABLE_ACCESS_TOKEN"}}
```

`https://api.cosmicforge-healthnet.com` could not be reached from the build sandbox (connection reset), so it is
**not confirmed** which code it runs. Register the staging webhook against `stagingca.cosmicforge-healthnet.com`
(section 6.4) unless the infrastructure owner confirms otherwise.

## 1. Target architecture

| Address | Kind in CA | Mailbox | Purpose | Sender display name | Who sends |
|---|---|---|---|---|---|
| `info@karryam.com` | SHARED | SHARED | GENERAL | `Karryam` | Assigned CA staff |
| `support@karryam.com` | SHARED | SHARED | SUPPORT (queue, SLA, ticket links) | `Karryam Support` | Assigned CA staff |
| `marketing@karryam.com` | SHARED | SHARED | MARKETING (departmental inbox; campaign replies) | `Karryam Marketing` | Assigned CA staff |
| `partnership@karryam.com` | SHARED | SHARED | GENERAL (no new enum: no workflow needs one) | `Karryam Partnerships` | Assigned CA staff |
| `<person>@karryam.com` | PRIMARY | PERSONAL | - | the person's name | That person only |
| `no-reply@karryam.com` | SYSTEM, **no mailbox**, listed in `MAIL_RESERVED_SENDER_ADDRESSES` | none | KarryGo OTPs, login codes, password resets | `Karryam` | **KarryGo Notification Service only**, via Resend SMTP |

- One Resend domain: `karryam.com` (sending + receiving). `marketing.karryam.com` stays a separate campaign domain;
  it is not touched here and broadcast dispatch stays off.
- KarryGo never calls CA for authentication mail; CA is not in that path. CA never calls KarryGo.
- HealthNet is untouched: its organization (`MAIL_RESTRICTED_HEALTH_ORGANIZATIONS=healthnet`) can never send through
  Resend, its domains are not on the allowlist, and inbound routing is by exact provisioned address only.

### Mail flows

```
Outbound (CA staff):  compose (membership + sender identity) -> sendDraft (content policy, quotas, sending gate)
  -> mail_outbox_jobs (durable, idempotency key) -> worker: re-check membership/identity/gate/emergency stop
  -> Resend POST /emails (From "Karryam Support <support@karryam.com>", Message-ID, In-Reply-To, References)
  -> PROVIDER_ACCEPTED -> webhook email.delivered/bounced/... -> per-recipient status

Inbound:  sender -> MX karryam.com (Resend) -> POST /api/mail/v1/webhooks/resend (email.received, svix signature,
  raw body) -> mail_webhook_events + PROCESS_INBOUND job in one transaction -> 200
  -> worker: GET received email + attachments -> resolve recipients (exact ACTIVE addresses only)
  -> reserved (no-reply@): discard + audit | unknown: reject (or quarantine-hold) + audit | known: scan, encrypt,
     store one copy per mailbox, thread by Message-ID/In-Reply-To/References, rules, notify members

KarryGo:  notification-service -> Resend SMTP (smtp.resend.com) From "Karryam <no-reply@karryam.com>"
  -> Resend emits email.* events to the same (only) webhook -> CA answers 200 {ignored, FOREIGN_SENDER}, stores nothing
```

## 2. What this change added (and why)

Audit result: domain/mailbox/membership/grant models, outbound/inbound pipelines, webhook verification, readiness
and the admin API already supported four shared mailboxes under one domain. Three real gaps were found and fixed:

| Gap (found on `staging` @ `c01dc4d`) | Fix |
|---|---|
| A mail admin could grant staff a sender grant on a `SYSTEM` address (e.g. `no-reply@`), and `listSenderIdentities` would then let them send as it. | `SYSTEM` and reserved addresses are refused for sender grants and grant requests (`403 SYSTEM_IDENTITY_NOT_GRANTABLE`) and are never returned as staff identities, even for a pre-existing grant (`authz/mail.policy.js`, `services/mail-admin.service.js`). A reserved address can only be created as `SYSTEM` without a mailbox (`400 RESERVED_ADDRESS_SYSTEM_ONLY`). Marketing refuses reserved addresses as From/Reply-To (`RESERVED_SENDER`, `REPLY_TO_RESERVED`) and hides them from the sender list. |
| Replies to KarryGo mail (`no-reply@karryam.com`) would be "unknown recipient": rejected, or under the quarantine policy held as operator jobs indefinitely. | Explicit no-reply policy: reserved recipients are discarded and audited (`MAIL_INBOUND_RESERVED_ADDRESS_DISCARDED`, counts/domains only), never held, stored or answered (`pipelines/inbound.processor.js`). |
| With one Resend account and one webhook, every KarryGo OTP `email.sent/delivered/bounced` event would be stored in CA (customer addresses in `mail_webhook_events` / unmatched `mail_delivery_events`, forever). | Outbound email events whose `from` is reserved, or is not an address CA ever provisioned, are acknowledged `200 {ignored:true, reason:"FOREIGN_SENDER"}` after signature verification and nothing is stored (`webhooks/resend-webhook.controller.js`). Inbound, broadcast and contact events are unaffected. |

Plus: `MAIL_RESERVED_SENDER_ADDRESSES` config (validated by `npm run mail:config:validate`), an idempotent provisioning
procedure (`src/modules/mail/ops/brand-mail-provisioning.js`, `npm run mail:provision:karryam`), and two test suites.

## 3. Non-Resend prerequisites (must be done first; owners in section 12)

### 3.1 Staging Central Admin database: migrations 27-37 (DB owner)

The ledger of the shared staging DB is not readable without credentials. Follow
`docs/cosmicforge-mail-staging-migration-runbook.md`; in short:

```bash
cd services/central-admin-api
export DATABASE_URL='postgresql://<owner>@<staging-admin-host>/cosmicforge_admin'   # never commit; never a HealthNet/KarryGo DB
npm run db:manifest:verify                     # 37 migrations, 0 checksum failures (verified 2026-10-27)
npm run db:admin:guard                         # must print database=cosmicforge_admin (refuses remote hosts unless run via an approved tunnel)
pg_dump --format=custom --no-owner --file "admin-staging-pre-karryam-$(date +%Y%m%d%H%M).dump" "$DATABASE_URL"
pg_restore --list admin-staging-pre-karryam-*.dump | head
psql "$DATABASE_URL" -Atc "SELECT file FROM social_manual_migrations ORDER BY file"   # compare with manifest orders 27-37
npm run db:admin:prepare                       # applies only missing files in manifest order, refuses checksum mismatches
npm run db:schema:assert
curl -s https://stagingca.cosmicforge-healthnet.com/api/mail/v1/health/ready   # still DISABLED (flags off)
```

This change adds **no migration**.

### 3.2 Private storage, KMS and scanner (Infrastructure)

| Item | Variables | Check |
|---|---|---|
| S3 bucket with `staging`/`stg` in its name, private, SSE | `MAIL_STORAGE_PROVIDER=s3`, `MAIL_S3_BUCKET`, `MAIL_S3_REGION`, `MAIL_S3_ENDPOINT` (https, optional), `MAIL_S3_ACCESS_KEY_ID`, `MAIL_S3_SECRET_ACCESS_KEY`, `MAIL_S3_SSE` (`AES256` or `AWS:KMS`), `MAIL_S3_SSE_KMS_KEY_ID` | `MAIL_S3_LIVE_ENDPOINT=... npm run test:mail:s3-kms-live` |
| KMS key (alias with `staging`/`stg`, or ARN + `MAIL_KMS_KEY_ENVIRONMENT=staging`) | `MAIL_KMS_PROVIDER=aws-kms`, `MAIL_KMS_KEY_ID`, `MAIL_KMS_REGION`, `MAIL_KMS_ACCESS_KEY_ID`/`MAIL_KMS_SECRET_ACCESS_KEY` (or the S3 pair) | `npm run mail:kms:generate-data-key` -> `MAIL_ENCRYPTION_KEYS`, `MAIL_ENCRYPTION_ACTIVE_KEY` |
| ClamAV (clamd, official signatures, `StreamMaxLength >= 25M`) | `MAIL_SCANNER_PROVIDER=clamd`, `MAIL_CLAMD_HOST`, `MAIL_CLAMD_PORT` | `MAIL_CLAMD_LIVE_HOST=... npm run test:mail:clamd-live` |
| Dedicated Mail worker process (one replica) | same image, command `npm run mail:worker`, `MAIL_WORKER_QUEUES=outbound,inbound,events` | worker log `liveness` lines; `/admin/ops/snapshot` queue counts |
| Metrics endpoint (optional) | `MAIL_METRICS_TOKEN` (>= 32 chars) | `GET /api/mail/v1/ops/metrics` with the token |

Never substitute `memory`/local storage, `MAIL_KMS_PROVIDER=env` keys or a disabled scanner to get a green status:
`staging` refuses memory storage, and an enabled Mail with no scanner is not ready to receive.

Then: `MAIL_DEPLOYMENT_ENV=staging npm run mail:config:validate` must print `"violations":[]`.

### 3.3 Session hardening (Security, recommended before staff use)

Live readiness reports `session.mode=legacy` (`JS_READABLE_ACCESS_TOKEN`). It does not block staging, but set
`AUTH_SESSION_MODE=cookie` (or `dual` + `MAIL_SESSION_ALLOW_DUAL=true`) before real mailbox content is read.

## 4. Staging environment checklist (no values here; secrets only in the secret manager)

Phase A - deploy (everything off; this is the profile the unit tests pin):

```dotenv
MAIL_DEPLOYMENT_ENV=staging
MAIL_PROVIDER=resend
MAIL_PROVIDER_ENVIRONMENT_TAG=staging
MAIL_DOMAIN_ALLOWLIST=karryam.com
MAIL_RESERVED_SENDER_ADDRESSES=no-reply@karryam.com
MAIL_ENABLED=false
MAIL_SENDING_ENABLED=false
MAIL_RECEIVING_ENABLED=false
MAIL_WORKER_ENABLED=false
MAIL_MARKETING_ENABLED=false
MAIL_BROADCAST_DISPATCH_ENABLED=false
MAIL_AUTOMATION_ENABLED=false
MAIL_PROVIDER_DOMAIN_MANAGEMENT_ENABLED=false
MAIL_MIXED_RECIPIENT_MODE=external-only
MAIL_MARKETING_PROVIDER_RESUBSCRIBE_ENABLED=false
MAIL_INTEGRATION_KARRYAM_COMPAT_SERVICES=
MAIL_UNKNOWN_RECIPIENT_POLICY=reject
RESEND_API_KEY=
RESEND_WEBHOOK_SECRET=
```

Phase B - infrastructure (section 3.2): `MAIL_STORAGE_PROVIDER`, `MAIL_S3_*`, `MAIL_KMS_*`, `MAIL_ENCRYPTION_KEYS`,
`MAIL_ENCRYPTION_ACTIVE_KEY`, `MAIL_SCANNER_PROVIDER`, `MAIL_CLAMD_HOST`, `MAIL_CLAMD_PORT`, optional `MAIL_METRICS_TOKEN`.

Phase C - provider (section 6): `RESEND_API_KEY` (CA's own key), `RESEND_WEBHOOK_SECRET` (the endpoint's `whsec_...`),
`MAIL_PROVIDER_DAILY_LIMIT` / `MAIL_PROVIDER_MONTHLY_LIMIT` (the plan limits shown in Resend), optionally
`RESEND_REQUESTS_PER_SECOND` (default 8), `RESEND_ATTACHMENT_HOST_ALLOWLIST` (default `resend.com,resend.app,resend-attachments.com`;
confirm against a real received attachment URL).

Phase D - application URLs: `MAIL_PUBLIC_APP_URL` (staging web origin), `MAIL_PUBLIC_API_URL`
(`https://stagingca.cosmicforge-healthnet.com`), and only if marketing confirmations/unsubscribe links are used later:
`MAIL_MARKETING_UNSUBSCRIBE_SECRET` (>= 32 chars).

Optional tuning (defaults are fine): `MAIL_WORKER_*`, `MAIL_ATTACHMENT_MAX_BYTES`, `MAIL_MAX_RECIPIENTS`,
`MAIL_MAILBOX_STORAGE_QUOTA_MB`, `MAIL_INBOUND_AUTH_POLICY`, `MAIL_RECONCILIATION_ENABLED` (turn on with receiving),
`MAIL_ALERT_*`, `MAIL_RETENTION_*` (no purge periods are defaulted).

Leave unset/false: `MAIL_BODY_SEARCH_ENABLED`, `MAIL_ARCHIVE_RAW_MIME`, `MAIL_RECEIVING_CUTOVER_CONFIRMED`,
`MAIL_ORIGIN_HEADER_SECRET`, `MAIL_INTEGRATIONS_ENABLED`, `MAIL_FORWARDING_EXTERNAL_ALLOWED_DOMAINS`,
`MAIL_RESTRICTED_HEALTH_PROVIDER_APPROVED`, `MAIL_EMERGENCY_STOP_*` (set to `true` only in an emergency).

KarryGo Notification Service (KarryGo owners; not CA): SMTP host `smtp.resend.com`, port 465 (TLS) or 587
(STARTTLS), user `resend`, password = **a separate Resend API key restricted to sending on `karryam.com`**,
From `Karryam <no-reply@karryam.com>`. Do not reuse CA's key.

## 5. Provision the Karryam identities in CA (Mail admin; after section 3.1)

Run from the deployed API image or an approved tunnel to the staging Admin DB:

```bash
cd services/central-admin-api
export MAIL_DOMAIN_ALLOWLIST=karryam.com MAIL_RESERVED_SENDER_ADDRESSES=no-reply@karryam.com
npm run mail:provision:karryam                                    # dry run: prints the plan, writes nothing (exit 2 = work left)
npm run mail:provision:karryam -- --apply --actor=<adminUserId>   # actor = ACTIVE mail administrator; writes are audited as them
npm run mail:provision:karryam                                    # re-run: every step EXISTS, exit 0
# add --allow-remote only when the guard must accept a non-local, non-production staging host
```

Behaviour: reuses organization `karryam` if it exists (never duplicates or renames it; `--org-kind=COMPANY` only
matters when it is created), registers `karryam.com` as `PENDING_VERIFICATION` (refused unless allowlisted), creates
the four SHARED mailboxes + addresses with the display names in section 1, and reserves `no-reply@karryam.com` as a
`SYSTEM` address with no mailbox. Anything in an unexpected shape (e.g. the domain owned by another organization,
an existing address of another kind, a RETIRED address) is reported as `CONFLICT` and left untouched. It never
creates memberships, sender grants, personal mailboxes or provider domain ids.

Equivalent through the existing UI/API (IT -> Mail Administration): create organization -> create domain ->
"Create shared mailbox" four times -> `POST /api/mail/v1/admin/addresses {domainId, localPart:"no-reply", kind:"SYSTEM", displayName:"Karryam"}`.

Then an authorized Mail admin assigns people (MFA step-up `MAIL_MEMBERSHIP_GRANT`):
`POST /api/mail/v1/mailboxes/{id}/members {adminUserId, role: MEMBER|MANAGER|READER, canSend, reason}`.
Personal mailboxes: HR/IT request `PERSONAL_MAILBOX` with `requestedAddress: "david@karryam.com"`, approved by a
different Mail admin. HR onboarding's automatic request picks the domain only when exactly one COMPANY organization
with one VERIFIED domain exists; otherwise IT chooses the address at approval.

## 6. Resend and Hostinger (account / domain owners; not performed)

### 6.1 Free-plan domain slot

1. In Resend -> Domains, confirm nothing still sends from `no-reply.karryam.com` (KarryGo config, other services,
   last 7 days of Resend logs).
2. Delete `no-reply.karryam.com` from Resend. Remove its now-unused DNS records in Hostinger afterwards.

### 6.2 Root-domain sending verification

1. Resend -> Domains -> Add `karryam.com` (choose the region; it cannot be changed later).
2. In Hostinger DNS for `karryam.com`, add exactly the records Resend displays (today: an MX and an SPF TXT on the
   `send` subdomain, and a DKIM TXT at `resend._domainkey`). Copy names/values from Resend; do not retype.
3. Add DMARC if none exists: `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:<monitored address>` (tighten later).
   If an SPF record already exists on the root, do not create a second one; the Resend SPF lives on `send.`.
4. Resend -> Verify. In CA: IT -> Mail Administration -> `karryam.com` -> Verify (read-only; links the provider
   domain by name and stores the records and statuses). Sending gate requires `VERIFIED` + sending `VERIFIED`.

### 6.3 Root MX receiving activation (**cuts over all mail for karryam.com**)

Before changing the root MX:
- Inventory every mailbox that exists today at Hostinger (or elsewhere) for `@karryam.com`. After the switch, mail for
  **every** `@karryam.com` address goes to Resend and then to CA; addresses CA has not provisioned are rejected
  (no catch-all). Provision personal mailboxes for everyone who still needs one, or export and retire the old ones.
- Lower the MX TTL a day ahead.

Then: enable receiving on `karryam.com` in Resend and replace the root MX with the record Resend displays. Keep the
old MX values written down for rollback (section 10).

### 6.4 Webhook (one endpoint for the account)

- URL (staging): `https://stagingca.cosmicforge-healthnet.com/api/mail/v1/webhooks/resend`
- Events: `email.received`, `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`,
  `email.complained`, `email.failed`, `email.suppressed`. Do not subscribe `email.opened` / `email.clicked`
  (not recorded for private mail) or `contact.*` (marketing accounts use their own brand endpoints).
- KarryGo's events arrive at the same URL; CA acknowledges them without storing anything (section 2).
- Register it only after `MAIL_ENABLED=true` and the secret is installed: while Mail is off the endpoint answers 503
  and Resend retries/marks failures.
- Because the account has one endpoint, staging and production CA cannot both receive. Moving to production later
  means re-pointing this URL (and installing the same secret there).

### 6.5 Keys and secrets

| Secret | Where | Scope |
|---|---|---|
| CA API key | `RESEND_API_KEY` (staging secret manager) | Full access (CA reads received emails/attachments and domain status) |
| Webhook signing secret | `RESEND_WEBHOOK_SECRET` | From the endpoint created in 6.4 |
| KarryGo SMTP key | KarryGo secret store | Sending access, domain `karryam.com` only |

Rotation: put the old webhook secret in `RESEND_WEBHOOK_SECRET_PREVIOUS` during the overlap.

### 6.6 Sender identities

No per-address verification exists at Resend: once `karryam.com` is verified, any `@karryam.com` From is accepted
by the provider. CA enforces who may use which identity (membership + `canSend`, grants, reserved addresses).

## 7. Staged activation (one change per step; check before the next)

| Step | Change | Check |
|---|---|---|
| 0 | Sections 3, 4 (phases A/B), 5 done | `mail:config:validate` no violations; `health/ready` = DISABLED |
| 1 | `MAIL_ENABLED=true` | `health/ready`: schema/encryption/storage/infrastructure `OK`; no traffic possible (sending/receiving off) |
| 2 | Resend 6.1-6.2, CA Verify | domain `VERIFIED`, sending `VERIFIED` in IT -> Mail Administration |
| 3 | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, provider limits; register webhook (6.4) | readiness `provider OK`, `webhooks OK`; webhook test event from Resend answers 200 |
| 4 | Worker deployment with `MAIL_WORKER_ENABLED=true` (one replica) | worker liveness logs; `/admin/jobs` empty of errors |
| 5 | Rollout: cohort of pilot staff (`/admin/rollout/...`), assign memberships | pilot users see only their mailboxes |
| 6 | `MAIL_SENDING_ENABLED=true` | smoke tests 8.1 |
| 7 | 6.3 root MX, then `MAIL_RECEIVING_ENABLED=true`, `MAIL_RECONCILIATION_ENABLED=true` | smoke tests 8.2 |
| 8 | Wider staff | ops alerts quiet for 48 h |

Marketing (`MAIL_MARKETING_ENABLED`, broadcast dispatch) stays off; it has its own approvals.

## 8. Smoke tests (owner-approved external test addresses only)

### 8.1 Sending
1. Pilot member of `support@` sends to an approved Gmail and Outlook address. Expect: status `Provider accepted`
   (this is **not** delivery), then `Delivered to receiving server` after `email.delivered`.
2. In the received message check From `Karryam Support <support@karryam.com>`, SPF/DKIM/DMARC pass, and the
   `Message-ID` header equals CA's (threading depends on it).
3. Repeat from `info@`, `marketing@`, `partnership@` and one personal mailbox.
4. Negative: a READER and a non-member cannot send; nobody can pick `no-reply@`.
5. KarryGo sends one OTP to an approved address: delivered by KarryGo; CA `/admin/webhook-events` shows **no** new
   row for it.

### 8.2 Receiving
1. From the external accounts write to each of the four addresses: each lands only in its own inbox, members are
   notified.
2. Reply to 8.1's message: it joins the same thread.
3. Send to `unknown@karryam.com`: rejected and audited, nothing stored.
4. Reply to the KarryGo OTP email (`no-reply@`): discarded, `MAIL_INBOUND_RESERVED_ADDRESS_DISCARDED` audited.
5. Attachment: a clean PDF is available; the EICAR test file is quarantined (IT -> Quarantine).

## 9. Admin frontend compatibility

No frontend change is needed. IT -> Mail Administration already lists domains with sending/receiving/SPF/DKIM/DMARC
checks, creates shared mailboxes with display names, manages members (with MFA step-up), sender grants, quarantine,
webhook events, jobs, provider quota and rollout. The user Mail pages list only the caller's mailboxes and sender
identities. The `no-reply@` reservation is created by the provisioning script or `POST /admin/addresses` (the UI has
no SYSTEM-address form; one is not needed for a one-time reservation). A grant attempt on it shows the API error
`SYSTEM_IDENTITY_NOT_GRANTABLE`.

## 10. Rollback and emergency stop

| Situation | Action |
|---|---|
| Stop all CA provider calls now | `MAIL_EMERGENCY_STOP_ALL=true` (or `POST /admin/emergency-stops`); queued mail is kept, not lost |
| Stop sending only | `MAIL_SENDING_ENABLED=false` (jobs defer without consuming attempts) |
| Stop receiving processing | `MAIL_RECEIVING_ENABLED=false` (webhook answers 503, Resend retries; jobs defer) |
| Inbound must go back to the old host | restore the old root MX in Hostinger (keep the noted values); disable receiving in Resend |
| Wrong mailbox setup | suspend the mailbox/address in IT -> Mail Administration (addresses are never deleted or reused) |
| Disable Mail entirely | `MAIL_ENABLED=false`; the API answers 503 for Mail routes, the worker exits; data stays |
| Database | rollback SQL in `docs/sql/` per the migration runbook, only with the DB owner |

KarryGo is unaffected by every CA action above: it sends through Resend SMTP directly.

## 11. Quotas, acceptance vs delivery, no-reply policy

- **Quota is shared.** On Resend Free (check the current limits in the Resend dashboard; 100/day and 3,000/month at
  the time of writing) KarryGo OTPs and CA mail consume the same account limit. Protect OTP delivery by capping CA:
  `PUT /api/mail/v1/admin/quotas {organizationId:<karryam>, purpose:"STAFF_MAIL", dailyHardLimit:<n>}` and the same
  for `SUPPORT`; set `MAIL_PROVIDER_DAILY_LIMIT` / `MAIL_PROVIDER_MONTHLY_LIMIT`. CA defers (never fails) mail on
  provider quota exhaustion; CA's usage panels count CA mail only, so check the Resend dashboard daily for the
  account total, and monthly before renewal.
- **Acceptance is not delivery.** `Provider accepted` = Resend took the message. `Delivered to receiving server` =
  `email.delivered`. Neither means read. Ambiguous provider outcomes show `Unknown`, never `Failed`.
- **No-reply.** `no-reply@karryam.com` has no inbox. Inbound mail to it is discarded and audited (no auto-reply, no
  backscatter, no quarantine hold). KarryGo templates should point customers to `support@karryam.com`.

## 12. Outstanding blockers and owners (priority order)

| # | Blocker | Owner |
|---|---|---|
| 1 | Back up and apply migrations 27-37 to the staging Admin DB; confirm ledger | Admin DB owner |
| 2 | Staging S3 bucket + KMS key + clamd + Mail worker deployment; env phase B | Infrastructure / DevOps |
| 3 | Run the provisioning procedure (section 5) and assign staff | Mail admin (IT) |
| 4 | Inventory existing `@karryam.com` mailboxes before the root MX switch | Domain owner + IT |
| 5 | Resend: remove `no-reply.karryam.com`, add/verify `karryam.com`, receiving, webhook, CA key + KarryGo key | Resend account owner |
| 6 | Hostinger DNS records for `karryam.com` | Domain owner |
| 7 | KarryGo notification-service SMTP config (`no-reply@karryam.com`, own key) and templates pointing to support | KarryGo engineering |
| 8 | Approved external test recipients; live smoke tests (section 8) | Product / IT |
| 9 | Session hardening (`AUTH_SESSION_MODE=cookie`) | Security |
| 10 | Confirm which code `api.cosmicforge-healthnet.com` serves before using it for any Mail webhook | Infrastructure |

## 13. Verification performed for this change (offline)

See the PR description for the exact commands and results (`npm run test:mail`, the two new suites,
`db:manifest:verify`, `mail:config:validate` with the staging profile, `mail:client:check`, provisioning dry run /
apply / re-run against a local disposable `cosmicforge_admin`).
