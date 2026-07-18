# Social Operations Environment Matrix

Audit date: 2026-07-17

This file lists variable names only. Values belong in local `.env` for development or encrypted environment storage/secret manager for staging and production. Do not promote local development values to staging or production.

## Common Variables

| Area | Variable names | Local | Test | Staging | Production |
|---|---|---|---|---|---|
| Admin DB | `DATABASE_URL` | local `cosmicforge_admin` only | ephemeral CI DB | staging Postgres secret | production Postgres secret |
| Encryption keyring | `SOCIAL_OPERATIONS_ENCRYPTION_KEYS_JSON`, `SOCIAL_ENCRYPTION_KEYS_JSON` | optional dev fallback | optional synthetic fallback | required secret | required secret, fail closed |
| Active key version | `SOCIAL_OPERATIONS_ENCRYPTION_ACTIVE_VERSION`, `SOCIAL_ENCRYPTION_ACTIVE_VERSION` | optional | optional | required | required |
| Content hash key | `SOCIAL_CONTENT_HASH_KEY` | optional dev fallback | optional synthetic fallback | required secret | required secret, fail closed |
| Feature flags | `SOCIAL_WORKERS_ENABLED`, `SOCIAL_PUBLISHING_WORKER_ENABLED`, `SOCIAL_ACTION_WORKER_ENABLED`, `SOCIAL_REDACTION_WORKER_ENABLED`, `SOCIAL_INBOX_ENABLED`, `SOCIAL_PHASE_D_ENABLED` | false by default | false by default | explicit per test window | explicit only after go-live approval |
| Reconciliation | `SOCIAL_RECONCILIATION_ENABLED` | false by default | false by default | explicit only for controlled tests | explicit after approval |
| Worker controls | `SOCIAL_WORKER_POLL_INTERVAL_MS` | optional | optional | required value | required value |
| Worker controls not yet env-backed | concurrency, lease duration, heartbeat interval, recovery interval, claim batch size, shutdown grace period | code defaults/wrapper args | code defaults/wrapper args | deployment wrapper required | deployment wrapper required |
| App URLs | `ADMIN_APP_BASE_URL`, `SOCIAL_API_BASE_URL`, `ADMIN_BACKEND_PUBLIC_URL`, `ADMIN_FRONTEND_PUBLIC_URL` | localhost allowed | localhost/CI only | HTTPS staging domain | HTTPS production domain |
| OAuth allow-list | `SOCIAL_OAUTH_REDIRECT_URIS`, `SOCIAL_OPERATIONS_OAUTH_REDIRECT_URIS` | exact localhost URLs only | exact CI/test URLs | exact HTTPS staging URLs | exact HTTPS production URLs |
| Media | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | optional stub | optional stub | required staging storage | required production storage |
| Monitoring | `SOCIAL_ALERT_WEBHOOK_URL`, `SOCIAL_MONITORING_API_KEY` | not required | not required | required if monitoring platform uses env integration | required |

## Provider Variables

Social Operations provider credentials must be separate from Marketing Intelligence and advertising credentials.

| Provider | Variable names | Current backend status |
|---|---|---|
| Meta | `SOCIAL_META_CLIENT_ID`, `SOCIAL_META_CLIENT_SECRET`, `SOCIAL_META_REDIRECT_URI`, `SOCIAL_META_WEBHOOK_SECRET`, `SOCIAL_META_WEBHOOK_VERIFY_TOKEN` | webhook secret/verify token naming matches implementation as `SOCIAL_META_WEBHOOK_SECRET` and `SOCIAL_META_WEBHOOK_VERIFY_TOKEN`; live OAuth exchange remains blocked by provider access |
| TikTok | `SOCIAL_TIKTOK_CLIENT_KEY`, `SOCIAL_TIKTOK_CLIENT_SECRET`, `SOCIAL_TIKTOK_REDIRECT_URI`, `SOCIAL_TIKTOK_WEBHOOK_SECRET` | live runtime blocked by provider access |
| X | `SOCIAL_X_CLIENT_ID`, `SOCIAL_X_CLIENT_SECRET`, `SOCIAL_X_REDIRECT_URI`, `SOCIAL_X_WEBHOOK_SECRET` | live runtime blocked by provider access/tier |
| LinkedIn | `SOCIAL_LINKEDIN_CLIENT_ID`, `SOCIAL_LINKEDIN_CLIENT_SECRET`, `SOCIAL_LINKEDIN_REDIRECT_URI`, `SOCIAL_LINKEDIN_WEBHOOK_SECRET` | live runtime blocked by provider access |

Repository also contains Marketing Intelligence/Ads variables such as `META_APP_SECRET`, `TIKTOK_APP_SECRET`, `X_ADS_CONSUMER_SECRET`, and `LINKEDIN_CLIENT_SECRET`. Those are not Social publishing credentials and must not be reused for Social Operations publishing.

## Startup Validation Status

- Production encryption keyring fails closed when missing.
- Production content hash key fails closed when missing.
- Social workers default disabled.
- Live inbox defaults disabled.
- Phase D defaults disabled.
- Exact redirect allow-listing is implemented by URL string.
- Safe-state validation is implemented by tests; a dedicated deployment-time env validator is still recommended before staging enablement.
