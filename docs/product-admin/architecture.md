# Product Admin architecture (Sections 2 and 3)

## Topology as implemented

```text
AUTHORIZED STAFF / HQ DEPARTMENTS
        │  browser (session cookie or bearer; no internal keys)
        ▼
CENTRAL ADMIN WEB (unchanged)
        │
        ▼
CENTRAL ADMIN API  services/central-admin-api
  existing auth: session, CSRF, MFA ──► product gateway  src/modules/product-gateway
        │  /api/products/*, /api/admin/product-integrations/*, /api/admin/product-integration-grants/*
        │  private Unix socket (or loopback), cf-hq-delegation+jwt (30 s, request-bound)
        ▼
PRODUCT INTEGRATION CORE  services/product-integration-core      ──► hq_integration.* (Central Admin-owned DB)
  registry · onboarding · grants · subscriptions · sync engine · projections · monitoring
        │  registry-pinned target (Unix socket today; TLS 1.3 mTLS + pinned private IP later)
        │  cf-svc-v1 service signature + cf-product-delegation+jwt for staff reads
        ▼
APPROVED PRODUCT ADMINS (Universal Product Admin Protocol v1, /internal/product-admin/v1)
  ├─ KARRYAM ADMIN   services/karryam-admin   ──► karryam_admin.* (its own admin DB)
  │        │ TLS 1.3 mTLS + HMAC v2 + Ed25519 staff assertion (disabled until enrolled)
  │        ▼
  │   KARRYAM BACKOFFICE  /internal/karryam-admin/v1 (KarryGo) ──► native owner services ──► source DBs
  ├─ HEALTHNET ADMIN  services/healthnet-admin (existing; must implement Protocol v1 before onboarding)
  └─ FUTURE PRODUCT ADMINS (same protocol; synthetic conformance product proves it)
```

## Authority boundaries in code

| Component | Owns | Never does |
|---|---|---|
| Central Admin API | Staff login, sessions, CSRF, MFA, browser-facing routes, signing the HQ delegation after session checks | Product authorization by tier; calling Product Admins or bridges directly; holding product keys |
| Product Integration Core | Registry, approved contract revisions, identity verification, onboarding approvals, staff product/platform grants, datasets, subscriptions, generic ingestion, cursors, projections, quarantine, drift detection, monitoring | Product-specific rules (enforced by `tests/static-boundaries.test.js`); contacting a product bridge; touching operational databases; trusting URLs from manifests/events |
| Karryam Admin | Its runtime, protocol endpoints, Karryam capability/dataset/event catalog, product-level audit, rejected-operation records, the bridge client, its own `karryam_admin` schema | Executing domain commands (none are enabled); exposing the bridge; sharing HQ databases |
| Karryam Backoffice (KarryGo) | Private, policy-controlled access to owner services | — (unchanged; a source contract dependency only) |
| Native owner services | Source records and business decisions | — |

## Data access rule

Every new call path is `HQ → Product Admin → Product Bridge → Source Owner`:

- The gateway can only reach PIC (fixed socket/loopback; non-loopback refused).
- PIC can only reach Product Admins through `endpoint_ref` entries in the
  operator allowlist; entries are bound to one product and environment, and
  targets are pinned private IPs or Unix sockets. Public, link-local
  (metadata), CGNAT and unspecified addresses are refused; no redirects.
- Only Karryam Admin holds the Karryam bridge configuration, and it is off by
  default. HealthNet and future products never use the Karryam bridge.
- Static tests assert that the gateway and PIC source never reference
  `/internal/karryam-admin`, Prisma, `DISPATCH_DATABASE_URL` or
  `MAIN_DATABASE_URL`, and that Karryam Admin never imports the Central Admin
  API or its databases.

Not allowed and not possible through the new code: HQ → Product Bridge,
HQ → operational database, HQ → operational microservice, browser → private
bridge. Public ingress must also deny `/internal/*`
(`infrastructure/product-admin/nginx-internal-deny.example.conf`).

## Monorepo structure (Section 3)

```text
apps/central-admin-web/              existing, unchanged
services/central-admin-api/          existing + src/modules/product-gateway (disabled by default)
services/product-integration-core/   NEW independent HQ service
services/karryam-admin/              NEW independent Product Admin (was a placeholder)
services/healthnet-admin/            existing, unchanged
packages/admin-contracts/            implemented (Protocol v1 schemas, manifest, compatibility, envelopes)
packages/service-clients/            implemented (fixed targets, mTLS client, service auth, server kit)
packages/event-contracts/            implemented (event envelope, registry, sequencing)
packages/identity-and-permissions/   implemented (grants, scopes, delegation)
infrastructure/product-admin/        operator templates (not deployed)
```

Packages have no runtime dependencies and are consumed by relative path; the
two new service images are built from the repository root with per-Dockerfile
ignore files and preserve the `packages/` + `services/<name>/` layout. The
existing API image is unchanged and still cannot see `packages/` (the layout
guard asserts this), so the gateway carries its own 40-line token signer whose
byte compatibility with `identity-and-permissions` is proven in its tests.

## Security properties shared by every hop

- Independent authorization at each boundary: the API checks the session and
  MFA; PIC re-verifies the delegation and authorizes from explicit grants;
  Product Admins re-verify service identity and product delegation and apply
  their own policy; the bridge applies its own mTLS/HMAC/assertion checks.
- Short-lived, request-bound tokens (method + path + body digest), durable
  replay protection (JTIs and nonces stored in PostgreSQL), strict claim sets.
- Fail closed: missing configuration, unavailable policy store, unavailable
  audit persistence or replay store → refusal, never a fallback.
- Bounded request and response sizes, timeouts, no redirects, JSON only.
- Logs are structured and never contain keys, tokens, bodies or headers.

## Same VPS now, multiple VPSs later

Only transport configuration changes when a service moves hosts: a Product
Admin endpoint entry switches from `transport: unix` to `transport: https`
with a pinned private address, server certificate pin and client
certificate; Karryam Admin switches its listener to `tcp:<private-ip>` with
mandatory TLS 1.3 mTLS and a client fingerprint allowlist. Protocol paths,
contracts, registry rows, grants and business logic are unchanged.
Co-location never grants implicit trust: every request is authenticated
exactly as it would be across hosts.

## Disabled by default

| Switch | Default | Effect while off |
|---|---|---|
| `PRODUCT_INTEGRATION_ENABLED` (API) | `false` | New routes authenticate, then answer 503 `PRODUCT_INTEGRATION_DISABLED` |
| `PIC_ENABLED` | `false` | Liveness only; all API calls 503 |
| `PIC_SYNC_ENABLED` | `false` | No scheduled synchronization or health polling |
| `KARRYAM_ADMIN_ENABLED` | `false` | Liveness only; protocol endpoints 503 `INTEGRATION_DISABLED` |
| `KARRYAM_BRIDGE_ENABLED` | `false` | Bridge capability is `BLOCKED_DEPENDENCY` |
| Product operations | always refused | `POST .../operations` returns 403 `DISABLED`; nothing is forwarded |
