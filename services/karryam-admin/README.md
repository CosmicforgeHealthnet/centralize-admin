# Karryam Admin — independent Product Admin service

Karryam Admin is the independent administrative runtime for the Karryam product. It implements the **Universal Product Admin Protocol v1** for Headquarters (HQ) and owns Karryam's private, read-only connection to the Karryam Backoffice Bridge. It is **disabled by default** and has **no executable domain commands**.

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
| `GET /capabilities` | Catalog + pinned bridge contract; `bridge_live` is `BLOCKED_DEPENDENCY` until bridge trust is enrolled; with bridge enabled and a `product.capabilities.read` delegation, the live bridge discovery result (or `BLOCKED_POLICY` / `UNAVAILABLE`) |
| `GET /datasets` | `karryam.operations_daily`, `karryam.finance_daily` (both `NOT_CERTIFIED`) |
| `GET /datasets/{id}/snapshots` | 404 unknown, else 503 `SOURCE_NOT_CERTIFIED` |
| `GET /events`, `POST /events/ack` | strict params/body validation, then 503 `EVENT_SOURCE_NOT_CERTIFIED` (never an empty success) |
| `GET /sync/status` | `event_source: NOT_CERTIFIED`, coverage `NONE`, validated against `sync-status.v1` |
| `POST /operations` | Requires an `operation.submit` delegation; durably recorded as `REJECTED` (`CAPABILITY_DISABLED`), idempotent replay, 409 on key/ID reuse. **Nothing executes.** |
| `GET /operations/{id}`, `GET /audit/{id}` | Stored rejection (`executed: false`) and sanitized audit trail |

Domain reads (operations, dispatch, taxi, fleet, customers, support, verification, finance) are `BLOCKED_DEPENDENCY` (`SECTION_6_DOMAIN_MODULE_NOT_IMPLEMENTED`). Commands (wallet refund, provider verification decision, support case update, pricing update) are `DISABLED` (`COMMAND_EXECUTION_NOT_CERTIFIED`, `SECTION_11_APPROVAL_NOT_ACTIVE`).

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
