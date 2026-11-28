# Section 9 — Data models, migrations and data governance

Specification: *Karryam Admin and Centralized Admin Headquarters — Complete
Backend Implementation Specification v1.0* (29 October 2026), Section 9.1–9.5.
Repository `CosmicforgeHealthnet/centralize-admin`, branch `staging`.
Report date: 1 November 2026. Starting `staging` SHA: `644ab48`.

## A. Executive verdict

**SECTION 9 CODE COMPLETE — EXTERNAL STAGING DATABASE CERTIFICATION PENDING**

Both databases (the dedicated Karryam Admin database and the HQ
`hq_integration` schema) received forward-only migrations `003` (Section 9)
and `004` (Sections 10/11 dependencies), runner hardening, a read-only
preflight, a disposable backup/restore drill and PostgreSQL test suites. All
of it passes on disposable PostgreSQL 17 locally and PostgreSQL 16 in GitHub
Actions with zero skips. Nothing was applied to a real staging or production
database: that, real roles, real backups, encryption at rest and a staging
restore drill are operator tasks (section I).

## B. Requirements matrix

Status legend — *before*: state found at `644ab48`; *after*: state at the
final SHA. "Verified" means covered by an automated PostgreSQL test.

| Requirement | Before | After | Files | Tests | Remaining blocker |
|---|---|---|---|---|---|
| 9.1 Dedicated Karryam Admin database | Implemented (own DB, no source/HQ access) | Verified | `services/karryam-admin/migrations/*`, `tests/boundaries.test.js` | static boundary test; cross-database CONNECT denied | Operator provisions the database |
| 9.1 HQ `hq_integration` schema | Implemented | Verified | `services/product-integration-core/migrations/*` | `section9-postgres` (PIC) | Operator applies migrations |
| 9.1 No direct operational DB access by product-admin code | Implemented (static tests) | Verified + legacy containment | `static-boundaries.test.js` | new: legacy Dispatch DB access confined to 3 legacy files | Legacy cutover needs owner approval (9.5.7) |
| 9.1 Migration/runtime role separation | Partial (PIC CLI refused equal URLs; KA runner did not) | Verified | `scripts/migrate.js` (both), `migration-safety.js` | runner refuses superuser, CREATEROLE, migration role as runtime, equal credentials | Real roles: operator |
| 9.1 Runtime cannot DDL/TRUNCATE/disable triggers/alter owner/delete audit/modify ledger | Partial (tested DDL/DELETE/UPDATE) | Verified | migrations 003, runners | exact privilege set compared to catalog; `DISABLE TRIGGER`, `OWNER TO`, `session_replication_role`, `TRUNCATE`, ledger insert all `42501` | — |
| 9.1 No default privileges / exact grants | Missing (grants additive only) | Verified | runners: revoke-then-grant in one transaction | `pg_default_acl` empty; privileges equal the documented set | — |
| 9.2.1 Migration ledger (version, SHA-256, time, immutable, lock, changed-file detection, idempotent) | Partial (ledger mutable by owner) | Verified | 003 (append-only triggers) | update/delete/truncate refused; changed checksum refused; concurrent runs; failed migration leaves nothing | — |
| 9.2.2 Bridge contract records | Partial (no approval/policy/signer/expiry) | Verified | 003 columns + guard | identity immutable; approval evidence recorded once; runtime cannot write it | Operator records approval evidence |
| 9.2.3 Capability snapshots (runtime ≠ static) | Missing | Verified | 003 `capability_snapshots`, `src/db/governance.js`, handlers | unknown capabilities never cached; expiry and other-contract → UNKNOWN; append-only | Live discovery needs Bridge enrollment; source provides no policy fingerprint (column stays null) |
| 9.2.4 Bridge sync cursors | Implemented | Verified + no-delete, sanitized hold codes | 003 | existing Stage A suite + 003 guards | — |
| 9.2.5 Durable inbox | Implemented | Verified + clearing reason, legal hold | 003 | retention keeps digest; held rows refused at DB | — |
| 9.2.6 Entity projections (version fence, tombstones, scope) | Partial (an entity could be moved to another tenant's partition) | **Defect fixed**, verified | 003 guard, `store.js` `SCOPE_CONFLICT` | cross-tenant collision quarantined, never overwritten, feed not blocked; DB backstop | — |
| 9.2.7 Metric snapshots (definition, grain, unit, currency, ratio parts, exact numeric) | Partial (no unit/currency/grain/definition) | Verified | 003 | 30-digit values exact; minor-currency needs currency and whole value; count whole and ≥ 0; null ≠ zero; identity immutable | — |
| 9.2.8 Derived HQ outbox | Implemented | Verified + schema/classification materialized | 003 generated columns + checks | RESTRICTED_PII and identity mismatch refused | — |
| 9.2.9 HQ ACKs | Partial (head bound only in code) | Verified | 003 trigger on insert and update | beyond head, regression, unknown partition refused | — |
| 9.2.10 Sync runs | Partial (mutable after finish) | Verified | 003 guard | finished run immutable; counters nonnegative integers; identity fixed | — |
| 9.2.11 Quarantine | Partial (runtime could rewrite digest; no repeat count) | **Defect fixed**, verified | 003 guard, `store.js` | evidence immutable; occurrences counted; reopen only on re-detection | — |
| 9.2.12 Operation receipts | Implemented | Verified + requester index, one non-refused operation per approval | 003/004 | existing suites + `high-risk-operations` | — |
| 9.2.13 Approval references | Partial (decision fields changeable on consume; no revocation/version/policy binding) | Verified | 003/004 | decided once; MFA recorded; revocation rules; bound version/policy/certification | — |
| 9.2.14 Security audit | Implemented | Verified + explicit product | 003 | owner and runtime cannot mutate | — |
| 9.2.15 Sensitive access log | Implemented | Verified + explicit product, index | 003 | append-only (002 tests) | — |
| 9.3 13 HQ table families | Implemented with gaps | Verified (all 13 carry data through the restore drill) | PIC 003 | `section9-postgres`, `restore-drill-postgres` | — |
| 9.3.1 Unique product/env, immutable identity | Implemented | Verified | 001 | existing + drill | — |
| 9.3.2 One active certified contract; no silent activation | Implemented (unique index) | Verified + enabled product must point at its own active contract (deferred) | PIC 003 | concurrent activation: exactly one wins; uncertified → ACTIVE refused | — |
| 9.3.3 Staff grants effective date | **Missing** (`authorize()` honoured `not_before` but the table had none) | Verified | PIC 003, `authz`, onboarding | not yet in force / expired / explicit deny / self-revoke | — |
| 9.3.4 Datasets/subscriptions cannot be enabled by DB update | Missing (no subscription guard) | Verified | PIC 003 guard | unapproved dataset, other product, scope outside product scope, identity change refused | — |
| 9.3.5 Inbox/cursors | Implemented | Verified + no delete | PIC 003 | existing sync suites | — |
| 9.3.6 Metric projections | Implemented | Verified + money/count rules | PIC 003 | minor-currency/count checks | — |
| 9.3.7 Audit and onboarding approvals immutable, reviewer separation | Implemented | Verified | 001, PIC 004 | runtime UPDATE refused | — |
| 9.4.1–9.4.4 Constraints, events, cursors, versions | Implemented | Verified | 003 both | see above | — |
| 9.4.5 Monetary integrity | Partial | Verified | 003 both | exact numeric, currency separation, whole minor units | — |
| 9.4.6 Audit/outbox immutability incl. trigger bypass | Partial | Verified | 003 | DISABLE TRIGGER / OWNER / replication role denied | — |
| 9.4.7 Classification and minimization | Partial (classes enforced, no field denylist) | Verified | `catalog.js` `PROHIBITED_FIELD`, PIC 003 DB check | NIN/OTP/password/card/location/medical refused in contracts and inbox | — |
| 9.4.8 Retention, legal hold, erasure, tombstones | Partial (fixed-days payload clearing only) | Verified | 003 both, `governance.js`, `retention/`, operator tools | two-person holds; retention skips held rows; race serialized; erasure only after owner-confirmed fulfilment | Operator tooling run through approved workflow |
| 9.4.9 Encryption at rest | Infra-only | Assessed (no field needs app encryption; see D/I) | — | — | Operator: disk/volume/backup encryption, key management |
| 9.4.10 Indexes and EXPLAIN | Partial | **Defect fixed** (`loadGrants` could not use the partial staff index), verified | 003 both | EXPLAIN on 20 000-row synthetic tables | — |
| 9.5.1 Forward-only, checksums, lock, transactions, ordering | Partial (ledger mutable; CRLF/LF checksum hazard for new files) | Verified; bytes pinned with `.gitattributes -text` | runners, `.gitattributes` | changed/missing file refused | — |
| 9.5.2 Preflight/preview | Missing | Verified | `--preview` (both), `migration-safety.js` | read-only, redacted, risk summary, row estimates, role problems | — |
| 9.5.3 Credentials | Partial | Verified | runners, config | see 9.1 | Real credentials: operator |
| 9.5.4 Backup/restore | Partial (PIC simple dump/restore test, skipped without pg_dump) | Verified | `infrastructure/product-admin/db/restore-drill.js`, drill tests | 10-step drill both schemas; CI requires tools | Real staging drill: operator |
| 9.5.5 Rollback strategy | Partial | Documented | `database-migration-runbook.md` | — | — |
| 9.5.6 Isolation from Mail/HealthNet/etc. | Implemented | Verified | migrations touch only `karryam_admin` / `hq_integration` | — | — |
| 9.5.7 Legacy direct-access cutover | Not audited | Audited, documented, guarded | `static-boundaries.test.js` | containment test | Owner parity/approval for any cutover |

## C. Karryam Admin schema (dedicated database, schema `karryam_admin`)

| Spec name (9.2) | Physical table | Section 9 additions |
|---|---|---|
| `karryam_admin_schema_versions` | `schema_migrations` | append-only triggers |
| `karryam_admin_bridge_contracts` | `bridge_contract_revisions` | contract version, policy revision, signer ref, approval evidence/by/at, expiry; identity immutable; approval once; no delete |
| `karryam_admin_capability_snapshots` | `capability_snapshots` (new) | per discovery and capability: Bridge state, permission, risk, owner, contract revision, source OpenAPI digest, Bridge role, staff, observed/expiry (≤ 1 day); append-only |
| `karryam_admin_bridge_sync_cursors` | `bridge_feed_partitions` | no delete; sanitized hold code |
| `karryam_admin_bridge_event_inbox` | `bridge_event_inbox` | `payload_cleared_reason` (RETENTION/ERASURE); clearing refused under legal hold; `SCOPE_CONFLICT` outcome |
| `karryam_admin_entity_projections` | `entity_projections` | identity/partition/scope immutable; erasure redaction (`redacted_at`) only; no delete |
| `karryam_admin_metric_snapshots` | `metric_snapshots` | dataset, definition version, grain, unit, currency, numerator/denominator; money/count/observed checks; identity immutable; no delete |
| `karryam_admin_outbox_events` | `hq_outbox` (+ `hq_outbox_heads`) | generated `schema_id`, `schema_version`, `classification`; syncable classes only; row/event identity check |
| `karryam_admin_outbox_acks` | `hq_outbox_acks` | head bound on insert and update; no delete |
| `karryam_admin_sync_runs` | `sync_runs` | finished immutable; counters checked; correlation ID; no delete |
| `karryam_admin_quarantine` | `event_quarantine` | occurrences, last seen; evidence immutable; resolution code; no delete |
| `karryam_admin_operation_receipts` | `operation_requests` | requester index; one non-refused operation per approval (004) |
| `karryam_admin_approval_refs` | `approval_references` | risk, expected version, policy revision, certification (004), revocation; decision once; MFA recorded |
| `karryam_admin_audit` | `integration_audit` | explicit `product_id`; staff index |
| `karryam_admin_data_access_log` | `sensitive_access_log` | explicit `product_id`; capability index |
| (governance) | `legal_holds`, `retention_policies` (new); `entity_version_gaps`, `projection_lineage`, `source_coverage` guarded | |
| (Section 11) | `high_risk_certifications` (004) | see Section 11 report |

Runtime role privileges (exactly; applied by the runner, verified by test):
SELECT/INSERT on `integration_audit`, `sensitive_access_log`,
`projection_lineage`, `hq_outbox`, `bridge_contract_revisions`,
`capability_snapshots`; SELECT/INSERT/DELETE on `request_nonces` (expired
rows only, trigger); SELECT/INSERT/UPDATE on trigger-guarded state tables;
SELECT on `schema_migrations`, `retention_policies`,
`high_risk_certifications`. No DDL, TRUNCATE, ownership or trigger control.

Data classification and retention: payloads are the Bridge's minimized
classes (exportable classes only, verified per event adapter); retention
policy rows (`retention_policies`): event payload 30 days (cleared, identity
kept); quarantine metadata and sync runs 730 days; audit, access log,
lineage and operation receipts 2555 days (retain-evidence classes cannot go
below 365 days or be cleared).

## D. Headquarters schema (`hq_integration`)

All 13 table families exist under their specified names. Section 9 changes
(PIC `003`, `004`): append-only ledger; enabled product ⇒ own ACTIVE contract
(deferred check); grants `not_before` + validity window + revocation reason;
full staff-grant index; subscription guard (same product, approved
HQ-syncable dataset on enable, scope ⊆ product scope, identity immutable);
cursors/subscriptions/registrations/contracts/datasets never deleted or
truncated; inbox payload retention (`payload_cleared_*`) with legal holds
(`hq_product_admin_legal_holds`, two-person, single release) and a
prohibited-field database check; metrics money/count rules; finished sync
runs immutable and counters ≥ 0; quarantine evidence immutable with a
single resolution and no restricted fields in `detail`; replay nonces
deletable only when expired; operations switch (004) recorded in onboarding
history and only as a reviewed revision on an ENABLED product.

Ownership and isolation: every row is keyed by `product_admin_id`; no
product-specific SQL; product scope is the ceiling for grants and
subscriptions; HQ stores only PUBLIC/INTERNAL/CONFIDENTIAL aggregates
(RESTRICTED_PII datasets can never be approved; CREDENTIAL/HEALTH are not
expressible in the protocol and are refused by schema validation).

Runtime privileges: SELECT/INSERT/UPDATE on guarded registry/state tables
(including the inbox, whose only permitted update is payload clearing),
SELECT/INSERT on lineage, onboarding approvals and security audit,
SELECT/INSERT/DELETE on replay nonces, SELECT on the ledger.

## E. Migration changes

| Database | Version | SHA-256 (committed bytes) | Notes |
|---|---|---|---|
| Karryam Admin | `001_karryam_admin_foundation` | `a2bd7c4ef6da75df6242f639a8c92b0bb1050cbf6e8184a47be584e4d5d7a017` | unchanged |
| Karryam Admin | `002_sections_6_8_modules_and_pipeline` | `9029b3fcff1ed3d7fef11bd45aa971d1a1494058e6212e80e6a659447ab5902e` | unchanged |
| Karryam Admin | `003_section_9_data_governance` | `3aefcb963f29890b1ceab8db033bc2437c491b934a9e7085a5556c8ce905a011` | new |
| Karryam Admin | `004_section_11_high_risk_governance` | `dfc6376ebbceb955be12eda7616e4bf68ef70fd7b25a80b8a8abb2c3bd59fd4b` | new |
| HQ | `001_product_admin_registry` | `783ed1a497ba322aa6844ed5789247f470b6385eaef7c991c6b5225733eb4d68` | unchanged |
| HQ | `002_sync_gate_and_integrity_hold` | `e9dc909eab3205cf6b66b969dea0b960feb4c25733e3097bbbe08f39df39ede9` | unchanged |
| HQ | `003_section_9_data_governance` | `630dac1f8d35699c5a3d16f4fbbee95bcac2139798f4414e11e9403ad27010d5` | new |
| HQ | `004_operations_governance` | `f151f6edceadc2c7805c137de0eaf96656bf4495fc9f0290fdfe4c75151a69af` | new |

Both `004` files were first pushed with CRLF line endings and re-committed
with LF in `b9a5832`; they had only been applied to disposable CI
databases. `.gitattributes` now stores migration bytes verbatim (`-text`),
so the checksum is identical on Windows, Linux and in the images.

Preflight of a database at release 002 (from the tests): pending `003`,
`004`; Karryam Admin `003` has one `TABLE_REWRITE` (`hq_outbox` generated
columns, small append-only table) and write-blocking index builds on new or
small tables; no blocking statements, no extensions; HQ `003` validates no
existing rows (`NOT VALID`) except where the data is new. Forward
compatibility: the previous image runs against the migrated schema (the
upgrade tests keep syncing across `003`), and the new image runs against
`002` (the HQ upgrade test onboards and syncs before migrating).

Restore drill (both schemas, local PostgreSQL 17 with pg_dump 18.4 and CI
PostgreSQL 16 with pg_dump 16): backup archive listed and checksummed,
restore into a fresh database equal by schema fingerprint, row counts and
ledger; re-applied migrations equal the migrated source; re-run applies
nothing. Reports are uploaded as CI artifacts
(`karryam-admin-restore-drill`, `hq-integration-restore-drill`).

## F. Database security evidence

| Property | Evidence |
|---|---|
| Permission separation | runtime privileges equal the documented set; runner refuses superuser/CREATEROLE/shared identities (`section9-postgres` ×2) |
| No cross-database access | runtime CONNECT to another database refused (`42501`) |
| No runtime DDL / trigger bypass | CREATE, DROP SCHEMA, ALTER … DISABLE TRIGGER, OWNER TO, `session_replication_role`, TRUNCATE refused |
| Append-only audit | owner and runtime UPDATE/DELETE/TRUNCATE refused (both schemas) |
| Protected outbox | UPDATE/DELETE/TRUNCATE refused; identity and classification checked |
| Source version integrity | older/equal versions refused; partition/scope immutable |
| Event deduplication | unique event ID; digest conflicts quarantined and held (Stage A suite) |
| Worker fencing | lease token monotonic; stale holders cannot commit (Stage A suite) |
| Monetary precision | 30-digit exact values; currency/whole-unit checks |
| Retention and legal hold | held rows survive retention; DB refuses clearing; race serialized by advisory lock |

## G. Test results

| Suite | Local (Windows, PG 17) pass / fail / skip | GitHub Actions (Linux, PG 16) |
|---|---|---|
| Karryam Admin (`npm test`, PG + KarryGo checkout) | 108 / 1* / 0 | 97 / 0 / 0 on `d7d5a5e`; 109 / 0 / 0 on the final code `b9a5832` |
| Product Integration Core (`npm test`) | 85 / 1* / 1† | migrations 5, conformance 17, Section 9 13, full 82 — all pass, 0 skip on `d7d5a5e` |
| Packages | 37 + 7 + 13 + 8 = 65 / 0 / 0 | pass |
| Central Admin product gateway | 10 / 1* / 0 | Social Operations CI pass |

\* Known Windows-only failures (Unix-socket permission bits / POSIX paths);
they pass on Linux CI. † POSIX-only configuration test skipped on Windows.
Skipped tests are not counted as passing.

## H. Git delivery

- Starting SHA `644ab48`.
- `758a427` Section 9 governance, migration discipline and restore drill
  (CI failed at workflow parsing: `runner` context in job env);
- `d7d5a5e` CI fix — all workflows green
  ([Product Admin Platform CI](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/41250850513),
  [Monorepo Layout](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/41250850619),
  Social Operations CI 41250850739 / 41250850639);
- later Section 10/11 commits are in the final acceptance report.
- Fast-forward pushes only; remote SHA verified after each push. No
  deployment workflow ran; `main` and production untouched.

## I. External database requirements (operator only)

1. Provision the four roles and the Karryam Admin database
   (`infrastructure/product-admin/postgres-roles.example.sql`, executed
   successfully against a disposable server); revoke PUBLIC CONNECT on the
   Central Admin database after granting existing roles explicitly.
2. Real credentials in the host secret manager (never in the repository).
3. Verified pre-migration staging backups; run `--preview`, then the
   migrations through the approved release workflow.
4. Encryption at rest for database volumes and backup storage, and key
   management for it: not verifiable from the repository. Assessment: no
   stored field requires application-level encryption — payloads are
   minimized operational classes, keys and certificates are file references
   only, continuation tokens are AES-256-GCM sealed, and source download
   tokens are never stored.
5. A staging restore drill on real infrastructure when permitted.
6. Database network access certification (only the two service hosts).
7. Owner-approved cutover of the legacy `karrygo/dispatch` module (reads and
   writes the Karryam Dispatch database directly via `dispatchPrisma`): not
   performed; requires source API parity, permission/readback parity,
   operational testing, owner approval and release authorization.

## J. Next section

Section 9 is code complete and tested. There is no engineering blocker for
Section 10; Sections 10 and 11 were implemented in the same delivery (see
`section-10-implementation-report.md`, `section-11-implementation-report.md`
and `sections-09-11-final-acceptance.md`).
