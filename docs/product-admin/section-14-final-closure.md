# Section 14 — WP0–WP11, Karryam/HQ DoD and release-group closure

Baseline reviewed: [Sections 12–13 implementation report](sections-12-13-implementation-report.md) at `db07424`.
The final Section 14 evaluator is `infrastructure/scripts/product-admin-section14-closure.mjs`; its output is published as a GitHub Actions artifact after the Section 13.3 staging gates.

## Verdict

**CODE ACCEPTANCE SUPPORTED BY CI; REAL STAGING CERTIFICATION AND SIGNED GO/NO-GO PENDING.**

The existing Section 13 gate result reports 5 PASS, 9 PENDING_EXTERNAL. Code conformance and disposable end-to-end evidence do not satisfy the live staging steps of the official definition of done. The final Section 14 CI evaluator binds all WP/DoD results to the exact commit SHA and refuses incomplete or failing evidence. It cannot approve a production promotion.

## Work-package closure matrix

| Package | Delivered implementation | Evidence | Live status |
|---|---|---|---|
| WP0 | Source registry, pinned Bridge OpenAPI and capability inventory | Contract-audit CI, source drift check, gate 6 | Live discovery pending |
| WP1 | Universal Product Admin Protocol and shared packages | Protocol tests, synthetic product, gate 9 | Code verified |
| WP2 | Generic HQ registration, grants, contracts and DB | PIC tests, synthetic third product, gate 9 | Real onboarding pending |
| WP3 | Karryam service and dedicated DB, non-root container | Karryam tests, migration rehearsal, gates 3–4 | Real VPS DB/network pending |
| WP4 | mTLS, HMAC v2, Ed25519 Bridge transport | Real-crypto disposable tests, gate 5 | Real certificate/Bridge enrollment pending |
| WP5 | Scoped readers and module inventory | API/contract coverage, gates 6 and 10 | Real source capability discovery pending |
| WP6 | Durable source events, reconciliation and source lineage | Stage A and journeys J3–J7, gate 8 | Pilot partition pending |
| WP7 | Product-neutral HQ sync, derived events and projections | Stage B, synthetic third product, gates 8–9 | Real HQ integration pending |
| WP8 | Governed source-labeled HQ reporting, Support/Finance/Marketing/Analytics contracts | Module reports, authorized reads, gates 10,13 | Dataset release and real report reads pending; no fabricated metrics |
| WP9 | Governed owner commands, independent approvals, MFA and readback | Section 11 high-risk suites, journeys J9–J10, gate 11 | Owner policy and command certification pending |
| WP10 | Private staging topology, protected secrets, GitHub Actions release automation | Real disposable Nginx/network/host rehearsal, gates 3–5,7,12,14 | Operator S1–S3 evidence pending |
| WP11 | Full regression, 12 business journeys, recovery, gate evaluation | Platform, infrastructure, monorepo and Social CI; gates 8–13 | Signed live release decision and full staging certification pending |

These are **implementation/CI evidence**, not claims that live operator acceptance has occurred.

## 14.1 — Karryam Admin backend DoD

The eight required capabilities — independent typed APIs; own durable store; Bridge-only access; reconciled source events; universal Product Admin Protocol; governed reads/writes; live staging network/security/audit certification; and HQ-outage survival — have supporting code and disposable tests. **The formal backend DONE label is withheld** until the actual staging security, isolation, Bridge, dataset, and recovery acceptance checks pass.

## 14.2 — Universal Headquarters DoD

Generic onboarding, signed manifest validation, scoped grants, approved datasets, event/metric ingestion with provenance, generic HQ reporting, suspension/revocation and recovery/backfill all have automated software evidence. The mandatory synthetic third Product Admin test is present. **Operational HQ DONE is withheld** until an operator independently onboards and certifies a real Product Admin on staging.

## 14.3 — Release groups

| Group | Work packages | Current status |
|---|---|---|
| A | WP0–WP4 | Code tested; private real Bridge identity and read pilot pending |
| B | WP5–WP8 | Code tested; scoped real reads/events/datasets pending |
| C | WP9–WP11 | Code tested; governed commands, live E2E and signed go/no-go pending |

The S0–S7 tracker in `infrastructure/product-admin/release/stages.json` remains the authoritative release sequence. The Section 14 evaluator consumes, but does not override, the Section 13.3 gate artifact.

## Operator activation / blockers

1. Establish the protected GitHub environment `product-admin-staging`, its required reviewers and the dedicated VPS secrets. This cannot be created or signed off by the code-audit script.
2. Operator provisions separate databases/roles, approved secrets, DB-A PUBLIC CONNECT restrictions, Nginx deny include, host firewall and networks; performs approved backup/migration, host preflight and S1/S2 deployment.
3. Source owner enrolls the private Bridge (certificates, HMAC/Ed25519 trust, permitted markets/tenants and signed policies); certify S3, S4 and S5.
4. Independently authorize individual risk-governed source command families and confirm real readback (S6); never bypass Section 11 controls.
5. Resolve the unmounted legacy `karrygo/dispatch` route mappings and confirm owner-approved parity; do not re-mount direct DB routes. Complete the documented 24-hour S7 monitoring window.
6. Certify staging firewall exposure, backup restoration, log/metric scraping and alerts; record all nine outstanding gate results and a signed owner go/no-go separately.

**Current decision: NO-GO for main/production promotion; continue with operator-controlled staging activation.** No live staging or production deployment is asserted by this document.

## CI artifact

The Product Admin Platform CI job now writes `product-admin-section14-closure.json` and Markdown alongside the Section 13.3 staging gate artifact. It fails on missing/stale/malformed gate evidence, missing required source paths or failing required gates. A `NOT_RUN` gate while an independent GitHub workflow is still executing remains **unaccepted/incomplete evidence**, but does not fail an otherwise healthy build merely for cross-workflow scheduling; the acceptance result must be re-evaluated once all workflows finish. `CODE_ACCEPTED_STAGING_PENDING` remains the expected result when all required CI evidence is available.
