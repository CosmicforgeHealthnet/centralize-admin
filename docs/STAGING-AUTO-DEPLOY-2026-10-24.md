# Central Admin staging: GitHub-to-Contabo automated backend deployment

## Intended flow (staging only)

A push to GitHub branch `staging` triggers `.github/workflows/staging.yml`:

1. `verify` runs the existing backend validation, tests, migration safety checks and dependency audit.
2. `build-staging-image` publishes the monorepo root `Dockerfile` to GHCR under the **immutable** tag `ghcr.io/cosmicforgehealthnet/admin-backend:staging-<commit-sha>`.
3. `deploy-staging-api` connects to the isolated Admin staging Compose project on Contabo and deploys **only the `app` service**. It does not run migrations, recreate `db`, change Nginx, or operate on the production directory.
4. After app startup, the deployment verifies HTTP liveness, an Admin DB `admin_users` query and HTTPS OPTIONS preflight from `https://centralize-admin-staging.vercel.app` to `/api/auth/login`, requiring HTTP 200, matching `Access-Control-Allow-Origin` and credentials header.
5. A failed rollout restores the former staging app image. Main DEV DB status is also reported, but a Main DB timeout is distinct from Admin login connectivity.
6. `.github/workflows/staging-admin-connectivity.yml` is an independent *manual* smoke test to avoid racing against staging deployment.

## One-time GitHub environment configuration

In GitHub, open repository **Settings → Environments → staging**. Configure these environment secrets:

- `STAGING_HOST`: the Contabo SSH host/IP for the *existing staging VPS*.
- `STAGING_USER`: an SSH principal authorized to run Docker on the staging host (ideally a dedicated deploy principal).
- `STAGING_SSH_KEY`: its **private** SSH key. Configure the matching **public** key in that SSH account's `authorized_keys`.

Create the SSH key on a trusted admin machine. Never commit it, post it in chat, or store it in repo files. If environment rules require manual approval, GitHub will hold deployments pending that approval. GHCR push/read authentication uses GitHub Actions' ephemeral `GITHUB_TOKEN`; no long-lived registry token needs to be stored on Contabo.

**Until these secrets are configured, GitHub will deliberately FAIL the deployment job with a clear message.** Do not substitute production credentials automatically.

## VPS constraints preserved

- Target: `/var/www/admin-server-staging`
- Container: `admin-server-staging-app-1`; internal port `4000`; loopback host port `4001`
- Nginx API hostname: `https://stagingca.cosmicforge-healthnet.com`
- Staging Compose DB: `admin-server-staging-db-1` — left running; no migration is performed automatically.
- Production directory: `/var/www/admin-server` — never accessed by the workflow.
- Additional override written by deployment: `docker-compose.github-staging.yml`. The older manual override `docker-compose.staging-local.yml` is not used by the GitHub deployment; avoid combining them.
- Rollback image is retained locally under `cf-admin-api:staging-rollback-<run-id>`.

## Known blockers and next checks

1. The **existing backend CI security check** `npm audit --omit=dev` is a strict deployment gate. A local 24 October 2026 image build showed six dependency audit findings (two moderate, four high). Inspect the actual GitHub CI results and address confirmed policy violations; do not bypass required security checks just to deploy.
2. The current VPS Compose configuration warns about undefined interpolation variables `admN` and `K`. The running and resolved Compose environment values were previously observed to match, but they might *both* contain unintended substituted passwords. Resolve interpolation **on the VPS only**, taking backups first; never print env/secrets in CI logs or issue trackers.
3. Existing staging `/health` was 200 with the old image, but login OPTIONS was HTTP 500 and logs said `Blocked CORS request`. The fix was committed to staging; production must not be used to fix this.
4. The main DEV database was repeatedly timing out from the VPS. Admin DB login tests are independent of main database dashboard tests. Investigate private DB networking/credentials separately; `/health` alone does not prove main DB availability.
5. A real login test requires an authorized staging admin account in its `admin_users` database. Do **not** send passwords to CI, this chat, or GitHub Actions logs.

## Definition of done

- Staging backend CI passed, commit-specific GHCR image published, deployment job green;
- `stagingca.cosmicforge-healthnet.com/health` responds and login preflight returns HTTP 200 with the correct CORS headers;
- `admin_users` database access verified and a user confirms actual staging login;
- production image, production Compose, `main` branch, production database, and production Vercel project remain untouched.

This document and workflow constitute deployment **configuration**, not proof that CI passed or that GitHub environment secrets have been installed.