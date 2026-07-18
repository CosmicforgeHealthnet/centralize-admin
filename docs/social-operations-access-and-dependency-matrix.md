# Social Operations Access and Dependency Matrix

Audit date: 2026-07-17

Status values: `AVAILABLE`, `NOT_AVAILABLE`, `PENDING_OWNER_ACTION`, `PENDING_PROVIDER_APPROVAL`, `PENDING_LEGAL_APPROVAL`, `PENDING_INFRASTRUCTURE`, `NOT_REQUIRED`.

No provider dashboard, deployment platform console, secret manager console, frontend repository, monitoring console, or legal approval system access was available from this local backend workspace. Items below are therefore blocked unless repository evidence proved availability.

| System | Required account | Required access level | Current access status | Owner | Action required | Blocker | Due state |
|---|---|---:|---|---|---|---|---|
| Meta developer account | Meta developer | App admin | NOT_AVAILABLE | Provider owner | Grant dashboard access or run setup | Dashboard access unavailable | APPROVED |
| Meta business portfolio | Meta Business | Business admin | NOT_AVAILABLE | Provider owner | Confirm portfolio, app review, products | Business access unavailable | APPROVED |
| Facebook Page | Test Page | Page admin with required tasks | NOT_AVAILABLE | Social owner | Provide approved staging Page | Page identity unavailable | IDENTITY_CONNECTED |
| Instagram professional account | IG professional linked to Page | Account/Page admin | NOT_AVAILABLE | Social owner | Provide approved professional identity | Identity unavailable | LIVE_SANDBOX_TESTED |
| TikTok developer account | TikTok for Developers | App admin | NOT_AVAILABLE | Provider owner | Grant dashboard access or run setup | Dashboard access unavailable | APPROVED |
| TikTok creator sandbox identity | TikTok creator | OAuth test creator | NOT_AVAILABLE | Social owner | Provide eligible creator | Creator unavailable | LIVE_SANDBOX_TESTED |
| X developer project/app | X developer portal | Project/app admin | NOT_AVAILABLE | Provider owner | Confirm organic app and scopes | Dashboard access unavailable | APPROVED |
| X approved API access tier | X developer portal | Tier admin | PENDING_PROVIDER_APPROVAL | Provider owner | Confirm tier supports posts, media, DMs | Access tier unverified | APPROVED |
| LinkedIn developer app | LinkedIn Developer | App admin | NOT_AVAILABLE | Provider owner | Grant app access or run setup | Dashboard access unavailable | APPROVED |
| LinkedIn organization admin | LinkedIn Company Page | Organization admin | NOT_AVAILABLE | Social owner | Provide real organization identity | Organization admin unavailable | IDENTITY_CONNECTED |
| Staging DNS/domain | DNS provider | DNS admin | NOT_AVAILABLE | Infrastructure owner | Provide approved HTTPS domain | Domain not found in repo | AVAILABLE |
| Production DNS/domain | DNS provider | DNS admin | NOT_AVAILABLE | Infrastructure owner | Confirm production domain only for checklist | Not needed for local work | AVAILABLE |
| TLS certificates | Certificate manager | Cert admin | NOT_AVAILABLE | Infrastructure owner | Confirm automatic or managed TLS | Certificate system unavailable | AVAILABLE |
| Deployment platform | SSH/docker host per workflow | Deploy admin | NOT_AVAILABLE | Infrastructure owner | Grant staging deploy access | Only GitHub workflow references found | AVAILABLE |
| PostgreSQL staging database | Staging Postgres | Backup and migration role | NOT_AVAILABLE | Database owner | Provide connection via secret manager | No staging DB URL available | AVAILABLE |
| PostgreSQL production database | Production Postgres | Readiness review only | NOT_AVAILABLE | Database owner | Keep production blocked until approval | No production DB access requested | AVAILABLE |
| Secret manager | Deployment encrypted env/GitHub secrets | Secret admin | NOT_AVAILABLE | Infrastructure owner | Store Social secrets by environment | No console access available | AVAILABLE |
| Cloudinary account | Cloudinary | Media admin | NOT_AVAILABLE | Media owner | Configure staging/prod credentials | No real upload target available | AVAILABLE |
| Monitoring platform | Existing monitor/alert tool | Alert admin | NOT_AVAILABLE | SRE owner | Configure queues, webhooks, SLA alerts | Monitoring console unavailable | AVAILABLE |
| Frontend repository | Admin frontend | Maintainer | NOT_AVAILABLE | Frontend owner | Implement capability contract and staging E2E | Frontend repo unavailable | FRONTEND_ACCESS_REQUIRED |
| Privacy/legal reviewer | Legal/privacy review system | Approver | PENDING_LEGAL_APPROVAL | Privacy/legal owner | Approve retention, redaction, Phase D | Approval unavailable | APPROVED |
| Emergency template approver | Clinical/safety owner | Template approver | PENDING_LEGAL_APPROVAL | Safety owner | Approve saved replies/templates | Approval unavailable | APPROVED |
| RBAC administrator | Admin platform | RBAC admin | PENDING_OWNER_ACTION | Security owner | Assign Section 7 grants in staging | No staging admin access | ASSIGNED |
| CI/CD platform | GitHub Actions | Repo workflow access | AVAILABLE | Engineering owner | Added non-deploying Social Operations CI workflow | Workflow not executed remotely here | ACTIVE |

