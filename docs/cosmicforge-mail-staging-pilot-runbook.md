# CosmicForge Mail - Controlled Staging Pilot Runbook

Status: **prepared, not executed.** Every step below needs a named operator and, where marked
**[APPROVAL]**, a recorded approval (ticket link, approver, timestamp) before it is performed.
Nothing in CI or the application performs any of these steps automatically.

Scope: staging only, test identities only, one approved **test** domain only. Out of scope:
production MX cutover, replacing existing transactional mail (SMTP/nodemailer, Gmail, cPanel),
`marketing@karryam.com`, HealthNet clinical email, and M7 marketing dispatch.

Related documents:

- `docs/cosmicforge-mail-staging-migration-runbook.md` (migration apply/verify/rollback)
- `docs/cosmicforge-mail-storage-kms.md` (private storage, KMS, rotation, backup/DR)
- `docs/cosmicforge-mail-malware-scanning.md` (clamd deployment and monitoring)
- `docs/hq-auth-sessions-and-mfa.md` (httpOnly sessions, CSRF, MFA enrollment)

Record every step in the pilot log: `step id | operator | approver | started | finished | result | evidence link`.

## 0. Go / no-go prerequisites

All must be true before section 1 starts. Any "no" stops the pilot.

| # | Prerequisite | Evidence |
| --- | --- | --- |
| P1 | PR #13 (Mail M1-M6) reviewed and merged to `staging` **[APPROVAL]** | merge commit SHA |
| P2 | Storage/KMS + scanner PR reviewed and merged to `staging` **[APPROVAL]** | merge commit SHA |
| P3 | HQ sessions + MFA PR reviewed and merged; staging running `AUTH_SESSION_MODE=dual` or `cookie` without login regressions for at least 48 h | session-mode value, error-rate graph |
| P4 | Every pilot user (senders, approvers, break-glass approvers, mail admins) has **verified** MFA enrollment and saved recovery codes | enrollment audit rows |
| P5 | Admin DB owner approval for the migration change window **[APPROVAL]** | ticket |
| P6 | Security approval of the storage bucket, KMS key policy and scanner deployment **[APPROVAL]** | ticket |
| P7 | Resend account owner has issued **test-only** credentials restricted to the test domain **[APPROVAL]** | key id (never the key) |
| P8 | Domain owner has approved the test domain and its DNS records **[APPROVAL]** | ticket |
| P9 | On-call owner named for the pilot window, with rollback authority | name |

## 1. Confirm what is deployed

```bash
# On the staging host (read-only checks)
docker inspect -f '{{.Config.Image}}' admin-server-staging-app-1        # image tag
docker exec admin-server-staging-app-1 node -p 'require("./package.json").version'
docker exec admin-server-staging-app-1 sh -c 'ls src/modules/mail >/dev/null && echo MAIL_MODULE_PRESENT'
```

- [ ] The image tag matches the merge commit from P1/P2 (`ghcr.io/...:<sha>`).
- [ ] `GET /health` returns 200.
- [ ] `GET /api/mail/v1/me/entitlements` (as a normal user) returns `503 MAIL_DISABLED` - proves the
      module is deployed **and** the master flag is still off.

## 2. Verify the actual flag values (do not trust `.env` files)

```bash
docker exec admin-server-staging-app-1 node -e '
for (const k of ["MAIL_ENABLED","MAIL_SENDING_ENABLED","MAIL_RECEIVING_ENABLED","MAIL_MARKETING_ENABLED",
  "MAIL_WORKER_ENABLED","MAIL_DOMAIN_ALLOWLIST","MAIL_DEPLOYMENT_ENV","MAIL_STORAGE_PROVIDER","MAIL_KMS_PROVIDER",
  "MAIL_S3_BUCKET","MAIL_S3_SSE","MAIL_SCANNER_PROVIDER",
  "AUTH_SESSION_MODE"]) console.log(k, "=", JSON.stringify(process.env[k] ?? null));'
```

- [ ] All five `MAIL_*_ENABLED` flags are `"false"` or unset.
- [ ] No API replica has `MAIL_WORKER_ENABLED=true`.
- [ ] `RESEND_API_KEY` is **unset** on the API container at this point (check with `test -z`, never print it).

## 3. Live migration preflight (read-only) **[APPROVAL: P5]**

Run against the staging **Admin** database only (`npm run db:admin:guard` must confirm the target).

```sql
-- Ledger: must return 0 rows. If it returns a row, STOP: the migration was applied before;
-- the in-place amendment policy no longer holds and a follow-up migration is required.
SELECT file, sha256, applied_at FROM social_manual_migrations
 WHERE file = '20261024_add_cosmicforge_mail_m1_m6.sql';

-- Name collisions: must return 0 rows.
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public'
   AND (table_name LIKE 'mail\_%' OR table_name LIKE 'marketing\_email\_%')
   AND table_name <> 'marketing_email_templates';
SELECT typname FROM pg_type WHERE typname LIKE 'Mail%' OR typname LIKE 'MarketingEmail%';
SELECT indexname FROM pg_indexes WHERE indexname LIKE 'UQ_mail_%' OR indexname LIKE 'IDX_mail_%';

-- Manifest checksum on the deployed commit must match the file you will apply.
```

```bash
npm run db:manifest:verify          # on the deployed commit
sha256sum prisma/manual-migrations/20261024_add_cosmicforge_mail_m1_m6.sql
```

- [ ] Ledger row absent; zero collisions; checksum equals `manifest.json`.
- [ ] If the sessions/MFA migration (`20261025_add_admin_sessions_mfa.sql`) is part of the
      deployed commit, run the same ledger/collision checks for it.

## 4. Backup and rollback plan (verified before any change)

```bash
pg_dump --format=custom --no-owner --file "admin-staging-pre-mail-$(date +%Y%m%d%H%M).dump" "$ADMIN_DB_URL"
pg_restore --list admin-staging-pre-mail-*.dump | head
# Restore drill into a scratch database (never into staging):
createdb mail_restore_drill && pg_restore --no-owner -d mail_restore_drill admin-staging-pre-mail-*.dump
psql -d mail_restore_drill -c 'SELECT count(*) FROM admin_users;'   # matches staging
dropdb mail_restore_drill
```

- [ ] Dump stored in the approved backup location; restore drill succeeded.
- [ ] Rollback path agreed (in order of preference):
  1. **Flags off** - set `MAIL_ENABLED=false`, recreate the container; all Mail routes return 503,
     worker exits. Data is kept.
  2. **Schema rollback** (only if no Mail data must be kept) - `docs/sql/cosmicforge-mail-m1-m6-rollback.sql`.
  3. **Full restore** from the dump (last resort; loses Admin writes after the dump).
- [ ] Previous image tag recorded for an application rollback.

## 5. Apply the Mail migration manually and verify drift **[APPROVAL: P5]**

Follow `docs/cosmicforge-mail-staging-migration-runbook.md` sections 4-5 exactly (single
transaction, ledger insert with the manifest checksum). Then:

```bash
DATABASE_URL="$ADMIN_DB_URL" npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
```

- [ ] Exit code 0 (no drift); 36 Mail tables, 5 triggers, 4 named indexes present.
- [ ] Existing login, HR, Support, Marketing and Social Operations smoke checks pass with flags still off.

## 6. Private storage and KMS readiness **[APPROVAL: P6]**

Per `docs/cosmicforge-mail-storage-kms.md`:

- [ ] Staging bucket exists, **Block Public Access** on, TLS-only and deny-unencrypted-put policy
      attached, versioning on, lifecycle aligned with retention/legal-hold policy.
- [ ] Bucket and KMS key are **staging-marked** and distinct from any production resource; the
      staging IAM principal cannot read production resources (attempt and record the AccessDenied).
- [ ] KMS key policy limits Decrypt/GenerateDataKey to the staging Mail principal; key rotation enabled.
- [ ] `MAIL_DEPLOYMENT_ENV=staging`; `npm run mail:config:validate` inside the container reports no violations.
- [ ] Wrapped data key generated with `npm run mail:kms:generate-data-key` (staging key, staging environment context); `MAIL_ENCRYPTION_KEYS` /
      `MAIL_ENCRYPTION_ACTIVE_KEY` set from the secret store (never pasted into tickets or logs).
- [ ] With `MAIL_ENABLED=true` but sending/receiving still **off** (step 9.1), `GET /api/mail/v1/admin/status`
      as a mail admin reports `storage.ok=true` and `encryption.available=true`.

## 7. Malware scanner readiness **[APPROVAL: P6]**

Per `docs/cosmicforge-mail-malware-scanning.md`:

- [ ] clamd container running on the private network only (no published port), freshclam
      signatures current (< 24 h), memory limit set, health check green.
- [ ] From the API container: clamd `PING` -> `PONG`; EICAR test string -> `FOUND`; a clean file -> `OK`.
- [ ] Mail health reports `scanner.available=true`.
- [ ] Alert routes for "scanner unavailable" and "quarantine spike" deliver to the on-call channel.

## 8. Test-domain DNS and Resend configuration (performed by the domain / Resend owners) **[APPROVAL: P7, P8]**

The application never changes DNS. The domain owner configures, for the **test** domain only
(for example `mailpilot-staging.<approved-domain>`):

| Record | Purpose | Check |
| --- | --- | --- |
| SPF `TXT` including the Resend sending host | sender authorization | `dig +short TXT <domain>` |
| DKIM `CNAME`/`TXT` records issued by Resend | message signing | Resend dashboard shows verified |
| DMARC `TXT _dmarc.<domain>` starting at `p=none; rua=mailto:<monitored mailbox>` | reporting | `dig +short TXT _dmarc.<domain>` |
| MX for the receiving subdomain pointing at Resend inbound | receiving | `dig +short MX <domain>` |
| Return-path / bounce `CNAME` if Resend requires it | bounces | Resend dashboard |

- [ ] **No production apex MX record is changed.** The test domain/subdomain is separate.
- [ ] Resend: domain verified (sending + receiving), API key scoped to sending for this domain only,
      webhook endpoint `https://<staging-api>/api/mail/v1/webhooks/resend` created with events
      `email.sent, email.delivered, email.delivery_delayed, email.bounced, email.complained,
      email.failed, email.received`; signing secret stored in the secret store.
- [ ] Inbound route for the test domain points to the same webhook.

## 9. Staged enablement (one change per step, each separately approved)

Use test identities only (`pilot.sender1@<test-domain>`, `pilot.support@<test-domain>`, ...).
After each step: watch logs and health for 30 minutes before the next.

### 9.1 `MAIL_ENABLED=true` (sending/receiving/marketing/worker still false) **[APPROVAL]**

- [ ] Set storage, KMS, scanner and `MAIL_DOMAIN_ALLOWLIST=<test-domain>` in the same change.
- [ ] Mail admin creates the organization, registers the test domain with its Resend domain id and
      runs **verify** (read-only provider call). Status becomes `VERIFIED`.
- [ ] Provision pilot mailboxes (personal + one SUPPORT shared mailbox) and addresses; grant pilot
      senders. SUPER users are **not** given memberships unless they are named pilot users.
- [ ] Internal-only send between two pilot users succeeds (no provider call; check worker absent).

### 9.2 One worker instance **[APPROVAL]**

- [ ] Start exactly one worker container from the same image: `npm run mail:worker` with
      `MAIL_WORKER_ENABLED=true` and `MAIL_WORKER_CONCURRENCY=1`. API replicas keep it `false`.
- [ ] Worker logs show it started and is polling; `queue` in health shows no stuck leases.

### 9.3 `MAIL_SENDING_ENABLED=true` + `RESEND_API_KEY` (test key) **[APPROVAL]**

Isolated outbound tests (recipients are pilot-owned external test inboxes only):

- [ ] External To from an allowlisted, verified sender -> status `QUEUED` then `SENT`/`DELIVERED`
      from webhook events only. Message arrives once.
- [ ] Mixed internal + external recipients -> internal copy delivered locally, provider receives
      **only** the external recipients (check Resend log), external recipient receives exactly one copy.
- [ ] Sender not allowlisted / unverified domain / revoked grant -> 403 with the documented reason, no provider call.
- [ ] Revoke a sender grant while a message is queued -> message `FAILED` with
      `MAIL_SEND_BLOCKED_AT_DISPATCH` audit, no provider call.
- [ ] Attachment send: clean file delivered; EICAR attachment is quarantined before send and the send is refused.

### 9.4 `MAIL_RECEIVING_ENABLED=true` + `RESEND_WEBHOOK_SECRET` **[APPROVAL]**

Webhook verification:

- [ ] A correctly signed event is accepted (`200`) and stored once.
- [ ] Re-delivering the **same** event id is acknowledged and deduplicated (no second job).
- [ ] A tampered body, wrong secret, missing signature or a timestamp outside tolerance -> `401`, nothing stored.
- [ ] An oversized body -> `413`, nothing stored.
- [ ] Delivery events (`email.delivered`, `email.bounced`) update only the matching recipient;
      unrelated provider ids change nothing.

Isolated inbound tests:

- [ ] Mail from a pilot-owned external inbox to `pilot.support@<test-domain>` lands in the SUPPORT queue,
      sanitized, remote images blocked, threaded by Message-ID on reply.
- [ ] Mail to an unknown address on the test domain is handled per `MAIL_UNKNOWN_RECIPIENT_POLICY`.
- [ ] Inbound EICAR attachment is quarantined and cannot be downloaded.

### 9.5 Marketing Studio (authoring only) - optional **[APPROVAL]**

- [ ] `MAIL_MARKETING_ENABLED=true` for authoring and approvals with MFA step-up. Confirm no dispatch
      endpoint exists (M7). Do not import real contact lists.

## 10. Monitoring, logs and alerting during the pilot

| Signal | Source | Alert threshold |
| --- | --- | --- |
| Mail health (`storage`, `provider`, `scanner`, `encryption`, `queue`) | `GET /api/mail/v1/admin/status` polled every minute | any component not ok for 5 min |
| Dead-lettered / `OUTCOME_UNKNOWN` jobs | `mail_outbox_jobs`, worker logs | any |
| Webhook signature failures | API logs (`MAIL_WEBHOOK_SIGNATURE_INVALID`) | > 5 in 10 min |
| Quarantined attachments | scanner logs / `mail_attachments.scan_status` | any during pilot (review each) |
| Send blocked at dispatch | `mail_audit_events` | any (review each) |
| 401/403 rate on `/api/auth/*` and `/api/mail/*` | API logs | 2x baseline |
| Worker heartbeat | worker logs | no poll log for 2 min |

- [ ] Logs never contain message bodies, attachment content, API keys or tokens (spot-check).

## 11. Pilot users

- [ ] Named list (max 10) approved by the business owner, each with verified MFA (P4).
- [ ] Each user briefed: test domain only, no patient/customer data, how to report issues.
- [ ] Offboarding test: offboard one pilot user - access removed on the next request, history retained.

## 12. Pilot exit and rollback

Rollback triggers: duplicate external delivery, any plaintext content leak, unexplained
`OUTCOME_UNKNOWN`, webhook verification bypass, scanner fail-open, cross-mailbox access, or any
security incident.

1. Set `MAIL_SENDING_ENABLED=false` and `MAIL_RECEIVING_ENABLED=false` (stops provider traffic immediately).
2. Stop the worker container.
3. Set `MAIL_ENABLED=false` (all Mail routes 503). Keep data for investigation.
4. Rotate `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` if credential exposure is suspected; disable the Resend webhook.
5. Only with Admin DB owner approval and no data to keep: run the schema rollback (section 4).
6. Write the incident/pilot report: what ran, evidence, issues, decision.

Pilot success criteria (all required before discussing a wider rollout): zero duplicate deliveries,
zero content leaks, all webhook negative tests rejected, EICAR quarantined in both directions,
health green for 14 consecutive days, and every audit sample reviewed.
