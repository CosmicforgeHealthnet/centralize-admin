# Marketing Intelligence Frontend Handoff

Base API path:

```text
/api/v1/marketing/intelligence
```

## Access Model

- Dashboard screens require `marketing/intelligence/VIEW`.
- Connection management, OAuth start, connection tests, bootstrap, and manual sync require `marketing/intelligence/EDIT`.
- A `VIEW` user should not see provider token fields or management controls.

## Dashboard

Use:

```http
GET /performance?from=YYYY-MM-DD&to=YYYY-MM-DD&platform=all
GET /performance?from=YYYY-MM-DD&to=YYYY-MM-DD&platform=meta
GET /performance?from=YYYY-MM-DD&to=YYYY-MM-DD&platform=tiktok
GET /performance?from=YYYY-MM-DD&to=YYYY-MM-DD&platform=x
GET /performance?from=YYYY-MM-DD&to=YYYY-MM-DD&platform=linkedin
GET /performance?from=YYYY-MM-DD&to=YYYY-MM-DD&platform=google_ads
```

Expected response data includes:

- `filters`
- `summary`
- `summaryByCurrency`
- `campaigns`

When `summary.mixedCurrencies` is true, global monetary values such as `spend`, `revenue`, and `cpa` are intentionally `null`. Render monetary totals from `summaryByCurrency` instead.

## Connections

Use:

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
```

Connection responses are safe for the UI. They expose booleans such as:

- `hasAccessToken`
- `hasRefreshToken`
- `hasEncryptedCredentials`
- `hasRequiredCredentials`
- `requiresReauthorization`

Do not expect plaintext tokens, encrypted envelopes, client secrets, consumer secrets, access token secrets, refresh tokens, Google developer tokens, or authorization codes in responses.

## OAuth

Start OAuth from the connection setup UI:

```http
GET /oauth/:platform/start
```

The backend returns an `authorizationUrl`; redirect the browser to that URL. Callback routes are handled by the backend:

```http
GET /oauth/:platform/callback
```

After callback, the backend redirects to the configured frontend success or failure URL. Do not send arbitrary redirect URLs from the browser; they are ignored.

## Manual Sync

Use:

```http
POST /sync
```

Body:

```json
{
  "platforms": ["META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"],
  "connectionIds": [],
  "since": "2026-07-01",
  "until": "2026-07-03"
}
```

Render per-platform status values such as `SUCCESS`, `PARTIAL`, `FAILED`, and `SKIPPED_NO_CREDENTIALS`. If a sync returns `skipped: true`, another sync already holds the lock.

## UI States

Recommended connection states:

- Connected: `status=ACTIVE` and `hasRequiredCredentials=true`
- Needs setup: no connection or `hasRequiredCredentials=false`
- Reauthorization required: `requiresReauthorization=true`
- Disabled: `status=DISABLED`
- Error: `status=ERROR` with sanitized `lastSyncError`

Recommended dashboard states:

- Empty state when no campaigns are returned.
- Mixed-currency state when `summary.mixedCurrencies=true`.
- Provider unavailable state when latest sync reports provider errors, while still showing stored dashboard data.

## Out Of Scope

Do not build social publishing, ad creation, budget mutation, recommendations, alerts, experiments, forecasting, or Phase 2/Phase 3 features from this Phase 1 backend contract.
