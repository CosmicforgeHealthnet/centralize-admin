# Staging recovery: browser CORS, Admin APIs and monorepo deployment

## Confirmed repository facts (2026-10-24)
- The active API is `services/central-admin-api/` and the web frontend is `apps/central-admin-web/`. Product services under `services/` other than central-admin-api are reserved directories, not running microservices.
- The backend `staging.yml` job validates/tests the backend. It **does not deploy** a staging server.
- The production backend workflow requires manual dispatch and must not be used for staging repair.
- The Next.js app consumes `NEXT_PUBLIC_API_URL` at build time; the browser sends authenticated requests to that API origin.
- The dashboard and user-statistics routes read via `mainPrisma` (the HealthNet main DB). Unreachable DBs, wrong `MAIN_DB_ENV`, missing `MAIN_DATABASE_URL_DEV/PROD`, migration drift or Prisma query failures can produce HTTP 500.
- `/health` is liveness and does not prove the main DB or the dashboard works. The backend connects the main DB in the background.
- There were no `staging` deployments returned by Vercel for the existing `centralize-admin` project when checked. The existing production alias must not be treated as staging.

## Applied source fix
- The exact canonical Admin origins are allowed even when `CORS_ORIGINS` is configured on the server.
- Custom exact origins in `CORS_ORIGINS` and the existing project-specific Vercel preview hostname matcher are preserved.
- A redundant wildcard OPTIONS handler was removed; the configured global CORS middleware handles preflight and credentialed headers.
- No cross-tenant wildcard or `Access-Control-Allow-Origin: *` was introduced.

## Actions required to restore staging (on authorized hosting/CI accounts)
1. **Frontend:** Configure the Vercel project Root Directory as `apps/central-admin-web` for builds sourced from the monorepo. Prefer a **separate staging Vercel project/alias** if changing the current production project's root would affect `main`. Select Git branch `staging`. Set `NEXT_PUBLIC_API_URL` to a real **staging** API origin (not the production API), then build and deploy a preview. Do not alias the preview to production.
2. **Backend:** Create/identify an isolated **staging** service using the repository-root `Dockerfile` (which copies `services/central-admin-api/`) or set the app working directory and Docker build context appropriately. Run it using staging-only credentials and databases. Confirm the deployed image SHA is the expected `staging` commit.
3. **Environment:** Provide `DATABASE_URL` for the Admin DB, `MAIN_DB_ENV=dev` for an intentionally isolated development main DB (or `prod` only if explicitly authorized), and the corresponding `MAIN_DATABASE_URL_DEV` or `MAIN_DATABASE_URL_PROD`. Check credentials and network access **without logging actual values**. Set `CORS_ORIGINS` to explicitly approved origins for this environment.
4. **Preflight smoke test:** From an authorized test host, send `OPTIONS /api/dashboard/overview` with `Origin: <staging-web-origin>`, `Access-Control-Request-Method: GET`, and `Access-Control-Request-Headers: Authorization`; expect 2xx, an exact matching Access-Control-Allow-Origin and Access-Control-Allow-Credentials: true. Reject unknown Origins.
5. **Authenticated API smoke test:** With a short-lived test Admin session, call `/api/dashboard/overview`, `/api/dashboard/revenue-chart`, `/api/dashboard/platform-usage`, `/api/users/stats`, `/api/users/growth-chart`, `/api/users/signup-trends`, `/api/users`, and `/api/notifications/unread-count`. Verify 200 and documented response shapes; 401/403 for unauthorized accounts. Never use production tokens in staging.
6. **If HTTP 500 persists:** Inspect sanitized backend logs for the precise error class/correlation ID. Specifically test Admin DB and main DB connection, table/column drift, privileges and Prisma client generation. Do not swallow query failures or replace missing real statistics with invented zeroes.
7. **UX verification:** Test dashboard, users, notifications, HealthNet, marketing, HR, permissions, session refresh, logout and preflight on desktop/mobile. Record checks and failures per route.
8. **Release gate:** Keep `main`, production Vercel alias, production API, production DB and production credentials unchanged. Only consider promotion after verified staging health, role-based access and CI checks.

## Local source tests
```sh
cd services/central-admin-api
node --test tests/cors-origins.test.js
node --check src/app.js
```

No evidence of deployed remediation is established merely by pushing code to `staging`.
