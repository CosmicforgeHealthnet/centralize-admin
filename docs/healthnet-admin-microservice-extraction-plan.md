# HealthNet Admin — First Product Admin Microservice Extraction
Date: 2026-10-24
Status: IMPLEMENTATION PLAN ONLY; NO NEW SERVICE DEPLOYED
Target branch: staging. Production and main remain unchanged.

## Authority and intended data flow

Future operating model:

    Central Admin HQ (admin auth, HQ RBAC, staff and cross-product orchestration)
      -> signed, scoped internal HealthNet Admin API
        -> HealthNet platform-owned API / approved HealthNet DEV read models
          -> HealthNet platform's database

The existing Admin API is the *current* owner of the legacy HealthNet admin handlers only as an implementation detail. This is not a transfer of ownership over clinical, billing, identity or medical data. HealthNet platform remains authoritative for domain operations. In the target model, HQ must not hold HealthNet database credentials. No direct HQ-to-product database path may remain once cutover is certified.

A HealthNet Admin microservice cannot restore visibility while the upstream HealthNet VPS/database is offline. Its value is a stable authority boundary and isolated failure domain. It must return dependency-unavailable when the source is down, not fabricate records.

## Actual staging inventory (verified 2026-10-24)

- services/healthnet-admin/: reserved README only; there is no runnable microservice yet.
- services/central-admin-api/src/modules/healthnet/: current service/controller/routes, about 5,166 lines in healthnet.service.js and **45 GET routes**, serving /api/healthnet.
- services/central-admin-api/src/modules/dashboard/: 3 GET routes for overview, revenue-chart and platform-usage. Dashboard implementation directly imports mainPrisma (26 call sites).
- services/central-admin-api/src/modules/users/: direct mainPrisma access (40 call sites).
- services/central-admin-api/src/modules/telemedicine/: direct mainPrisma access (10 call sites); consultation mutation/events require dedicated owner-contract design.
- services/central-admin-api/src/modules/appointments/: uses a separate mainApi HTTP client; inspect its upstream authority before moving it.
- services/central-admin-api/src/shared/config/mainDatabase.js: Prisma access to product database; legacy path.
- apps/central-admin-web/src/lib/healthnet.service.ts and healthnet.store.ts: existing frontend HealthNet API integration.
- packages/admin-contracts/, packages/service-clients/, packages/identity-and-permissions/: currently only reserved READMEs, not executable libraries.

**Important:** inventory includes obvious references, not a complete transitive dependency graph. A cross-repo API and database ownership audit is mandatory before extraction. Do not copy only healthnet.service.js and assume isolation is complete.

## Implementation stages and acceptance gates

### H0 — Inventory, contracts and authority classification (required first)

1. Enumerate all current endpoints, methods, query and path params, HTTP statuses, pagination, CSV exports, response shapes, RBAC policy and frontend consumers for /api/healthnet, /api/dashboard, /api/users, /api/telemedicine and related appointments/verification flows.
2. Walk all imports, SQL/Prisma models, environment variables, event emitters, provider connections, medical records/PII, document-storage URLs, caching, analytics and message queues. Label each function as HealthNet platform-owned, HealthNet Admin-owned, HQ-owned or third-party.
3. For each read/write operation, define the *authoritative* source and a versioned internal contract. Non-read operations must remain in their authoritative service; never direct-mutate product tables from HQ.
4. Produce parity fixtures with sanitized, deterministic sample responses, RBAC/field-redaction rules, pagination/error/CSV behavior, and golden comparisons against the existing API. Record the 45 HealthNet routes individually.
5. Confirm the HealthNet product's own APIs and data visibility contract. If an owner API is missing, block that endpoint from cutover rather than using unauthorized cross-database access.

Gate: signed endpoint/field-by-field contract matrix, service authority map and no unresolved critical privacy/ownership questions.

### H1 — Independent runnable HealthNet Admin service (no traffic cutover)

Implement in services/healthnet-admin/ as its own runtime (not a duplicate of central-admin-api):
- Independent package/lockfile, startup, config validation, health/live and health/ready endpoints, Dockerfile, staging Compose service and CI.
- HealthNet Admin service has an independently scoped **service identity**, environment/secrets and deployment lifecycle. It does not reuse HQ session-signing keys or a copied HQ admin-user database.
- Use validated JWT audience/issuer or mTLS service authentication, expiring credentials, trusted proxy boundary and strict per-operation scopes. Validate HQ forwarded user identity and permissions at HealthNet Admin, not merely at HQ.
- Independent Prisma/read-model access only where explicitly approved by HealthNet platform owner. Prefer authenticated, versioned HealthNet domain APIs for authoritative data; any legacy read-only direct database connection is temporary, private and logged in the migration register.
- No public Mongo/Postgres exposure; no access from the internet to privileged internal endpoints; no logging of tokens/PII/medical records.
- Preserve current domain operations' side effects, idempotency, audit, version numbers and rate limits. Mutations are opt-in behind owner-approved commands and never silently retried.

Gate: service builds, offline tests and security tests pass, with no HQ or frontend consumer changed. Degraded readiness when HealthNet upstream is offline must not crash HQ.

### H2 — Internal gateway and contract compatibility

1. Implement a reusable, typed internal service client in packages/service-clients with timeouts, bounded safe retries, circuit-breaker/fallback status, request IDs, field allowlists and service-specific auth. No raw DB URL.
2. Publish versioned admin-contracts for HealthNet: data/error envelopes, 503 DEPENDENCY_UNAVAILABLE, health statuses and Retry-After. Include privacy labels (clinical/admin/aggregate).
3. Central Admin keeps public /api/healthnet/... URLs for backwards compatibility but delegates to the new internal HealthNet Admin API. Web frontend retains its existing API base origin.
4. Keep central RBAC + downstream per-action authorization; no privileged implicit admin-to-admin full access. Fail closed for consent, medical record access, payments, verification and mutation.
5. Map 404/401/403/422/429/500/502/503/504 distinctly; do not turn application defects into dependence outages.

Gate: consumer contract tests, service identity permissions, error mapping, redaction, pagination and CSV binary parity.

### H3 — Read-only shadow validation (must use authorized staging sources)

1. Deploy HealthNet Admin *staging only* without redirecting HQ traffic.
2. Dual-read selected low-sensitivity endpoints **only with explicit owner approval** and compare shape, types, counts and data lineage. Do not dual-write, trigger domain side effects or copy raw medical data into logs.
3. Exercise DB-offline and restoration scenarios; assert unaffected HQ routes work and unavailable HealthNet cards report unavailable rather than zero.
4. Compare detailed HealthNet route response shapes (all 45 GET routes) and dashboard cards, charts, metrics, exports, RBAC and privacy behavior; record evidence and exceptions.

Gate: parity proven and owner approvals for every migrated route. Block critical-data migration if HealthNet VPS is down and live parity cannot be established.

### H4 — Controlled cutover and retirement of HQ direct DB access

1. Roll out via per-endpoint feature flag/routing, beginning with read-only aggregate widgets, then listings, then sensitive views; keep rollbacks.
2. Route HQ -> HealthNet Admin -> owner API/read-model. Monitor dependency health, latency, 4xx/5xx, access denials, audits, missing fields, dashboards, export parity and tenant/product isolation.
3. Only after all direct mainPrisma HealthNet reads are migrated and certified, remove MAIN_DATABASE_URL_DEV / MAIN_DATABASE_URL_PROD from HQ runtime and its product Prisma permissions. Do not remove or change the product's DB.
4. Finalize independent deploy pipelines and runbooks. Production cutover requires explicit approval after staging certification and rollback rehearsal.

Gate: full matrix green, no direct HQ-to-HealthNet database connections, clean secrets, security sign-off, positive rollback exercise.

## Failure-isolation acceptance matrix (applies during extraction and after)

- HealthNet source down: HQ login, HR, marketing, staffing, support and healthy services remain accessible; dependent widgets show available/unavailable states accurately.
- Mixed results: successful widgets continue rendering, with no Promise.all fail-all semantics. Missing HealthNet is never counted as zero in HQ-wide revenue or user totals.
- True empty data: clear empty response is shown only after a successful authoritative read.
- Slow source: bounded service-to-service timeout; 503 with safe dependency ID, correlation ID, bounded Retry-After; avoid retry storms and stale masquerading as live.
- Recovered source: automatic bounded retry and manual retry rehydrate real data; no restart or repeated login.
- Permission denied: 401/403 remains 401/403, never converted to 503.
- Data mutation while source down: no approval, payment, identity/doctor verification or other authoritative write is represented as successful.
- HQ + HealthNet Admin pipelines: isolated build/deploy targets. Vercel manages HQ frontend deployments natively; no new frontend deployment GitHub job.
- No schema edits, DB transfers, production flags or prod connection experiments without owner approval.

## Implementation order / risk controls

Resilience fixes are introduced first, independently of extraction, so the current HealthNet outage remains visible but non-destructive. The new healthnet-admin runtime is **not created or deployed by this plan**. The present PR should not be described as completion of H0–H4 until separately implemented, tested and signed off. A mixed legacy/new architecture remains intentional during migration.

## Immediate follow-up

1. Complete H0 endpoint/field and transitive dependency inventory against active source repositories.
2. Secure approval for HealthNet owner API/read-model authority and service credential design.
3. Implement H1 isolated runtime in a separate reviewed PR, without migrating any live traffic.
4. Verify both outage and success scenarios against the restored HealthNet development VPS before H3/H4.
