# HQ integration registry, onboarding and synchronization (Section 5)

Implemented in `services/product-integration-core` (PIC) and exposed to staff
through the Central Admin API gateway. Product-neutral throughout.

## 5.1 Registry database

Schema `hq_integration` inside the Central Admin-owned PostgreSQL
(`cosmicforge_admin`), created by `migrations/001_product_admin_registry.sql`.
It does not touch `admin_ops_service_registry`, Mail, HealthNet or any
product database.

| Table | Key constraints |
|---|---|
| `hq_product_admins` | unique `service_instance_id`; one live registration per `(product_id, environment)`; identity, endpoint_ref, workload identity, signer and requester immutable; `REVOKED`/`REJECTED` terminal; status changes must bump `revision` by one; `ENABLED` requires active contract, activation metadata and verified identity |
| `hq_product_admin_contracts` | unique `(product_admin_id, revision)` and `(product_admin_id, catalog_digest)`; one `ACTIVE` per registration; catalog/digests immutable; status only `VALIDATED→CERTIFIED|REJECTED`, `CERTIFIED→ACTIVE|REJECTED`, `ACTIVE→SUPERSEDED`; certifier ≠ validator |
| `hq_product_admin_grants` | product XOR platform; no `*` in actions/datasets/scope; no self-grant; immutable except one-time revocation; no delete |
| `hq_product_admin_datasets` | unique `(product_admin_id, dataset_id, version)`; definitions immutable; `RESTRICTED_PII` can never be `APPROVED`; approval requires approver and time |
| `hq_product_admin_subscriptions` | one stream per product dataset; no `*` scope; bounded poll/page/freshness |
| `hq_product_admin_event_inbox` | unique `(product_admin_id, event_id)` and `(subscription_id, partition_key, sequence)`; no restricted classification; append-only (no update/delete/truncate) |
| `hq_product_admin_sync_cursors` | unique partition; `last_sequence`, `acked_sequence`, `lease_token` monotonic; `acked ≤ last`; gap bounds consistent |
| `hq_product_admin_metrics` | unique point `(product_admin_id, metric_id, definition_version, scope_key, window)`; `OBSERVED ⇔ value present`; observed values need source time and coverage; replacement only by a strictly newer source entity version (row version bumped); unit/grain/currency immutable |
| `hq_product_admin_lineage` | exactly one source (inbox event or snapshot); append-only |
| `hq_product_admin_sync_runs` | run status, counts, ACK status, fencing token, sanitized error code |
| `hq_product_admin_quarantine` | sanitized metadata only (no payloads); one record per event and reason |
| `hq_product_admin_onboarding_approvals` | append-only history of every transition and decision |
| `hq_product_admin_security_audit` | append-only, sanitized metadata |
| `hq_product_admin_replay_nonces` | durable JTI/nonce replay protection |

No secrets are stored: rows hold an `endpoint_ref` and signer key ID; the
destination, TLS material and keys live in operator files.

Credentials: `pic_migrator` (DDL, owns the schema) and `pic_runtime` (DML only:
no DDL, no deletes except replay nonces, insert/select only on append-only
tables). Tests run fresh migrations on a disposable PostgreSQL and prove the
runtime restrictions.

## 5.2 Onboarding state machine

```text
DRAFT → REQUESTED → IDENTITY_VERIFIED → CONTRACT_VALIDATED → POLICY_REVIEWED → CERTIFIED_STAGING → ENABLED
  any non-terminal → REJECTED (terminal) | SUSPENDED | REVOKED (terminal)
  SUSPENDED → REQUESTED only by an explicit approver (all gates again)
```

| Step | Platform action | Gate |
|---|---|---|
| request | `integration.request` | environment = PIC environment; endpoint_ref allowlisted **for this product**; signer enrolled for this product; registration is untrusted |
| verify-identity | `integration.verify` | manifest fetched from the pinned target; signature by the approved signer; product, instance, environment, workload identity match; TLS pin matches `identity_fingerprint_ref` when TLS is used |
| validate-contract | `integration.verify` | fresh verified manifest, no revision rollback; immutable contract revision; compatibility vs active contract (breaking → recorded `REJECTED`, 409) |
| review-policy | `integration.review` | reviewer ≠ requester |
| approve dataset | `integration.review` | reviewer ≠ requester; product readiness `CERTIFIED_BY_PRODUCT`; never `RESTRICTED_PII` |
| certify-staging | `integration.certify` | evidence reference; ≥ 1 approved dataset; certifier ≠ requester and ≠ contract validator |
| approve (→ ENABLED) | `integration.approve` | approver ≠ requester and ≠ certifier; certified contract; manifest unexpired; identity verified; ≥ 1 approved dataset |
| suspend / revoke / reject | `integration.suspend` / `.revoke` / `.review` | reason code; revoke disables subscriptions and releases leases |

Every transition requires `expected_revision` (stale → 409), records an
approval row and an audit row in the same transaction, and requires recent
MFA (5 minutes) because platform actions carry that requirement. A product
can never register itself or move itself forward; a new manifest only
creates drift for review.

## 5.3 Registration record

Product ID, display name, service instance ID, environment, endpoint_ref,
workload identity, certificate fingerprint reference, approved signer key ID,
current contract, manifest digest/revision/expiry, lifecycle status and
revision, supported protocol, allowed markets/organizations/zones/tenants,
activation/suspension/revocation metadata, health, sync and drift status.

## 5.4 Headquarters API

All routes require an existing staff session (cookie or bearer, CSRF for
cookie writes), are forwarded only if they match the allowlist, and are
authorized in PIC from explicit grants. Admin routes also require MFA within
5 minutes at the gateway.

| HQ route (Central Admin API) | Action |
|---|---|
| `GET /api/products` | navigation contract (no action needed; only products with a `product.view` grant appear) |
| `GET /api/products/:productId/manifest` | `product.manifest.read` |
| `GET /api/products/:productId/capabilities` | `product.capabilities.read` (recent MFA; live via product delegation) |
| `GET /api/products/:productId/datasets` | `dataset.list` (+ per-dataset `metric.read` visibility) |
| `GET /api/products/:productId/metrics/:metricId` | `metric.read` on the metric's dataset, exact scope |
| `GET /api/products/:productId/events/status` | `events.status.read` |
| `GET /api/products/:productId/operations/:id` | `operation.read` |
| `POST /api/products/:productId/operations` | `operation.submit` → always 403 `DISABLED` in this phase; nothing forwarded |
| `GET/POST /api/admin/product-integrations` | `integration.read` / `integration.request` |
| `GET /api/admin/product-integrations/:id[/monitoring]` | `integration.read` |
| `POST /api/admin/product-integrations/:id/{verify-identity,validate-contract,review-policy,certify-staging,approve,reject,suspend,revoke,resume-review}` | per table above |
| `POST /api/admin/product-integrations/:id/datasets/:datasetId/approve` | `integration.review` |
| `POST /api/admin/product-integrations/:id/subscriptions[/:sid/{enable,disable}]` | `integration.subscriptions.manage` |
| `POST /api/admin/product-integrations/:id/contracts/propose` · `/:cid/certify` · `/:cid/activate` | `integration.verify` · `.certify` · `.approve` |
| `POST /api/admin/product-integrations/:id/health-check` · `/sync` | `integration.verify` · `integration.subscriptions.manage` |
| `POST /api/admin/product-integration-grants[/:grantId/revoke]` | `integration.grants.manage` |

`SUPER`, `EXECUTIVE` and `ADMIN` tiers get nothing implicitly (tested).

## 5.5 Navigation contract

`GET /api/products` returns, per granted product: `product_id`,
`display_name`, `available`, `reason` (`NOT_REGISTERED`, `NOT_ENABLED`,
`PROTOCOL_INCOMPATIBLE`, `IDENTITY_NOT_VERIFIED`, `CONTRACT_DRIFT` or null), lifecycle status,
contract revision, protocol, effective scope, grant role, capability state
counts, datasets with `granted` flags (computed with the same decision as
the metric read: expiry, explicit deny, dataset and scope) and `navigation` metadata (only when
available). The frontend is unchanged; specialised product pages remain
separate work.

## 5.6 Synchronization algorithm → code

| # | Requirement | Implementation (`src/sync/engine.js`) |
|---|---|---|
| 1 | only enabled, approved subscriptions | `loadSubscriptions`: product `ENABLED`, contract `ACTIVE`, dataset `APPROVED`, subscription enabled+`ACTIVE`, schema digest present in active contract |
| 2 | partition lease with fencing | `acquireLease`: `lease_token + 1`, expiry; every commit re-checks owner + token `FOR UPDATE` |
| 3 | destination from registry | `clientFor(endpoints, row)` via `endpoint_ref`; endpoint bound to product+environment |
| 4 | approved service identity | `cf-svc-v1` keys from the endpoint entry; TLS pin for HTTPS |
| 5 | bounded page | `limit ≤ page_limit ≤ 100`, 1 MiB response cap, `events-page.v1` validation |
| 6 | verify identity, schema, digest, sequence, source, scope | Per run, before any request: `identityBlock` — approved signer present in the trust store, unrevoked, unexpired, enrolled for this product/environment; stored manifest unexpired; no `IDENTITY_MISMATCH`/`MANIFEST_EXPIRED`/`MANIFEST_INVALID` drift (run result `BLOCKED_IDENTITY` + alert). Per event: `createEventRegistry(...).validate` + `sequenceDecision` |
| 7 | privacy and authorization policy | restricted classification refused; subscription allowed scope; dataset dimensions |
| 8 | durable append-only inbox | `hq_product_admin_event_inbox` |
| 9 | same ID, different digest | `DIGEST_CONFLICT` quarantine; identical replays counted as duplicates |
| 10 | domain-neutral projections only | `METRIC_OBSERVATION` against the pinned metric definition; other standard families (`projection: NONE`) are validated, stored and sequenced but never projected |
| 11 | lineage + cursor in the same transaction | one transaction per event |
| 12 | commit | — |
| 13 | ACK after commit | `ack()` after the page; tested by inspecting the inbox from the ACK handler |
| 14 | retry ACK without re-applying | pending `acked < last` is retried first next run |
| 15 | quarantine invalid/unsupported/out-of-scope/drifted | `quarantine()`; cursor advances, coverage `PARTIAL` |
| 16 | stop at gaps | `GAP` records `gap_from/gap_to`, stops the partition |
| 17 | sanitized alerts | `integration.alert` audit rows + structured logs |
| 18 | reconcile from snapshots | `reconcilePartition`: approved snapshot, version-guarded apply, cursor advanced only if the snapshot covers the gap |
| 19 | never older over newer | `ON CONFLICT ... WHERE source_entity_version < EXCLUDED...` + trigger |
| 20 | stop on revocation | product row `FOR SHARE` per event; revoked → run `ABORTED_REVOKED`, no ACK, no further requests |

## 5.7–5.9 Subscriptions, metrics, monitoring

Subscriptions carry dataset, pinned schema revision and digest, allowed
scope (⊆ product scope), consumer department (must be authorized by the
dataset), freshness target, poll interval, page limit, enabled flag, status
(`ACTIVE`/`SUSPENDED`/`POLICY_BLOCKED`), last success, last source
observation, last reconciliation, coverage, gap status and quarantine count.

Metric reads are exact-scope (no aggregation across scopes, products or
currencies); a missing observation is 503 `NO_SOURCE_OBSERVATION`, never
zero; `as_of` is the oldest genuine source observation; coverage is
`PARTIAL` whenever the stream had gaps or quarantines.

`GET .../monitoring` reports registry status, identity and manifest expiry,
connection health, contract and drift, datasets, subscriptions with lag,
cursors with sequence lag, unacknowledged counts and gaps, 24 h run stats
(failed ACKs, lease failures, failed runs, last success), quarantine counts
and alert counts by reason. Health is never inferred from local liveness.

The scheduled health check runs before every scheduled synchronization tick.
A fully verified manifest from the approved signer with an unchanged catalog
refreshes the stored manifest digest, revision and expiry; anything else
records drift and stops synchronization (above) until a later check verifies
again. Lifecycle state is never changed by a health check, so a `SUSPENDED`
or `REVOKED` product is never reactivated by a new manifest.

## 5.10 Universal onboarding conformance

`services/product-integration-core/tests/conformance-synthetic-third-postgres.test.js`
runs the 20 required steps against a synthetic third Product Admin
(`tests/helpers/synthetic-product-admin.js`, test-only) through the real PIC
HTTP API and a disposable PostgreSQL. The HQ engine contains no product
literal or branch (`tests/static-boundaries.test.js`), and Karryam Admin goes
through the same path (`tests/karryam-through-hq-postgres.test.js`).

## Runbook

### Install (staging, operator)

1. Create roles (`infrastructure/product-admin/postgres-roles.example.sql`).
2. Take a backup of `cosmicforge_admin` (existing CA DB procedure).
3. `PIC_MIGRATION_DATABASE_URL=... PIC_RUNTIME_ROLE=pic_runtime npm run migrate`
   in `services/product-integration-core` (from an approved GitHub Actions job
   or the operator host — never by an agent on the VPS).
4. Bootstrap platform grants for at least three distinct people
   (`scripts/bootstrap-platform-grant.js`).
5. Deploy with `PIC_ENABLED=false`, then enable after configuration review.

### Rollback

Migrations are forward-only. The schema is additive and isolated, so the
application rollback is: set `PRODUCT_INTEGRATION_ENABLED=false` on the API,
`PIC_ENABLED=false` (or stop PIC); existing features are unaffected. To
remove the schema entirely (only if no evidence must be kept), restore from
the pre-migration backup or, after exporting the audit and approval tables,
`DROP SCHEMA hq_integration CASCADE` as the migrator. Never edit an applied
migration file — the runner refuses a changed checksum.

### Restore

`pg_dump --format=custom --schema=hq_integration` and `pg_restore --no-owner`
into a database prepared with the same roles, then run `npm run migrate` with
`PIC_RUNTIME_ROLE` to re-apply runtime grants (the ledger is restored, so no
DDL re-runs). The restore test proves data, ledger and append-only guards
survive. After a restore, cursors resume from their restored positions;
events newer than the backup are re-fetched (they were not ACKed beyond the
restored `acked_sequence` unless the product pruned them — in that case the
gap is reconciled from snapshots).
