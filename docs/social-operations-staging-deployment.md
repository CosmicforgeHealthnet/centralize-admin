# Social Operations Staging Deployment

Audit date: 2026-07-17

No controlled staging deployment was executed because staging domain, staging database, deployment platform access, secret manager access, Cloudinary configuration, monitoring access, and provider approvals were not available.

## Required Staging Components

| Component | Status | Blocker |
|---|---|---|
| HTTPS API endpoint | PENDING_INFRASTRUCTURE | staging domain/deploy access unavailable |
| Staging PostgreSQL database | PENDING_INFRASTRUCTURE | staging DB URL and backup access unavailable |
| API service | PENDING_INFRASTRUCTURE | deployment platform unavailable |
| Publishing worker service | PENDING_INFRASTRUCTURE | deployment platform unavailable |
| Action worker service | PENDING_INFRASTRUCTURE | deployment platform unavailable |
| Redaction worker service | PENDING_LEGAL_APPROVAL | Phase D/legal gate unavailable |
| Secure environment configuration | PENDING_INFRASTRUCTURE | secret manager unavailable |
| Health checks | PENDING_INFRASTRUCTURE | staging service unavailable |
| Structured logs | PARTIAL_LOCAL | logger redaction exists; monitor unavailable |
| Monitoring/alerts | PENDING_INFRASTRUCTURE | monitoring platform unavailable |
| Cloudinary/media storage | PENDING_INFRASTRUCTURE | account/config unavailable |
| Staging callback URLs | PENDING_INFRASTRUCTURE | staging origin unavailable |
| Staging webhook URLs | PENDING_INFRASTRUCTURE | staging origin unavailable |

## Local Verification Completed

- Local database target confirmed as `cosmicforge_admin`.
- Prisma format/validate/generate pass.
- Local tests pass.
- Local partial indexes verified directly.
- Local startup passes with workers disabled.
- Final local startup smoke after dependency updates returned `/health` 200, `/api/marketing/social/posts` 401, `POST /api/marketing/social/posts` 401, and `/api/v1/marketing/social/connections` 401.

## Staging Migration Checklist

Do not run until staging access exists:

1. Validate the staging Admin database target and confirm it is not production.
2. Back up the staging Admin database according to operations policy.
3. Review Prisma schema changes and manual migration manifest checksums.
4. Regenerate Prisma client during build.
5. Apply Prisma schema changes to the staging Admin database.
6. Run the same Admin-database PostgreSQL artifact preparation step used by CI.
7. Confirm the preparation advisory lock completed and `social_manual_migrations` recorded the applied artifact checksum.
8. Verify duplicate-data prechecks did not block partial unique index creation.
9. Run strict schema assertions.
10. Verify webhook partial indexes directly in PostgreSQL.
11. Verify Task assignee nullability.
12. Verify legacy-source partial index.
13. Start application and worker processes only after database validation passes.

Do not activate Phase D, live inbox, live providers, live Cloudinary, or Social workers requiring provider credentials during migration validation.
