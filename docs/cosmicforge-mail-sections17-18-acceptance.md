# CosmicForge Mail: Sections 17 and 18 acceptance report

Date: 2026-10-26. Branch: `staging` (local commits only, **not pushed**). Base: `origin/staging` @ `405ca07`.
Specification: "CosmicForge Mail Implementation Specification" v1.0, §17 (backend placement and process architecture),
§17.1 (parser and session caveats), §18 (provider adapter contract); §19/§20 applied as cross-cutting requirements.

## Outcome

**Sections 17 and 18 are code-complete and tested offline. Live provider verification is BLOCKED (no Resend
credentials, domain or account access). Nothing was pushed or deployed.**

Work started with three read-only audits of the real code (transactions and workers; HTTP, authorization and
sessions; inbound, domains and broadcasts) plus a check of the provider contract against Resend's current
documentation. Verified defects, all fixed with regression tests:

| Area | Defects |
|---|---|
| Worker and outbound | 11 |
| Inbound, domains, forwarding, membership | 11 |
| Broadcasts | 5 |
| Authorization and break-glass | 4 |
| HTTP, readiness, sessions, logging | 8 |
| **Total** | **39** |

Two regressions introduced during this round were caught by the existing suites and fixed: the contract wrapper
cached adapter methods, and it changed the `cancelBroadcast` signature.

Two items still need a later owner action: a frontend step-up dialog for membership grants, and a DB-backed worker
heartbeat (which needs a migration). No migration was created.

Result legend: **PASS** = implemented and tested offline. **BLOCKED** = live verification needs credentials, a domain
or account permissions. **FAIL** = incomplete or defective.

---

## A. Section 17 verification matrix

Paths are under `services/central-admin-api/src/modules/mail/` unless stated.

| Requirement (PDF §17 / §17.1) | Existing implementation | Changes made | Test evidence | Result |
|---|---|---|---|---|
| Controllers validate and return HTTP shape | `http/mail.routes.js`, service-level validation, `services/serializers.js` | Malformed JSON is now 400 `INVALID_JSON` (was 500, all Admin routes); invalid ids reaching UUID columns are 400 (`P2023`/validation errors) instead of 500; non-UUID `labelId` rejected; draft recipient lists capped at draft time; JSON shape guard (depth 16, arrays 5000, keys 20000) | `mail-provider-contract-unit` (body limits, malformed JSON, error responses), `mail-authz-tiers-postgres` (labelId), `mail-worker-reliability` (recipient caps) | PASS |
| Structured, safe errors; no raw Prisma errors | `mail.errors.js` `mailError`; `src/shared/middlewares/error.middleware.js` | Mail P2002 no longer echoes column names; `code` + `correlationId` on 409/404/413; 401 coded `UNAUTHENTICATED` | `mail-provider-contract-unit` "error responses" | PASS |
| Policy service enforces auth / tenant / grants (object level) | `authz/mail.policy.js`, `authz/break-glass.service.js` | Break-glass re-checked per request (requester grant + ACTIVE, approver grant + ACTIVE); every break-glass exposure audited (thread list, thread view, queue, notes, activity); contact suggestions exclude break-glass mailboxes; nobody can self-grant shared-mailbox membership; admin grants need MFA step-up `MAIL_MEMBERSHIP_GRANT` | `mail-authz-tiers-postgres` 10/10 (EMPLOYEE, ADMIN, EXECUTIVE, SUPER positive/negative), `mail-inbound-domain-postgres` (self-grant), `mail-postgres` M1 | PASS |
| Domain services own transactions | `services/compose.service.js` (message, recipients, outbox job, audit in one transaction) | Body object written before the transaction is removed when it rolls back; attachment count check + insert now serialized under the draft row lock, object removed on failure | `mail-worker-reliability` (orphan body, concurrent attachment limit) | PASS |
| Prisma access scoped to the Admin DB; no product DB calls | Mail uses the Admin Prisma client only | none | `mail-app-wiring` "no HealthNet Main DB or cross-module internal dependencies" | PASS |
| Provider HTTP isolated to adapters; no vendor SDK in React | `adapters/*` | All provider calls now pass through `adapters/provider-contract.js` | grep: no `resend` import or API key in `apps/central-admin-web/src`; `mail-provider-contract-unit` | PASS |
| Worker sends only after the transaction commits | Only `pipelines/outbound.processor.js` calls `sendMessage`; API never sends | none needed | `mail-postgres` M2/M3 | PASS |
| Durable outbox; crash and lease recovery; no duplicate sends | `jobs/mail-job.repository.js` (`FOR UPDATE SKIP LOCKED`, lease recovery to RECONCILING) | OUTBOUND and INBOUND leases heartbeated; payload writes fenced by lease token (`writeJobPayload`, `MAIL_JOB_LEASE_LOST`); lost lease checked before each provider call; lease clamped to provider timeout + 30 s; `complete()`/`fail()` returning "not updated" is no longer counted as success | `mail-worker-reliability` (two concurrent runs after lease expiry: one provider email, stale run fenced; post-accept DB failure: same key, same id, no duplicate), `mail-concurrency-postgres` (8 workers × 200 jobs exactly once) | PASS |
| Terminal failures never leave mail QUEUED | dead-letter cleanup existed | New `onFailed` hook: a FAILED (non-retryable) SEND_MESSAGE job runs the terminal cleanup; batches that may have been accepted become OUTCOME_UNKNOWN, never "failed" | `mail-worker-reliability` | PASS |
| Feature flags never destroy queued work | emergency stop deferred | `MAIL_SENDING_ENABLED=false` and `MAIL_RECEIVING_ENABLED=false` now defer (no attempt consumed) instead of dead-lettering; emergency stop re-checked before every batch | `mail-worker-reliability`, `mail-inbound-domain-postgres` | PASS |
| Independent, controllable worker process; no cron in API replicas | `src/mail-worker.js` (`npm run mail:worker`), `MAIL_WORKER_ENABLED`, `MAIL_WORKER_QUEUES`, bounded concurrency | Graceful drain (`MAIL_WORKER_DRAIN_TIMEOUT_MS`), in-flight job ids logged; `unhandledRejection`/`uncaughtException` handled; DB errors while settling a job no longer crash the worker; liveness log line + `lastTickCompletedAt` | `mail-worker-reliability` (stop drains, timeout, survives `complete` throwing, entrypoint handlers) | PASS; DB-backed liveness heartbeat needs a migration (owner action) |
| Every failure path carries correlation / job ids | request id → `X-Request-ID` and error bodies | Request id stored on outbox jobs (`correlationId`); outbound audits carry `jobId`, `correlationId`, `idempotencyRef`; worker logs carry job id/kind/key | `mail-worker-reliability` (FAILED cleanup records job and request ids) | PASS |
| §17.1 global JSON parser stays small; deliberate route limits | 10 KB global; 1 MB for every Mail path | 64 KB default for Mail; drafts, signatures/preferences and marketing authoring up to `2 × MAIL_BODY_MAX_BYTES + 64 KB` (max 12 MB), so a configured body cap is now reachable | `mail-provider-contract-unit` "app.js: small Mail routes 64 KB…", `mail-app-wiring` | PASS |
| §17.1 multipart / direct-to-storage with own limits | multer: 1 file, size cap, scan before availability | Cleanup after a failed insert; race-free count limit | `mail-worker-reliability`, m9 "a1" | PASS |
| §17.1 webhooks bypass mutation before signature check | raw parser on webhook paths (256 KB), XSS middleware skipped for Mail | Regression test through `app.js` with whitespace, key order and `<script>` characters | `mail-provider-contract-unit` (exact bytes, reordered JSON rejected, old/future timestamp, missing headers, 413 before verification, rotation overlap), `mail-app-wiring` | PASS |
| §17.1 session architecture assessment | HQ auth has `AUTH_SESSION_MODE` legacy/dual/cookie (httpOnly cookies + CSRF + origin check, server-side session revocation) | `security/session-assessment.js`; readiness reports the mode; `MAIL_REQUIRE_HARDENED_SESSION` (default on in production) makes an enabled Mail not ready unless sessions are cookie mode (or dual with `MAIL_SESSION_ALLOW_DUAL=true`) | `mail-provider-contract-unit` "session assessment" | **BLOCKED** (security-owner migration; see §G) |
| Private responses not cached; tokens and search terms not logged | `no-store` on some routes | Router-wide `Cache-Control: no-store`; access logs redact unsubscribe/consent tokens and sensitive query values (`q`, `token`, `code`, …) | `mail-provider-contract-unit` "access logs redact" | PASS |
| Rate limits | 300/min per user router-wide; send 20/min; public 30/min/IP | Per-user limits: search 60/min, contact suggestions 120/min, raw MIME 30/min, attachment downloads 120/min (shared across replicas) | existing limiter tests; route wiring | PASS |
| Readiness / health (§20) | `/health/live`; `/health/ready` reported `ready:true` with no checks when Mail was off | Dependency-specific readiness (`ops/dependency-readiness.js`): schema, encryption, storage (real backend health), scanner, provider (probe cached 30 s), webhooks, infrastructure, queue counts, session. Disabled Mail answers 200 `ready:false, state: DISABLED` with config-only states and no network calls | `mail-provider-contract-unit` readiness tests, `mail-schema-readiness` | PASS |
| Frontend/API compatibility | generated client `apps/central-admin-web/src/lib/generated/mail-api.ts` | Additive fields and routes only; client regenerated; `mail:client:check` ok; web `tsc` clean | see §E | PASS, with one UI follow-up: admin membership adds now need a step-up dialog |

## B. Section 18 verification matrix

| Requirement | Implementation | Test evidence | Result |
|---|---|---|---|
| Provider-neutral contract with the nine operations | `adapters/provider-contract.js`: `sendMessage`, `fetchInboundMessage`, `fetchInboundAttachments`, `validateDomain`, `queueBroadcast`, `cancelBroadcast`, `syncAudience`, `retrieveDeliveryEvents`, `healthProbe` (`createMailProviderContract`); every adapter used by Mail is wrapped (`withTransportContract`, `withMarketingContract`) in `application.js` | `mail-provider-contract-unit` "contract: exposes the nine operations…" | PASS |
| Typed normalized errors | `MailProviderError` keeps `kind` (retry semantics) and adds `category`, `retryable`, `providerErrorName`, `rateLimit`, `operation`, `describe()`; unexpected adapter exceptions become OUTCOME_UNKNOWN (writes) or retryable (reads) | catalogue test (29 Resend status/name pairs), "MailProviderError" test | PASS |
| Resend mapping isolated in the adapter | `adapters/resend-errors.js` (status + name + message), `resend.adapter.js`, `marketing/resend-marketing.adapter.js` | same | PASS |
| Idempotency | stable per-batch `Idempotency-Key` (1-256 chars, 24 h); `invalid_idempotent_request` = OUTCOME_UNKNOWN; `concurrent_idempotent_requests` retryable; broadcasts are not idempotent and are reconciled by name/status; `queueBroadcast` never sends twice | `mail-postgres` ambiguity tests, `mail-worker-reliability` post-accept failure, contract queue test | PASS |
| Outbound send (From, display name, To/Cc/Bcc, Reply-To, subject, HTML, text, attachments, Message-ID, In-Reply-To, References, custom headers) | `resend.adapter.js`; documented limits enforced before any call (50 To, 40 MB attachments after Base64, header CRLF, key length) | "documented limits are enforced before any network call" (also asserts Bcc never appears in a header) | PASS offline; live BLOCKED |
| Recipient correctness, partial delivery, unknown outcomes | per-batch plan, per-recipient state, OUTCOME_UNKNOWN past the idempotency window | `mail-mixed-recipients-postgres` 19/19, `mail-postgres` regressions | PASS offline |
| Inbound fetch | `GET /emails/receiving/{id}` (provider `authentication` spf/dkim/dmarc, `received_for`, `raw`) | `mail-postgres` M2, `mail-inbound-domain-postgres` | PASS offline; live BLOCKED |
| Inbound attachments | `GET /emails/receiving/{id}/attachments` with `has_more`/`after` paging; expired signed link (403) is retried with fresh links and, on the final attempt, the message is delivered with that attachment marked failed (never lost) | "received attachments…" test, `mail-inbound-domain-postgres` | PASS offline |
| Inbound routing / no open relay | only our domains; ACTIVE addresses; FAILED sending verification no longer drops inbound (routing uses receiving state); unknown recipients of mixed messages held under the `quarantine` policy; external forwarding re-checked against the allowlist at execution | `mail-inbound-domain-postgres` 12/12 | PASS |
| Domain verification | `validateDomain` maps status (incl. `partially_verified`, `temporary_failure`), SPF, DKIM, receiving, capabilities; DMARC reported `NOT_REPORTED` (Resend does not report it); `createDomain` (`POST /domains`), `verifyDomain` (`POST /domains/{id}/verify`), `findDomainByName`; admin routes behind `MAIL_PROVIDER_DOMAIN_MANAGEMENT_ENABLED=false` + MFA; re-verification never lifts a suspension; empty allowlist refuses new domains | "domains…" test, `mail-inbound-domain-postgres` | PASS offline; live BLOCKED |
| Webhook signatures | `webhooks/resend-webhook.verifier.js`: `svix-id`/`svix-timestamp`/`svix-signature`, HMAC-SHA256 over `id.timestamp.rawBody`, `timingSafeEqual`, ±300 s tolerance, multiple `v1,` signatures, current + previous secret | unit + app-level byte test | PASS offline; live BLOCKED |
| Webhook delivery events and replay | event + job in one transaction; unique (provider, svix-id); 503 until durable so the provider retries | `mail-postgres`, `mail-concurrency-postgres` | PASS |
| Broadcasts | create draft → send/schedule; campaign-to-provider ID mapping; event attribution; guarded dispatch/campaign transition tables | `mail-m7-postgres`, `mail-broadcast-cancel-postgres` 10/10 | PASS offline |
| Broadcast cancellation | `POST /broadcasts/{id}/cancel` only for queued/scheduled; scheduled → draft (nothing sent) → CANCELLED and provider draft + segment deleted; queued → CANCELED → campaign PARTIAL (sends already made are not recalled); late delivery events still apply and correct CANCELLED → PARTIAL | `mail-broadcast-cancel-postgres` | PASS offline; live BLOCKED |
| Contact / audience synchronization | consent and suppression re-checked per contact before sync; provider-unsubscribed contacts never re-subscribed; `syncAudience` only accepts consent-verified contacts | `mail-broadcast-cancel-postgres` (sync rules), contract sync test | PASS |
| Consent | CosmicForge DB is the record; re-subscription needs a new verified double opt-in (previous round) | `mail-resubscribe-pricing-*` | PASS |
| Rate limits | client pacing (`RESEND_REQUESTS_PER_SECOND`, default 8 per worker process, below Resend's documented 10/s per team); `ratelimit-*` and `retry-after` captured; 429 defers durably | pacing test, 429 test | PASS offline |
| Quotas | `x-resend-daily-quota` / `x-resend-monthly-quota`; `daily_quota_exceeded` / `monthly_quota_exceeded` defer until the documented reset without consuming attempts | `mail-postgres` q8, `mail-m7-postgres` quota tests | PASS offline |
| Retries / unknown outcomes | read timeout = TIMEOUT (retryable); write timeout = OUTCOME_UNKNOWN (reconciled, never blindly replayed) | timeout test, `mail-postgres` ambiguity | PASS |
| Provider recovery / health | `healthProbe` OK / DEGRADED (429) / UNAVAILABLE / MISCONFIGURED (401/403) / NOT_CONFIGURED; readiness distinguishes unconfigured from unhealthy | "health probe distinguishes…" | PASS |
| Optional Inboxes API | not adopted (see §H) | n/a | Decision recorded |
| Live staging proof (§18 "Prove in staging") | — | — | **BLOCKED**: API scopes, per-domain receiving and MX, exact live webhook payloads, reply/forward headers, attachment sizes, live rate limits and quotas, live cancellation semantics, complaint handling, plan/price tier |

## C. Technical artifacts

### C.1 Architecture

```text
Browser (React)  --HTTPS, HQ session-->  api-gateway/Express app.js
  no provider SDK                         | requestContext (X-Request-ID), helmet, CORS
                                          | Mail parsers: raw 256 KB (webhooks) | JSON 64 KB / rich (body-limits.js)
                                          v
                               http/mail.routes.js  (controllers; no-store; per-user + per-route limits)
                                          v
                               authz/mail.policy.js, step-up, break-glass  (deny by default, object level)
                                          v
                               services/*  (domain logic, Admin DB transactions)
                                          | message + recipients + outbox job (+ audit) in ONE transaction
                                          v
                               Admin PostgreSQL  (mail_* tables; mail_outbox_jobs)
                                          ^  claim (SKIP LOCKED, lease token, heartbeat)
src/mail-worker.js (separate process: MAIL_WORKER_ENABLED, MAIL_WORKER_QUEUES)
   jobs/mail-worker.js -> pipelines/* , marketing/* , ops/*  processors
                                          v
                               adapters/provider-contract.js  (validate, normalize, categorize)
                                          v
                               adapters/resend*.js | fake.adapter.js   (only place with provider HTTP)
                                          v
                               Resend API  (/emails, /emails/receiving, /domains, /broadcasts, /contacts, /segments)
Resend webhooks --> POST /api/mail/v1/webhooks/resend(/brand/:slug) --> verify raw bytes --> event + job (one tx) --> 200
```

### C.2 Transaction boundary (staff send)

```text
POST /drafts/:id/send (Idempotency-Key)
 ├─ outside tx: authorize sender + recipients, content policy, store encrypted body object
 ├─ BEGIN
 │   ├─ lock draft row, quota (advisory lock), create message + recipients
 │   ├─ enqueue SEND_MESSAGE (idempotencyKey, correlationId = request id)
 │   └─ audit
 ├─ COMMIT  ──> 202 { status: QUEUED, jobId }
 └─ on rollback: remove the stored body object (durable deletion queue or direct)
worker (after commit only)
 ├─ claim job (lease token) ─ heartbeat while running
 ├─ per batch: re-check halt + quota ─ mark batch inFlight (fenced write) ─ provider send (Idempotency-Key = job:batch)
 ├─ accepted: fenced acceptance tx (providerMessageId, PROVIDER_ACCEPTED)
 └─ unknown (timeout / 409 conflict): batch ambiguous ─ retry with SAME key inside 23 h, else OUTCOME_UNKNOWN
```

### C.3 Worker processing and recovery

- Claim: `FOR UPDATE SKIP LOCKED`, unique lease token per claim, bounded concurrency (1-32).
- Heartbeat: MARKETING, OUTBOUND and INBOUND leases are renewed. A lost lease sets `job.lease.lost`, which stops the run before its next provider call; fenced writes refuse to overwrite the newer run's plan.
- Expired leases: OUTBOUND jobs recover to RECONCILING (never blind resend); others to PENDING.
- Outcomes: complete; fail → retry with backoff (or `retry-after`); defer (flags off, emergency stop, quota) without consuming attempts; FAILED / DEAD_LETTER run terminal cleanup hooks.
- Shutdown: stop claiming, drain the current tick and in-flight jobs up to `MAIL_WORKER_DRAIN_TIMEOUT_MS`, log unfinished job ids (they recover via lease expiry).
- Crash safety: errors while settling are logged with the job id and never crash the process; process-level handlers log and shut down gracefully.

### C.4 Provider adapter contract

| Operation | Input (validated before any call) | Output (normalized) |
|---|---|---|
| `sendMessage(request)` | idempotencyKey 1-256, valid From, ≥1 To, valid Cc/Bcc, subject, html or text, attachments with filename + content | `{ providerMessageId }` (missing id = OUTCOME_UNKNOWN) |
| `fetchInboundMessage(id)` | provider id | normalized inbound (parties, envelope recipients, RFC ids, provider authentication, raw link) |
| `fetchInboundAttachments(id)` | provider id | `[{ providerAttachmentId, filename, contentType, sizeBytes, contentId, inline, expiresAt, download(maxBytes) }]` |
| `validateDomain(id)` | provider id | `{ status, sendingStatus, receivingStatus, spfStatus, dkimStatus, dmarcStatus, region, capabilities, records }` |
| `queueBroadcast({ organization, providerBroadcastId, scheduledAt })` | provider id | `{ providerBroadcastId, status, alreadyQueued }` |
| `cancelBroadcast({ organization, providerBroadcastId })` | provider id | `{ outcome: NOT_FOUND | NOT_CANCELLABLE_ALREADY_SENT | ALREADY_CANCELED | NOTHING_TO_CANCEL | RETURNED_TO_DRAFT | CANCELED, providerStatus, sentBeforeCancel: NONE | ALL | UNKNOWN }` |
| `syncAudience({ organization, segmentId, add, remove })` | every added contact `consentVerified: true` | `{ added, created, removed, providerUnsubscribed[] }` |
| `retrieveDeliveryEvents(id)` | provider id | `[{ type, occurredAt, recipient }]` (known types only) |
| `healthProbe()` | — | `{ ok, status: OK | DEGRADED | UNAVAILABLE | MISCONFIGURED | NOT_CONFIGURED, latencyMs, detail, rateLimit }` |

### C.5 Webhook security flow

1. `app.js` routes `POST /api/mail/v1/webhooks/resend[/brand/:slug]` to a raw parser (256 KB) before JSON parsing and XSS mutation; the global per-IP limiter is skipped for this path (the provider is authenticated by signature).
2. 503 while Mail, the relevant capability or the schema is not ready (provider retries).
3. Verify `svix-id`, `svix-timestamp` (±300 s), `svix-signature` (`v1,<base64>` list) with HMAC-SHA256 over `id.timestamp.rawBody` using the current and previous secret, compared with `timingSafeEqual`. Unknown brand looks like a bad signature (401).
4. Unknown event types: 200 `ignored` (never processed). Brand endpoints never accept `email.received`.
5. One transaction: unique (provider, svix-id) event row + job. Duplicate = 200 `duplicate:true`. Storage failure = 503 (not acknowledged).
6. Content is fetched later by the worker through the adapter; only routing metadata is stored from the event.

### C.6 Normalized error catalogue

| Category | Kind | Typical Resend source | Worker behaviour |
|---|---|---|---|
| AUTHENTICATION_FAILED | PERMANENT | 401 `missing_api_key` / invalid key; 403 `suspended_api_key` | fail; readiness MISCONFIGURED |
| PERMISSION_DENIED | PERMANENT | 401/403 `restricted_api_key`, 403 `invalid_permission`, testing-mode, domain owned by another account, 403 without name (User-Agent) | fail |
| DOMAIN_NOT_VERIFIED | PERMANENT | 403 `validation_error` "domain is not verified" | fail (sending gate also blocks earlier) |
| INVALID_RECIPIENT | PERMANENT | 422 invalid recipient address | fail recipient batch |
| VALIDATION_FAILED | PERMANENT | 400/422 validation, `invalid_idempotency_key`, `invalid_attachment`, `missing_required_*`; pre-call contract checks | fail (nothing submitted) |
| NOT_FOUND | PERMANENT | 404 | fail / treated as absent |
| NOT_SUPPORTED | PERMANENT | 405; missing adapter method | fail |
| CONFLICT | RETRYABLE | 409 `concurrent_idempotent_requests`, `resource_locked` | retry with same key |
| RATE_LIMITED | RETRYABLE | 429 `rate_limit_exceeded` (+ `retry-after`) | defer by retry-after |
| QUOTA_EXCEEDED | RETRYABLE (quota) / PERMANENT (403) | 429 `daily_quota_exceeded` / `monthly_quota_exceeded`; 403 `email_above_quota` | defer until documented reset, no attempt consumed |
| PROVIDER_UNAVAILABLE | RETRYABLE | 5xx `application_error`, `service_unavailable`; read network errors | backoff with jitter |
| TIMEOUT | RETRYABLE | read timeout | retry |
| OUTCOME_UNKNOWN | AMBIGUOUS / IDEMPOTENCY_CONFLICT | write timeout or reset; accepted without id; 409 `invalid_idempotent_request` | reconcile; never blind resend |
| NOT_CONFIGURED | NOT_CONFIGURED | no API key / unconfigured brand | fail closed, no network call |

### C.7 Environment configuration reference (new or changed in this round)

| Variable | Default | Purpose |
|---|---|---|
| `RESEND_REQUESTS_PER_SECOND` | `8` | client pacing per worker process (0 = off) |
| `MAIL_REQUIRE_HARDENED_SESSION` | production: true; else false | enabled Mail not ready without httpOnly cookie sessions |
| `MAIL_SESSION_ALLOW_DUAL` | `false` | accept `AUTH_SESSION_MODE=dual` as hardened during rollout |
| `MAIL_PROVIDER_DOMAIN_MANAGEMENT_ENABLED` | `false` | allow provider domain registration / verify trigger (admin + MFA) |
| `MAIL_PROVIDER_ENVIRONMENT_TAG` (alias `RESEND_API_KEY_ENVIRONMENT`) | empty | if set, must equal the deployment environment |
| `MAIL_WORKER_DRAIN_TIMEOUT_MS` | `30000` | graceful worker drain |
| `MAIL_WORKER_LEASE_SECONDS` | `120` | now clamped to ≥ `RESEND_TIMEOUT_MS`/1000 + 30 |

Unchanged and still OFF: `MAIL_ENABLED`, `MAIL_SENDING_ENABLED`, `MAIL_RECEIVING_ENABLED`, `MAIL_MARKETING_ENABLED`,
`MAIL_WORKER_ENABLED`. Credentials (`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_WEBHOOK_SECRET_PREVIOUS`,
`RESEND_MARKETING_API_KEY__<SLUG>`, `RESEND_WEBHOOK_SECRET__<SLUG>`) stay empty in source.

New infrastructure violations (staging/production): `MAIL_PROVIDER=fake`; sending/receiving enabled without a webhook
secret or without a domain allowlist; provider environment tag mismatch.

### C.8 API / OpenAPI changes (all additive)

- `POST /admin/domains/{domainId}/provider-registration` (admin + step-up `MAIL_DOMAIN_PROVIDER_MANAGE`, flag-gated).
- `POST /admin/domains/{domainId}/verify`: optional `trigger`; links a provider domain by name when no id is stored; response gains `checks` (spf/dkim/dmarc/receiving).
- `POST /mailboxes/{id}/members`: accepts `stepUpId` (required for admin-driven grants); self-grant refused (403 `SELF_GRANT_NOT_ALLOWED`).
- `GET /health/ready`: adds `state`, `dependencies`, `queue`, `session`; disabled Mail now `ready:false` (HTTP 200).
- Marketing dispatch: additive `paused` / `campaignPaused`, report `totals.providerSent`.
- Error bodies: additive `code` / `correlationId`; malformed JSON 400.
- Generated client regenerated (`apps/central-admin-web/src/lib/generated/mail-api.ts`); `mail:client:check` ok.

### C.9 Migrations

**None created.** Manifest still 37 migrations, 0 checksum failures, safety 0 findings. Everything fits existing
tables and JSON columns (job payload `correlationId`, `mail_delivery_events` SENT rows). The shared staging database
was not touched.

## D. Automated test results

All runs are offline, on the final code, using PostgreSQL 16 and `NODE_ENV=test` as CI does. No run used a live
provider. Mocks and the fake provider are not counted as live tests.

| Suite | Result |
|---|---|
| Full backend `npm test` (migrated Admin DB, as CI) | 1453 tests: **1450 pass, 0 fail, 3 skipped** (no IPv6 loopback; live clamd and S3 tests skip without endpoints and were run separately below) |
| `npm run test:mail` (41 files) | **469 / 469 pass** (was 398) |
| `test:mail:s3` (S3 storage mode) | **30 / 30 pass** |
| `test:mail:clamd-live` (real clamd 1.5.4 daemon, local; EICAR via a one-line local signature) | 1 / 1 pass |
| `test:mail:s3-kms-live` (real S3/KMS protocol, local moto server) | 1 / 1 pass |
| New suites | `mail-provider-contract-unit` 20/20, `mail-worker-reliability` 17/17, `mail-inbound-domain-postgres` 12/12, `mail-provider-identity-unit` 3/3, `mail-broadcast-cancel-postgres` 10/10, `mail-authz-tiers-postgres` 10/10 |
| Flake check | the broadcast-cancel suite run 12 times in parallel under load: 12/12 pass (a test-order assumption was found and fixed, `fa63e03`) |
| Migration manifest / safety / replay | 37 migrations, 0 checksum failures, 0 safety findings, replay drift none |
| Rollback drill / backup-restore drill (disposable DBs) | ok / ok (130 tables, 0 mismatches) |
| Secret scan / network-guard static / `config:validate:staging` | 815 files, 0 findings / ok / ok |
| Generated client (`mail:client:check`) | ok |
| Web `tsc` / `next build` | clean / ok |
| Playwright desktop + mobile (mocked API, includes the Section 16 UI agent's specs) | 161 pass, 21 skipped (existing project-specific skips), 0 fail |

Regression coverage includes the M1-M10 and Sections 11-15 suites, Section 16 UI specs, login and MFA
(`auth-sessions-mfa-postgres`, `auth-premigration-compat`), HR, IT, Help & Support, Marketing, HealthNet isolation and
the Karryam contract vectors, all inside the full backend run.

## E. Security review findings (fixed in this round)

1. Admin/SUPER could self-grant access to any shared mailbox (support, HR) without MFA or a second person.
2. Break-glass thread lists, thread summaries, support queue, internal notes and activity were not audited.
3. Break-glass access survived revocation of the requester's grant for up to 4 hours.
4. Capability tokens (unsubscribe/consent links) and private search terms were written to production access logs.
5. Private lists, notes and contact PII were cacheable (no `no-store`).
6. Mail P2002 errors exposed column names; malformed JSON and invalid ids produced 500s.
7. Re-verifying a suspended domain silently lifted the suspension (sending kill-switch and inbound).
8. Narrowing the external forwarding allowlist did not stop existing forwarding rules.
9. A staging/production deployment could run with `MAIL_PROVIDER=fake`, without a webhook secret or allowlist, without a violation.
10. One 1 MB JSON limit for every Mail route; no depth/array limits; unbounded draft recipient arrays.

Remaining risk: in the default `AUTH_SESSION_MODE=legacy`, the browser keeps the access token where JavaScript can read
it (see §G). Mail stays disabled until the security owner completes the session migration.

## F. Provider capability verification (documentation, 2026-10-26)

Checked against Resend's public API reference: error catalogue (status + name), `POST /emails` fields and limits (50
To, attachments ≤ 40 MB after Base64, Idempotency-Key 1-256 characters for 24 h, `User-Agent` required), rate-limit
headers (`ratelimit-limit|remaining|reset`, `retry-after`) and quota headers (`x-resend-daily-quota` free plan only,
`x-resend-monthly-quota`), default 10 requests/s per team, `GET /emails/receiving/{id}` fields (`authentication`,
`received_for`, `raw`, `attachments`), `GET /emails/receiving/{id}/attachments` (paging, `download_url`, `expires_at`),
`POST /domains` (`capabilities.sending|receiving`, `region`), `POST /domains/{id}/verify` (asynchronous, status
pending), `POST /broadcasts/{id}/cancel` (queued or scheduled only; scheduled → draft; already-sent emails unaffected),
webhook headers `svix-id`/`svix-timestamp`/`svix-signature` over the raw body. **Not verifiable without an account:**
actual plan limits and quotas, API key scopes, receiving behaviour for our domains, exact live payloads, pricing.

## G. Session-security assessment (§17.1)

- **Current state:** `AUTH_SESSION_MODE=legacy` is the default. The frontend keeps the access JWT in `localStorage`
  and in a JavaScript-readable cookie, valid for up to 8 h. An XSS anywhere in the Admin app could steal mailbox access.
- **Already built in HQ auth:**
  - `dual` and `cookie` modes, with `__Host-` httpOnly Secure cookies;
  - CSRF header plus trusted-Origin checks for cookie-authenticated mutations;
  - server-side sessions with per-request revocation (`sid`), and refresh rotation with reuse detection.
- **Done here (no change to Admin login):**
  - Mail reports the session mode on readiness.
  - `MAIL_REQUIRE_HARDENED_SESSION` (default on in production) keeps an enabled Mail not ready until sessions are
    hardened.
  - Mail responses are `no-store`, and tokens never appear in logs.
  - Mail membership, user status and break-glass are re-checked on every request, so access revocation works mid-session.
- **Plan for the security owner** (not done here, because it changes every Admin user's session):
  1. Staging: `AUTH_SESSION_MODE=dual` and verify the frontend cookie path, CSRF header and refresh.
  2. Run the auth regression suites (`auth-sessions-mfa-postgres`, `auth-premigration-compat`).
  3. Switch to `cookie` and remove `localStorage` token use from the frontend (UI agent).
  4. Set `MAIL_REQUIRE_HARDENED_SESSION=true` on staging before the Mail pilot.
  5. Legacy tokens without a `sid` expire within 8 h of the switch.
- **Result:** BLOCKED pending that approved migration. Private-mail rollout must not proceed in legacy mode.

## H. Optional Resend Inboxes API: decision

**Not adopted.**
- **Status:** the documentation marks it private beta, with responses that may change before general availability.
  It needs an access request and preview SDK builds.
- **Overlap:** it covers inbox create/list/update/delete, drafts and `inbox.*` webhooks. CosmicForge already owns
  mailboxes, threads, drafts, authorization and retention in the Admin DB.
- **Risk:** routing the same receiving address through Inboxes and through Receiving would create two ingestion paths,
  which §18 forbids.
- **Gain:** none measured. Pricing, rate limits and access scopes for our account are unknown.

The baseline stays `/emails`, Receiving, signed webhooks and Broadcasts. Revisit only after general availability, with
an engineering spike on a dedicated test address and owner approval for any migration.

## I. Deployment impact

- These commits change files under `services/central-admin-api/src/`. That matches `infrastructure/scripts/staging-api-change-scope.sh`, so a push to `staging` **will build and deploy the staging API and restart its container**. That deployment is not authorized by this assignment, so nothing was pushed.
- With the current staging configuration (Mail disabled), the expected runtime changes on deploy are:
  - `/health/ready` changes from `{ready:true, enabled:false, checks:{}}` to HTTP 200 `{ready:false, enabled:false, state:"DISABLED", …}`. The deploy workflow probes only `/health`, not Mail readiness.
  - All Admin routes: malformed JSON returns 400 instead of 500. P2002/P2025 bodies gain `code` and `correlationId`.
  - Access-log URLs are redacted.
  - Mail JSON bodies over 64 KB on small routes return 413.
  - No migrations. Workers are not started. No provider calls are made with Mail disabled.

## J. Staging release procedure (when separately authorized)

1. Review the local commits (§K); `git fetch origin staging` and rebase/merge if `origin/staging` moved.
2. Re-run `npm run test:mail`, full `npm test`, `db:manifest:verify`, `migrations:safety`, `security:secret-scan`, `mail:client:check`, web `tsc` + `next build` + Playwright.
3. `git push origin staging`; watch "Social Operations CI" (staging.yml): verify → SSH check → image build → deploy.
4. Probe `https://stagingca.cosmicforge-healthnet.com/health`, `/api/mail/v1/health/live` (200) and `/health/ready` (200, `state:"DISABLED"`), and the staging frontend.
5. Keep all Mail flags off. Activation follows `docs/cosmicforge-mail-staging-migration-runbook.md` and the acceptance report hand-off.

**Rollback:** no schema change, so rollback is code-only: `git revert` the commits (or redeploy the previous image tag
from the staging workflow) and push. Configuration additions are optional and default safe.

## K. Local commits

| SHA | Commit |
|---|---|
| `d68bc21` | feat(mail): provider-neutral contract and Resend error/limit/domain mapping (section 18) |
| `ea920e1` | fix(mail): worker and outbound reliability (section 17) |
| `02f0fb7` | fix(mail): inbound routing, domain lifecycle, forwarding and membership grants |
| `46c779d` | fix(mail): broadcast cancellation semantics and guarded campaign transitions |
| `22d1803` | fix(mail): break-glass revocation, exposure audits and id validation |
| `896daf0` | feat(mail): HTTP hardening, dependency readiness, session assessment and wiring |
| `b04b713` | test(mail): scope SENT evidence replay check to its dispatch |
| `fa63e03` | test(mail): replay SENT evidence for a recipient that was actually sent |
| (this file) | docs(mail): sections 17-18 acceptance report |

The series is meant to deploy together: shared wiring (`application.js`, routes, config) lands in `896daf0`, so the
earlier commits were not deployed or tested on their own. Totals: 47 files changed in `services/central-admin-api` (4,310 insertions, 330 deletions) and
one generated file in `apps/central-admin-web`.

## L. Outstanding owner actions

| Action | Owner |
|---|---|
| Authorize the staging deployment of these commits | Release owner |
| HQ session migration to `dual`/`cookie`, then `MAIL_REQUIRE_HARDENED_SESSION=true` | Security owner |
| UI: step-up dialog for admin membership grants (`MAIL_MEMBERSHIP_GRANT`), self-grant message, domain register/verify actions and `checks` display, paused flag on campaign views | Section 16 UI agent |
| Migration for a DB-backed worker heartbeat (readiness can then report worker liveness) | DB owner (future additive migration) |
| Resend staging API key (full access for domains/receiving; sending-only keys break health and domain checks), webhook endpoint and secret, receiving route for one test address | Resend account owner |
| Approved isolated test subdomain, SPF/DKIM/DMARC/MX (no root MX change) | Domain owner |
| Apply migrations 27-37 to the staging Admin DB after backup | DB owner |
| Live §18 proofs (scopes, receiving, payloads, headers, attachment sizes, limits/quotas, cancellation, complaints, tier) | Engineering with the above access |

## M. Final answers

1. **Is Section 17 fully implemented?** Yes in code. The one exception is the session hardening switch, which is a security-owner migration (BLOCKED) and is enforced as a readiness gate.
2. **Is Section 18 fully implemented at code level?** Yes.
3. **Is the provider-neutral contract complete?** Yes. All nine operations exist, inputs are validated, outputs and errors normalized. Every Mail provider call goes through it.
4. **Can the Resend adapter operate once authorized credentials are supplied?** Yes, by design and per offline tests against documented contracts. It has not been proven live.
5. **Are the outbox, inbound and reconciliation workers correct?** Yes per offline tests. Fixed in this round: lease fencing, heartbeats, terminal cleanup, deferral instead of dead-letter, crash safety, graceful drain.
6. **Are webhook signatures validated against raw bytes?** Yes. Covered by an app-level byte-preservation test.
7. **Are Mail authorization and private mailbox boundaries enforced?** Yes. Tested for all four tiers, including break-glass revocation and the self-grant fix.
8. **Does the backend remain safe without Resend credentials?** Yes. It fails closed with NOT_CONFIGURED, makes no network calls, and readiness reports DISABLED or NOT_CONFIGURED.
9. **Is the session architecture adequate for private-mail rollout?** No, not in the default legacy mode. An approved security migration is still pending (§G).
10. **Are all backend and Mail regression tests passing?** Yes. Full backend 1450/1453 pass with 0 failures and 3 environment skips; Mail 469/469; S3 30/30; Playwright 161 pass and 0 fail (§D).
11. **Were any migrations created?** No. Nothing was applied to the shared staging database.
12. **Were Section 16 frontend contracts preserved?** Yes: the changes are additive and the client was regenerated. One behaviour change: admin membership adds now need an MFA step-up, which needs a UI follow-up.
13. **Have any live provider operations been tested?** No.
14. **Are the changes locally committed or remotely deployed?** Locally committed only. Nothing was pushed or deployed.
15. **What remains before an authorized staging deployment?** Release-owner authorization, then the procedure in §J. Mail activation additionally needs the owner actions in §L.
