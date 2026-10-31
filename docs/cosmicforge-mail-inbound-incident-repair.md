# CosmicForge Mail — inbound incident: root causes and permanent repair

**Incident:** incoming emails (two Gmail replies to `favour@karryam.com`) did not appear in the inbox.
**Status:** see "Production evidence" at the end. Code complete is **not** production fixed: the final gate is a delivered message visible in the real mailbox.

## Evidence before the repair (GitHub Actions, no VPS access)

| When (UTC) | Source | Finding |
|---|---|---|
| 2026-10-30 05:22 | Production deploy run 41007315111 | Production moved to `admin-backend:production-5d1a988`; Mail flags `none`; "no production Mail worker deployed". |
| 2026-10-30 05:34 | Mail ops `services-deploy` (production), run 41009187748 | Worker deployed while Mail was off, so it exited 0 "by design" and got `restart: on-failure:5`. |
| 2026-10-30 06:00 | Mail settings `apply` (production), run 41011497322 | `MAIL_ENABLED`, `MAIL_SENDING_ENABLED`, `MAIL_RECEIVING_ENABLED`, `MAIL_WORKER_ENABLED` set to true. Worker recreated, reported "(running)". |
| 2026-10-30 06:03 | Mail ops `services-deploy` (production), run 41011820522 | Worker Compose rewritten to `unless-stopped`; worker "running". The run failed only because the staging app was redeployed concurrently (unrelated-container guard). |
| 2026-10-31 09:31 | Mail ops `staging-checks` (production), run 41012202018 attempt 4 | Readiness: `INBOUND pending 2`, `EVENTS pending 331`, dead letters 0; schema, encryption, storage, scanner, provider and webhooks OK; session `BLOCKING` (`JS_READABLE_ACCESS_TOKEN`). |
| 2026-10-31 09:20 / 09:26 / 09:31 | Production preflight, run 41007104540 attempts 2–4 | 09:20 passed (lock free). 09:26 and 09:31 refused: "database isolation cutover is running". |

## Root causes

1. **The production worker ran but served no queue.** Image `5d1a988` claims a queue only when a `WORKER_<QUEUE>` rollout ALLOW rule exists (`workerQueuesAllowed`), and rollout enforcement defaults on in production. No rule existed, so the running worker claimed nothing. Webhooks were still verified and stored durably, so jobs accumulated: 2 INBOUND (`PROCESS_INBOUND` from `email.received`) and 331 EVENTS (delivery and contact events from the shared Resend account that passed the ownership filters). PR #57 (merged into `main` at `5111ea6a`) removed that dependency but was never deployed.
2. **Deployment verification could not tell a worker that processes from one that doesn't.** `ca-production-deploy.sh` and `ca-mail-env-install.sh` accepted `running` *or* `exited 0`. Nothing checked that the worker polled the API's database, served the core queues, or completed any job. A disabled worker exited 0, which also looked like success.
3. **Alerting depended on the stalled worker.** Ops alerts are evaluated by an `OPS_EVALUATE` job on the EVENTS queue, which was not being served. `MAIL_QUEUE_STALLED` could never fire.
4. **No safety net for missed webhooks.** `MAIL_RECONCILIATION_ENABLED` defaulted to false, so inbound reconciliation never ran.
5. **The "cutover is running" preflight blocker was a lock collision, not a cutover.** `ca-mail-staging-ops.sh` takes `/run/lock/centralize-admin-db-isolation.lock` exclusively for every mode, including read-only checks. Attempts 3 and 4 of the production preflight started within 2 seconds of attempts 3 and 4 of the Mail `staging-checks` job, so each was refused. The 09:20 attempt didn't overlap and passed. The last real cutover run was 2026-10-29 16:34 (success).

## Changes

### Backend (services/central-admin-api)

| Area | File(s) | Change |
|---|---|---|
| Worker enablement | `mail.config.js` | `workerEnabled` = Mail enabled unless `MAIL_WORKER_ENABLED=false` (explicit emergency shutdown). |
| Core queue gating | `ops/rollout.service.js` | `workerQueueDecisions`: OUTBOUND, INBOUND and EVENTS follow backend flags only (`SENDING_DISABLED`, `RECEIVING_DISABLED`, `INBOUND_NOT_OWNED_HERE`, `MAIL_DISABLED`). An explicit `WORKER_<QUEUE>` DENY = `EMERGENCY_DENY_RULE` pause. ALLOW rules for core worker capabilities are refused (`CORE_WORKER_BACKEND_MANAGED`). MARKETING stays rollout-gated. |
| Worker loop | `jobs/mail-worker.js`, `application.js` | Records per-tick active and paused queues with their reasons, and writes a throttled durable heartbeat (RUNNING, then STOPPED on graceful shutdown). |
| Durable heartbeat | `jobs/worker-heartbeat.js` | One row per worker instance in `mail_outbox_jobs` (`kind=WORKER_HEARTBEAT`, `status=SUCCEEDED`, never claimable or recoverable, no migration needed). Holds state, queues, release image, `current_database()`, counters and last error. Excluded from job stats. |
| Worker process | `src/mail-worker.js` | Mail off or worker shut down: **idles** instead of exiting 0 (with a DISABLED heartbeat when Mail is on). Logs its database name and release at start. |
| Self-test | `application.js` | `WORKER_SELF_TEST` handler: no side effects. Used by deploy verification. |
| Reconciliation | `mail.config.js`, `pipelines/inbound-reconciler.js`, `adapters/resend.adapter.js` | On by default for a staging/production deployment that receives and owns inbound mail. Only emails listing an allowlisted address (To/Cc/Bcc) are considered; others are counted as `foreign` and never fetched, queued or stored. Only our own addresses go into the job payload. At most `MAIL_INBOUND_RECONCILE_MAX_ENQUEUE` (50) per run. Provider rate limits rethrow as retryable with Retry-After (60 s when the provider sends none). Duplicate prevention is unchanged: mailbox + RFC Message-ID. |
| Health | `ops/dependency-readiness.js`, `jobs/mail-job.repository.js` | Readiness adds `operational` (`OK`/`DEGRADED`, reasons such as `WORKER_NOT_RUNNING`, `QUEUE_UNSERVED:INBOUND`, `QUEUE_STALLED:INBOUND`, `DEAD_LETTERS:EVENTS`, plus per-queue pending, retrying, leased, dead-letter and failed-24h counts and the oldest due age). `ready` is not gated on it, so the API keeps accepting durable work. |
| Alerts | `ops/ops-monitor.service.js`, `src/server.js` | New `MAIL_WORKER_NOT_RUNNING` (critical), `MAIL_WORKER_QUEUE_UNSERVED` (critical for INBOUND) and `MAIL_WORKER_DISABLED`. Snapshot includes workers and the last inbound delivery. The API process runs the same evaluation every `MAIL_OPS_EVALUATE_SECONDS` (watchdog; `MAIL_OPS_API_WATCHDOG_ENABLED=false` turns it off). Alerts are logged as `[MailOps] ALERT …` and notified to Mail admins. New Prometheus metrics: `cf_mail_workers_running`, `cf_mail_worker_heartbeat_age_seconds`, `cf_mail_worker_unserved_core_queues`. |
| Deploy proof | `ops/worker-verification.js`, `scripts/mail/verify-worker.js` | Passes only with a fresh RUNNING heartbeat on the API's database, for the expected release, serving every enabled core queue, plus a completed isolated self-test job (inserted first in claim order; cancelled if not processed). Exit codes: 0 verified, 1 not verified, 2 not applicable. |

### Deployment and operations (.github)

| Script / workflow | Change |
|---|---|
| `ca-production-deploy.sh` | With Mail on, the worker must be running, stable (no restart within 15 s), `restart: unless-stopped`, on the app's image and on `cosmicforge_admin`, and must pass `verify-worker.js`. An exited worker is never accepted. A failure rolls back app and worker. The worker override pins the image, `restart: unless-stopped` and `MAIL_RELEASE_IMAGE`. Missing worker with Mail on: exit 4, no app rollback. Preflight reports the worker and heartbeat. Lock: a cutover holder is refused at once; any other holder is waited for (max 10 min) and named. Never removed or bypassed. |
| `ca-mail-env-install.sh` | Recreated worker must be running, stable and verified when Mail is on. |
| `ca-mail-staging-ops.sh` | `services-deploy`: `unless-stopped` whenever Mail is on and verified processing. Read-only modes take both locks **shared** and every refusal names the holder. New read-only `--mail-diagnose` (described below). |
| `ca-mail-diagnose.js` | Read-only diagnostic run inside the app (and worker) container. Reports worker database identity, job counts per queue/kind/status, every inbound job with its webhook event (status, times, sender **domain**), our own recipients, routing result, owner and membership state and stored copies, plus rollout rules, emergency stops, heartbeats and open alerts. No content, subjects or external addresses. |
| `ca-mail-staging-ops.yml` | `mail-diagnose` operation (read-only, staging or production). |
| `staging.yml` | Staging deploy verifies the worker processes work when Mail is on. |

### Unchanged on purpose

Webhook signature verification, encryption, scanner checks, mailbox authorization, production-only inbound ownership, shared-webhook routing for Admin and Karryam, emergency stops, and session hardening are all unchanged. Marketing, broadcasts, automation and integrations stay off unless separately enabled.

## Tests

* `tests/mail-inbound-backend-managed-postgres.test.js` (real PostgreSQL): `email.received` → durable event + job (idempotent) → a running worker with **rollout enforced and zero rules** → encrypted message in the owner's INBOX → `GET /mailboxes/:id/threads` and `/threads/:id/messages` return it for the owner; another staff member is refused. Also covers the heartbeat, deploy self-test, transient provider failure with backoff, crash recovery from an expired lease, reconciliation of an omitted webhook exactly once (late webhook = duplicate, no second copy; another product's mail never queued), wrong-environment ownership (503 + paused queue), receiving disabled (paused, attempts kept), emergency DENY pause and resume, retired core ALLOW rules, and `MAIL_WORKER_NOT_RUNNING` with DEGRADED readiness.
* `tests/mail-backend-managed-unit.test.js` (13 tests): config defaults, queue decisions, heartbeat writer/summary, reconciler ownership/cap/Retry-After, readiness, alerts, `verifyWorker` failure modes (absent, other database, old release, idle queues, unprocessed probe), idle worker process.
* Replica (`ca-release-ops-replica.sh` P5): with Mail on, a worker that exits 0 fails the release and rolls it back. Mail off: the release completes with an idle worker.

## Legacy-session readiness blocker (separate issue)

Production runs `AUTH_SESSION_MODE=legacy`: the access token is readable by JavaScript. With `MAIL_REQUIRE_HARDENED_SESSION` defaulting to true in production, Mail readiness reports `NOT_READY` (`session.status=BLOCKING`, `JS_READABLE_ACCESS_TOKEN`). This blocks neither webhook acceptance nor worker processing. It must not be "fixed" by disabling the requirement. Remediation (HQ auth rollout, owned by security; see `docs/hq-auth-sessions-and-mfa.md`): confirm that migration 28 (sessions/MFA) is applied in production and that the production frontend sends credentials and CSRF headers. Then move to `AUTH_SESSION_MODE=dual` (optionally `MAIL_SESSION_ALLOW_DUAL=true` while old tabs drain), and finally to `cookie`.

## Database isolation lock

No cutover was running: see root cause 5. With this change, read-only Mail checks hold the lock shared, refusals name the holder (PID and command), and the production deploy waits for non-cutover holders instead of failing. A running cutover is still always refused.
