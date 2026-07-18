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

1. Confirm staging database name and host.
2. Confirm host is not localhost and database is not local `cosmicforge_admin`.
3. Create staging database backup.
4. Review migrations.
5. Apply migrations in order through the repository-approved migration runner.
6. Regenerate Prisma client during build.
7. Verify required tables and indexes.
8. Verify webhook partial indexes directly in PostgreSQL.
9. Verify Task assignee nullability.
10. Verify legacy-source partial index.
