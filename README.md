# CosmicForge — Centralized Admin

This is a **multi-service repository**, not a single combined runtime. The existing Express/Prisma admin API and Next.js admin web remain separate deployable applications.

## Active applications

- `apps/central-admin-web/` — Next.js administration frontend; former `frontend/` moved without altering source or dependency lockfile.
- `services/central-admin-api/` — Express/Prisma backend; former repository-root backend moved together with its Prisma schema, scripts, dependencies and tests.

Each application has its own `package.json`, lockfile and deployment lifecycle. There is intentionally no root `node_modules` or root `npm ci` requirement. Install and run from each application directory.

## Reserved boundaries (not implemented services)

- `services/healthnet-admin/` has a standalone read-only foundation (not yet HQ-integrated).
- `services/karryam-admin/` has a standalone, disabled-by-default **read-only private KarryGo capability connector** (Unix socket, mTLS/HMAC v2/Ed25519; not live certified). It is not yet a full product admin.
- `services/future-product-admins/` remains a placeholder.
- `modules/` maps ownership of current functions, not new executable modules. Existing code still lives under `services/central-admin-api/src/modules/` and `apps/central-admin-web/src/`.
- `packages/` reserves shared identity, UI, API-contract, client and event-contract packages. No live runtime dependencies on these packages are introduced.
- `infrastructure/` holds layout verification and planned deployment conventions.

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
