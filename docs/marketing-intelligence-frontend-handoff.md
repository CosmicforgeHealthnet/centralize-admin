# Marketing Intelligence Frontend Handoff

Base API path:

```text
/api/v1/marketing/intelligence
```

## Access Model

- Dashboard screens require `marketing/intelligence/VIEW`.
- Connection management, OAuth start, connection tests, bootstrap, campaign sync, creative sync, and creative scoring require `marketing/intelligence/EDIT`.
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

When `summary.mixedCurrencies` is true, global monetary values such as `spend`, `revenue`, `netRevenue`, `cpa`, and `roas` are intentionally `null`. Render monetary totals from `summaryByCurrency` instead.

Dashboard monetary fields:

- `spend`
- `revenue`
- `netRevenue`
- `cpa`
- `roas`
- `currencyCompatibility`

If `currencyCompatibility=false`, show ROAS as unavailable instead of calculating it in the browser.

## Connections

Use:

```http
GET    /connections
GET    /connections/:id
POST   /connections
PATCH  /connections/:id
POST   /connections/:id/test
POST   /connections/:id/validation-evidence
POST   /connections/:id/disable
POST   /connections/:id/enable
DELETE /connections/:id
POST   /connections/bootstrap
GET    /provider-validation
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

Render per-platform status values such as `SUCCESS`, `PARTIAL`, `FAILED`, and `SKIPPED_NO_CREDENTIALS`. A manual sync that collides with another run returns HTTP `409`; scheduled collisions are recorded as `SKIPPED_LOCKED`.

## Provider Validation

Use:

```http
GET /provider-validation
```

Render a row for each platform:

- `META`
- `TIKTOK`
- `X`
- `LINKEDIN`
- `GOOGLE_ADS`

Display `codeStatus`, `mockTests`, `liveStatus`, and `blocker`. `LIVE_VALIDATED` should be treated as the only fully live-ready state. `CREDENTIAL_BLOCKED`, `APPROVAL_BLOCKED`, `FAILED`, and `NOT_VALIDATED` are per-platform blockers and should not hide stored dashboard data for other platforms.

Authorized operator tooling may record completed checks with `POST /connections/:id/validation-evidence`:

```json
{
  "connectionTestPassed": true,
  "boundedFetchPassed": true,
  "metricReconciled": true,
  "paginationVerified": true,
  "rateLimitVerified": true,
  "tokenRefreshVerified": true,
  "checkedAt": "2026-07-19T08:00:00.000Z"
}
```

The mutation requires `EDIT`, is audit logged, and derives status from the recorded evidence. Omit `tokenRefreshVerified` only when token refresh is not applicable to that connection.

## Creative Intelligence (Phase 2 Sections 7-9)

Use the same base path:

```http
GET  /creatives?platform=all&page=1&limit=25&sort=lastSeenAt
GET  /creatives/:id
POST /creatives/sync
POST /creatives/score
GET  /creatives/:id/scores?page=1&limit=25
GET  /creatives/:id/scores/latest
```

Reads require `VIEW`; sync and score require `EDIT`. A manual creative lock collision returns HTTP `409`. Do not render raw provider payloads or infer missing metrics as zero. Provider conversions are informational and are not interchangeable with trustworthy internal signups or payments. Mixed-currency CPC, CPA, and ROAS are intentionally unavailable, and no browser-side FX conversion should be applied.

`platform=all` may complete with per-connection partial success. Meta scores the ad with creative metadata, TikTok scores the ad with an optional native creative ID, X scores the promoted entity, LinkedIn preserves and scores the full creative URN, and Google Ads scores an ad. See `docs/marketing-intelligence-phase-2.md` for payloads, scoring, fatigue, and live-provider blockers.

## Recommendations (Phase 2 Section 10)

Use the same authenticated base path:

```http
GET   /recommendations?page=1&limit=25&status=PENDING
GET   /recommendations/:id
POST  /recommendations/evaluate
PATCH /recommendations/:id/accept
PATCH /recommendations/:id/dismiss
POST  /recommendations/:id/convert-to-task
```

Reads require `VIEW`; evaluation and lifecycle changes require `EDIT`. Evaluation accepts optional `platform`, `connectionId`, `from`, `to`, and `ruleTypes`. It may return `PARTIAL_SUCCESS` with per-campaign `failures` and reason-coded `skippedRules`. A concurrent owner-token lock returns HTTP `409`.

Render all four recommendation types (`PAUSE`, `SCALE`, `REALLOCATE_BUDGET`, `CREATE_CONTENT`) as advisory. Never imply that the backend paused a campaign, changed a budget, or created provider content. Display the Decimal confidence plus `evidence.confidenceComponents`, reasoning, sanitized evidence, `suggestedAction`, analysis window, currency, and expiration reason. Lifecycle states are `PENDING`, `ACCEPTED`, `DISMISSED`, `EXPIRED`, and `CONVERTED_TO_TASK`.

Accept uses an empty body. Dismiss uses:

```json
{ "reason": "Not applicable to the current campaign plan" }
```

Task conversion accepts:

```json
{
  "assigneeAdminUserId": "4d61ce86-3f5b-4f63-ad93-aa155c58d40d",
  "dueDate": "2026-07-25T17:00:00.000Z"
}
```

Both fields are optional. An idempotent repeat returns the existing Task with `idempotent: true`. A missing linked Task is an integrity conflict, while a serializable/unique race returns HTTP `409` and should offer retry. The real Task fields are title, description, due date, assigner, assignee, and status. There is no Task priority or metadata field; operational urgency appears only in the sanitized description.

## Alerts (Phase 2 Section 11)

```http
GET   /alerts?page=1&limit=25&status=OPEN
GET   /alerts/:id
POST  /alerts/evaluate
PATCH /alerts/:id/acknowledge
PATCH /alerts/:id/resolve
```

Render the ten documented alert types, severity (`INFO`, `WARNING`, `CRITICAL`), status (`OPEN`, `ACKNOWLEDGED`, `RESOLVED`), occurrence count, original/last trigger time, cooldown, and recovery state. Acknowledge uses an empty body. Resolve uses `{ "reason": "..." }`.

An acknowledged alert remains active. Repeated detections update the same active lifecycle, preserve `triggeredAt`, and do not notify during cooldown unless severity escalates. Consecutive recovered evaluations resolve it; recurrence after resolution creates a new lifecycle. Notifications are persisted before realtime emission through the existing user/admin Socket.IO room. Missing recipients and sanitized delivery failures do not remove the alert or fail the entire evaluation.

## Experiments (Phase 2 Section 13)

```http
POST /experiments
GET  /experiments?page=1&limit=25
GET  /experiments/:id
PATCH /experiments/:id
POST /experiments/:id/start
POST /experiments/:id/complete
POST /experiments/:id/cancel
```

Only `CTR`, `CPC`, `CPA`, and `CONVERSION_RATE` are accepted. Create requires a name, hypothesis, metric, and two distinct bounded JSON variant objects. Variant JSON is non-executable metadata and rejects nested secrets, prototype-pollution keys, commands, and provider-write/mutation instructions.

Only `DRAFT` records can be patched; status and creator are not editable. Start uses an empty body. Complete requires structured A/B sample sizes and decimal metric strings, winner (`A`, `B`, `TIE`, or `INCONCLUSIVE`), data source, and analysis window. Statistical-significance language requires a supplied method and supporting evidence. Cancel requires a reason. `COMPLETED` and `CANCELLED` records are immutable.

## Evaluation orchestration

Recommendation and alert evaluation may be invoked manually through the `EDIT` endpoints or automatically when the corresponding backend scheduler is enabled. Alert health and performance use independent `MARKETING_ALERT_HEALTH_*` and `MARKETING_ALERT_PERFORMANCE_*` flags, cron expressions, timezones, rule groups and locks. The legacy shared alert keys are fallback-only when a specific key is absent. Both paths use the same recovery, cooldown, partial-result, and evaluation-run behavior. The UI may label monitoring as automatic only when deployment configuration confirms that the scheduler is enabled; the API does not expose process environment values.

Automation evaluates and records advisory recommendations and alerts only. It never pauses campaigns, changes budgets, creates provider content, or deploys experiments. Lock collisions are recorded as `SKIPPED_LOCKED`, partial runs remain visible in the evaluation ledger, and failure of one job does not prevent the other job or Phase 1 synchronization from running.

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
- Currency-incompatible state when `currencyCompatibility=false`.
- Provider unavailable state when latest sync reports provider errors, while still showing stored dashboard data.

## Out Of Scope

Do not build social publishing, ad creation, budget mutation, automated provider actions, experiment execution, forecasting, ML/LLM features, or other Phase 3 behavior. Phase 2 Sections 7-17 expose only the read-only intelligence, advisory recommendation/alert, existing-Task conversion, tracking-only experiment, settings, and operational-run workflows documented here.

## Sections 14-17 frontend contract

### Settings screen

Use `GET /settings` with optional `platform`, `connectionId`, `currencyCode`, `includeConfigured`, and `includeDefaults`. Render configured values separately from effective values and show the returned resolution source (`CONNECTION`, `PLATFORM`, `GLOBAL`, or `BOOTSTRAP`), version, scope, currency, and bounded operational warnings. `targetCpa` and `minimumSpend` require a three-letter currency; never reuse a monetary value across currencies or offer FX conversion.

Those monetary keys have no universal numeric bootstrap. Render `null` as “not configured for this currency,” not zero. `SETTING_CURRENCY_CONTEXT_REQUIRED` means the UI must supply a currency; `SETTING_MONETARY_VALUE_UNAVAILABLE` means no compatible setting exists. Target-dependent recommendation and alert rules will be skipped safely.

`defaultMarketingAssigneeAdminUserId` is an eligible admin UUID or `null`. Sending null clears that scoped value. Do not send placeholders such as `fallback`, `default`, or `auto`. The backend runtime fallback is separate and deterministic; conversion responses/audits identify the source as `REQUEST`, `CONNECTION_SETTING`, `GLOBAL_SETTING`, or `MARKETING_FALLBACK`.

Use `PATCH /settings` with an atomic `updates` array and an `expectedVersion` on every item. Send `expectedVersion: 0` for a new identity and the displayed current version for an update. On HTTP 409 `SETTING_VERSION_CONFLICT`, refetch and ask the operator to review the newer value. The endpoint requires `EDIT` plus the existing ADMIN-tier guard. `llmCommentaryEnabled` is a reserved GLOBAL Boolean that defaults to false; enabling it does not create commentary or any network/LLM behavior.

```json
{
  "updates": [
    {
      "key": "targetCpa",
      "scope": "PLATFORM",
      "platform": "META",
      "currencyCode": "EUR",
      "value": "25.00",
      "expectedVersion": 2
    }
  ]
}
```

### Evaluation-run screen

Use `GET /evaluation-runs` and `GET /evaluation-runs/:id`; both require `VIEW`. Supported list filters are `type`, `trigger`, `status`, `platform`, `connectionId`, `from`, `to`, `page`, `limit`, `sort`, and `direction`. The page size cap is 100. Display status, trigger, operation type, scope, timestamps, counts, settings fingerprint, sanitized step/platform summary, and stable failure codes. Never expect lock tokens/hashes, raw provider errors, credentials, stack traces, or raw payloads.

Recognize `SUCCEEDED`, `PARTIAL_SUCCESS`, `FAILED`, `SKIPPED_LOCKED`, and lock-renewal failure states. `SKIPPED_LOCKED` is an idempotent overlap outcome for scheduled work, not proof of provider failure. Stored feature toggles can make a connection explicitly skipped even when the deployment scheduler is registered.

### Authorization and API behavior

All lists/details/settings/run reads require `marketing/intelligence VIEW`. Every mutation requires `EDIT`; settings additionally require the reusable ADMIN-tier policy. Do not build UI affordances around invented granular permissions. Static action endpoints are authoritative and must not be formed as resource IDs.

All protected responses use the existing envelope and sanitized serializer. Decimal values arrive as JSON-safe values, dates as ISO strings, and BigInt values as strings. For `platform=all`, retain successful data when `meta.partial=true` and render each sanitized `meta.platformErrors` entry. A single-platform provider failure is a normal stable error response, not partial success. Handle HTTP 409 for lock collision, stale version, invalid lifecycle transition, and integrity conflicts without blindly retrying mutations.

The backend audits mutations and manual runs; the frontend must not send tokens, provider bodies, lock owners, full evidence objects, or payment references as audit metadata. No additional frontend audit request is required.

The required Sections 14-17 API inventory is exactly 26 endpoints. The full router exposes 44 because 18 approved Phase 1/Sections 8-9 extensions remain for attribution, stored performance, score history, provider validation, connection administration, OAuth, and campaign synchronization. Clients should not count those extensions as missing or duplicate Section 14-17 endpoints.

## Sections 18-21 frontend hardening contract

Treat every resource ID as an opaque UUID. Do not send placeholders, whitespace-padded values, objects, SQL fragments, or client-defined sort expressions. Date-only filters use exact `YYYY-MM-DD`; timestamps use ISO-8601 with a timezone. Date ranges include both selected calendar days, while the server internally queries the exclusive start of the next UTC day. Surface validation messages next to the named field and do not retry HTTP 400 responses.

The backend recursively removes credentials, raw provider payloads, lock-owner data/hashes, encrypted envelopes, stacks, and other private fields. The UI must not depend on any of those fields or attempt to reconstruct them from operational summaries. Render sanitized strings as text, not HTML. Decimal values must remain strings/decimal-safe values through formatting; do not use binary floating-point for money or threshold edits, and never infer unavailable values as zero.

Successful multi-scope operations may return:

```json
{
  "success": true,
  "message": "Operation completed with partial results",
  "data": {},
  "meta": {
    "partial": true,
    "runId": "11111111-1111-4111-8111-111111111111",
    "warnings": [{ "code": "LLM_COMMENTARY_UNAVAILABLE" }],
    "platformErrors": [{ "platform": "META", "code": "PROVIDER_UNAVAILABLE", "retryable": true }]
  }
}
```

Keep successful data visible, show each bounded warning/error, and offer retry only when the returned `retryable` value and operation idempotency both permit it. Canonical error families are provider unavailable/permission/token refresh, lock conflict/ownership loss, insufficient data, invalid transition, duplicate action, validation, not found, forbidden, rate limited, stale version, invalid setting, and Task integrity conflict. Existing specialized codes such as `SETTING_VERSION_CONFLICT` remain valid. Never display a provider body, token, stack, or database message even if an intermediary injects one.

Evaluation-run and mutation responses may include safe operational IDs, counts, duration, status, and provider failure category. They do not expose environment flags or prove that production schedulers, provider credentials, account permissions, or live validation have been configured. `llmCommentaryEnabled` remains non-operational; show the bounded unavailable warning and do not present generated commentary as a supported capability.

## Phase 2 release gate

`MARKETING_INTELLIGENCE_PHASE2_ENABLED` is a deployment-level master flag that defaults false. When disabled, creative sync/scoring, recommendation and alert evaluation/lifecycle mutations, Task conversion, and experiment mutations return HTTP 503 with `MARKETING_INTELLIGENCE_PHASE2_DISABLED`. Read APIs, settings administration, provider connection setup/validation, OAuth preparation, attribution, and independent Phase 1 campaign synchronization remain available under their existing policies. The UI must not infer the flag from missing data; handle the stable code and show an operationally disabled state.

Dark-launch business defaults are also false for `creativeSyncEnabled`, `recommendationEvaluationEnabled`, and `alertEvaluationEnabled`. The final recommendation/comparison lookbacks are 14 days, underperformance threshold 0.30, maximum scale 0.20, and general alert cooldown 1,440 minutes. A component value cannot bypass a disabled deployment master.
