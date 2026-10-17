# Centralize Admin

Full-stack admin monorepo (migration in progress).

## Backend services

- `services/main-admin/` — existing admin backend, moved without business-logic changes.
- `services/karrygo-admin/` — placeholder for a future service.

## Frontend

- `web/main-admin-frontend/` — destination for the existing Next.js frontend from the separate `CosmicforgeHealthnet/centralize-admin` repository. Import pending.

## Running existing backend

```bash
cd services/main-admin
npm ci
npm run dev
```

The repository rename, frontend import, CI validation, and staging merge remain pending.
