# Karryam Admin — independent Product Admin service

Karryam Admin is the independent administrative runtime for the Karryam product. It implements the **Universal Product Admin Protocol v1** for Headquarters (HQ) and owns Karryam's private, read-only connection to the Karryam Backoffice Bridge. It is **disabled by default**; no source command is executable unless an operator explicitly enables an R1/R2 command after the source policy approves it.

```text
HQ Product Integration Core ──(cf-svc-v1 + delegation, private transport)──▶ Karryam Admin
Karryam Admin ──(TLS 1.3 mTLS + HMAC v2 + Ed25519 staff assertion)──▶ Karryam Backoffice Bridge ──▶ native owner services
```

HQ never calls the bridge or any Karryam operational database. Karryam Admin never connects to HQ's database or to Karryam source databases; it has its own dedicated administrative database.

## What works now

- Own Node.js 22 runtime (`src/server/index.js`), strict fail-closed configuration, structured redacted JSON logs, correlation/request IDs, bounded bodies (64 KiB), request/header timeouts, graceful SIGTERM/SIGINT shutdown.
- Private-only listener: Unix socket (default `/run/cosmicforge/karryam-admin.sock`, mode 0660), loopback TCP, or a private-IP TCP listener that **requires** TLS 1.3 mutual TLS with an allowlist of client certificate SHA-256 fingerprints. Wildcard and public addresses are refused.
- All 12 Protocol v1 endpoints under `/internal/product-admin/v1`, mounted through the shared `createProductAdminHandler` kit (`packages/service-clients`): service authentication (cf-svc-v1 HMAC, durable nonce replay protection), delegated staff identity (`cf-product-delegation+jwt`, bound to method/path/body, ≤60 s, durable JTI replay protection), audit-before-execute (no audit, no access), envelope validation.
- Signed product manifest (`product_id` exactly `karryam`) when an operator provisions an Ed25519 signer; otherwise `503 UNAVAILABLE MANIFEST_SIGNER_NOT_PROVISIONED`.
- Pinned KarryGo bridge contract metadata (`src/bridge/contracts/karrygo-backoffice-v1.json`, KarryGo staging `a4adee68…`, 435 capabilities: 370 READ_ONLY / 52 AVAILABLE / 7 BLOCKED_DEPENDENCY / 6 DISABLED). Source-matrix `AVAILABLE` is artifact state, never runtime authorization.
- Read-only bridge capability discovery (ported from validated PR #36 code): pinned private IP, TLS 1.3 mTLS, HMAC v2, Ed25519 staff assertion with `request_digest`, one fixed path, 256 KiB cap, no redirects. Staff context requires recent MFA (≤300 s), an HQ **product grant role** mapped by `KARRYAM_ADMIN_ROLE_MAP` (staff tiers are rejected) and the bridge market/organization inside the delegated scope — all checked before any network call.
- Dedicated database schema `karryam_admin`: append-only `integration_audit` (triggers + runtime role without UPDATE/DELETE/TRUNCATE), `request_nonces`, and `operation_requests` whose CHECK constraint only allows `REJECTED`.

## Endpoint behaviour

| Endpoint | Behaviour today |
|---|---|
| `GET /health/live` (also `/internal/product-admin/v1/health/live`) | 200 process liveness only |
| `GET /health/ready` | 200 `CONFIGURED` when the database answers, else 503; always `upstream_certified: false`; 503 `DISABLED` when disabled |
| `GET /manifest` | Signed manifest, or 503 `MANIFEST_SIGNER_NOT_PROVISIONED` |
| `GET /capabilities` | Catalog, pinned Bridge contract and registry summary, `modules`, `reports`, the 435-entry `capability_map`; `bridge_live` discovery with a `product.capabilities.read` delegation |
| `GET /datasets` | `karryam.support_operations`, `karryam.verification_pipeline`, `karryam.marketing_campaigns`, `karryam.sync_health` (`NOT_CERTIFIED` unless listed in `KARRYAM_ADMIN_CERTIFIED_DATASETS`) |
| `GET /datasets/{id}/snapshots` | 404 unknown; 503 `DATASET_NOT_CERTIFIED` / `EVENT_SOURCE_NOT_CERTIFIED`; else a consistent snapshot of the latest observations with `through_sequence` |
| `GET /events`, `POST /events/ack` | Derived outbox pages (contiguous sequences) and monotonic HQ ACKs; 503 while the dataset is uncertified or the pipeline is off (never an empty success) |
| `GET /sync/status` | `CERTIFIED` only with a running pipeline and a certified dataset; partitions and heads from the outbox |
| `POST /operations` | Governed pipeline: disabled capabilities durably `REJECTED`; enabled R1/R2 commands recorded, dispatched once, settled by owner evidence (`UNKNOWN_OUTCOME` otherwise); local approval propose/decide |
| `GET /operations/{id}`, `GET /audit/{id}` | Requester-only status with authoritative readback of unsettled operations; sanitized audit trail |
| `GET /resources/...`, `GET /reports/...` (1.1) | Scoped module reads and reports through the pinned Bridge connector or local projections (see below) |

### Sections 6–8 (this service)

- **Modules (Section 6).** 17 modules cover all 435 pinned Bridge capabilities
  (`src/modules/catalog.js`). Reads: Protocol 1.1 `GET /resources/{module read
  capability}/{Bridge collection}[/{id}]` — scoped, bounded (≤100, ≤31 days),
  purpose-bound, sealed continuation tokens, audited, sensitive-access logged.
  Reports: `GET /reports/karryam.report.<id>` (14 reports, `src/modules/reports.js`).
  Commands: `POST /operations` governed pipeline (`src/operations/service.js`);
  all 58 source commands are DISABLED unless listed in
  `KARRYAM_ADMIN_ENABLED_COMMANDS` (R1/R2 only).
- **Connector (Section 7).** `src/bridge/client` + pinned registry
  `src/bridge/contracts/karrygo-capabilities.v1.json` (regenerate and review with
  `KARRYGO_CHECKOUT=... node scripts/pin-bridge-contract.js [--write]`; CI fails
  on drift).
- **Pipeline (Section 8).** Stage A worker `node src/worker/index.js` (Bridge
  feed → inbox → projections → derived outbox, ACK after commit); Stage B is
  served by `/events`, `/events/ack`, `/sync/status`, `/datasets/{id}/snapshots`
  from the derived outbox. Operator tools: `node scripts/pipeline-ops.js
  status | reconcile [--full-backfill] | release-hold --partition .. --resolution .. --operator ..`.

Evidence and blockers: [docs/product-admin/sections-6-8-implementation-report.md](../../docs/product-admin/sections-6-8-implementation-report.md).

## Run, test, migrate

```bash
cd services/karryam-admin
npm ci
npm run check
npm test                                  # Postgres test skipped
KARRYAM_ADMIN_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres npm test   # disposable server only
```

The Postgres test creates and drops its own `ka_test_*` database and roles. Never point it at staging or production.

Migrations are forward-only and use a separate credential that the server never reads:

```bash
KARRYAM_ADMIN_MIGRATION_DATABASE_URL=postgresql://<migrator>@<host>/<db> KARRYAM_ADMIN_RUNTIME_ROLE=<runtime_role> npm run migrate
```

The runner takes an advisory lock, applies each file in its own transaction, records SHA-256 checksums and refuses to continue if an applied file changed. It never creates roles or passwords; the operator provisions a migration (owner) role and a runtime login role. **Rollback/restore:** take a `pg_dump` of the Karryam Admin database before migrating; to roll back, restore that dump (there are no down-migrations). The schema holds only integration metadata, nonces and rejected-operation records.

## Container

```bash
docker build -f services/karryam-admin/Dockerfile -t karryam-admin:local .   # from the repository root
```

Non-root (uid/gid 10001), no `EXPOSE`, default Unix socket in `/run/cosmicforge` (mount a host directory shared only with the approved Product Integration Core group). `Dockerfile.dockerignore` limits the build context to the shared packages and this service.

## Configuration

See `.env.example`. Every secret comes from an operator-mounted file referenced by an absolute path. Enabling the service without any required value stops startup with a sanitized reason code (for example `KARRYAM_ADMIN_ENVIRONMENT_REQUIRED`). Runtime and migration database URLs must differ.

## External blockers (operator action required)

- Approved HQ ↔ Karryam Admin service keys and delegation keys (`*_KEYS_FILE`), and the HQ registry's approved workload identity/fingerprint.
- Production/staging manifest signing key enrollment in the HQ trust store (no signer identity is invented here).
- Karryam Admin database, migration role and runtime role on the target host.
- KarryGo bridge trust enrollment: HQ client certificate fingerprint, HMAC key ID, staff Ed25519 key ID, issuer/audience, approved read role(s) and market/organization policy.
- Private network/socket provisioning via the approved GitHub Actions deployment workflow (no direct VPS access, no public ingress).
