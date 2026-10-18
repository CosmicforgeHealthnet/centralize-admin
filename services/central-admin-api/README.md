# Central Admin API (active)

Express/Prisma admin backend moved intact from the old repository root. Source is `src/`, generated and migration database schemas are in `prisma/`, configuration remains next to `package.json`, and tests remain under `tests/`.

Run `npm ci`, `npm run dev`, `npm test` **inside this directory**. The service is independent from `apps/central-admin-web/`. No external provider, database, or production deployment has been changed by this file-tree move.
