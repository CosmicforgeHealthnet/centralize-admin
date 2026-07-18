# Social Operations Production Go-Live Checklist

Prepared: 2026-07-17

This checklist is prepared only. Production go-live was not executed.

| Gate | Status | Owner | Blocker |
|---|---|---|---|
| Migrations reviewed | PENDING_OWNER_ACTION | Engineering | final production review required |
| Production backup procedure verified | PENDING_INFRASTRUCTURE | Database owner | production DB access unavailable |
| Prisma client generated | AVAILABLE_LOCAL | Engineering | local only |
| Production encryption keys configured | PENDING_INFRASTRUCTURE | Security owner | secret manager unavailable |
| Old encryption keys backed up | PENDING_INFRASTRUCTURE | Security owner | key backup process unavailable |
| Provider production apps approved | PENDING_PROVIDER_APPROVAL | Provider owner | provider approvals unavailable |
| Production callback URLs registered | PENDING_INFRASTRUCTURE | Provider/infrastructure owner | production domain/dashboard unavailable |
| Production webhook URLs registered | PENDING_INFRASTRUCTURE | Provider/infrastructure owner | production domain/dashboard unavailable |
| Webhook secrets configured | PENDING_INFRASTRUCTURE | Security owner | secret manager unavailable |
| Provider identities connected | PENDING_OWNER_ACTION | Social owner | live identities unavailable |
| Live acceptance passed | PENDING_PROVIDER_APPROVAL | Provider owner | live tests not executed |
| Frontend contract verified | FRONTEND_ACCESS_REQUIRED | Frontend owner | frontend repo unavailable |
| Cloudinary production configuration complete | PENDING_INFRASTRUCTURE | Media owner | Cloudinary unavailable |
| Worker deployment complete | PENDING_INFRASTRUCTURE | SRE owner | staging/prod deployment unavailable |
| Queue alerts active | PENDING_INFRASTRUCTURE | SRE owner | monitoring unavailable |
| Webhook alerts active | PENDING_INFRASTRUCTURE | SRE owner | monitoring unavailable |
| Privacy alerts active | PENDING_INFRASTRUCTURE | SRE/privacy owner | monitoring unavailable |
| HealthNet escalation alerts active | PENDING_INFRASTRUCTURE | SRE/safety owner | monitoring unavailable |
| RBAC grants assigned | PENDING_OWNER_ACTION | RBAC administrator | staging/prod admin unavailable |
| Retention values approved | PENDING_LEGAL_APPROVAL | Legal/privacy | approval unavailable |
| Redaction configuration approved | PENDING_LEGAL_APPROVAL | Legal/privacy | approval unavailable |
| Emergency templates approved | PENDING_LEGAL_APPROVAL | Safety/legal | approval unavailable |
| Phase D gate passed | PENDING_LEGAL_APPROVAL | Legal/privacy | approval/settings unavailable |
| Legacy write deprecation decision approved | PENDING_OWNER_ACTION | Product owner | cutover decision unavailable |
| Secret scan passed | AVAILABLE_LOCAL | Engineering | local scanner passed; CI scanner not remotely executed |
| Dependency scan passed | BLOCKED | Engineering | `npm audit --audit-level=moderate` still reports 3 moderate Prisma toolchain transitive findings; force fix would downgrade Prisma |
| Rollback plan documented | PENDING_OWNER_ACTION | Engineering/SRE | staging deployment details unavailable |
| Incident-response contacts documented | PENDING_OWNER_ACTION | Operations | contact list unavailable |
| Final business owner approval | PENDING_OWNER_ACTION | Business owner | approval unavailable |
| Final privacy/legal approval | PENDING_LEGAL_APPROVAL | Legal/privacy | approval unavailable |
| Final engineering approval | PENDING_OWNER_ACTION | Engineering lead | approval unavailable |

Final go-live status: `NOT_READY_FOR_PRODUCTION_GO_LIVE_REVIEW`.
