# Centralized Admin frontend integration

## Layout

- Root repository: existing Express/Prisma admin backend. Its dependencies, entry points, Dockerfile, and endpoints are preserved.
- `frontend/`: Next.js 16 / React 19 admin application, copied from `CosmicforgeHealthnet/main-admin-frontend` commit `ab4b42f5822334817f9c87619b881312ea841943`.
- These applications share one Git repository, **not one Node process**. Deploy them independently and do not route frontend requests through the backend's existing Docker image.

## Develop locally

1. Run the existing backend from the repository root using its normal database/configuration procedure (typically port `4000`).
2. Run `cd frontend && npm ci`.
3. Copy `frontend/.env.example` to `frontend/.env.local`, then configure `NEXT_PUBLIC_API_URL` to the backend's externally reachable base URL (default: `http://localhost:4000`, without a trailing `/api`).
4. In `frontend/`, run `npm run dev`. The Next.js frontend is available at `http://localhost:3000`.
5. From `frontend/`, run `npm run lint` and `npm run build`.

The client currently makes requests such as `/api/auth/login` through `src/lib/api.ts`, so the backend URL must **not** include `/api`.

## Deployment

- **Backend**: retain the existing root-level service deployment and port `4000`. No backend API path or database migration was changed by the import.
- **Frontend**: create a separate Next.js project/service pointing at this same repository with **root directory `frontend`**. For Vercel use framework Next.js, install `npm ci`, and build `npm run build`. Do not point Vercel at the repository root.
- **Container alternative**: `docker build -f frontend/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://<backend-host> -t cosmicforge-admin-frontend ./frontend`, then run on port `3000`. Replace the placeholder with the actual URL. `NEXT_PUBLIC_API_URL` is embedded in client assets **at build time**; rebuild when changing it.
- Configure backend `CORS_ORIGINS` with the frontend's actual origin, including its URL scheme, and verify credentials/authentication flow in the deployed environment. Do not use wildcard credentialed CORS.
- Set up frontend environment variables in the frontend service; keep server secrets in the backend, never in `NEXT_PUBLIC_*` variables.

## Validation and follow-up

- `.github/workflows/frontend-ci.yml` checks `npm ci`, ESLint and the Next.js build when frontend files are changed.
- Original frontend screens, auth/session logic, API stores, and routes were imported **without functional changes**. Repository consolidation does **not** mean every screen is connected to a live backend, nor that production authentication/security has been certified.
- Verify login, refresh/logout, authorization, representative admin modules, and image loading in staging before repointing production DNS.
- Keep the original frontend repository intact until the new service is validated and deployed successfully. Its history remains available there; this is a snapshot import rather than a Git-history transplant.
