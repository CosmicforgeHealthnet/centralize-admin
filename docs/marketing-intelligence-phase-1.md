# Marketing Intelligence Phase 1

Phase 1 is a five-platform ads intelligence backend for:

- META
- TIKTOK
- X
- LINKEDIN
- GOOGLE_ADS

It does not include frontend code, social-media organic publishing, campaign creation, recommendations, alerts, experiments, forecasting, or budget automation.

## Architecture

The module lives under `src/modules/marketing/intelligence/`.

- `connectors/` contains read-only advertising insights connectors.
- `provider-connections.service.js` manages encrypted provider connections.
- `oauth.service.js` handles OAuth state, start URLs, callbacks, and reconnects.
- `aggregation/aggregation.service.js` synchronizes provider rows into database snapshots.
- `aggregation/sync-lock.js` provides a Postgres-backed overlap lock.
- `aggregation/aggregation.cron.js` registers the scheduled sync once.
- `intelligence.service.js` serves the dashboard from the database only.
- `funnel-ingestion.service.js` and `attribution.service.js` normalize funnel attribution.

## Database Migration Order

The local operationalization target was confirmed as:

```text
host=localhost
port=5432
database=cosmicforge_admin
user=postgres
```

Apply manual migrations to the admin database in this order:

1. `prisma/manual-migrations/20260714_add_marketing_intelligence_phase1.sql`
2. `prisma/manual-migrations/20260715_add_marketing_connection_token_expiry.sql`
3. `prisma/manual-migrations/20260716_add_marketing_attributions_phase1.sql`
4. `prisma/manual-migrations/20260717_extend_marketing_ad_platforms.sql`
5. `prisma/manual-migrations/20260718_add_marketing_connection_credentials_currency.sql`
6. `prisma/manual-migrations/20260719_finalize_marketing_intelligence_connections.sql`
7. `prisma/manual-migrations/20260720_fix_marketing_intelligence_currency_width.sql`

`20260720` is intentionally additive. It widens Marketing Intelligence currency fields to `VARCHAR(16)` so the documented `UNSPECIFIED` default fits safely after the original `20260718` migration defect.

Run:

```powershell
npx prisma format --schema prisma/schema.prisma
npx prisma validate --schema prisma/schema.prisma
npx prisma generate --schema prisma/schema.prisma
```

The generated admin Prisma client lives in `src/generated/admin-client`.

## Connection API

Base path:

```text
/api/v1/marketing/intelligence
```

Routes:

```http
GET    /connections
GET    /connections/:id
POST   /connections
PATCH  /connections/:id
POST   /connections/:id/test
POST   /connections/:id/disable
POST   /connections/:id/enable
DELETE /connections/:id
POST   /connections/bootstrap
POST   /sync
GET    /oauth/:platform/start
GET    /oauth/:platform/callback
```

Management routes require authentication plus Marketing Intelligence `EDIT` section access. The dashboard route requires `VIEW`.

Connection responses never return plaintext tokens, encrypted envelopes, IVs, tags, authorization codes, client secrets, consumer secrets, app secrets, Google developer tokens, or authorization headers. Responses expose booleans such as `hasAccessToken`, `hasRefreshToken`, and `hasRequiredCredentials`.

`DELETE /connections/:id` soft-disables the connection. Historical raw insights and snapshots remain available.

## OAuth

OAuth state is stored in `marketing_oauth_states` by SHA-256 state hash. State rows contain the admin user id, platform, intended account context, expiry, used timestamp, and encrypted verifier/secret material where required. State is single-use and expires according to `MARKETING_OAUTH_STATE_TTL_SECONDS`.

Start routes:

```http
GET /api/v1/marketing/intelligence/oauth/tiktok/start
GET /api/v1/marketing/intelligence/oauth/x/start
GET /api/v1/marketing/intelligence/oauth/linkedin/start
GET /api/v1/marketing/intelligence/oauth/google_ads/start
GET /api/v1/marketing/intelligence/oauth/meta/start
```

Callbacks:

```http
GET /api/v1/marketing/intelligence/oauth/tiktok/callback
GET /api/v1/marketing/intelligence/oauth/x/callback
GET /api/v1/marketing/intelligence/oauth/linkedin/callback
GET /api/v1/marketing/intelligence/oauth/google_ads/callback
GET /api/v1/marketing/intelligence/oauth/meta/callback
```

Callback URLs are derived from `ADMIN_BACKEND_PUBLIC_URL` unless the provider-specific `*_REDIRECT_URI` variable is set. The callback never trusts arbitrary redirect URLs from request parameters. Success/failure redirects use configured fixed URLs.

## Environment Bootstrap

Set `MARKETING_INTELLIGENCE_BOOTSTRAP_CONNECTIONS=true` to import complete environment credentials into encrypted database-backed connections at startup. Bootstrap is idempotent:

- Existing `platform + accountId` database connections win over environment credentials.
- Existing DB credentials are not overwritten by older env values.
- Missing provider configuration is skipped.
- Incomplete provider configuration is reported without logging values.
- TikTok and LinkedIn refresh tokens and rotated tokens are persisted encrypted.
- Google Ads stores the refresh token and developer token, not repeated short-lived access tokens.

## Required Environment Variables

Shared:

```env
MARKETING_INTELLIGENCE_SYNC_ENABLED=false
MARKETING_INTELLIGENCE_BOOTSTRAP_CONNECTIONS=false
MARKETING_INTELLIGENCE_CRON=0 */6 * * *
MARKETING_INTELLIGENCE_LOOKBACK_DAYS=3
MARKETING_INTELLIGENCE_INITIAL_LOOKBACK_DAYS=30
MARKETING_INTELLIGENCE_SYNC_TIMEZONE=UTC
MARKETING_INTELLIGENCE_LOCK_TTL_SECONDS=1800
MARKETING_PROVIDER_TIMEOUT_MS=30000
MARKETING_PROVIDER_MAX_RETRIES=3
MARKETING_CREDENTIALS_ENCRYPTION_KEY=
MARKETING_OAUTH_STATE_TTL_SECONDS=600
ADMIN_BACKEND_PUBLIC_URL=
ADMIN_FRONTEND_PUBLIC_URL=
MARKETING_OAUTH_SUCCESS_REDIRECT_URL=
MARKETING_OAUTH_FAILURE_REDIRECT_URL=
```

Generate the encryption key with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Meta uses `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_GRAPH_API_VERSION`, `META_CURRENCY`, `META_APP_ID`, `META_APP_SECRET`, and `META_REDIRECT_URI`.

TikTok uses `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET`, `TIKTOK_ACCESS_TOKEN`, `TIKTOK_REFRESH_TOKEN`, `TIKTOK_ADVERTISER_ID`, token expiry variables, API overrides, redirect URI, and `TIKTOK_CURRENCY`.

X uses OAuth 1.0a variables `X_ADS_CONSUMER_KEY`, `X_ADS_CONSUMER_SECRET`, `X_ADS_ACCESS_TOKEN`, `X_ADS_ACCESS_TOKEN_SECRET`, `X_ADS_ACCOUNT_ID`, API overrides, redirect URI, and `X_ADS_CURRENCY`.

LinkedIn uses `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_REFRESH_TOKEN`, `LINKEDIN_AD_ACCOUNT_URN`, token expiry variables, API version, redirect URI, and `LINKEDIN_CURRENCY`.

Google Ads uses `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID`, optional `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, API version, redirect URI, and `GOOGLE_ADS_CURRENCY`.

## Provider Setup

Meta: configure a Meta app or system user token with Marketing API ads reporting access. Use canonical ad account IDs with `act_` prefix.

TikTok: configure a TikTok for Business app with advertiser reporting permissions. Store app credentials with refresh token support when available.

X: configure X Ads OAuth 1.0a credentials with read access to the ads account.

LinkedIn: configure LinkedIn Marketing Developer Platform access and sponsored account reporting permissions. Account URNs must match `urn:li:sponsoredAccount:<id>`.

Google Ads: configure Google Cloud OAuth credentials, a Google Ads developer token, and a numeric customer ID. Customer ID dashes are removed before storage.

## Connection Test

`POST /connections/:id/test` performs a minimal read-only reporting request through the provider connector. It does not store snapshots, trigger backfills, mutate campaigns, return raw provider bodies, or expose credentials.

Error categories are sanitized:

- `INVALID_CREDENTIALS`
- `REAUTHORIZATION_REQUIRED`
- `INSUFFICIENT_PERMISSION`
- `ACCOUNT_NOT_FOUND`
- `API_ACCESS_NOT_APPROVED`
- `RATE_LIMITED`
- `PROVIDER_UNAVAILABLE`
- `INVALID_CONFIGURATION`

## Manual And Scheduled Sync

Manual sync:

```http
POST /api/v1/marketing/intelligence/sync
```

Payload:

```json
{
  "platforms": ["META", "TIKTOK"],
  "connectionIds": [],
  "since": "2026-07-01",
  "until": "2026-07-03"
}
```

The endpoint validates date ranges, enforces a maximum manual range, uses the same Postgres lock as cron, runs the same aggregation service, supports partial provider failure, and returns per-platform/per-connection counts.

Scheduled sync uses `MARKETING_INTELLIGENCE_CRON`, `MARKETING_INTELLIGENCE_SYNC_TIMEZONE`, and `MARKETING_INTELLIGENCE_SYNC_ENABLED=true`. Cron registration is process-idempotent and skipped under `NODE_ENV=test`.

The Marketing Intelligence runtime uses the admin database only. It does not call `mainPrisma` or `mainDatabase`. Payment revenue attribution requires the emitted `PAYMENT_SUCCESS` payload to include `amount` and `currency`; when they are absent, the payment event is still recorded but revenue is left empty.

## Multiple Account Support

Raw insights and performance snapshots include:

- `connectionId`
- `accountId`
- `platform`
- `campaignExternalId`
- `date`

Uniqueness is account-aware:

```text
platform + accountId + campaignExternalId + date
```

This prevents campaign IDs from different connected accounts being merged.

## Currency Behavior

Every connection and snapshot stores currency. When the dashboard sees one currency, it returns monetary totals normally. When it sees multiple currencies, global monetary totals are set to `null` and per-currency totals are returned in `summaryByCurrency`. Non-monetary values such as impressions and clicks may still be summed globally.

No hardcoded currency conversion is performed.

## RBAC

- Dashboard read: `marketing/intelligence/VIEW`
- Connection management, OAuth start, bootstrap, test, manual sync: `marketing/intelligence/EDIT`
- `SUPER` tier bypass remains controlled by the shared RBAC middleware.

## Live Test Procedure

1. Apply all manual migrations.
2. Run Prisma format, validate, and generate.
3. Configure `MARKETING_CREDENTIALS_ENCRYPTION_KEY`.
4. Configure provider credentials and callback URLs.
5. Start the backend without provider credentials and verify it boots.
6. Start with one configured provider and verify bootstrap/test.
7. Use `POST /connections/:id/test` for each provider.
8. Run a short manual sync with real credentials.
9. Confirm dashboard reads database snapshots.
10. Enable scheduled sync only after manual sync succeeds.

## Troubleshooting

- `SKIPPED_NO_CREDENTIALS`: no active DB connection and no complete env credentials.
- `SKIPPED_ENCRYPTION_KEY_MISSING`: bootstrap was requested but encryption is unavailable.
- `REAUTHORIZATION_REQUIRED`: provider rejected or expired credentials.
- `RATE_LIMITED`: provider throttled the request.
- `PROVIDER_UNAVAILABLE`: provider timeout or upstream failure.
- Mixed-currency dashboard totals are intentionally null for monetary fields.

## Deployment Checklist

```text
[ ] All Marketing Intelligence migrations applied
[ ] Prisma schema validated
[ ] Prisma client generated
[ ] MARKETING_CREDENTIALS_ENCRYPTION_KEY configured
[ ] ADMIN_BACKEND_PUBLIC_URL configured
[ ] ADMIN_FRONTEND_PUBLIC_URL configured
[ ] OAuth callback URLs registered with providers
[ ] Meta credentials configured
[ ] TikTok credentials configured
[ ] X credentials configured
[ ] LinkedIn credentials configured
[ ] Google Ads credentials configured
[ ] Provider currencies confirmed
[ ] Marketing Intelligence VIEW permission granted
[ ] Marketing Intelligence EDIT permission granted
[ ] Provider connection tests passed
[ ] Manual sync passed
[ ] Dashboard endpoint passed
[ ] Funnel attribution passed
[ ] Scheduled sync enabled
[ ] Cron expression confirmed
[ ] Live Meta sync verified
[ ] Live TikTok sync verified
[ ] Live X sync verified
[ ] Live LinkedIn sync verified
[ ] Live Google Ads sync verified
[ ] No secrets committed
[ ] Dependency vulnerabilities reviewed
```

Live provider checks are operator actions when real provider credentials are unavailable.

## Known Limitations

- No frontend is included.
- Frontend implementation should follow `docs/marketing-intelligence-frontend-handoff.md`.
- No social-media organic publishing is included.
- No ad campaign creation or budget mutation is included.
- No recommendations, alerts, experiments, forecasting, or Phase 2 features are included.
