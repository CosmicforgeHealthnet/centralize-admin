# Product Integration Core (HQ)

Headquarters' reusable, product-neutral integration service. It owns the
Product Admin **registry**, **onboarding**, **dataset subscriptions**, the
generic **synchronization engine**, **metric projections**, **quarantine**,
**contract drift detection** and **integration monitoring**.

It is not a Karryam connector. Karryam, HealthNet and any future CosmicForge
product are onboarded through the same registry model and the same
[Universal Product Admin Protocol v1](../../docs/product-admin/protocol-v1.md).
There is no product-specific code in `src/` (enforced by
`tests/static-boundaries.test.js`).

**Status: code complete and tested against disposable PostgreSQL. Disabled by
default. Not deployed.** Staging activation needs the operator items listed
under [External dependencies](#external-dependencies).

## Boundaries

```text
Central Admin API --(private socket, cf-hq-delegation+jwt)--> Product Integration Core
Product Integration Core --(registry-pinned target, cf-svc-v1 + mTLS/socket)--> Product Admin
```

- Callers: only the Central Admin API, with a 30-second, request-bound HQ
  delegation token signed by a key shared only by those two services. PIC
  re-verifies it, claims its `jti` durably (replay protection) and
  independently authorizes every action from explicit grants. Staff tier is
  never consulted.
- Destinations: only Product Admins, resolved from the operator endpoint
  allowlist through the registry's `endpoint_ref`. Never a product bridge,
  never an operational database, never a URL from a manifest or event.
- Data: only approved, non-restricted datasets; only the domain-neutral
  `METRIC_OBSERVATION` projection is applied.

## Layout

| Path | Purpose |
|---|---|
| `migrations/001_product_admin_registry.sql` | `hq_integration` schema: the 13 `hq_product_admin_*` tables, guards and triggers |
| `src/db/migrate.js`, `scripts/migrate.js` | Forward-only, checksum-verified migrations; runtime grants |
| `scripts/bootstrap-platform-grant.js` | Operator bootstrap of the first platform grants (audited) |
| `src/onboarding/state-machine.js` | Pure lifecycle rules |
| `src/onboarding/service.js` | Registration, identity verification, contract validation, reviews, certification, activation, suspension, revocation, datasets, subscriptions, grants |
| `src/registry/endpoints.js` | Operator endpoint allowlist, signer trust store, fixed product clients |
| `src/registry/health.js` | Connection, identity and contract-drift checks |
| `src/sync/engine.js` | Generic leased, fenced, idempotent synchronization and reconciliation |
| `src/projections/metrics.js` | Version-protected metric projection |
| `src/monitoring/index.js` | Sanitized integration status |
| `src/api/app.js`, `src/api/products.js` | Internal API (`/internal/pic/v1`) |
| `src/config`, `src/server` | Fail-closed configuration, private listener, scheduler, shutdown |

## Run and test

```bash
cd services/product-integration-core
npm ci
npm run check
npm test                                    # unit + static tests; PostgreSQL tests skip
PIC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres npm test   # full suite on a DISPOSABLE server
```

`PIC_TEST_DATABASE_URL` must be a superuser on a throwaway PostgreSQL. Each
test creates and drops its own database plus a separate migration role and
runtime role.

Migrations (migration credential only):

```bash
PIC_MIGRATION_DATABASE_URL=postgresql://pic_migrator@db/cosmicforge_admin PIC_RUNTIME_ROLE=pic_runtime npm run migrate
```

Container (build context is the repository root):

```bash
docker build -f services/product-integration-core/Dockerfile -t product-integration-core:local .
```

The image runs as uid 10002, exposes no port and listens on a Unix socket by
default. With `PIC_ENABLED=false` (default) it answers `/health/live` and
refuses everything else with `503 PRODUCT_INTEGRATION_DISABLED`.

## Configuration

See `.env.example`. Operator JSON file formats are documented with examples in
[`infrastructure/product-admin/`](../../infrastructure/product-admin/README.md).
Startup refuses: missing environment or credentials, identical runtime and
migration credentials, public/unspecified listen addresses, remote TCP without
an mTLS step, keys shorter than 32 bytes, keys reused across trust boundaries,
HQ delegation keys without expiry, and insecure loopback transport outside
test/development.

## External dependencies

Operator actions, not code: approved Product Admin workload identities and
certificates (for TLS transports), signer public keys enrolled in the trust
store, per-product service and delegation keys, the HQ delegation key shared
with the Central Admin API, staging database roles (`pic_migrator`,
`pic_runtime`) and the migration run, the first platform grants, and a
deployment definition (none is added to the staging workflows yet).
