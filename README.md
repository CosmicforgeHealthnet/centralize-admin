# CosmicForge — Centralized Admin

This is a **multi-service repository**, not a single combined runtime. The existing Express/Prisma admin API and Next.js admin web remain separate deployable applications.

## Active applications

- `apps/central-admin-web/` — Next.js administration frontend; former `frontend/` moved without altering source or dependency lockfile.
- `services/central-admin-api/` — Express/Prisma backend; former repository-root backend moved together with its Prisma schema, scripts, dependencies and tests.

Each application has its own `package.json`, lockfile and deployment lifecycle. There is intentionally no root `node_modules` or root `npm ci` requirement. Install and run from each application directory.

## Product Admin platform (disabled by default)

Universal Product Admin Protocol v1 and the HQ integration platform — see [docs/product-admin](docs/product-admin/README.md):

- `services/product-integration-core/` — HQ product registry, onboarding, grants, subscriptions, generic synchronization and monitoring (own process, `hq_integration` schema).
- `services/karryam-admin/` — independent Karryam Admin implementing Protocol v1 (own `karryam_admin` schema; bridge client disabled until trust enrollment).
- `services/central-admin-api/src/modules/product-gateway/` — staff routes `/api/products/*` and `/api/admin/product-integrations/*` (off unless `PRODUCT_INTEGRATION_ENABLED=true`).
- `packages/admin-contracts`, `packages/event-contracts`, `packages/identity-and-permissions`, `packages/service-clients` — dependency-free shared libraries, consumed by relative path.
- `infrastructure/product-admin/` — operator configuration templates (not deployed by any workflow).

## Reserved boundaries (not implemented services)

- `services/healthnet-admin/` is an independent read-only service foundation that does not yet implement Protocol v1; `services/future-product-admins/` remains a placeholder. Future products onboard through the same registry once they implement Protocol v1.
- `modules/` maps ownership of current functions, not new executable modules. Existing code still lives under `services/central-admin-api/src/modules/` and `apps/central-admin-web/src/`.
- `packages/shared-ui` remains reserved.
- `infrastructure/` holds layout verification, Mail operations and Product Admin templates.

## Local development

Backend:
```sh
cd services/central-admin-api
npm ci
# Set up a local .env using .env.example (never commit secrets).
npm run dev
```

Frontend (in a second shell):
```sh
cd apps/central-admin-web
npm ci
# Configure NEXT_PUBLIC_API_URL to your backend's base origin.
npm run dev
```

Verify repository layout: `npm run layout:check` at repository root.

## CI and Docker

Backend CI jobs run with working directory `services/central-admin-api/`, preserving their existing npm, Prisma, schema safety and test commands. Frontend lint/TypeScript/build CI uses `apps/central-admin-web/`.

The root `Dockerfile` remains a **compatibility entry point** for the existing backend image-build process and copies the backend from `services/central-admin-api/`. Frontend deployment must set its project root to `apps/central-admin-web`. Do not deploy any reserved service or package as if implemented.

An external staging/production deployment that mounts source paths or runs `npm ci` in the repository root will require its deployment configuration to be updated; CI success alone does not certify external host mounts, environment settings, running routes or OAuth flows. Preserve current production until smoke-tested.
