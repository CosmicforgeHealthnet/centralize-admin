# HealthNet Admin — independent service foundation

**Current scope: runnable, independently containerized read-only administrative boundary. Not yet connected to HQ or the live HealthNet platform.** The HealthNet source VPS is currently offline. The original full HealthNet administration remains inside `services/central-admin-api` until parity and authorization certification.

## What works

- Own Node.js 22 HTTP runtime, port `4100` (default `127.0.0.1`) and standalone Dockerfile. Uses **no dependencies** from the Centralized Admin backend, no Prisma and no HQ database secrets.
- `GET /health/live` is independent of HealthNet platform health. `GET /health/ready` reports whether all connection configuration needed for at least one mapping is present; it explicitly does **not** claim the upstream is reachable.
- Versioned read-only internal endpoints: `GET /v1/dashboard/metrics`, `/v1/dashboard/charts/activity`, `/v1/dashboard/charts/patients`, `/v1/dashboard/charts/revenue`.
- Short-lived, HMAC-SHA256 signed HQ service JWTs: `iss=central-admin-hq`, `aud=healthnet-admin`, nonempty `sub`, `scopes` containing `healthnet:dashboard:read`, and `iat`/`exp` no more than 90 seconds apart. This secret MUST be different from browser JWT/refresh tokens.
- Explicit per-operation upstream owner API mappings, service-only bearer credential, no redirects, fixed 4s timeout, bounded 1MiB response, strict source response allowlist. Unknown/sensitive fields are dropped. A genuine missing upstream returns 503 rather than blank/zero data; an unapproved route returns 501; malformed owner data returns 502.
- Test suite: `npm test` and `npm run check`.

## Run locally (without any production credentials)

```bash
cd services/healthnet-admin
npm run check && npm test
```

A runnable server **requires** a unique strong `HEALTHNET_INTERNAL_JWT_SECRET`. Configure secrets using the host's secret manager; do not commit real tokens. Set `HOST=127.0.0.1` for local use. `HEALTHNET_PLATFORM_ADMIN_BASE_URL` must use HTTPS in production; explicit owner-approved path variables are documented in `.env.example`.

Container image:

```bash
docker build -f services/healthnet-admin/Dockerfile -t healthnet-admin:local services/healthnet-admin
```

Do not publish port 4100 to the internet. Private network exposure and service-to-service authentication are both required.

## Current status and extraction gates

This work begins H1 by giving HealthNet Admin a real independent executable runtime, health endpoints and scoped read-only API adapter. It **does not extract all 45 HQ HealthNet endpoints** and **does not move product database credentials to this new service**. It also does not change HQ's active routes.

Full migration is described in:

- [Stage-gated microservice extraction](../../docs/healthnet-admin-microservice-extraction-plan.md)
- [45 existing HQ HealthNet routes](../../docs/healthnet-admin-route-inventory.md)

The four initial administrative aggregates have **no live platform-owner path mappings configured by default**. Their backing contract and H2 gateway routing require explicit HealthNet platform-owner confirmation before use. Do not copy the legacy 5,166-line HealthNet service and bypass the owner's auth/business rules.

**Before staging traffic cutover:** complete H0 owner contract inventory, verify field and permission parity, integrate HQ signed-service-token issuance and backwards-compatible paths, test offline/recovery, audit, enable private networking, test user-bound authorization for sensitive routes and obtain staging security approval. No silent change to HQ authorization or existing production.
