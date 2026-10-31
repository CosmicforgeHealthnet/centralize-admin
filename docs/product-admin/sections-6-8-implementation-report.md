# Sections 6–8 — Karryam Admin modules, secure Bridge connector and two-stage synchronization

Specification: *Karryam Admin and Centralized Admin Headquarters — Complete
Backend Implementation Specification v1.0*, Sections 6, 7 and 8.
Repository `CosmicforgeHealthnet/centralize-admin`, branch `staging`.
Report date: 31 October 2026. Builds on Sections 1–5 (PR #55, merged to
`staging` as `5da5254`).

## A. Executive result

**CODE COMPLETE — EXTERNAL STAGING CERTIFICATION PENDING**

Everything that can be built and proven without live operator credentials is
implemented, tested against a disposable secure Bridge and disposable
PostgreSQL, and pushed to `staging`:

- all 435 Bridge capabilities are pinned, mapped to exactly one of 17 modules,
  and exposed honestly (366 source reads through scoped module reads; 58
  source commands as governed, disabled-by-default operations; 2 internal
  sync capabilities; 13 blocked or disabled at the source);
- the Section 7 connector (TLS 1.3 mTLS, HMAC v2, Ed25519 assertions with
  `request_digest`, fixed pinned routes, schema validation, drift detection,
  error classification, unknown-outcome handling);
- the Section 8 pipeline: Stage A (Bridge → Karryam Admin) and Stage B
  (Karryam Admin → Product Integration Core → HQ), with separate databases,
  inboxes, outboxes, cursors and ACKs, proven end to end.

Nothing is live-certified. The Bridge, Karryam Admin and its worker remain
**disabled by default**; no Bridge trust material, signed source policy or
private network exists for staging yet (see I). No source command is enabled,
and R3/R4 commands cannot be enabled by configuration at all.

## B. Capability coverage matrix

Source: KarryGo `staging` `a4adee680f88705641c6a204caac83125d1970a5`
(unchanged since Sections 1–5). Recomputed inventory: **435 = 370 READ_ONLY /
52 AVAILABLE / 7 BLOCKED_DEPENDENCY / 6 DISABLED**. Each capability belongs to
exactly one inventory module (no double counting); a few modules additionally
*serve* a capability owned by another (Support serves `hq.support.queue`,
Marketing serves `hq.campaigns.readback`, Finance serves `hq.finance.report`).

"Implemented" = reachable through an exact, pinned, validated adapter
(reads: `resourceList`/`resourceGet`/`reportGet`; commands: the governed
`POST /operations` pipeline). "Blocked" = BLOCKED_DEPENDENCY or DISABLED at the
source. "Live certified" is **No** everywhere: no real Bridge enrollment exists.

| Module | Source capabilities | Reads implemented | Commands implemented (R3/R4) | Sync | Blocked at source | Tested | Live certified |
|---|---:|---:|---:|---:|---:|---|---|
| Customer Administration | 20 | 15 | 5 (2) | 0 | 0 | yes | No |
| Taxi Administration | 22 | 19 | 3 (2) | 0 | 0 | yes | No |
| Dispatch Administration | 34 | 31 | 3 (2) | 0 | 0 | yes | No |
| Hauling Administration | 26 | 23 | 3 (2) | 0 | 0 | yes | No |
| Corporate Fleet Administration | 64 | 61 | 3 (2) | 0 | 0 | yes | No |
| Vendor Administration | 80 | 77 | 3 (2) | 0 | 0 | yes | No |
| Wallet and Payments Administration | 70 | 67 | 3 (2) | 0 | 0 | yes | No |
| Pricing Administration | 16 | 5 | 11 (9) | 0 | 0 | yes | No |
| Referral Administration | 24 | 21 | 3 (2) | 0 | 0 | yes | No |
| Verification Administration | 15 | 11 | 3 (2) | 0 | 1 | yes | No |
| Support and Safety Administration | 17 | 13 | 3 (2) | 0 | 1 | yes | No |
| Media Administration | 3 | 0 | 3 (0) | 0 | 0 | yes | No |
| Analytics Administration | 14 | 13 | 0 | 0 | 1 | yes | No |
| Notifications and Marketing | 2 | 0 | 1 (1) | 0 | 2 | yes | No |
| Finance and Reporting | 1 | 0 | 0 | 0 | 1 | yes | No |
| Governance and HQ Operations | 17 | 7 | 8 (3) | 2 | 0 | yes | No |
| Bridge platform metadata | 10 | 3 | 3 (1) | 0 | 7 | yes | No |
| **Total** | **435** | **366** | **58 (34)** | **2** | **13** (some also counted above) | | |

Notes:

- *Tested*: every module has the full negative/positive suite in
  `tests/modules.test.js` using a representative list and detail collection
  through real TLS/signatures; every one of the 435 entries is checked for
  module assignment, exposure state and schema compilation
  (`tests/boundaries.test.js`, `tests/modules.test.js`). Not every one of the
  366 reads is individually exercised against a fixture; the adapter is a
  single generic, pinned path, and each source-schema family used by the
  modules (Owner/Vendor/Support resource snapshots, Taxi, scoped analytics
  releases, finance report, HQ queue/status/feed) is exercised.
- Commands: all 58 are **DISABLED** in this environment. The pipeline was
  exercised with `customer.review.submit` (R2) enabled in tests only.
- Fleet "source-confirmed counts" have no source aggregate (the analytics
  contract measures TAXI/DISPATCH/HAULING only); the report is an explicit
  `NO_SOURCE_AGGREGATE` blocker instead of an invented number.

The full 435-entry mapping (Bridge capability, module, Karryam capability,
method, path, permission, scope dimensions, risk, privacy, source state,
exposure state, blockers) is served live by `GET /capabilities`
(`capability_map`) and generated from the pinned registry
`services/karryam-admin/src/bridge/contracts/karrygo-capabilities.v1.json`.

## C. Backend APIs

Product Admin Protocol bumped **1.0 → 1.1 (additive)** with three
product-neutral, staff-delegated endpoints (OpenAPI regenerated:
`packages/admin-contracts/openapi/product-admin-protocol-v1.openapi.json`):

| Endpoint | Purpose |
|---|---|
| `GET /internal/product-admin/v1/resources/{capabilityId}/{collectionId}` | bounded, scoped list of one module collection; opaque continuation |
| `GET /internal/product-admin/v1/resources/{capabilityId}/{collectionId}/{resourceId}` | one scoped resource |
| `GET /internal/product-admin/v1/reports/{reportId}` | one report with source, grain, units, scope, coverage |

HQ-facing (Product Integration Core and the Central Admin gateway; generic, no
Karryam branch): `GET /internal/pic/v1/products/{p}/resources/{cap}/{coll}[/{id}]`,
`GET /internal/pic/v1/products/{p}/reports/{report}` and the matching
`/api/products/...` gateway routes with exact query allowlists. New staff
actions `resource.read` and `report.read` (recent MFA ≤ 300 s). A 1.0 product
answers `PROTOCOL_FEATURE_UNSUPPORTED` from HQ instead of being called.

Karryam Admin manifest (signed): **91 capabilities** in this environment — 1
metadata, 16 module READ capabilities, 14 report READ capabilities, 58 source
commands (all DISABLED), 2 local governance commands (approval propose/decide,
AVAILABLE, no source call). With Bridge enrollment the module reads become
`READ_ONLY`; nothing becomes `AVAILABLE` without explicit operator enablement.

Reports (Section 11): operational activity, Taxi/Dispatch/Hauling status
(analytics releases per authority, never summed), Fleet status (blocked:
no source aggregate), vendor readiness (withheld without complete cohort),
support/SOS queue, wallet by currency, payment and reconciliation, verification
pipeline, marketing evidence (consent aggregates not released by the source),
connector health, sync lag, quarantine/reconciliation.

## D. Database and workers

Migration `002_sections_6_8_modules_and_pipeline.sql` (forward-only; applied
and re-applied on disposable PostgreSQL 16 in CI and 17 locally):

- governed operations: lifecycle `RECORDED → DISPATCHING → SUCCEEDED | FAILED |
  UNKNOWN_OUTCOME`, `UNKNOWN_OUTCOME → SUCCEEDED | FAILED` only; trigger-enforced
  transitions, single dispatch, immutable identity/digest/scope/requester;
- `approval_references` (two-person CHECK, binding immutable, single consume);
- `sensitive_access_log` (append-only);
- Stage A: `bridge_feed_partitions` (cursor, ACK, head, hold, fenced lease;
  monotonic by trigger), `bridge_event_inbox` (unique event ID and
  partition/sequence, immutable digest; only retention may clear the payload),
  `entity_projections` (version must increase), `entity_version_gaps`,
  `event_quarantine` (metadata + digest only), `projection_lineage`
  (append-only), `source_coverage`, `sync_runs`, `bridge_contract_revisions`;
- Stage B: `metric_snapshots`, `hq_outbox` (append-only, contiguous per
  dataset/partition via `hq_outbox_heads` which advance by exactly one),
  `hq_outbox_acks` (monotonic, never past head).

Runtime role: SELECT/INSERT on append-only tables, UPDATE only where a trigger
guards the transition, no DELETE/TRUNCATE/DDL (tested).

Worker: `node src/worker/index.js` (same non-root image, separate process;
disabled unless `KARRYAM_BRIDGE_FEED_ENABLED=true` with full enrollment).
Per-partition fenced leases, per-event transactions, ACK to the Bridge only
after commit, pending-ACK retry first, bounded pages with backpressure,
exponential backoff, reconciliation on start and every
`KARRYAM_BRIDGE_RECONCILE_INTERVAL_SECONDS`, daily payload retention, graceful
shutdown that finishes the in-flight transaction. Operator tools:
`scripts/pipeline-ops.js status | reconcile [--full-backfill] | release-hold`.

Design facts discovered while building and handled explicitly:

- The Bridge feed is **one global sequence filtered by scope**, so sequence
  holes inside one scope are normal and are not gaps. Gaps are detected per
  entity version; ordering, regression and beyond-head anomalies hold the
  partition.
- Rows that commit late in the Bridge outbox (lower sequence, visible later)
  are recovered by a **rewind re-read** during reconciliation (`LATE_APPLIED`).
- The Bridge keeps **one ACK per consumer name**; each partition therefore
  acknowledges as its own consumer (`<consumer>.<partition>`), so partitions
  never regress each other.
- Snapshot backfill uses the authorized HQ support queue (support cases);
  verification and campaign entities have no source snapshot route, so their
  open gaps keep coverage PARTIAL until later events or operator resolution.

## E. Security

Evidence (all automated, real TLS and real signatures against the disposable
Bridge, `tests/connector-security.test.js`, `tests/modules.test.js`,
`tests/operations.test.js`):

- TLS 1.3 only (TLS 1.2 server refused), pinned private IP, SNI from the
  operator origin, CA validation, optional server fingerprint pin and
  revocation list; client certificate must carry exactly the enrolled URI SAN,
  be currently valid and not revoked (startup refuses otherwise); Bridge
  refuses wrong URI and unenrolled/revoked fingerprints.
- HMAC v2 exact canonical form; invalid HMAC, wrong key, unknown key ID,
  version 1, wrong service name, stale timestamp and duplicate nonce refused.
- Ed25519 assertions: invalid signature, wrong audience/issuer, wrong market,
  zone or tenant scope, missing permission, unapproved role, mismatched
  `request_digest` and revoked session refused; zone/tenant claims sent for
  scoped routes.
- Delegation and scope: HQ checks grant + recent MFA; Karryam Admin re-checks
  action, mapped role (staff tiers never authorize), MFA freshness and that
  market/organization/zone/tenant are explicitly delegated **and** enrolled —
  a missing zone grant never means "all zones". All denials happen before any
  network call.
- Continuation tokens: AES-256-GCM, separate key boundary, bound to staff,
  capability, collection, scope, filters and window; tamper and rebinding refused.
- Commands: intent and audit before dispatch, exact body schema, server-bound
  identity fields, single dispatch, `UNKNOWN_OUTCOME` never resubmitted,
  settlement only from owner readback, R3/R4 cannot be enabled.
- Audit: every read and operation step is audited; sensitive classes are
  recorded in `sensitive_access_log`; audit failure returns no data.
- Source isolation: Karryam Admin has no source/HQ database access (static
  boundary test); HQ never calls the Bridge (the HQ read path is PIC → Karryam
  Admin → Bridge, test-proven with the original staff identity reaching the
  Bridge assertion).
- Secret scanning extended: `secret-scan.js --product-admin` covers both
  services, shared packages, product-admin infrastructure templates, docs and
  all workflows (0 findings).

## F. CI

Local evidence on this commit series (Windows workstation, disposable
PostgreSQL 17 via embedded-postgres, KarryGo checkout at the pinned commit):

| Suite | Pass | Fail | Skip |
|---|---:|---:|---:|
| `packages/*` (4 packages) | 57 | 0 | 0 |
| Karryam Admin (`npm test`, PG + KarryGo required) | 80 | 1* | 0 |
| Product Integration Core (`npm test`, PG) | 65 | 1* | 2 |
| Central Admin product-gateway tests | 10 | 1* | 0 |

\* Pre-existing Windows-only failures (Unix-socket mode bits / POSIX config
paths); they pass on Linux CI. The wider Central Admin API Prisma/PostgreSQL
suites could not run on this workstation (no configured test database); they
do not touch the changed files and run in GitHub Actions.

GitHub Actions results for the pushed SHA are recorded in the delivery note
below (section H) once the runs finish.

## G. Two-stage integration results

`services/product-integration-core/tests/karryam-two-stage-postgres.test.js`
(simulated/CI — **not** a real staging Bridge):

- synthetic owner events → disposable secure Bridge → real Karryam Admin
  worker → Karryam Admin PostgreSQL inbox and minimized projection;
- Bridge ACK equals the committed cursor, only after commit;
- derived HQ outbox with contiguous sequences and lineage;
- real PIC sync engine ingests, projects the metric, records lineage and ACKs
  only after its own commit;
- authorized HQ API read returns the OBSERVED, COMPLETE value; before sync it
  returns `NO_SOURCE_OBSERVATION`;
- HQ offline: Stage A keeps acknowledging the Bridge; HQ crash after commit
  before ACK; restart resumes with HQ inbox count equal to the Karryam outbox
  (no loss, no duplicate application);
- HQ → PIC → Karryam Admin → Bridge scoped resource read with the original
  staff identity; other tenant, missing MFA, missing grant, non-READ
  capability and unknown query keys refused.

Stage A edge cases (`services/karryam-admin/tests/pipeline-postgres.test.js`):
duplicates, changed digest on a known event ID (integrity hold, never ACKed
past or skipped, operator release re-holds), unknown schema, cross-tenant
event, invalid payload, out-of-order page, crash before commit, crash after
commit before ACK, ACK retry, tombstone, older version, entity-version gap and
snapshot repair, late-visible rewind, Bridge outage, revoked transport
identity, lease collision and fencing, Stage B ACK semantics, local reports,
append-only/immutability guarantees, retention.

Real staging Bridge results: **none** (no enrollment exists).

## H. Git delivery

- Starting `staging` SHA: `0397114`.
- Work-package commits and final SHA: recorded in the delivery note appended
  after push.
- No staging deployment was performed; `main` and production were not touched.

## I. External blockers (operator actions)

1. KarryGo Bridge enrollment for staging: approved client certificate and key
   with the approved URI SAN, Bridge CA, HMAC key and key ID with expiry,
   Ed25519 staff signing key and key ID, issuer/audience, enrolled
   market/organization/zones/tenants, approved roles, and the consumer
   principal (subject, role, ACR) for the Stage A worker.
2. Signed, approved source-owner policies for every capability family to be
   read (the Bridge returns `blocked_policy` without them), and the KarryGo
   feature flags (`ADMIN_REMOTE_ENABLED`, HQ event/queue/finance flags).
3. Private network path from the Karryam Admin host to the Bridge (no public
   exposure) and the Unix-socket path between PIC and Karryam Admin.
4. Karryam Admin database, migration and runtime roles; run migration 002
   through the approved release workflow (pre-migration backup).
5. Operator files: continuation-token key, HQ service and delegation keys,
   manifest signer enrolled in the HQ trust store.
6. HQ onboarding with independent reviewers: approve the Karryam contract
   revision 1.1, certify datasets (`KARRYAM_ADMIN_CERTIFIED_DATASETS`) only
   after staging evidence, create subscriptions and staff grants
   (`resource.read`, `report.read`, `metric.read`).
7. Any command enablement: per-capability owner policy + operator listing in
   `KARRYAM_ADMIN_ENABLED_COMMANDS` (R1/R2 only); R3/R4 needs a separate
   certification change (Section 11).

## J. Final verdict

Ready: the complete Karryam Admin backend (17 modules over all 435 pinned
capabilities, 14 reports, governed operations), the certified-ready secure
connector, and the two-stage pipeline with its HQ integration, all tested with
real cryptography and real PostgreSQL. Disabled: everything live — Bridge
calls, the worker, every source command, and dataset certification — until
the operator prerequisites in I are met. The platform is ready for controlled
staging activation and for the next section; it is **not** live-certified.
