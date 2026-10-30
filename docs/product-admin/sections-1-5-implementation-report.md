# Sections 1–5 — Engineering evidence report

Specification: *Karryam Admin and Centralized Admin Headquarters — Complete
Backend Implementation Specification v1.0 (29 October 2026)*, Sections 1–5.
Repository `CosmicforgeHealthnet/centralize-admin`, branch `staging`.
Report date: 30 October 2026.

**Verdict: SECTIONS 1–5 CODE COMPLETE — STAGING/EXTERNAL CERTIFICATION PENDING**

## A. Section completion matrix

| Section | Requirement | Existing / reused | Newly implemented | Tested | Remaining blocker |
|---|---|---|---|---|---|
| 1.1 | Refresh audit, record SHAs/PRs | Previous audit references | `section-1-baseline-audit.md` | Recomputed this session | — |
| 1.2 | Verify Karryam Backoffice | KarryGo `a4adee68` (unchanged) | Pinned metadata in Karryam Admin + drift test | 104/104 checksums OK; 435 = 370/52/7/6; hashes recorded | Bridge not certified end-to-end (KarryGo's own status) |
| 1.3 | Verify Centralized Admin, legacy direct DB | Auth/session/MFA middleware | Telemetry + mount guard + cutover note for `dispatchPrisma` router | Gateway test asserts router stays unmounted | Future cutover when Section 6 lands |
| 1.4 | Audit PR #36 | HMAC v2, Ed25519 assertion, request digest, TLS 1.3 mTLS client, non-root socket container | Ported into Karryam Admin; local delegation and HQ direct caller replaced | Ported tests + real TLS 1.3 fake bridge | PR #36 left open (not merged) |
| 2 | Topology, authority boundaries, data access rule, multi-VPS readiness | — | Enforced in service boundaries, endpoint allowlist, static guards | Static boundary tests in gateway, PIC, Karryam Admin | — |
| 3.1 | Monorepo structure | `apps/`, `central-admin-api`, `healthnet-admin` | `product-integration-core`, `karryam-admin`, 4 packages, `infrastructure/product-admin` | Layout guard (58 paths) | — |
| 3.2 | Independent Karryam Admin foundation | PR #36 bridge code | Config, security, transport, bridge, protocol, audit, DB, migrations, Dockerfile | 29/29 (incl. PostgreSQL, mTLS) | Keys, signer, DB, deployment (operator) |
| 3.3 | Independent Product Integration Core | — | Registry, onboarding, grants, subscriptions, sync, projections, quarantine, drift, monitoring | 43/43 with PostgreSQL | Keys, trust store, DB roles + migration, deployment (operator) |
| 3.4 | Central Admin API integration | `authenticate`, `requireAuthSchema`, `requireRecentMfa` | Product gateway, disabled by default | 11/11 gateway; full API suite 1520/1523 (3 env skips) | HQ delegation key + PIC socket (operator) |
| 3.5 | PR #36 migration | — | No `/api/karryam/capabilities` alias (never deployed, no consumer); generic `/api/products/:id/capabilities` | Alias returns 404 (test) | — |
| 3.6 | Legacy direct DB protection | Router kept | Telemetry, guard test, `LEGACY_CUTOVER.md` | Yes | Cutover (later) |
| 4.1 | Reusable protocol packages | — | `admin-contracts`, `service-clients`, `event-contracts`, `identity-and-permissions` | 16 + 8 + 7 + 8 tests (Node 22 and Node 20) | — |
| 4.2 | 12 Product Admin endpoints | — | Shared server kit + Karryam handlers + synthetic product | Karryam protocol tests; synthetic conformance | Karryam data endpoints honestly unavailable until Sections 6–9 |
| 4.3 | Signed manifest | — | Ed25519 sign/verify, closed schema, trust store, rollback guard | Invalid/expired/foreign/URL-injection tests | No signer enrolled for staging/production (by design) |
| 4.4–4.5 | Dataset and event metadata | — | Schemas, digests, event envelope v1, registry | Yes | — |
| 4.6 | Version compatibility | — | `compareCatalogs`, `activationDecision`, immutable contract revisions, propose/certify/activate | Unit + conformance step 18 | Dual-read execution is a later phase (plan field + refusal implemented) |
| 4.7 | Standard response envelope | — | `okEnvelope`, `errorEnvelope`, truthfulness rules | Yes | — |
| 4.8 | Protocol security tests | — | See protocol-v1.md table | Yes | — |
| 5.1 | Registry database | — | `hq_integration` schema, 13 tables + replay nonces, constraints, triggers, separate roles | Fresh migrate, runtime-role denial, append-only, restore | Staging installation (operator) |
| 5.2 | Onboarding state machine | — | Pure state machine + transactional service | Unit + conformance | — |
| 5.3 | Registration and identity | — | Endpoint allowlist binding, signer enrollment, pinned TLS fingerprints, no secrets in DB | API security tests | Real identities/certificates (operator) |
| 5.4 | HQ product gateway | — | 9 required routes + admin functions | Gateway + PIC API tests | Disabled until configured |
| 5.5 | Navigation contract | — | `GET /api/products` | Conformance steps 6, 8, 18, 19 | Frontend consumption is separate work |
| 5.6 | Generic synchronization (20 rules) | — | `sync/engine.js` | Conformance + 8 sync edge-case tests | No real product event source yet |
| 5.7 | Dataset subscriptions | — | Subscriptions with scope, department, freshness, poll interval | Yes | — |
| 5.8 | Metric projections | — | Domain-neutral, version-protected, exact-scope reads | Yes | — |
| 5.9 | Health, sync, observability | — | Monitoring endpoint, alerts, drift checks | Yes | — |
| 5.10 | Synthetic third-product conformance | — | 20-step test, no product branch in HQ | 17/17 (16 steps + suite) | — |

## B. Repository changes

- Start: `680b315ea9ad2275bb9630d8390cd2dc01f4ae77`. Implementation pushed to
  `origin/staging` (fast-forward) at `3bf5499c0e6833444d82bbe1c97fa4b993954a91`,
  CI fix at `13017ff1071e0b8b893b5e3b5f936ae1027f6f51`, plus this report commit.
  No pull request was used (direct push to `staging` as instructed); PR #36 was
  not merged or modified; nothing was pushed to `main`.
- Commits: `1e0809d` packages · `219da02` karryam-admin · `22b6df3`
  product-integration-core · `cdc4519` central-admin-api gateway · `abb0549`
  CI + layout guard · `3bf5499` docs/templates · `13017ff` test fix (Karryam
  PostgreSQL test roles get passwords for CI's SCRAM authentication).
- 151 files changed (+18,146 / −17): packages 52, karryam-admin 36,
  product-integration-core 34, central-admin-api 12, infrastructure 9,
  docs 5, workflow 1, READMEs 2.
- Existing files modified: `README.md`, `infrastructure/scripts/check-layout.mjs`,
  four package READMEs, `services/karryam-admin/README.md`,
  `services/future-product-admins/README.md`,
  `services/central-admin-api/{.env.example, src/app.js, src/shared/middlewares/auth.middleware.js (additive tokenIssuedAt), src/modules/karrygo/dispatch/dispatch.routes.js (telemetry)}`.
- Intentionally unchanged: frontend (`apps/central-admin-web`), Mail,
  HealthNet, Logistics, existing auth/RBAC behavior, Prisma schemas and
  migrations, root Dockerfile/.dockerignore, all deployment workflows,
  KarryGo, PR #36.
- Reused from PR #36: HMAC v2 signing, Ed25519 staff assertion, request
  digest, TLS 1.3 mTLS bridge client, origin validation, non-root Unix-socket
  container pattern, negative tests.
- Dependencies: `pg` 8.20.0 in the two new services (same as the API). No
  dependency changes in the API or frontend. Contract revision: Protocol 1.0,
  packages 1.0.0.

## C. Architecture

See [architecture.md](architecture.md). The Central Admin API keeps staff
authentication and signs a 30-second request-bound delegation after session
(and, for admin routes, MFA) checks. The Product Integration Core owns the
registry, onboarding, grants, subscriptions, ingestion, projections and
monitoring and authorizes every action from explicit grants. Karryam Admin
owns its runtime, catalog, audit, operation records and the (disabled) bridge
client. New products register by implementing Protocol v1 and being onboarded
through the same API — the synthetic third product does exactly that with no
HQ code change. Disabled: every new switch defaults off; all domain commands
are refused at HQ and at Karryam Admin.

## D. Database

- Schema `hq_integration` (PIC, migration `001_product_admin_registry`):
  `hq_product_admins`, `_contracts`, `_grants`, `_datasets`, `_subscriptions`,
  `_event_inbox`, `_sync_cursors`, `_metrics`, `_lineage`, `_sync_runs`,
  `_quarantine`, `_onboarding_approvals`, `_security_audit`,
  `_replay_nonces`, `_schema_migrations`.
- Schema `karryam_admin` (Karryam Admin, migration
  `001_karryam_admin_foundation`): `schema_migrations`, `integration_audit`,
  `request_nonces`, `operation_requests` (status can only be `REJECTED`).
- Constraints: see [registry-and-onboarding.md](registry-and-onboarding.md#51-registry-database).
- Migration tests on disposable PostgreSQL 16: fresh apply, idempotent
  re-run, tampered checksum refused, nothing created outside the schema.
- Runtime vs migration role: runtime cannot `CREATE`, `DROP`, `DELETE`,
  `TRUNCATE` or update append-only tables; even the owner cannot rewrite audit
  (triggers). Backup/restore of `hq_integration` verified.
- Source isolation: no new code connects to Karryam/HealthNet operational
  databases or the HQ main database; static tests enforce it.

## E. Protocol

Endpoints, authentication (`cf-svc-v1` service signatures, product
delegation, private transport, audit-before-execute), envelope, readiness and
the Karryam capability/dataset status table are in
[protocol-v1.md](protocol-v1.md). Supported capability today: none usable in
production; `karryam.bridge.capabilities.read` becomes READ_ONLY only after
bridge trust enrollment. Disabled: all Karryam commands; blocked: all domain
reads (Section 6). Compatibility checks classify identical, additive and
breaking revisions; breaking ones never activate.

## F. Integration registry (demonstrated by tests)

`conformance-synthetic-third-postgres.test.js` (synthetic product) and
`karryam-through-hq-postgres.test.js` (Karryam Admin): registration as
untrusted, identity verification against the pinned endpoint and approved
signer, immutable contract validation, independent review, dataset approval
(product-certified only; restricted refused), explicit staff grants (no
self-grants, no tier access), certification with evidence, independent final
approval, suspension, permanent revocation, and Karryam correctly held at
`POLICY_REVIEWED` because its datasets are not certified.

## G. Synchronization (test evidence)

| Behaviour | Test |
|---|---|
| Event persistence, cursor advance, ACK only after commit | conformance steps 9–13 (ACK handler observes the committed inbox row) |
| Duplicate protection / altered digest | conformance step 14 (`DIGEST_CONFLICT`, identical replay counted as duplicate) |
| Gap handling and partial coverage | conformance step 16 (cursor held at 3, gap 4–4, coverage PARTIAL) |
| Reconciliation | conformance step 16 (snapshot backfill, gap cleared, lineage `RECONCILE_SNAPSHOT`) |
| Quarantine | sync test: unknown family, schema drift, scope denial; no payload stored |
| Revocation | sync test mid-run (1 of 3 events, no ACK, `ABORTED_REVOKED`); conformance step 20 (no further requests) |
| Recovery from interruption | conformance step 15 (crash after commit, lease blocks, takeover retries ACK, no double apply); fencing test |
| Older entity version | sync test (`STALE_IGNORED`, projection unchanged) |
| ACK failure after commit | sync test (retry without re-application) |
| Out-of-order delivery | sync test |
| Poll interval scheduling | sync test |

## H. CI and security

Local runs at the pushed commit (disposable PostgreSQL 16, Node 22):

| Suite | Command | Result |
|---|---|---|
| admin-contracts | `npm test` | 16 pass / 0 fail |
| event-contracts | `npm test` | 7 / 0 |
| identity-and-permissions | `npm test` | 8 / 0 |
| service-clients (incl. real TLS 1.3 mTLS) | `npm test` | 8 / 0 |
| Packages on Node 20.20.2 | same | 39 / 0 |
| Karryam Admin | `KARRYAM_ADMIN_TEST_DATABASE_URL=… npm test` (trust and SCRAM auth) | 29 / 0 / 0 skipped |
| Product Integration Core | `PIC_TEST_DATABASE_URL=… npm test` (trust and SCRAM auth) | 43 / 0 / 0 skipped |
| Gateway (Node 22 and Node 20) | `node --require ./tests/helpers/network-guard.js --test tests/product-gateway.test.js` | 11 / 0 |
| Central Admin API full suite (CI env, prepared DB) | `npm test` | 1523 tests: 1520 pass, 0 fail, 3 skipped (no clamd, no live S3, no IPv6 loopback) |
| Mail | `npm run test:mail` | 499 / 0 and 30 / 0 (s3 mode) |
| Social operations | `npm run test:social-operations` | 222 / 0 |
| Network guard | `npm run test:network-guard` | 28 pass / 1 skipped |
| HealthNet Admin | `npm test` | 8 / 0 |
| Frontend | lint / `tsc --noEmit` / `next build` | 0 errors (198 pre-existing warnings) / pass / pass |
| Static | secret-scan, network-guard-static, static-social, migrations:safety, db:manifest:verify, layout guard | all pass, 0 findings |
| Containers | CI smoke script run locally | both images non-root (10001 / 10002), read-only, no network, live 200, ready 503, protocol 503, bridge path 404, enabling without config exits non-zero |

Security-negative outcomes: all listed in protocol-v1.md and the PIC API
security tests passed (forged/replayed/rebound delegations, SUPER without
grant, expired/revoked grants, missing dataset grant, cross-market/tenant,
wildcards, scope beyond product, missing MFA, endpoint not allowlisted or
bound to another product, wrong signer, environment isolation, URL fields,
disabled operations never forwarded).

GitHub Actions (push to `staging`):

| Workflow | `3bf5499` | `13017ff` |
|---|---|---|
| Product Admin Platform CI | [run 41010719497](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/41010719497) — **failure**: Karryam Admin PostgreSQL test connected without a password (local cluster used trust auth; CI uses SCRAM). Packages, PIC (43/43, 0 skipped) and containers passed | [run 41010961178](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/41010961178) — **success**: packages, Karryam Admin 28 pass / 1 skip (KarryGo checkout not present in CI) / 0 fail, PIC 43/43, containers |
| Social Operations CI (`staging.yml`, verify + deploy) | [run 41010719336](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/41010719336) — **success** (full API suite, Mail, Social Ops, static checks; image published; staging deploy) | [run 41010961225](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/41010961225) — **success** (no API change → no deploy) |
| Social Operations CI (`social-operations-ci.yml`) | [run 41010719400](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/41010719400) — success | [run 41010961256](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/41010961256) — success |
| Monorepo Layout and Container CI | [run 41010719341](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/41010719341) — success | [run 41010961254](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/41010961254) — success |

The CI PostgreSQL logs show the negative database tests genuinely executing
(append-only, immutable identity, monotonic cursor, restricted dataset and
runtime-privilege refusals), not skipping.

### Automatic deployment effect

The push of `3bf5499` changed `services/central-admin-api/**`, so the existing
`staging.yml` pipeline verified, published
`ghcr.io/cosmicforgehealthnet/admin-backend:staging-3bf5499…` and deployed it
to the **staging** VPS ([deploy job](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/41010719336/job/123918606436),
success; the pipeline's own health, admin-DB login query and CORS checks
passed, no rollback). Effect on staging: the new `/api/products/*` and
`/api/admin/product-integration*` routes exist but, with
`PRODUCT_INTEGRATION_ENABLED` unset, answer 503 `PRODUCT_INTEGRATION_DISABLED`
after authentication; all existing routes are unchanged. No database migration
ran; the Product Integration Core and Karryam Admin were **not** deployed
anywhere. Production was not touched.

Baseline notes: none of the failures seen during development were in
existing suites; an earlier gateway-fork run showed 43 PostgreSQL replay
failures caused only by the sandbox's shallow clone (the replay verifier needs
git history; CI uses `fetch-depth: 0`), which passed after deepening.

## I. External dependencies (operator action required — not done)

1. Product Admin manifest signer keys (Karryam staging) and enrollment of the
   public key in PIC's trust store.
2. Per-product PIC service and delegation keys; HQ delegation key shared by
   the API and PIC; Karryam Admin key files.
3. Staging database roles (`pic_migrator`, `pic_runtime`; Karryam Admin's own
   database and roles), running both migrations, bootstrapping the first
   platform grants for distinct requester/reviewer/approver staff.
4. Deployment definitions for PIC and Karryam Admin (no workflow deploys them
   yet), socket directory sharing with the API container, ingress `/internal/*`
   deny rule.
5. Karryam Bridge trust enrollment: HQ client certificate under the dedicated
   CA, HMAC key, staff signing key, approved issuer/audience/ACR, role map,
   signed owner policies — then certification in staging.
6. Certificates/private network for any future multi-VPS move.
7. Product certification of Karryam datasets/events (Sections 6–9) before any
   Karryam dataset can be approved or synchronized.

## J. Verdict

**SECTIONS 1–5 CODE COMPLETE — STAGING/EXTERNAL CERTIFICATION PENDING**

All Section 3–5 software exists, runs and is tested, including the mandatory
synthetic third-product conformance with no product-specific HQ code, and
Karryam Admin implements Protocol v1 honestly. It is not certified on staging:
the new services are not deployed, no keys or signers are enrolled, the
registry migration has not been applied to the staging database, and the
bridge is not enrolled. Those are operator dependencies (section I), not code
gaps.

Next work package: (1) operator enrollment and a reviewed GitHub Actions
deployment for PIC and Karryam Admin on staging with both disabled, then
staged enablement and a staging conformance run; (2) Section 6 Karryam
domain modules and Section 8 bridge event processing so Karryam datasets can
become `CERTIFIED_BY_PRODUCT`.

---

## Addendum — independent re-verification and hardening (30 October 2026, second pass)

A second engineering pass re-ran the Section 1 audit and every Section 3–5
suite against the latest `staging`, and audited the code against each bullet
of Sections 3.2–5.10. Nothing was reimplemented. Verified requirements
are unchanged. The gaps below were fixed in place and covered by new tests.

### Baseline (recomputed)

| Item | Value |
|---|---|
| centralize-admin `staging` at start | `1ccfc0fa45f579735dd523dac09aad780f3c43b3` (Mail-only commits since `0cebe34`; none touch Sections 1–5) |
| KarryGo `staging` | `a4adee680f88705641c6a204caac83125d1970a5` — unchanged |
| PR #36 | `0a3b401d833f81c5696797f3c67388940be69699`, still draft and untouched |
| Other open PRs | #54 (Mail only) |
| Bridge artifacts | the four SHA-256 values above all match; `SHA256SUMS` 104/104 OK; matrix 435 = 370 READ_ONLY / 52 AVAILABLE / 7 BLOCKED_DEPENDENCY / 6 DISABLED; OpenAPI 3.1.0, info 1.0.0, 432 paths |

### Gaps found and fixed

| Spec | Gap | Fix |
|---|---|---|
| 1.2 | CI always skipped the pinned KarryGo contract test (no checkout), so drift was never checked automatically | CI checks out KarryGo's bridge artifacts (public repository, sparse) at the pinned commit and makes the test **required** (`KARRYGO_REQUIRE_CHECKOUT=1`). A second step compares KarryGo `staging` HEAD and raises a warning annotation on drift |
| 5.6 step 6, 5.9 | Synchronization filtered only on lifecycle `ENABLED`: a product whose signer was revoked or expired, or whose manifest had expired, kept synchronizing. `manifest_expires_at` was never refreshed after onboarding | `identityBlock` runs before every subscription run and sends no request when it trips. It checks: approved signer present in the trust store, unrevoked, unexpired and enrolled for this product/environment; stored manifest unexpired; no identity drift. The result is `BLOCKED_IDENTITY` plus a sanitized alert. The engine now requires a trust store (fail closed). A verified health check with an unchanged catalog refreshes the manifest digest, revision and expiry |
| 5.5 | Navigation showed products with identity drift as available. The dataset `granted` flag ignored expiry and explicit deny | `IDENTITY_NOT_VERIFIED` reason; the `granted` flag uses the same `authorize` decision as the read path |
| 4.6 | Changing a capability's `requires_recent_mfa` / `requires_independent_approval` produced no change entry, so the revision was classified `IDENTICAL` | These are now `BREAKING` (`CAPABILITY_AUTHORIZATION_CHANGED`). Lineage, title, blockers, sunset and pure version bumps are `ADDITIVE`. Any remaining difference becomes `BREAKING` `UNCLASSIFIED_CHANGE` |
| 4.6 | Any protocol minor of major 1 was accepted | Minor must be ≤ the supported minor (unknown newer contracts are rejected) |
| 4.2, 5.4 | `GET /operations/{id}` and `GET /audit/{id}` needed only a service signature, so any staff member with product-level `operation.read` could read any operation, including its audit `staff_ref` | Both now need a request-bound `operation.read` product delegation; Karryam Admin returns only operations the delegated staff member requested (others answer 404). PIC signs that delegation. `POST /operations` refuses a command scope outside the delegated scope (`SCOPE_DENIED`) |
| 6 | A malformed explicit `DENY` grant was silently ignored (fail open) | It now denies (`POLICY_INVALID`) |
| 3.2 | Karryam Admin accepted the same key for service authentication, delegation and the bridge HMAC | `KEY_REUSE_ACROSS_BOUNDARIES` (matches PIC) |
| 5.2 | A subscription of a `REVOKED`/`REJECTED` registration could still be toggled (writing misleading history) | `REGISTRATION_TERMINAL` (409) |
| 5.9 | PIC replaced the API's correlation ID, so logs could not be joined across the two services | PIC keeps its server-generated ID and logs the validated inbound ID as `upstream_correlation_id` |
| 5.10 step 10 | Only metric-observation events were exercised | The synthetic product now also declares a non-metric standard family (`projection: NONE`). A new test proves it is validated, stored without projection, sequenced and ACKed after commit, and that an off-schema payload (here with an extra personal field) is quarantined without retaining the payload |

### Not changed (recorded)

- Retention (`retention_days`) is stored as metadata. Purging append-only
  inbox and lineage rows needs a migration-role job (later phase).
- Dual-read migration remains a recorded refusal
  (`DUAL_READ_PLAN_REQUIRES_NEW_REGISTRATION`); execution is later-phase work.
- Capability state changes (for example `DISABLED` → `AVAILABLE`) stay
  `ADDITIVE`, with mandatory independent certification and approval. A state
  change only advertises readiness; it grants nobody access.
- `quarantined_count` never decreases, so coverage stays `PARTIAL` after any
  quarantine. This is conservative by design.

### Local test evidence (Windows 11, Node 25.2.1, disposable PostgreSQL 18.4)

| Suite | Result |
|---|---|
| admin-contracts | 19 / 19 (3 new tests) |
| event-contracts | 7 / 7 |
| identity-and-permissions | 9 / 9 (1 new) |
| service-clients | 8 / 8 |
| Karryam Admin (PostgreSQL + real KarryGo checkout, required) | 29 / 30. The one failure is the Unix-socket permission test, which cannot run on Windows |
| Product Integration Core (PostgreSQL, `pg_dump` restore) | 48 / 49 (6 new tests). The one failure is a config test that requires POSIX absolute paths; Windows temp directories are `C:\…` |
| Central Admin API gateway | 10 / 11. The one failure is the Unix-socket transport (Windows); no API source changed |

The Windows-only failures were confirmed as environment limits: the
services ship as Linux containers, and the same tests pass on the Ubuntu CI
runners. The three identity-gate tests were also checked by mutation:
disabling the gate makes them fail.

### Deployment effect

No file under `services/central-admin-api/`, nor `Dockerfile` or
`.dockerignore`, was changed, so `staging-api-change-scope.sh` classifies
the change as non-deployable. No staging image or VPS change results. PIC
and Karryam Admin are still not deployed anywhere.

### Verdict (unchanged)

**SECTIONS 1–5 CODE COMPLETE — STAGING/EXTERNAL CERTIFICATION PENDING.**
The external dependencies in section I are still outstanding: signer keys and
trust enrollment, PIC/Karryam Admin keys, staging database roles and
migrations, deployment definitions, Bridge enrollment, and Karryam dataset
certification.
