# CosmicForge Mail M9: operational hardening

Status: code complete behind flags. Destructive retention execution is **off**
by default (`MAIL_RETENTION_EXECUTION_ENABLED=false`). No live database,
storage or provider was touched while building it.

Contents: retention and legal holds, backup/restore validation, monitoring
and alerts, usage, quotas and cost, abuse controls and the emergency stop,
security review, accessibility, runbooks.

## 1. Retention and legal holds

Policies (`mail_retention_policies`, M1) say *what* to do (ARCHIVE or DELETE
after N days; N from 30 to 36500, chosen by an authorised operator). M9 adds
the executor: `mail_retention_runs` plus the `RETENTION_RUN` worker job.

| Step | Who | Effect |
|---|---|---|
| Dry run (`POST /admin/retention/runs`) | Mail admin (EDIT) | Counts only: candidates, held, skipped (open case / in-flight send). No data changed. No content or addresses recorded. |
| Review | Mail admin, records owner | Compare counts with expectations. |
| Execute (`POST /admin/retention/runs/{dryRunId}/execute`) | Mail admin (EDIT) + step-up `MAIL_RETENTION_EXECUTE` | Refused unless the env flag is on, the dry run is COMPLETED and younger than `MAIL_RETENTION_DRY_RUN_VALID_HOURS` (24h), and the policy/period is unchanged. Reuses the dry run's cutoff. One execution per dry run (DB unique). |

What DELETE removes per thread:
- recipients, attachments, delivery events, finished outbox jobs, drafts,
  internal notes, per-user state and labels;
- subject, snippet, sender, reply-to, envelope recipient, search text, auth
  results and object keys on the thread and messages;
- the encrypted body/raw MIME/attachment objects in storage.

It keeps a content-free tombstone (ids, direction, status, timestamps, sizes,
hashes) for audit integrity. ARCHIVE only moves the thread to the ARCHIVE
folder.

Protected (never touched; counted as `held` / `skippedActive`):
- an org-wide legal hold in the thread's brand;
- a hold on the mailbox;
- a subject hold naming the personal mailbox owner, or any sender in the
  thread;
- open or pending support conversations;
- threads with in-flight outbound jobs.

Holds are re-read for every batch, so a hold placed mid-run takes effect
immediately.

System categories need an explicit period (`MAIL_RETENTION_*_DAYS`). No
defaults are provided:

| Category | Action | Hold rule |
|---|---|---|
| `WEBHOOK_PAYLOADS` | Replace stored provider payload with a redaction marker | Any active hold anywhere blocks it (rows are not brand-scoped). |
| `INTEGRATION_EVENTS` | Delete append-only M8 rows inside `SET LOCAL cosmicforge.mail_retention_purge='on'` | Skips brands with any active hold. |
| `PRODUCT_DELIVERY_EVENTS` | Same | Same |

Resumability:
- The run stores a cursor and processes `MAIL_RETENTION_BATCH_SIZE` threads per
  job, then defers itself.
- For EXECUTE runs, the cursor moves in the same transaction as each thread's
  purge, so a crash never repeats or skips a thread.
- Object deletion runs after commit. A failed object delete is counted
  (`storageRemoveFailed`) and leaves an orphaned encrypted blob, never a
  dangling reference.
- Turning the flag off mid-run defers the run (it resumes when re-enabled);
  cancelling stops it after the current batch.

**Legal durations are not defined by this code.** The records owner and legal
counsel must approve every policy period before execution is enabled in any
environment.

## 2. Backup and restore validation

`npm run mail:backup:verify -- --source-url=<disposable db>`
(`scripts/mail/verify-backup-restore.js`):

- It dumps every `mail_*` / `marketing_*` table, restores into a fresh
  database, and compares per-table row counts and full-row checksums.
- It also checks that the append-only triggers and CHECK constraints survived.
- With `--storage-dir`, it checks that every referenced object exists in a
  filesystem backend. For S3, use provider inventory tooling.
- It refuses any database that is not local and named like a disposable copy,
  unless `--confirm-disposable=<exact name>` is given. It never writes to the
  source.

Evidence (local replay DB, PostgreSQL 16): `ok: true`, 109 tables, 0
mismatches, 5 triggers / 29 checks preserved. Production backup cadence,
PITR and storage replication are infrastructure decisions **not made here**.

## 3. Monitoring and alerts

- `GET /api/mail/v1/admin/ops/snapshot` (mail admins): queues, oldest due job
  per queue, dead letters, webhook backlog, scan backlog, staff and broadcast
  outcomes (24h), integration rejections, retention runs, today's usage vs
  limits, open alerts, emergency-stop state.
- `GET /api/mail/v1/ops/metrics`: Prometheus text for the platform scraper.
  - Authenticated with `Authorization: Bearer $MAIL_METRICS_TOKEN` (32+ chars,
    constant-time compare); 404 when no token is configured.
  - Contains counts and ages only; a test asserts no `@`, subjects or bodies
    appear.
- Alert evaluation runs as an `OPS_EVALUATE` job every
  `MAIL_OPS_EVALUATE_SECONDS` (default 300), once per bucket across workers.
  - Open alerts are de-duplicated by fingerprint (DB partial unique index).
    Repeats bump `occurrences`, an escalation to critical re-notifies, and
    cleared conditions auto-resolve.
  - Notifications are in-app only, to mail admins.

Alert definitions (thresholds are **initial values**, configurable via
`MAIL_ALERT_*`, to be tuned from pilot data; no historical stability data
exists yet):

| Code | Default trigger | Severity | First response |
|---|---|---|---|
| `MAIL_QUEUE_STALLED` | Oldest due job in a queue > 900s (critical > 3600s) | warning/critical | Check worker processes for that queue; check DB connectivity. |
| `MAIL_DEAD_LETTERS` | ≥ 1 dead letter in 24h | warning | Inspect `last_error_code`; never blindly re-queue sends (risk of duplicates). |
| `MAIL_WEBHOOK_BACKLOG` | Unprocessed webhook older than 600s | warning | Check EVENTS worker; provider status. |
| `MAIL_SCAN_BACKLOG` | Attachment waiting > 1800s | warning | Check clamd health. |
| `MAIL_OUTCOME_UNKNOWN` | ≥ 1 recipient with unknown outcome (24h) | warning | Reconcile via provider dashboard before any resend. |
| `MAIL_BOUNCE_RATE_HIGH` | ≥ 5% bounced over ≥ 100 recipients (staff, or per brand marketing) | critical | Pause the brand / review lists. |
| `MAIL_COMPLAINT_RATE_HIGH` | ≥ 1 per 1000 marketing recipients (≥ 100 sample) | critical | Pause brand marketing immediately. |
| `MAIL_QUOTA_SOFT_LIMIT_REACHED` / `_HARD_` | Today's accepted ≥ limit | warning / critical | Confirm legitimacy; raise the limit only with the brand owner. |
| `MAIL_EMERGENCY_STOP_ACTIVE` | A stop is holding sends | warning | Confirm it is intended; follow §5 to release. |
| `MAIL_RETENTION_RUN_FAILED` | Failed run in 7 days | warning | Read `error_code`; re-run the dry run. |
| `MAIL_INTEGRATION_REJECTIONS` | ≥ 20 rejected product events per hour | warning | Contact the product owner; check contract version. |
| `MAIL_STORAGE_UNHEALTHY` / `MAIL_ENCRYPTION_UNAVAILABLE` / `MAIL_INFRASTRUCTURE_VIOLATION` | Health probe | critical | Mail fails closed; restore storage/KMS/config. |

## 4. Usage, quotas and cost

- `mail_usage_daily` counts per brand, purpose and UTC day: accepted,
  rejected, received, provider requests and bytes. Purposes are
  `STAFF_MAIL`, `SUPPORT`, `MARKETING_BROADCAST`, `MARKETING_AUTOMATION`,
  `MARKETING_CONFIRMATION` and `INBOUND`.
- Every send path records into it (staff outbound, inbound, broadcasts,
  automation, confirmations).
- `mail_quota_limits` holds an optional daily soft, daily hard and monthly
  hard limit per brand and purpose (`PUT /admin/quotas`, audited). How the
  hard limits are enforced:

| Path | When the limit would be exceeded |
|---|---|
| Staff compose | 429 `MAIL_QUOTA_HARD_LIMIT` before queueing (external recipients only) |
| Broadcast | Fails before the provider send, with the final recipient count |
| Automation / confirmations | Defer |

- Existing per-user and per-mailbox limits (M2) still apply.
- **No prices are stored or assumed.** The usage report shows counts only. A
  cost estimate appears only if an operator sets `MAIL_COST_RATES` from their
  own contract.

## 5. Abuse controls and emergency stop

- Existing limits: per-user sends per minute, per-mailbox daily quota,
  recipient cap, attachment scanning, sender-identity re-check at dispatch,
  and per-integration ingestion rate limits.
- New in M9: brand/purpose hard limits; bounce and complaint alerts.
- The emergency stop is a runtime-controls module consulted by **every** send
  path:
  - `MAIL_EMERGENCY_STOP_ALL=true` now also halts staff and support mail.
    Before M9 it only halted marketing (gap fixed).
  - `MAIL_EMERGENCY_STOP_MARKETING=true` halts marketing only.
  - Queued staff mail is **deferred, not failed**, and goes out after release;
    new external sends get 503 `MAIL_EMERGENCY_STOP`.
  - Receiving and delivery-event processing continue.
  - M10 adds a database-backed stop that needs no redeploy.

## 6. Security review (M1–M9)

| Area | Control | Evidence |
|---|---|---|
| Private mail access | Membership-based; SUPER has no implicit access; break-glass needs request + approval + step-up | `mail-postgres.test.js` isolation subtests, `mailbox-isolation.spec.ts` |
| Step-up | Shared HQ MFA, session-bound, purpose-bound, single-use, 5-min TTL | Stage A3 subtests; M9 wrong-purpose step-up rejected |
| Content at rest | AES-256-GCM per object, KMS-wrapped keys in staging/prod, fail closed | `mail-infra.test.js` |
| Search | Metadata only; body search disabled | `publicStatus.search`, M1 tests |
| Logs/records | No bodies, subjects or addresses in retention runs, audit metadata, metrics | M9 assertions (`doesNotMatch`) |
| Service auth | HMAC, skew-limited, constant-time; unknown service == bad signature | `mail-m8-unit.test.js` |
| Webhooks | Svix signature verified, raw body, idempotent | M5/M7 tests |
| Destructive ops | Retention execute: flag + fresh dry run + step-up + one-shot; append-only tables guarded by trigger | M9 subtests |
| Metrics | Token required, 404 when unset, counts only | M9 subtests |
| Dependencies | `npm audit` policy script | `scripts/security/check-npm-audit-policy.js` (Stage F evidence) |

Residual risks (accepted for pilot, documented):
- The per-process ingestion rate limiter is not shared across replicas.
- An orphaned encrypted object remains if a storage delete fails; it is
  counted, and its key is unrecoverable without DB references.
- Automated axe checks are not a full accessibility audit.

## 7. Accessibility

- `e2e/accessibility.spec.ts` runs axe-core (WCAG 2.1 A/AA) on the inbox, Mail
  settings, Operations and Product integrations pages. Serious or critical
  violations fail the build.
- First run finding: the light-theme `--muted-foreground` token (`#8f90a4`,
  3.2:1 on white) failed contrast app-wide. It is now `#6b6c80` (5.1:1). This
  is a small visible change to secondary text across the admin and needs
  design sign-off.
- Manual keyboard and screen-reader review is still required before pilot.

## 8. Runbooks

**Retention (first use in an environment)**
1. Records owner approves the policy period in writing.
2. Create the policy.
3. Run a dry run and review the counts.
4. Take a verified backup (§2).
5. Set `MAIL_RETENTION_EXECUTION_ENABLED=true` for the window.
6. Execute with a step-up.
7. Watch the run reach COMPLETED.
8. Set the flag back to `false`.
9. Keep the run record as evidence.

**Legal hold**
1. Create the hold before any retention window: org-wide, mailbox, or
   subject.
2. Confirm the next dry run shows `held`.
3. Release only on written instruction.

**Restore drill (disposable)**
1. Restore the latest backup into a disposable database.
2. Run `mail:backup:verify` against it with `--confirm-disposable`.
3. Record the JSON report.

**Emergency stop**
1. Set `MAIL_EMERGENCY_STOP_ALL=true` (or `_MARKETING`) and restart the API
   and workers. M10 offers the no-redeploy stop.
2. Confirm the `MAIL_EMERGENCY_STOP_ACTIVE` alert and `cf_mail_halted 1`.
3. Investigate.
4. Release: unset the flag. Queued mail resumes within about 5 minutes.
   Review `OUTCOME_UNKNOWN` before any manual resend.

**Bounce or complaint spike**
1. Pause the brand's marketing dispatch (M7 brand pause; resuming needs a
   step-up).
2. Review recent lists and imports.
3. Check provider suppression.
4. Resume only with owner sign-off.

**Quota hard limit reached**
1. Confirm the traffic is legitimate (not a compromised account).
2. Raise the limit only with the brand owner.
3. If the traffic is not legitimate, suspend the sender or mailbox (M2
   offboarding).

**Stalled queue / dead letters**
1. Check that worker processes are running for the queue
   (`MAIL_WORKER_QUEUES`).
2. Check lease expiry recovery.
3. For dead `SEND_MESSAGE` jobs, the recipient state shows FAILED or
   `OUTCOME_UNKNOWN`. Never re-send unknowns without provider confirmation.

## Configuration

See `services/central-admin-api/.env.example` (M9 block). Migration
`20261029_mail_m9_operations.sql` (number 32). Rollback:
`docs/sql/cosmicforge-mail-m7-m10-rollback.sql` (M9 section).
