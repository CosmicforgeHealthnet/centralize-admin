# Advertising Execution Phase 3 — Sections 18–24

Audit date: 2026-07-22

Verdict: COMPLETE for Sections 18 through 24. Provider writes remain disabled by default, dry-run remains enabled, no production credentials were used, and no automated test contacted a live advertising provider.

## Section 18 — Creative and ad management

- One production creative-publication flow performs authentication/authorization, source-asset and provider-account scoping, strict DTO validation, destination normalization plus DNS/SSRF checks, media signature and metadata extraction, checksum deduplication, malware policy, explicit material hashing, reuse classification, advisory-lock revision allocation, immutable evidence/audit persistence, and allowlisted response mapping.
- Publication revisions are append-only. Exact account-scoped material is reused; changed material receives the next serialized revision.
- Review synchronization is read-only, version-aware, append-only, and preserves `PENDING_REVIEW`, `APPROVED`, `REJECTED`, `LIMITED`, and `UNKNOWN`. Activation requires `APPROVED`.
- Public responses exclude storage paths, signed URLs, provider bodies, tokens, lease ownership, and idempotency internals.

## Section 19 — Targeting, delivery, and scheduling

- Provider/account/version-scoped discovery persists normalized and native identifiers with TTL, content hash, availability, and last-validation evidence.
- Strict targeting covers location type/radius/coordinates, languages, keyword match and negative scope, placement mode/device, duplicates, include/exclude conflicts, and server-owned regulated/sensitive-category denial.
- Delivery validation enforces provider bidding/optimization/billing compatibility and explicit timezone conversion. Europe and US ambiguous/nonexistent DST instants are tested.

## Section 20 — Recommendation bridge

- Only an authenticated conversion of an `ACCEPTED` recommendation creates a `DRAFT` plan.
- Evidence, suggested action, reasoning, and confidence are non-authoritative context. They never enqueue, execute, activate, raise a budget, or lower approval requirements.
- A partial unique index permits historical terminal plans while guaranteeing one active draft/execution lineage per recommendation. Concurrent conversion is idempotent.

## Section 21 — Durable jobs and leases

- Submission identity is durable and unique. Claim SQL qualifies the exact plan version, fingerprint, expiry, approvals, provider, connection, and account before `FOR UPDATE OF job SKIP LOCKED`.
- A partial unique index serializes only the same provider/connection/account; different accounts can progress concurrently.
- Owner-qualified lease transitions, heartbeats, account locks, recovery classification, reconciliation routing, dead-letter review, lifecycle start/stop, and graceful shutdown are implemented.
- Provider I/O occurs after the claim transaction has committed.

## Section 22 — Idempotency and retry safety

- Canonical typed v2 identities bind provider, connection, account, approved plan/version, item, operation/resource types, and material hash without delimiter ambiguity.
- Attempts persist before provider calls. Results persist after normalized responses.
- Changed before-state blocks mutation. UNKNOWN and provider-success/local-persistence-failure outcomes route to reconciliation and are never blindly retried.
- Retry policy distinguishes rate limit/transient-not-started work from policy, permission, validation, stale precondition, partial-success, exhausted, and unknown outcomes.

## Section 23 — Final safety controls

- The ordered seven-layer pipeline is transport, domain, capability, business policy, provider preflight, approval integrity, and execution precondition.
- The final mutation gate rechecks master, dry-run, worker, provider, connection, approval packet, plan version, policy, capability, currency, budget, schedule, creative review, targeting, before-state, account lock, job lease, and idempotency identity immediately before a write adapter call.
- All execution/provider/worker defaults are false; dry-run defaults true. Missing versions, clients, credentials, permissions, policies, or readback capability fail closed.

## Section 24 — Reconciliation, compensation, audit, and observability

- A separate durable reconciliation queue has lease ownership, heartbeat/reschedule/escalation semantics and read-only provider adapters.
- Normalized comparison persists current/previous hashes and classifies `VERIFIED`, `DRIFTED`, `UNKNOWN`, and `EXTERNAL_CHANGE`, updating operation/run/plan aggregates transactionally.
- Compensation is a relationally linked human-authored `DRAFT`; it cannot auto-approve or auto-queue. Safe-state verification closes the compensation evidence without rewriting the original outcome.
- Audit enum values and event payloads match the Admin audit adapter. Notification/realtime payloads are bounded and secret-safe.
- Metrics cover creative/media/malware/review, targeting cache/discovery, validation and qualification, queues/claims/leases/heartbeats, unknown/local-persistence recovery, reconciliation, compensation, and kill-switch activity.

## Database evidence

- New additive remediation: `prisma/manual-migrations/20260730_advertising_execution_sections18_24_remediation.sql`.
- Earlier migrations `20260728_advertising_execution_sections9_10.sql` and `20260729_advertising_execution_sections18_24.sql` were not edited.
- Manifest: 24 ordered migrations; checksum, missing, extra, and duplicate counts are zero.
- Empty replay: PostgreSQL 18.4, 24 migrations, drift `none`.
- Local target guard: `localhost:5432/cosmicforge_admin`, schema `public`.
- Approved local preparer is idempotent: 11 approved entries skipped on the verification rerun.
- Runtime assertion: Advertising Execution tables 20/20, required indexes 12/12, asserted enums 7/7.
- No database reset, database drop, table drop, truncation, staging application, production application, or main-Prisma configuration was used.

## Verification evidence

- Prisma format, validate, and Admin client generation: PASS (Prisma 7.9.0).
- Manifest verify and migration safety: PASS (24 files, zero findings).
- Advertising Execution focused tests: 175 passed, 0 failed.
- Disposable PostgreSQL integration tests: 5 passed, 0 failed. These cover real revision locking/deduplication, review persistence, targeting expiry, `SKIP LOCKED`, account serialization, approval qualification, and reconciliation aggregates with fake providers.
- Marketing Intelligence regression: 319 passed, 0 failed.
- Social Operations focused regression: 222 passed, 0 failed.
- Full repository suite: 772 passed, 0 failed.
- Development, staging-synthetic, and production-synthetic configuration validation: PASS with execution disabled and dry-run enabled.
- Secret scan, static Social Operations safety, static test-network safety, runtime network guard, `node --check`, and `git diff --check`: PASS.
- Dependency policy: PASS in full and production modes; 0 critical, 0 high, 0 moderate. One accepted low transitive `body-parser` advisory remains.

## Deployment readiness boundary

The implementation is complete, but live execution is intentionally not enabled. A later, separately authorized rollout must supply production credentials and write-client factories, verify account permissions and provider versions, configure connection policies, complete provider sandbox/readback validation, and explicitly enable each kill switch. This work stops at Section 24.
