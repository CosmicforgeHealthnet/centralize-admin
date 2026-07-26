# CosmicForge Advertising Execution Phase 3 — Sections 25–28 completion report

Audit date: 2026-07-23  
Repository: `C:\Projects\ADMIN-Backend`  
Scope: backend Sections 25, 25.1, 26, 26.1, 26.2, 27, 27.1, 27.2, 27.3, 28, 28.1 and 28.2 only

## 1–4. Starting evidence and worktree preservation

1. Initial branch: `staging`.
2. Initial commit: `c5680ca12beb271dfcbcdd13bfe729bcd7cdd2ce`.
3. Initial Git status: dirty, with existing modified and untracked work from Advertising Execution Sections 6–24 and related generated/configuration files; nothing was staged.
4. Existing work was preserved. No reset, checkout, clean, broad rewrite or deletion was performed. In particular, the prior `20260728`, `20260729` and `20260730` Advertising Execution migrations and the Sections 6–24 implementation were not removed or rewritten.

## 5–6. Task-scoped file inventory

Created for Sections 25–28:

- `prisma/manual-migrations/20260731_advertising_execution_sections25_28.sql`
- `src/modules/marketing/advertising-execution/adapters/provider-error-normalizer.js`
- `src/modules/marketing/advertising-execution/execution.authorization.js`
- `src/modules/marketing/advertising-execution/execution.health.js`
- `src/modules/marketing/advertising-execution/execution.query-validator.js`
- `src/modules/marketing/advertising-execution/security/execution-input-sanitizer.js`
- `src/modules/marketing/advertising-execution/__tests__/sections25-28.api-security-observability.test.js`
- `tests/advertising-execution-sections25-28-postgres.test.js`
- `docs/advertising-execution-architecture.md`
- `docs/advertising-execution-api-handoff.md`
- `docs/advertising-execution-operations-runbook.md`
- `docs/advertising-execution-live-validation-matrix.md`
- `docs/advertising-execution-error-codes.md`
- `docs/advertising-execution-rbac-matrix.md`
- `docs/advertising-execution-audit-events.md`
- `docs/advertising-execution-metrics-health.md`
- `docs/advertising-execution-migration-map.md`
- `docs/advertising-execution-provider-access-blockers.md`
- this report

Task-scoped modifications include `prisma/schema.prisma`, the generated Admin Prisma client, the manual-migration manifest, `package.json`, the Admin database preparation/assertion scripts, execution routes/controller/service/errors/response/observability/audit/events, policy and plan repositories/services, approval-integrity logic, and creative publication list support. Three pre-existing Social Operations assertions were updated only to recognize the legitimate `SUBMITTED` execution state and 25th approved migration.

## 7–13. Mounting, endpoints, schemas, responses, pagination and RBAC

The router is mounted once at `/api/v1/marketing/advertising-execution`. One router-level bearer authentication middleware protects all routes. Every endpoint uses existing Marketing section authorization, strict normalized validation and the existing `{ success, message, data }` envelope. The Section 25 route test proves every required route occurs exactly once.

Complete new inventory (25 Section 25 business endpoints plus Section 27 health):

| Method/path | Access | Core request contract |
|---|---|---|
| `GET /capabilities` | VIEW | optional provider; connection/account must be paired |
| `GET /policies` | VIEW | provider, connection, currency, effective, bounded page |
| `PATCH /policies` | EDIT + EXECUTION_ADMIN | id, expectedVersion, typed value, enabled, reason |
| `POST /plans` | EDIT + AUTHOR | provider, connection, account, currency, normalized draft/items |
| `GET /plans` | VIEW | bounded state/scope/source/date/search/sort filters |
| `GET /plans/:id` | VIEW | UUID |
| `PATCH /plans/:id` | EDIT + AUTHOR | expectedVersion and allowlisted editable fields |
| `DELETE /plans/:id` | EDIT + AUTHOR | expectedVersion and reason; DRAFT cancellation only |
| `POST /plans/:id/validate` | EDIT + AUTHOR | expectedVersion |
| `POST /plans/:id/submit` | EDIT + AUTHOR | expectedVersion and exact fingerprint |
| `POST /plans/:id/approve` | EDIT + APPROVER | version, fingerprint, optional comment/acknowledgments |
| `POST /plans/:id/reject` | EDIT + APPROVER | version, fingerprint and reason |
| `POST /plans/:id/revoke-approval` | EDIT + APPROVER | version, fingerprint and reason |
| `POST /plans/:id/queue` | EDIT + AUTHOR | version, fingerprint, optional MANUAL/SCHEDULED trigger |
| `POST /plans/:id/cancel` | EDIT + AUTHOR | version and reason |
| `POST /plans/:id/create-compensation` | EDIT + AUTHOR | original links, reason and normalized state evidence |
| `GET /runs` | VIEW | bounded plan/scope/status/date/sort filters |
| `GET /runs/:id` | VIEW | UUID |
| `GET /operations/:id` | VIEW | UUID; attempts bounded to 25, snapshots to 20, reconciliation/retry evidence to 25 |
| `POST /operations/:id/retry` | EDIT + EXECUTION_ADMIN | review reason; no provider call |
| `GET /drift` | VIEW | bounded scope/classification/acknowledgment filters |
| `POST /drift/:id/acknowledge` | EDIT + EXECUTION_ADMIN | reason; does not resolve drift |
| `POST /recommendations/:id/create-plan` | EDIT + AUTHOR | accepted recommendation id; DRAFT only |
| `POST /creatives/:id/publications` | EDIT + AUTHOR | one multipart media item plus strict normalized payload |
| `GET /creatives/:id/publications` | VIEW | bounded scope/format/review/reuse filters |
| `GET /health` | VIEW | authenticated, no body |

Fine roles reuse `AdminSectionGrant` sections `advertising-execution:author`, `:approver`, `:execution-admin`, `:emergency-operator`, or `advertising-execution:*`; `SUPER` remains the explicit platform bypass. High-risk role checks exist both in middleware and service code. Emergency policy changes additionally require EMERGENCY_OPERATOR. The author cannot be the sole approver, required tier/count are enforced, and revocation is limited to the actor's current approval.

Request validation uses allowlists for query/body/path data; UUIDs, positive versions, 64-character fingerprints, dates, booleans, enums, Decimal strings, sorting and ranges are normalized. Lists use page/limit pagination with a maximum page size of 100 and deterministic secondary ordering. Response mappers expose safe summaries, current plus historical evidence where appropriate, and never return token material, credential envelopes, native provider bodies, signed URLs, internal paths, stack traces, lease owners or idempotency internals.

## 14–31. Production API behavior

14. Policy GET returns bounded, scope-filtered, safe policy summaries and effective flags without credential/network configuration.
15. Policy PATCH is optimistic on `expectedVersion`, writes the current version and immutable history atomically, records changed paths/reason, maps stale writes to `EXECUTION_PLAN_CONFLICT`, and cannot override a false environment master gate.
16. Plan creation accepts normalized provider-neutral fields, verifies account scope, persists atomically, defaults to DRAFT and audits creation.
17. Plan editing is DRAFT-only, allowlisted, atomically increments the version, invalidates stale material and returns stable 409 conflicts. A real PostgreSQL service test verifies stale mapping.
18. Validation runs the ordered validation pipeline, permits read-only provider preflight only, hashes the exact before-state/material, stores an immutable expiring validation packet and issues, and returns bounded warnings/errors.
19. Submission accepts only the exact valid, unexpired plan version/fingerprint packet and freezes approval requirements.
20. Approval validates separation of duties, approver tier/count, current packet and expiry, then appends immutable approval evidence.
21. Rejection requires an exact current packet plus a reason and appends evidence rather than rewriting history.
22. Revocation appends a `REVOKED` event for the actor's own current approval before execution, recalculating plan status without altering the original approval.
23. Queueing rechecks master/provider/connection/worker/dry-run policy, exact plan version/fingerprint/expiry and approval integrity. Durable uniqueness makes repeat submissions idempotent. The endpoint queues only and makes no provider call.
24. Cancellation is state-aware. DRAFT through QUEUED may cancel; only PENDING/CLAIMED jobs can be atomically cancelled. Running work fails with `EXECUTION_PRECONDITION_CHANGED`.
25. Compensation creates a relationally linked DRAFT only; it never approves, queues or executes automatically.
26. Run APIs provide bounded lists and safe detail with plan/job/operation/reconciliation/compensation relationships.
27. Operation detail caps attempts, reconciliation and retry-review evidence and redacts normalized/native secrets.
28. Retry performs human review, blocks UNKNOWN, policy, permission, validation, immutable and changed-precondition cases, and creates a durable idempotent review/job only. It performs no provider call.
29. Drift list supports bounded filters. Acknowledgment appends immutable awareness evidence and never changes the reconciliation classification or resolves the incident.
30. Recommendation conversion uses the existing bridge, requires an accepted recommendation and produces an idempotent DRAFT only.
31. Creative publication creation reuses the complete Section 18 validation/revision service; the API itself performs no direct provider upload. The list API is bounded and uses safe mappers.

## 32–41. Errors, audit and security

Stable public mappings:

| Code | HTTP |
|---|---:|
| `AD_EXECUTION_DISABLED` | 503 |
| `EXECUTION_PLAN_CONFLICT` | 409 |
| `EXECUTION_VALIDATION_FAILED` | 422 |
| `EXECUTION_APPROVAL_REQUIRED` | 409 |
| `EXECUTION_SELF_APPROVAL_FORBIDDEN` | 403 |
| `EXECUTION_BUDGET_POLICY_VIOLATION` | 422 |
| `EXECUTION_CAPABILITY_UNAVAILABLE` | 409 |
| `EXECUTION_PRECONDITION_CHANGED` | 409 |
| `EXECUTION_PROVIDER_RATE_LIMITED` | 429 |
| `EXECUTION_PROVIDER_PERMISSION_ERROR` | 403 |
| `EXECUTION_OUTCOME_UNKNOWN` | 502 |
| `EXECUTION_RECONCILIATION_DRIFT` | 409 |

The provider-neutral normalizer classifies bounded rate-limit/retry-after, permission, validation, precondition, unknown-outcome and drift evidence. It deliberately does not map every provider 5xx to UNKNOWN and never exposes native bodies.

Audit actions added/completed are `EXECUTION_PLAN_CREATED`, `EXECUTION_PLAN_UPDATED`, `EXECUTION_PLAN_VALIDATED`, `EXECUTION_PLAN_SUBMITTED`, `EXECUTION_APPROVED`, `EXECUTION_REJECTED`, `EXECUTION_REVOKED`, `EXECUTION_STARTED`, `EXECUTION_COMPLETED`, `PROVIDER_OPERATION_ATTEMPTED`, `EXECUTION_DRIFT_DETECTED`, `EXECUTION_DRIFT_ACKNOWLEDGED`, `EXECUTION_COMPENSATION_CREATED`, `EXECUTION_OVERRIDE_USED`, and `EXECUTION_OPERATION_RETRY_REVIEWED`, alongside existing queue/policy/creative/reconciliation actions. Audit DTOs are bounded to identities, hashes, versions, decisions, safe scope, counts and sanitized correlation/provider request references.

Database triggers reject UPDATE/DELETE on approvals/events, policy history, validation packets/issues, snapshots, reconciliations, drift acknowledgments and retry reviews. Foreign keys are restrictive. Corrections therefore require new linked evidence.

The recursive input guard rejects unknown keys, `__proto__`/`prototype`/`constructor`, credential-like keys, raw provider request/response objects, executable URI/content patterns, excessive depth, oversized objects/strings/arrays and unsafe multipart shapes. DTO and response allowlists are separate. Existing SSRF/DNS destination controls and the test network guard remain active. Mutation routes accept JSON, except the single bounded multipart publication route; bearer authentication means no cookie-session CSRF token flow is in use, while content-type enforcement and rate limits protect mutations. Limits are 120 reads, 30 ordinary writes and 10 elevated actions per minute per existing limiter semantics.

Emergency-related policy modification requires EXECUTION_ADMIN and EMERGENCY_OPERATOR in service authorization, a 2FA-enabled actor, explicit reason and bounded future expiry. Configuration is not recorded as `EXECUTION_OVERRIDE_USED`; that event is reserved for actual exercise. Capability, credentials, immutable evidence and non-overridable global safety restrictions remain mandatory.

## 42–44. Structured events, metrics and health

Exact structured names are:

- `marketing_execution.plan_validated`
- `marketing_execution.approval_recorded`
- `marketing_execution.job_claimed`
- `marketing_execution.operation_started`
- `marketing_execution.operation_succeeded`
- `marketing_execution.operation_failed`
- `marketing_execution.operation_unknown`
- `marketing_execution.reconciliation_drift`
- `marketing_execution.compensation_queued`
- `marketing_execution.kill_switch_changed`

Metrics cover plan/validation/submission/cancellation, approval latency/outcomes, queue/lease/heartbeat/contention, operation attempts/results/retries/preconditions/latency, provider reads/writes/rate limits/permissions/capabilities, targeting/review, Decimal-safe budget exposure, reconciliation/incident age and compensation. The only allowed labels are provider, operationType, resourceType, resultCategory, status, bounded apiVersion, workerType and currency; identifiers are rejected.

Authenticated health reports `ready`, `degraded`, `disabled` or `unavailable`; master/dry-run/worker state; queue and reconciliation depth/age; provider/API blockers; schema readiness; and adapter readiness. Disabled-by-configuration is a safe state. Missing schema is unavailable. Recursive redaction removes secrets and operational ownership details.

## 45–50. Schema, migration, mapping and database evidence

Schema additions are four evidence models: `MarketingExecutionPolicyHistory`, `MarketingExecutionValidationPacket`, `MarketingExecutionDriftAcknowledgment` and `MarketingExecutionRetryReview`; relations to users/plans/policies/reconciliations/operations; cancellation enum values; audit actions; and list/filter indexes.

The additive migration is `20260731_advertising_execution_sections25_28.sql`. It creates the four tables, restrictive foreign keys, indexes, enum/audit values and append-only triggers. It stores neither credentials nor raw provider payloads.

Migration map:

| Responsibility | File |
|---|---|
| foundation | `20260728_advertising_execution_sections9_10.sql` |
| approvals/runs/jobs/initial policy and creative models | `20260729_advertising_execution_sections18_24.sql` |
| operations/reconciliation/creative/targeting/lease remediation | `20260730_advertising_execution_sections18_24_remediation.sql` |
| Sections 25–28 evidence, cancellation, immutability and query indexes | `20260731_advertising_execution_sections25_28.sql` |

The original implementation run reported 25 migrations and the pre-remediation 24-table/18-index inventory. The authoritative remediation addendum below supersedes those counts: 26 migrations replay with drift `none`, and runtime assertions pass for 25/25 Advertising Execution tables, 20/20 indexes and 7/7 enums. No staging or production database was touched.

## 51–54. Documentation and handoff

Documentation created covers architecture, complete endpoint/request/RBAC handoff, stable errors, audit events, metrics/health, operations, migration mapping, provider blockers and the live-validation matrix. Every provider is explicitly `NOT_LIVE_VALIDATED`. API versions are environment-supplied and readiness is account-specific/fail-closed; the matrix links the official Google Ads, Meta, TikTok, LinkedIn and X sources checked on 2026-07-23.

## 55–59. Tests and exact verification evidence

New tests:

- 11 Section 25–28 unit/security/observability tests.
- 7 PostgreSQL evidence tests, including policy optimism/history, validation/approval immutability, drift acknowledgment, retry-review idempotency, audit sanitization and the production service lifecycle with zero provider calls.
- Existing regression assertions updated for the new submitted state and 25th migration.

Commands actually run successfully:

| Command | Result | Count/duration where emitted | Tracked-file effect |
|---|---|---|---|
| `npx prisma format --schema prisma/schema.prisma` | exit 0 | format PASS | schema formatting only |
| `npx prisma validate --schema prisma/schema.prisma` | exit 0 | 9.6 s wall | none |
| `npx prisma generate --schema prisma/schema.prisma` | exit 0 | generation PASS | regenerated Admin client |
| `npm run db:manifest:generate` | exit 0 | 25 entries | updated manifest |
| `npm run db:manifest:verify` | exit 0 | 25, all failure counters zero | none |
| `npm run migrations:safety` | exit 0 | 25 files, 0 findings | none |
| `npm run db:replay:verify` | exit 0 | superseded by remediation run below | disposable DB only |
| `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | exit 0 | no difference, 10.9 s | none |
| `npm run db:schema:assert` | exit 0 | 24/24 tables, 18/18 indexes, 7/7 enums | none |
| `npm run test:advertising-execution:sections25-28` | exit 0 | superseded by expanded HTTP/security run below | none |
| `npm run test:advertising-execution:postgres:sections25-28` | exit 0 | superseded by expanded remediation run below | disposable DB only |
| Advertising Execution unit + PostgreSQL command | exit 0 | 198 passed, 0 failed, 49.925 s | disposable DB only |
| Marketing Intelligence regression command | exit 0 | 323 passed, 0 failed, 8.387 s | none |
| `npm run test:social-operations` | exit 0 | 222 passed, 0 failed, 17.809 s | generated untracked test artifacts only |
| `npm test` | exit 0 | 790 passed, 0 failed, 38.620 s final run | none |
| `npm run test:network-guard` | exit 0 | 29 passed, 0 failed, 2.225 s | none |
| `npm run config:validate` | exit 0 | development PASS | none |
| `npm run config:validate:staging` | exit 0 | synthetic staging PASS | none |
| `npm run config:validate:production` | exit 0 | synthetic production PASS | none |
| `npm run security:secret-scan` | exit 0 | 656 files, 0 findings | none |
| `npm run security:audit-policy` | exit 0 | 0 critical/high/moderate failures | none |
| `npm run security:audit-policy:production` | exit 0 | 0 critical/high/moderate failures | none |
| `npm run security:static-social` | exit 0 | 8 checks | none |
| `npm run security:network-guard-static` | exit 0 | 18 checks, 0 prohibited shell-network uses | none |
| `node --check` over task JavaScript | exit 0 | 113 files, 0 failures | none |
| `git diff --check` | exit 0 | 0 whitespace errors | none |

Warnings: one accepted low transitive `body-parser` advisory (`GHSA-V422-HMWV-36X6`) remains under repository policy; there are zero critical, high or moderate findings. Dotenv informational tips, a deliberate “Skipped notification without adminUserId” test warning, and Git LF-to-CRLF notices were non-failures. No test made an external provider request because the runtime network guard was installed.

## 60–71. Completion audit and final safeguards

Required verdicts:

- Section 25 API: **COMPLETE**
- Section 25.1 stable errors: **COMPLETE**
- Section 26 RBAC/audit/security: **COMPLETE**
- Section 27 observability: **COMPLETE**
- Section 28 migration/file map: **COMPLETE**
- Security: **PASS**
- Live-provider safety: **PASS**
- Repository regressions: **PASS**

Final confirmations:

- All required Section 25 routes exist exactly once, are authenticated, validated, authorized, bounded and connected to production services/repositories.
- No controller, queue endpoint, retry endpoint, recommendation bridge, compensation endpoint or creative-publication API directly invokes a provider mutation.
- Existing Advertising Execution migrations were not edited; the remediation is isolated in the later additive `20260801_advertising_execution_sections25_28_remediation.sql` migration.
- Only the Admin Prisma client/configuration was used; `mainPrisma` was not used.
- No live provider request, provider write or media upload occurred.
- Master execution, every provider execution flag, connection writes and workers remain disabled by default.
- Dry-run remains enabled by default.
- Workers remain disabled and import-safe; they do not start on module import.
- Nothing was deployed, staged, committed, pushed or merged.
- Final Git state remains intentionally dirty and unstaged because it contains the preserved Sections 6–24 work plus this completed Sections 25–28 implementation. `git diff --check` passes.

Work stops at Section 28.

## 2026-07-23 production-integrity remediation addendum

This addendum is the authoritative final strict re-audit for the remaining Sections 25–28 findings. It preserves the earlier report as historical evidence while superseding its pre-remediation migration, schema and test counts.

| # | Required report item | Final evidence |
|---:|---|---|
| 1 | Initial branch | `staging`. |
| 2 | Initial commit | `c5680ca12beb271dfcbcdd13bfe729bcd7cdd2ce` (`chore(prisma): apply canonical schema formatting`). |
| 3 | Initial Git status | Dirty and unstaged; no cached/staged paths. A deterministic 144-file initial evidence set was recorded. |
| 4 | Existing work preserved | Existing Sections 6–28 tracked/untracked work and unrelated changes were not reset, cleaned, restored, stashed, rebased or deleted. |
| 5 | Files created | New remediation migration, request-context middleware, schema assertion, emergency-override/retry services, HTTP/PostgreSQL/remediation tests and Advertising Execution documentation. |
| 6 | Files modified | Admin schema/client and guarded migration scripts; Advertising Execution application/services/repositories/adapters/routes/responses/tests; shared app/error lifecycle; package/config and exact migration-inventory tests. |
| 7 | Atomic queue design | One serializable command holds an advisory transaction lock and reloads the authoritative plan/packet/policy evidence. |
| 8 | Queue transaction boundaries | Run, operations, snapshots, compensation link, one active job, plan/run state and audit row commit or roll back together. |
| 9 | Queue idempotency | Canonical SHA-256 submission identity, database uniqueness, upserts and transaction serialization return the same plan/run/job for duplicates. |
| 10 | Queue rollback tests | Injected failure after job creation leaves no run/job/operation/audit and preserves APPROVED; a later valid request succeeds. |
| 11 | Retry eligibility rules | Current failure/outcome, provider processing, dependencies, capability, policy, gates, packet, approvals, expiry, fingerprint and BEFORE/read-back state are revalidated. Stored `safeToRetry` is not authoritative. |
| 12 | Retry RBAC policy | Option B: every retry requires authenticated `EXECUTION_ADMIN`; AUTHOR/APPROVER alone cannot schedule. |
| 13 | Retry transaction | Review, decision, action job, operation/run state, job link and audit commit in one serializable transaction. |
| 14 | Retry foreign key | `action_job_id` has a restrictive FK to `marketing_execution_jobs` plus an index. |
| 15 | Claimed cancellation design | API writes a durable request/checkpoint and does not clear the lease or claim final cancellation. |
| 16 | Cancellation worker behavior | Exact lease owner observes the request after account lock and before mutation, persists the outcome and releases its own lease; RUNNING is rejected to compensation. |
| 17 | Compensation lineage validation | Server loads and matches original plan/run/operation/item/reconciliation/snapshots, provider, connection, account, currency and resource. |
| 18 | Compensation relational evidence | Restrictive relational links retain original plan/run/operation/reconciliation and compensation plan; duplicate active exact scope is idempotent. |
| 19 | Policy history semantics | Initial and update rows store previous/new versions, values, enabled states, actor, reason, time, correlation, effective scope and behavior change. |
| 20 | Policy key validation | A strict registry applies per-key boolean, Decimal cap, count/tier, freshness, domain and malware-value validation; unknown keys fail closed. |
| 21 | Effective policy precedence | Connection overrides platform overrides global only where allowed; false/missing global execution gates remain absolute. |
| 22 | Audit events added | Plan lifecycle, queue, execution start/completion, provider attempt/result phase, drift, compensation, retry review, cancellation, kill switch and actual override use have production call sites. |
| 23 | Exact queue audit action | New submissions emit canonical `EXECUTION_QUEUED`; the historical alias remains readable only. |
| 24 | Central audit append-only enforcement | PostgreSQL trigger rejects UPDATE and DELETE on `admin_audit_logs`; disposable tests prove INSERT works and mutations fail. |
| 25 | Provider network policy wiring | Production read/write adapter paths receive exact host policy, guarded DNS lookup, public-IP validation, HTTPS/443-only, timeouts, proxy-off and response bounds. |
| 26 | Redirect controls | Provider transport uses `maxRedirects: 0`; the separately bounded destination reader revalidates each redirect destination. |
| 27 | Multipart limit changes | Global creative upload is reduced to 32 MiB with one file and bounded fields/parts/headers; provider-specific media validation remains stricter where applicable. |
| 28 | Provider error normalization wiring | Production read registry, retry read-back, operation runner and write adapter factory use the shared neutralizer. |
| 29 | Stable-error call sites | Capability, permission, validation, precondition, rate limit, unknown and drift conditions map to the registered HTTP contract. |
| 30 | Retry-After handling | Delta/date forms are parsed without raw bodies, capped at one hour and returned by shared middleware only when valid. |
| 31 | Correlation ID handling | Shared middleware accepts only safe bounded `X-Request-ID` values or generates UUIDs; responses, errors, audits and events receive the ID. |
| 32 | Structured-event call sites | Validation/approval, worker, operation runner, reconciliation, compensation and kill-switch paths emit the ten exact `marketing_execution.*` names through the shared adapter. |
| 33 | Metrics production updates | Queue, validation, approvals, cancellation, operation attempts/outcomes/latency, provider reads/writes/rate limits, reconciliation, compensation and kill-switch paths update metrics. |
| 34 | Metric label safety | Only provider, operation/resource/result/status, API version, worker type and currency are accepted; IDs, URLs and reasons are rejected. |
| 35 | Run response bounds | Lists and detail cap jobs, operations, attempts, snapshots, reconciliation/retry/compensation evidence and expose total counts separately. |
| 36 | Operation response bounds | Detail caps attempts at 25, snapshots at 20 and reconciliation/retry evidence at 25 with allowlisted mapping. |
| 37 | Filter implementation/removal | Accepted plan/run/creative filters map to Prisma predicates with deterministic sorts/date checks; contextual capability filters must be complete; unsupported policy account/currency filters are rejected. |
| 38 | Health full schema assertion | Cached bounded introspection verifies 25 required tables, 20 indexes and 7 enums and fails readiness closed. |
| 39 | Account-specific readiness | Optional provider/connection context returns sanitized connection/capability/gate/freshness/failure-category evidence without globalizing one account. |
| 40 | Adapter readiness | Health checks required audit/metrics/notification/realtime methods and bounded failure state, not mere object presence. |
| 41 | Emergency override model | Durable exact provider/connection/account/plan/run/operation scope, allowed/non-overridable controls, reason, actor/approver, MFA reference, window/status and usage count. |
| 42 | Override bounds | ACTIVE SUPER account with current 2FA; exact plan scope; `CONNECTION_WRITE_GATE` only; maximum two hours; no wildcard/permanent override. |
| 43 | Override actual-use audit | `EXECUTION_OVERRIDE_USED` is written inside the successful new queue transaction only when the override is consumed. |
| 44 | Notification changes | Existing Admin notification infrastructure receives bounded plan/approval/retry/unknown/drift/dead-letter/cancellation/compensation/kill-switch/override events. |
| 45 | Schema changes | Cancellation request/evidence fields, retry action-job relation, complete policy history fields and emergency override model; `EXECUTION_QUEUED` enum action. |
| 46 | New migration | `20260801_advertising_execution_sections25_28_remediation.sql`; additive, deterministic, restrictive and no DROP/TRUNCATE/destructive rename/unsafe CASCADE. |
| 47 | Manifest result | 26 migrations; zero checksum, missing, extra or duplicate failures. |
| 48 | Replay result | Empty PostgreSQL 18.4 replay applies 26 migrations; `drift=none`. |
| 49 | Drift result | Replay verifier reports no schema drift. |
| 50 | Local Admin migration application | Guard proved `localhost:5432/cosmicforge_admin`, schema `public`; remediation applied once, final idempotency run reports applied 0/skipped 13. Existing Admin counts were preserved. |
| 51 | Runtime schema assertion | `advertising_execution_tables=25/25 indexes=20/20 enums=7/7`. |
| 52 | HTTP/RBAC tests | 47/47; real mounted Express router covers 27 primary endpoints, unauthenticated denial and VIEW/EDIT/AUTHOR/APPROVER/EXECUTION_ADMIN/EMERGENCY_OPERATOR/SUPER matrix. |
| 53 | PostgreSQL tests | 10/10 on disposable replay database; no provider transport. |
| 54 | Queue concurrency tests | Three simultaneous calls produce exactly one run/job/operation and one authoritative created response. |
| 55 | Retry concurrency tests | Durable idempotency returns the same review/action job; unique/FK constraints prevent duplicate or orphan evidence. |
| 56 | Cancellation ownership tests | API preserves claimed lease; wrong owner cannot observe/release; exact owner cancels before provider mutation. |
| 57 | Compensation lineage tests | Server-owned lineage/snapshot validation and DRAFT-only creation are covered by service/PostgreSQL paths; caller evidence fields are rejected. |
| 58 | Audit append-only tests | Policy/approval/validation/drift/retry evidence and central audit UPDATE/DELETE rejection pass on PostgreSQL. |
| 59 | Network tests | Provider policy/redirect/header/DNS/size unit coverage passes; global network guard passes 29/29 and blocks provider/Cloudinary/external hosts. |
| 60 | Error normalization tests | Stable category/code, no raw body, known/unknown processing and bounded retry metadata pass. |
| 61 | Observability tests | Exact event aliases, production emitters, metrics, correlation, sanitization and existing notifications pass. |
| 62 | Health tests | Full inventory, disabled/degraded evidence, adapter functionality, account context and forbidden-key removal pass. |
| 63 | Full Advertising Execution count | 194/194 unit/domain tests pass; Sections 25–28 focused HTTP/security is additionally 47/47. |
| 64 | Marketing Intelligence regression | 319/319 pass. |
| 65 | Social Operations regression | 222/222 pass after its exact manifest inventory was advanced to 26. |
| 66 | Full repository count | 829/829 pass under the network guard. |
| 67 | Secret scan | 664 files scanned; zero findings. |
| 68 | Network guard | 29/29 runtime tests and 18 static checks pass; no prohibited shell network use. |
| 69 | Dependency audit | Zero critical/high/moderate policy failures; one documented residual low transitive advisory `GHSA-V422-HMWV-36X6` is allowed by repository policy. |
| 70 | Final strict audit verdict | No BLOCKER/HIGH/MEDIUM/LOW remediation finding remains: Sections 25–28 **COMPLETE**. |
| 71 | Previous migration integrity | `20260728`–`20260731` were present as untracked initial work and remain present; they were not edited by this remediation. Only `20260801` carries remediation DDL. |
| 72 | Admin Prisma only | Advertising Execution contains no `mainPrisma`/`prisma.main` production use; generated Admin client and `cosmicforge_admin` were used. |
| 73 | No live provider request | Confirmed; tests ran behind the network guard and all provider states remain `NOT_LIVE_VALIDATED`. |
| 74 | No provider mutation | Confirmed; no live provider write occurred. |
| 75 | No media upload | Confirmed; no live media upload occurred. |
| 76 | Disabled flags | Master, worker, Google, Meta, TikTok, LinkedIn and X flags remain `false`; per-connection write defaults false. |
| 77 | Dry-run | `MARKETING_AD_EXECUTION_DRY_RUN=true`. |
| 78 | Worker import safety | Full tests prove module import starts no execution worker, listener, socket or timer; worker flag remains false. |
| 79 | No publication/deployment actions | Nothing staged, committed, pushed, merged or deployed. No staging/production migration was applied. |
| 80 | Final Git status | Intentionally dirty and unstaged: 27 modified tracked paths, 139 untracked files (25 top-level status entries), zero staged paths; preserved earlier work plus this remediation. |

### Final command ledger

All commands exited 0 unless an explicitly described inventory mismatch was corrected and rerun. Commands that generate the Admin client/manifest intentionally update those tracked generated artifacts; test artifacts are under `artifacts/` and excluded from the deterministic digest. Warnings were limited to Git LF/CRLF notices, one `pg` future-deprecation notice during concurrent test queries, dotenv tips and the documented dependency advisory.

The final read-only audit used the same deterministic rule on both sides: modified/untracked files, excluding `artifacts/`, `coverage/`, `*.log`, `*.tap`, `*.tmp` and the generated Admin client. It covered 152 files; the before/after SHA-256 digest was identical (`2bc406d8789bd72e0c53f641cf96cbbd71ab806d5033ec5c442f1d994b9a037d`) during the final syntax/whitespace audit. The initial 144-file digest is not compared byte-for-byte with the completed implementation because the remediation intentionally added and modified files.

| Command | Result | Duration |
|---|---|---:|
| `npx prisma format --schema prisma/schema.prisma` | formatted | 8.8 s |
| `npx prisma validate --schema prisma/schema.prisma` | valid | 5.1 s |
| `npx prisma generate --schema prisma/schema.prisma` | Admin client generated, Prisma 7.9.0 | 5.5 s |
| `npm run db:manifest:generate` / `npm run db:manifest:verify` | 26, clean | 2.5 s / 1.9 s |
| `npm run migrations:safety` | 26 files, 0 findings | 1.3 s |
| `npm run db:replay:verify` | 26 migrations, drift none | 18.5 s |
| `npm run db:schema:assert` | 25/25, 20/20, 7/7 | 2.7 s |
| `npm run test:advertising-execution:sections25-28` | 47/47 | 5.5 s final test time |
| `npm run test:advertising-execution:postgres:sections25-28` | 10/10 | 23.6 s test time |
| `node --require ./tests/helpers/network-guard.js --test src/modules/marketing/advertising-execution/__tests__/*.test.js` | 194/194 | 8.7 s final test time |
| `node --require ./tests/helpers/network-guard.js --test src/modules/marketing/intelligence/__tests__/*.test.js` | 319/319 | 13.7 s test time |
| `npm run test:social-operations` | 222/222 | 18.7 s test time |
| `npm test` | 829/829 | 48.8 s final test time |
| `npm run test:network-guard` | 29/29 | 1.1 s test time |
| `npm run security:network-guard-static` | 18 checks, clean | 3.8 s wall |
| `npm run security:secret-scan` | 664 files, 0 findings | 4.8 s wall |
| `npm run config:validate` | disabled defaults confirmed | 3.8 s wall |
| `npm run security:audit-policy` | policy pass | 6.5 s wall |
| changed JavaScript `node --check` | 134 files, 0 failures | 19.6 s wall |
| `git diff --check` | pass; LF/CRLF notices only | 4.1 s wall |

Final verdicts: Section 25 API **COMPLETE**; Section 25.1 stable errors **COMPLETE**; Section 26 RBAC **COMPLETE**; Section 26.1 audit **COMPLETE**; Section 26.2 security/privacy **COMPLETE**; Section 27.1 structured events **COMPLETE**; Section 27.2 metrics **COMPLETE**; Section 27.3 health **COMPLETE**; Section 28.1 migration **COMPLETE**; Section 28.2 file map **COMPLETE**; documentation **COMPLETE**; PostgreSQL integration **COMPLETE**; security **PASS**; live-provider safety **PASS**; repository regressions **PASS**; overall Sections 25–28 **COMPLETE**.
