# Universal Product Admin Protocol v1 (Section 4)

Product Admin → Headquarters private protocol. One implementation of the
rules lives in `packages/` and is reused by every Product Admin and by HQ.
Machine-readable contract:
`packages/admin-contracts/openapi/product-admin-protocol-v1.openapi.json` and
`packages/admin-contracts/schemas/*.json`,
`packages/event-contracts/schemas/event-envelope.v1.json`.

These endpoints are **not** aliases for Karryam Backoffice routes
(`/internal/karryam-admin/v1`), and the Product Admin event envelope is **not**
the Bridge source-event contract.

## Endpoints

Base path `/internal/product-admin/v1`. Private transport only (Unix socket,
or TLS 1.3 mutual TLS to a private address).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/manifest` | service | Signed product manifest |
| GET | `/health/live` | none | Process liveness only |
| GET | `/health/ready` | none | Configuration/dependency readiness; never claims upstream certification |
| GET | `/capabilities` | service (+ optional product delegation) | Capability catalog with states and blockers |
| GET | `/datasets` | service | Dataset catalog |
| GET | `/datasets/{datasetId}/snapshots` | service | Authoritative bounded snapshot (`snapshot.v1`) |
| GET | `/events` | service | One bounded page for one partition (`events-page.v1`); query `dataset_id`, `partition_key`, `after_sequence`, `limit ≤ 100` |
| POST | `/events/ack` | service | Acknowledge events HQ has committed (`events-ack.v1`) |
| GET | `/sync/status` | service | Event source state and partition heads (`sync-status.v1`) |
| GET | `/operations/{operationId}` | service + product delegation (`operation.read`) | Operation status; only the requesting staff member's own operations (others answer 404) |
| POST | `/operations` | service + product delegation | Typed command (`operation-command.v1`); command scope must lie within the delegated scope; disabled unless certified |
| GET | `/audit/{operationId}` | service + product delegation (`operation.read`) | Sanitized audit trail; same ownership rule |

## Authentication

- **Service identity (`cf-svc-v1`)** — HMAC-SHA256 over
  `cf-svc-v1 LF service_id LF key_id LF METHOD LF request_uri LF unix_seconds LF nonce LF hex(sha256(body))`,
  headers `X-CF-Service-Id`, `X-CF-Key-Id`, `X-CF-Timestamp`, `X-CF-Nonce`,
  `X-CF-Signature-Version`, `X-CF-Signature`. ±30 s skew, each header exactly
  once, nonces claimed durably (replay refused). Only `hq-product-integration-core`
  is accepted by Product Admins.
- **Product delegation (`cf-product-delegation+jwt`)** — HS256, ≤ 60 s, issued by
  PIC per product with a per-product key, audience `<product_id>:<service_instance_id>`,
  bound to method + exact request URI + body digest, carrying the staff subject,
  session, `auth_time`, `mfa_at`, action, dataset, effective scope, grant role and
  grant ID. JTI claimed durably.
- **Transport** — Unix socket shared only with the caller, or TLS 1.3 mTLS with a
  client-certificate fingerprint allowlist (Karryam Admin listener) and server
  certificate pinning (HQ client).
- **Audit before execution** — every authenticated request is audited before the
  handler runs; if audit persistence is unavailable the request is refused (503
  `AUDIT_UNAVAILABLE`).

## Standard response envelope

```json
{
  "contract_version": "1.0",
  "product_id": "karryam",
  "correlation_id": "server-generated-id",
  "as_of": null,
  "freshness": "UNKNOWN",
  "coverage": "UNKNOWN",
  "result": null,
  "error": { "code": "UNAVAILABLE", "reason": "SOURCE_NOT_CERTIFIED" }
}
```

Truthfulness rules enforced by `validateEnvelope` (servers suppress violating
responses; clients reject them): an error has no result; a success has a
result; `COMPLETE`/`PARTIAL` coverage and `FRESH`/`STALE` freshness require a
genuine `as_of`; `as_of` is never in the future. Metric observations may be
`OBSERVED` only with a value, an observation time and `COMPLETE`/`PARTIAL`
coverage; `UNAVAILABLE` observations carry `null`, never zero.

## Signed manifest

`signed-manifest.v1` = `{ manifest, signature }`. The manifest contains the
immutable product ID, service instance ID, environment, display name, protocol
`{major, minor}`, build SHA, manifest revision, issued/expiry times (≤ 7 days),
workload identity, signing key ID, capability catalog (states + blockers),
dataset catalog and event-family catalog. The signature is Ed25519 over the
canonical JSON (sorted keys) with `signed_revision` and `signed_digest`.

HQ verification (`verifyManifest`) requires: the exact registry-approved key
ID; a signer enrolled by an operator for the same product and environment,
unexpired and unrevoked; a valid signature and digest; product, instance,
environment and workload identity equal to the registry; validity window;
supported protocol (same major, minor no newer than this HQ supports — an
unknown newer minor is rejected); no revision rollback; valid catalog semantics.
Every object is closed (`additionalProperties: false`), so a manifest cannot
carry URLs, callback addresses or anything else that could redirect a
connection or change permissions. Manifests propose; only reviewers decide.

No production or staging signer is enrolled. Tests generate ephemeral keys
(`packages/admin-contracts/src/testing.js`).

## Datasets and events

Dataset definitions (`dataset.v1`): ID, version, schema ID and digest (computed
over meaning-bearing fields and verified), privacy class, scope dimensions,
authorized departments, semantic grain, units, currency, freshness target,
lineage, allowed fields (type, classification, meaning, unit), metric
definitions, retention, product readiness and blockers. Fields can never be
more sensitive than their dataset. HQ refuses to approve `RESTRICTED_PII`
datasets (also a database constraint) and datasets the product has not marked
`CERTIFIED_BY_PRODUCT`.

Event families (`event-family.v1`) declare schema ID/version, dataset,
classification, projection (`METRIC_OBSERVATION` uses the standard,
product-neutral payload schema), closed payload schema, status and sunset.
Events (`event-envelope.v1`) carry event ID, source ID, product ID, dataset,
partition key, sequence, entity type/ID/version, single-valued scope,
classification, occurrence and emission times, payload and payload digest.

## Version compatibility

`compareCatalogs(pinned, proposed)` returns `IDENTICAL`, `COMPATIBLE_ADDITIVE`
or `BREAKING`. Breaking: protocol major change or minor downgrade, removed
datasets/fields/metrics/families/capabilities, changes to privacy, scope
dimensions, authorized departments, grain, units, currency, field type /
meaning / unit / classification, metric definition / aggregation / grain /
unit / currency, event schema ID / dataset / classification / projection,
incompatible payload schemas, capability kind / risk / request schema, any
breaking change without a major version, additive change without a version
bump, a silent schema-digest change, any change to a capability's
`requires_recent_mfa` or `requires_independent_approval` (authorization
rules), an event family's `version_policy`, a payload schema that drops a
required property or changes or adds any keyword other than optional
`properties`, duplicate or malformed catalog entries, an inconsistent
dataset schema digest, and any difference the comparator does not recognise
(`UNCLASSIFIED_CHANGE`).

The comparison is exhaustive: every rule records the keys it classified,
then every matched object (catalog, protocol, dataset, field, metric,
lineage, event family, capability) is compared key by key in canonical form,
and any difference no rule accounted for is `UNCLASSIFIED_CHANGE`, also when
recognised changes accompany it. A change in the relative order of entries
or set values is unclassified too. Object key order is never a difference
(canonical form). An unrecognised change can therefore never pass as
`IDENTICAL` or `COMPATIBLE_ADDITIVE`. `activationDecision` refuses a
comparison whose decision disagrees with its own change list, and contract
activation re-compares the candidate against the contract active at that
moment with the current comparator. Capability state, lineage (known keys),
title, blockers, sunset and pure version bumps are additive but always need
review. Nothing activates automatically:
additive revisions need certification and explicit activation by a different
person; breaking revisions are recorded as `REJECTED` and need a new
registration with a dual-read migration plan. Pinned contract and schema
digests are stored immutably in `hq_product_admin_contracts`.

## Karryam Admin implementation status

| Capability | Kind | State | Blocker |
|---|---|---|---|
| `karryam.bridge.capabilities.read` | METADATA | BLOCKED_DEPENDENCY (READ_ONLY only when the bridge is enrolled and enabled) | `BRIDGE_TRUST_NOT_ENROLLED` |
| `karryam.{operations.overview,dispatch,taxi,fleet,customers,support,verification,finance}.read` | READ | BLOCKED_DEPENDENCY | `SECTION_6_DOMAIN_MODULE_NOT_IMPLEMENTED` |
| `karryam.wallet.refund`, `karryam.provider.verification.decide`, `karryam.support.case.update`, `karryam.pricing.update` | COMMAND | DISABLED | `COMMAND_EXECUTION_NOT_CERTIFIED`, `SECTION_11_APPROVAL_NOT_ACTIVE` |

Datasets `karryam.operations_daily` (INTERNAL) and `karryam.finance_daily`
(CONFIDENTIAL, NGN) and event family `karryam.metric_observation` are
`NOT_CERTIFIED` (`SOURCE_EVENT_PIPELINE_NOT_IMPLEMENTED`). Endpoint behaviour:
manifest is signed when a signer key is provisioned (otherwise 503
`MANIFEST_SIGNER_NOT_PROVISIONED`); snapshots 503 `SOURCE_NOT_CERTIFIED`;
events and ACK 503 `EVENT_SOURCE_NOT_CERTIFIED` (never an empty success);
sync status reports `NOT_CERTIFIED` with coverage `NONE`; every command is
durably recorded as `REJECTED` and answered 403 — no command executes.

## Security tests (where)

| Requirement | Test |
|---|---|
| Invalid / forged manifest signature | `packages/admin-contracts/tests/protocol.test.js` |
| Expired / not-yet-valid / over-long manifest | same |
| Unapproved protocol / contract version | same |
| Manifest URLs cannot redirect | same; plus `service-clients` redirect refusal |
| Cross-product identity | same; `event-contracts`; `service-clients/tests/protocol-server.test.js` |
| Cross-market / cross-tenant | `identity-and-permissions`, `event-contracts`, PIC conformance step 17 |
| Unknown datasets denied | Karryam Admin protocol tests; PIC API tests |
| Revoked access | `identity-and-permissions`; PIC API and conformance step 20 |
| Disabled writes cannot execute | Karryam Admin protocol tests; PIC API tests |
| Incompatible revisions cannot activate | `admin-contracts` compatibility; PIC conformance step 18 |
| Missing data never becomes success | envelope tests; Karryam events/snapshots; PIC metric `NO_SOURCE_OBSERVATION` |
