# Marketing Intelligence Phase 2: Sections 7-13

This document describes the implemented creative ingestion, deterministic scoring, recommendation, alert, task-conversion, and experiment-tracking workflows in the active repository `C:\Projects\ADMIN-Backend` on `staging`. Marketing Intelligence persists through `src/shared/config/database.js`, the admin Prisma schema at `prisma/schema.prisma`, and the generated admin client at `src/generated/admin-client`. The intended database is `cosmicforge_admin`; the main-application Prisma client is used only by existing source-system event producers.

Sections 7-13 add data models, raw creative ingestion, scoring/fatigue history, recommendations, alert delivery, atomic task conversion, and tracking-only experiments. They do not implement automated provider writes, forecasting, ML, or LLM features.

## Routes and access

The base path is `/api/v1/marketing/intelligence`.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/creatives` | `marketing/intelligence/VIEW` | Paginated sanitized creative catalog |
| GET | `/creatives/:id` | `marketing/intelligence/VIEW` | One creative with safe related data |
| POST | `/creatives/sync` | `marketing/intelligence/EDIT` | Read-only provider catalog/insight synchronization |
| POST | `/creatives/score` | `marketing/intelligence/EDIT` | Deterministic scoring run |
| GET | `/creatives/:id/scores` | `marketing/intelligence/VIEW` | Paginated immutable score history |
| GET | `/creatives/:id/scores/latest` | `marketing/intelligence/VIEW` | Latest score using deterministic tie-breaking |
| GET | `/recommendations` | `marketing/intelligence/VIEW` | Paginated recommendations |
| GET | `/recommendations/:id` | `marketing/intelligence/VIEW` | Recommendation detail |
| POST | `/recommendations/evaluate` | `marketing/intelligence/EDIT` | Deterministic recommendation evaluation |
| PATCH | `/recommendations/:id/accept` | `marketing/intelligence/EDIT` | Accept a pending recommendation |
| PATCH | `/recommendations/:id/dismiss` | `marketing/intelligence/EDIT` | Dismiss a pending recommendation |
| POST | `/recommendations/:id/convert-to-task` | `marketing/intelligence/EDIT` | Atomically create an assigned Task from an accepted recommendation |
| GET | `/alerts` | `marketing/intelligence/VIEW` | Paginated condition alerts |
| GET | `/alerts/:id` | `marketing/intelligence/VIEW` | Alert detail |
| POST | `/alerts/evaluate` | `marketing/intelligence/EDIT` | Evaluate alert conditions |
| PATCH | `/alerts/:id/acknowledge` | `marketing/intelligence/EDIT` | Acknowledge an open alert |
| PATCH | `/alerts/:id/resolve` | `marketing/intelligence/EDIT` | Manually resolve an alert |
| POST | `/experiments` | `marketing/intelligence/EDIT` | Create a tracking-only experiment draft |
| GET | `/experiments` | `marketing/intelligence/VIEW` | Paginated experiments |
| GET | `/experiments/:id` | `marketing/intelligence/VIEW` | Experiment detail |
| PATCH | `/experiments/:id` | `marketing/intelligence/EDIT` | Edit a draft experiment |
| POST | `/experiments/:id/start` | `marketing/intelligence/EDIT` | Start a draft experiment |
| POST | `/experiments/:id/complete` | `marketing/intelligence/EDIT` | Complete a running experiment with structured results |
| POST | `/experiments/:id/cancel` | `marketing/intelligence/EDIT` | Cancel a draft or running experiment |

Example sync request:

```json
{
  "platforms": ["META", "TIKTOK"],
  "connectionIds": ["4d61ce86-3f5b-4f63-ad93-aa155c58d40d"],
  "since": "2026-07-01",
  "until": "2026-07-07"
}
```

Example scoring request:

```json
{
  "platform": "all",
  "connectionIds": ["4d61ce86-3f5b-4f63-ad93-aa155c58d40d"],
  "creativeAssetIds": ["ed280cad-037f-4530-a4a3-c5a6bbb4b7ed"],
  "since": "2026-07-01",
  "until": "2026-07-07"
}
```

All responses use the repository's existing `ApiResponse` envelope. List endpoints return pagination metadata. Decimal and BigInt values are serialized by the existing API stack. Raw provider responses, credentials, authorization headers, cookies, signatures, and tokens are never returned. A manual sync or score lock collision returns HTTP 409. `platform=all` isolates provider/connection failures and can return partial success.

## Section 7 data foundation

The schema contains one model each for creative assets, daily performance snapshots, immutable score snapshots, recommendations, alerts, experiments, evaluation runs, and typed scoped settings. Sections 10-13 activate the recommendation, alert, task-conversion, and experiment models through the protected routes documented above.

Creative identity is unique by `connectionId + sourceKey`. Daily metric identity is unique by `connectionId + sourceMetricKey + UTC date`. Score history is unique by creative, analysis window, and rule version. Settings use a non-null scope fingerprint so uniqueness does not depend on nullable PostgreSQL columns. Historical creative, performance, and score records are retained when optional related records are removed; nullable Social Media Asset and admin-user relations use `SET NULL`.

## Section 8 creative ingestion

Creative catalog and creative insight contracts are separate from the campaign connector contract. A provider may support campaign sync without creative sync, and unsupported creative operations return an explicit `UNSUPPORTED` result. Each external page is persisted independently, repeated cursors and configured page limits stop infinite pagination, and already committed pages remain available when a later page fails.

Raw pages reuse `marketing_ad_insights_raw` with a creative payload category, provider request ID, and sanitized request metadata. Campaign-level internal conversions are never copied to every creative. Provider conversion counts remain informational. Internal attributed signups, payments, and revenue stay `null` unless the source mapping reaches a trustworthy ad/creative grain. Missing metrics remain `null`, not zero.

| Platform | Catalog | Insights | Scored grain | Pagination | Live status and blocker |
|---|---|---|---|---|---|
| META | Implemented | Implemented | Ad with creative metadata | Graph cursor | Mock-tested only; credentials, permissions, pagination/rate-limit checks, token refresh, and metric reconciliation are required for `LIVE_VALIDATED` |
| TIKTOK | Implemented | Implemented | Ad, with optional native creative ID | Page number | Mock-tested only; advertiser access and all live-validation gates are required; Smart+ hierarchy varies |
| X | Implemented | Implemented | Promoted entity/post | Cursor | Mock-tested only; X Ads API approval and OAuth 1.0a credentials are required |
| LINKEDIN | Implemented | Implemented | Full creative URN | Start/count | Mock-tested only; account reporting permissions, configured API version, and live gates are required |
| GOOGLE_ADS | Implemented | Implemented | Ad | Page token | Mock-tested only; developer token, customer context, OAuth access, and live gates are required |

No automated test calls a live provider. None of the platforms should be presented as live-validated merely because connector tests pass. The authoritative operational status is returned by `GET /provider-validation`; `LIVE_VALIDATED` requires connection, bounded fetch, persistence, reconciliation, pagination, rate-limit/error-path, and applicable refresh evidence.

Meta actions and other provider conversions are provider-defined informational measurements, not internal payment truth. Google ingestion queries ad-group ads and does not claim asset-group scoring; shared-asset metrics are not multiplied across child assets. X micro-unit spend and Google cost micros use exact Decimal conversion. TikTok, LinkedIn, and Google reuse their existing refresh/configuration paths.

## Section 9 deterministic scoring

Settings resolve in this order:

```text
CONNECTION -> PLATFORM -> GLOBAL -> bootstrap default
```

Invalid scoped values fall through safely. Invalid threshold groups and all-zero weight sets fall back to valid bootstrap defaults. The deterministic settings fingerprint and settings version are stored on each score snapshot.

The metrics are:

```text
CTR             = clicks / impressions
CPC             = spend / clicks
CPM             = spend / impressions * 1000
Conversion rate = trustworthy attributed payments / clicks
CPA             = spend / configured trustworthy internal goal
ROAS            = net trustworthy attributed revenue / spend
```

Zero denominators, incomplete aggregates, untrustworthy attribution, and mixed-currency monetary inputs produce `null`. No FX conversion is performed. Provider conversions cannot promote a creative to `STRONG`.

Bootstrap sufficiency boundaries are:

- `INSUFFICIENT`: below 500 impressions or 10 clicks.
- `LIMITED`: minimum limited evidence is met, but sufficient evidence is not.
- `SUFFICIENT`: at least 1,000 impressions and 30 clicks, plus the configured spend requirement where applicable.
- `STRONG`: sufficient evidence plus at least five trustworthy internal goal conversions.

The default base weights are CTR 20%, CPC 15%, internal conversion rate 20%, internal CPA 25%, internal ROAS 15%, and trend stability 5%. Missing or currency-incompatible components are excluded and the available weights are renormalized. Compatible peer medians are preferred; scoped targets are the fallback.

For higher-is-better metrics, the ratio is `creative / target`; for lower-is-better metrics it is `target / creative`. Ratios are clamped to `[0, 2]`, then mapped with `componentScore = clampedRatio * 50`. The final score is:

```text
score = clamp(0, 100,
  sum(componentScore * availableWeight) / sum(availableWeight)
  + metadataModifier
)
```

The metadata modifier is deterministic, reason-coded, disabled for insufficient evidence, and capped to plus or minus 5 points. Scores use Decimal arithmetic, are stored to two decimal places, and retain metrics, peer basis, targets, exclusions, rule version, and settings fingerprint. Re-running the same creative/window/rule updates the same unique snapshot rather than creating duplicate history.

Fatigue compares seven complete UTC days with the preceding seven. Both windows require configured volume and at least two active days. A 25% CTR decline is the primary signal and must be confirmed by a configured CPC increase, CPA increase, or internal conversion-rate decline. Two distinct consecutive positive evaluation windows transition `NONE -> WATCH -> FATIGUED`. Two distinct stable windows transition `FATIGUED -> RECOVERED`, followed by `RECOVERED -> NONE`. Re-running the same analysis window does not advance the streak. Missing comparison data does not trigger fatigue, and incompatible currencies exclude CPC/CPA confirmation.

## Section 10 recommendation engine

Recommendation settings use connection, platform, global, then bootstrap-default precedence. Deterministic rules create `PAUSE`, `SCALE`, `REALLOCATE_BUDGET`, and `CREATE_CONTENT` recommendations from internal campaign truth and persisted creative scores. Confidence uses the required 40/30/20/10 weighted components. Canonical condition identities, period buckets, and material-evidence fingerprints update an existing `PENDING` recommendation while preserving accepted, dismissed, expired, and converted history. Evaluation uses the shared owner-token lock and run ledger and never performs provider writes.

`PENDING` recommendations reset their recovery streak when the condition is seen. An unseen condition expires only after the configured consecutive recovery evaluations, or immediately when its explicit expiry passes, its evidence is stale, or its connection is inactive. The expiration reason is retained and terminal recommendation evidence is not rewritten. A dismissed condition is reconsidered as a new lifecycle only in a new period bucket or after material evidence changes. Evaluation responses include `failures` and reason-coded `skippedRules` so partial results are visible.

Lifecycle requests are empty for accept and require `{ "reason": "..." }` for dismiss. Invalid transitions and concurrent evaluation locks return HTTP `409` with stable error details. List responses return `{ items, pagination }`; detail responses include confidence, `evidence.confidenceComponents`, `suggestedAction`, lifecycle actor/timestamps, `expiresAt`, and `expirationReason`.

## Section 11 alert engine

The alert engine supports CPA target breach, spend without conversion, conversion-rate drop, confirmed creative fatigue, stale sync, multi-metric campaign deterioration, high-performing campaigns, token-refresh failure, degraded connections, and platform permission errors. Active conditions retain one lifecycle record, increment occurrence counts, preserve the original trigger time, escalate severity, and suppress repeat Notifications during cooldown. Automatic resolution requires consecutive recovery evaluations; a returned resolved condition starts a new lifecycle. Notifications use the existing service, active targeted recipients, and the existing Socket.IO server after persistence.

Alert list/detail payloads expose `type`, `severity`, `status`, `occurrenceCount`, `triggeredAt`, `lastTriggeredAt`, `cooldownUntil`, recovery state, and sanitized delivery failure state. Acknowledge has an empty body; resolve requires `{ "reason": "..." }`. During cooldown the active alert still updates without another Notification or realtime event. Notification and realtime failures never delete the persisted alert; missing recipients are recorded safely.

## Section 12 recommendation-to-task conversion

Only accepted recommendations convert. A serializable transaction locks the recommendation, validates an active eligible Marketing assignee, creates the existing `Task` with `assigneeId`, persists one assignment Notification, links the task, changes the recommendation to `CONVERTED_TO_TASK`, and writes the audit record. Repeats return the linked task without duplicate records. The repository has no `TaskAssignee`, Task priority, department, or source-metadata field; deterministic operational urgency and the recommendation reference are therefore stored in the bounded sanitized Task description without inventing schema fields. Realtime delivery occurs after commit and cannot roll back a valid conversion.

The request is `{ "assigneeAdminUserId"?: "uuid", "dueDate"?: "ISO-8601 timestamp with timezone" }`. Assignee resolution is request override, configured default, then deterministic active Marketing fallback. A linked missing Task returns an integrity conflict; serializable/unique conflicts return a retryable HTTP `409`. Idempotent repeats return `idempotent: true` with the existing Task and do not create another Notification or audit transition.

## Section 13 experiment tracking

Experiments are tracking-only and allow `CTR`, `CPC`, `CPA`, and `CONVERSION_RATE`. Variant objects are canonicalized, bounded by size and nesting depth, required to differ, and rejected when they contain secret-bearing or executable metadata. Only drafts are editable. Valid transitions are `DRAFT -> RUNNING`, `DRAFT -> CANCELLED`, `RUNNING -> COMPLETED`, and `RUNNING -> CANCELLED`. Completion requires structured samples, decimal metric strings, winner classification, data source, and analysis window; significance claims require an explicitly supplied method and evidence. Variant metadata is never interpreted as a provider command.

Create requires `name`, `hypothesis`, `metric`, distinct `variantAConfig` and `variantBConfig`, with optional platform/connection/campaign references. PATCH accepts draft fields only and atomically increments `version`; it cannot set status, creator, result, or lifecycle times. Start has an empty body. Complete requires `{ result: { variantA, variantB, winner, dataSource, analysisWindow, ... }, conclusion? }`. Cancel requires `{ "reason": "..." }`. Completed and cancelled records are immutable.

## Sections 10-13 orchestration status

## Automatic recommendation and alert orchestration

Recommendation and alert evaluation can run manually through the protected `EDIT` endpoints or automatically through the existing `node-cron` process scheduler. Automatic jobs are disabled by default and are independently configured:

| Setting | Default | Purpose |
|---|---|---|
| `MARKETING_RECOMMENDATION_SCHEDULER_ENABLED` | `false` | Enable scheduled advisory recommendation evaluation |
| `MARKETING_RECOMMENDATION_CRON` | `15 */6 * * *` | Recommendation cron expression |
| `MARKETING_RECOMMENDATION_TIMEZONE` | `UTC` | Recommendation IANA timezone |
| `MARKETING_ALERT_HEALTH_SCHEDULER_ENABLED` | `false` | Enable hourly connection-health rules |
| `MARKETING_ALERT_HEALTH_CRON` | `5 * * * *` | Health-rule cron expression |
| `MARKETING_ALERT_HEALTH_TIMEZONE` | `UTC` | Health-rule IANA timezone |
| `MARKETING_ALERT_PERFORMANCE_SCHEDULER_ENABLED` | `false` | Enable daily campaign-performance rules |
| `MARKETING_ALERT_PERFORMANCE_CRON` | `30 2 * * *` | Performance-rule cron expression |
| `MARKETING_ALERT_PERFORMANCE_TIMEZONE` | `UTC` | Performance-rule IANA timezone |
| `MARKETING_INTELLIGENCE_LOCK_TTL_SECONDS` | `1800` | Owner-token lease and maximum unattended lock duration; heartbeat renews every one-third TTL |

Configuration validation rejects invalid booleans, cron expressions, and timezones before server startup. Each cron calls its internal evaluation service with trigger `SCHEDULED`; it does not call the HTTP API. Manual and scheduled runs share the same independent recommendation or alert owner-token lock, heartbeat, and evaluation-run ledger. A collision records `SKIPPED_LOCKED`. Successful, partial, failed, and disabled results are retained by the service ledger.

The registry starts once, prevents hot-reload duplicate registration, isolates recommendation and alert runtime failures, and stops both jobs during graceful server shutdown. Phase 1 campaign sync, creative sync, recommendation evaluation, and alert evaluation use independent schedules and lock scopes. Enabling automation never authorizes provider writes: recommendations remain advisory, alert delivery uses the existing Notification and Socket.IO infrastructure, and provider campaign actions remain manual.

Business controls continue to use typed `MarketingIntelligenceSetting` precedence (`CONNECTION -> PLATFORM -> GLOBAL -> bootstrap default`). Final dark-launch defaults disable creative sync, recommendation evaluation, and alert evaluation; use 14-day recommendation/comparison windows, 14-day expiry/evidence staleness, two recovery evaluations, a 20% scale cap, a 1,440-minute general alert cooldown, three default Task due days, and Marketing-department recipient targeting. Severity-specific alert cooldowns remain rule-specific controls. An explicit `defaultMarketingAssigneeAdminUserId` or eligible deterministic Marketing fallback is still required for Task conversion. Provider requests remain bounded by `MARKETING_PROVIDER_TIMEOUT_MS` (30 seconds by default); the owner lease has a 30-minute maximum unattended duration and active evaluation heartbeat renewal, while server shutdown provides a 10-second process grace period.

## Operational limitations

- Normal patient/doctor self-registration is not present in this repository. The available lab-registration approval producer emits signup events after its transaction succeeds; other source applications require external integration.
- Monetary totals are never combined across currencies, and no FX conversion exists.
- Trustworthy creative-level internal attribution depends on source events carrying sufficient account and ad/creative identity; campaign-only attribution is intentionally not duplicated.
- Live provider credentials, account permissions/approval, and operator-recorded live validation evidence are external configuration blockers.
- Automated provider writes, experiment execution, forecasting, ML, and LLM workflows remain unimplemented and out of scope.

## Sections 14-17: production settings, orchestration, APIs, RBAC, and audit

### Canonical settings

All Section 14 settings are declared in `setting-registry.js` and resolved deterministically as `CONNECTION -> PLATFORM -> GLOBAL -> bootstrap default`. Invalid historical rows are skipped with bounded reason-coded warnings; raw stored JSON and database errors are never returned or logged. Monetary settings require an uppercase three-letter currency and currency participates in the effective identity and fingerprint. No FX conversion is performed.

| Key | Type and bounds | Allowed scopes | Currency-aware | Bootstrap default |
|---|---|---|---|---|
| `targetCpa` | Decimal >= 0 or null | GLOBAL, PLATFORM, CONNECTION | yes | `null` |
| `underperformThresholdPct` | Decimal 0-1 | GLOBAL, PLATFORM | no | `0.30` |
| `scaleThresholdPct` | Decimal 0-1 | GLOBAL, PLATFORM | no | `0.20` |
| `minimumSpend` | Decimal >= 0 or null | GLOBAL, PLATFORM, CONNECTION | yes | `null` |
| `minimumClicks` | Integer >= 0 | GLOBAL, PLATFORM | no | `30` |
| `minimumSignups` | Integer >= 0 | GLOBAL, PLATFORM | no | `3` |
| `minimumPayments` | Integer >= 0 | GLOBAL, PLATFORM | no | `3` |
| `recommendationLookbackDays` | Integer 1-90 | GLOBAL, PLATFORM | no | `14` |
| `comparisonLookbackDays` | Integer 1-90 | GLOBAL, PLATFORM | no | `14` |
| `attributionWindowDays` | Integer 1-90 | GLOBAL | no | `30` |
| `creativeFatigueThresholdPct` | Decimal 0-1 | GLOBAL, PLATFORM | no | `0.25` |
| `creativeMinimumImpressions` | Integer >= 0 | GLOBAL, PLATFORM | no | `1000` |
| `maximumRecommendedScalePct` | Decimal 0-1 | GLOBAL, PLATFORM | no | `0.20` |
| `alertCooldownMinutes` | Integer 5-10080 | GLOBAL, PLATFORM | no | `1440` |
| `defaultMarketingAssigneeAdminUserId` | active eligible admin UUID or null | GLOBAL, CONNECTION | no | `null` |
| `recommendationEvaluationEnabled` | Boolean | GLOBAL, PLATFORM, CONNECTION | no | `false` |
| `alertEvaluationEnabled` | Boolean | GLOBAL, PLATFORM, CONNECTION | no | `false` |
| `creativeSyncEnabled` | Boolean | GLOBAL, PLATFORM, CONNECTION | no | `false` |
| `llmCommentaryEnabled` | Boolean | GLOBAL | no | `false` |

`llmCommentaryEnabled` is reserved and does not enable an LLM client, network call, or Phase 3 behavior. Settings batches are atomic and use `expectedVersion` (`0` for create, the current version for update). A successful write increments the version; stale versions return HTTP 409 with `SETTING_VERSION_CONFLICT`. Setting mutation and its bounded old/new/version audit are committed in the same serializable transaction. The reusable repository admin-tier guard is applied in addition to `marketing/intelligence EDIT`; the service independently verifies that the actor exists, is active, and has at least the `ADMIN` tier.

`targetCpa` and `minimumSpend` deliberately have no universal numeric bootstrap. They require an explicit currency context and resolve only against rows for that currency. If no compatible row exists, the value is `null` with `SETTING_MONETARY_VALUE_UNAVAILABLE`; if the read context omits currency, the value is `null` with `SETTING_CURRENCY_CONTEXT_REQUIRED`. Target-dependent recommendation and alert rules skip instead of treating null as zero. Minimum-spend sufficiency falls back only to the documented non-monetary click/completeness checks.

`defaultMarketingAssigneeAdminUserId` stores only an active eligible UUID or `null`. A null row behaves as a cleared setting and resolution continues through lower-precedence scopes. Task conversion separately applies deterministic runtime resolution: request override, connection setting, global setting, then an ordered eligible Marketing fallback. The audit records `REQUEST`, `CONNECTION_SETTING`, `GLOBAL_SETTING`, or `MARKETING_FALLBACK`.

```http
GET /api/v1/marketing/intelligence/settings?platform=META&connectionId=<uuid>&currencyCode=EUR&includeConfigured=true&includeDefaults=true
PATCH /api/v1/marketing/intelligence/settings
```

```json
{
  "updates": [
    {
      "key": "minimumClicks",
      "scope": "PLATFORM",
      "platform": "META",
      "value": 50,
      "expectedVersion": 3
    }
  ]
}
```

GET returns the requested context, configured rows, effective values, each resolution source/version/scope/currency, defaults when requested, and sanitized operational warnings.

### Scheduler and run ledger

The existing `node-cron` registry owns all jobs and prevents duplicate registration. All registration flags default to `false`; cron expressions and IANA timezones are validated at startup.

| Job | Registration flag | Cron key/default | Timezone key/default | Lock namespace | Run type |
|---|---|---|---|---|---|
| Recommendation evaluation | `MARKETING_RECOMMENDATION_SCHEDULER_ENABLED` | `MARKETING_RECOMMENDATION_CRON=15 */6 * * *` | `MARKETING_RECOMMENDATION_TIMEZONE=UTC` | `marketing:intelligence:recommendations` | `RECOMMEND` |
| Alert performance | `MARKETING_ALERT_PERFORMANCE_SCHEDULER_ENABLED` | `MARKETING_ALERT_PERFORMANCE_CRON=30 2 * * *` | `MARKETING_ALERT_PERFORMANCE_TIMEZONE=UTC` | `marketing:intelligence:alerts:performance` | `ALERT` |
| Alert health | `MARKETING_ALERT_HEALTH_SCHEDULER_ENABLED` | `MARKETING_ALERT_HEALTH_CRON=5 * * * *` | `MARKETING_ALERT_HEALTH_TIMEZONE=UTC` | `marketing:intelligence:alerts:health` | `ALERT` |
| Creative synchronization | `MARKETING_CREATIVE_SYNC_SCHEDULER_ENABLED` | `MARKETING_CREATIVE_SYNC_CRON=30 */6 * * *` | `MARKETING_CREATIVE_SYNC_TIMEZONE=UTC` | `marketing:intelligence:creative-sync` | `CREATIVE_SYNC` |
| Creative scoring | `MARKETING_CREATIVE_SCORE_SCHEDULER_ENABLED` | `MARKETING_CREATIVE_SCORE_CRON=0 1 * * *` | `MARKETING_CREATIVE_SCORE_TIMEZONE=UTC` | `marketing:intelligence:creative-score` | `SCORE` |
| Recommendation expiry | `MARKETING_RECOMMENDATION_EXPIRY_SCHEDULER_ENABLED` | `MARKETING_RECOMMENDATION_EXPIRY_CRON=30 2 * * *` | `MARKETING_RECOMMENDATION_EXPIRY_TIMEZONE=UTC` | `marketing:intelligence:recommendation-expiry` | `RECOMMEND` |
| Full evaluation | `MARKETING_FULL_EVALUATION_SCHEDULER_ENABLED` | `MARKETING_FULL_EVALUATION_CRON=0 3 * * *` | `MARKETING_FULL_EVALUATION_TIMEZONE=UTC` | `marketing:intelligence:full-evaluation` | `FULL_EVALUATION` |

Full evaluation and component schedules are mutually exclusive to avoid duplicated production work. Stored feature toggles remain authoritative per connection/platform; scheduler flags only register jobs. Each operation initializes its run attempt before lock acquisition, marks collisions `SKIPPED_LOCKED`, starts the existing one-third-TTL owner-checked heartbeat only after acquisition, records renewal loss, stops unsafe continuation, and releases only its owner token. Raw owner values are never exposed; only safe hashes may be stored.

Health and performance alert jobs have independent handles, flags, cron expressions, timezones, rule groups, locks, summaries, failure isolation, and shutdown. Health evaluates only `SYNC_STALE`, `TOKEN_REFRESH_FAILED`, `CONNECTION_DEGRADED`, and `PLATFORM_PERMISSION_ERROR`. Performance evaluates only `CPA_TARGET_BREACH`, `SPEND_WITHOUT_CONVERSION`, `CONVERSION_RATE_DROP`, `CREATIVE_FATIGUE`, `CAMPAIGN_PERFORMANCE_DROP`, and `HIGH_PERFORMING_CAMPAIGN`. The legacy `MARKETING_ALERT_SCHEDULER_ENABLED`, `MARKETING_ALERT_CRON`, and `MARKETING_ALERT_TIMEZONE` are fallback-only: a present specific key always wins.

### Exact route inventory reconciliation

The Sections 14-17 specification requires exactly 26 creative, recommendation, alert, experiment, settings, and evaluation-run endpoints. All 26 are present with no duplicate method/path pairs. The router contains 44 routes in total because 18 legitimate earlier-phase extensions are preserved: public click attribution and OAuth callback; stored performance; creative score history/latest; provider validation; ten connection-management routes; OAuth start; and Phase 1 campaign synchronization. These are classified as `LEGITIMATE_EXISTING_ROUTE`, not additional Section 14-17 requirements.

Full evaluation calls internal services in this order: resolve immutable per-connection settings snapshots; creative catalog/insight sync; creative scoring; recommendation evaluation; alert evaluation/recovery; recommendation expiry. Component locks remain independent under the top-level full-evaluation lock. Failures are isolated by connection and step, producing `PARTIAL_SUCCESS` when appropriate. Provider fetches occur outside whole-run transactions and pages/batches are persisted using short transactions. The registry stops every scheduled task and waits for active scheduler callbacks during graceful shutdown.

```http
GET /api/v1/marketing/intelligence/evaluation-runs?type=ALERT&status=PARTIAL_SUCCESS&page=1&limit=25&sort=startedAt&direction=desc
GET /api/v1/marketing/intelligence/evaluation-runs/<uuid>
```

Run queries require `VIEW`, cap `limit` at 100, validate UUID/date/platform/type/trigger/status filters, and allow only `startedAt`, `completedAt`, `createdAt`, `status`, and `runType` sorts. Responses include scope, settings fingerprints, counts, sanitized step/platform summaries, and failure codes. They omit lock hashes, credentials, provider bodies, authorization material, stack traces, and Prisma runtime objects.

### API, RBAC, and audit contract

Every read endpoint uses `marketing/intelligence VIEW`; manual sync/scoring/evaluation, lifecycle transitions, task conversion, experiment mutation, and settings mutation use `EDIT`. No additional Marketing Intelligence permission namespace was introduced. Static action routes (`/sync`, `/score`, `/evaluate`, `/settings`, and `/evaluation-runs`) are registered before dynamic `/:id` routes. Existing rate limiting and the explicit Decimal/BigInt/Date/nested-value serializer apply to protected endpoints.

Lifecycle services reject missing or inactive actors and enforce current status/version independently of route middleware. Recommendation, alert, experiment, Task-conversion, and settings state-change audits are transactionally paired with the mutation. Manual operation audits contain actor, trigger, scope, result, and run ID; scheduled operational history uses the run ledger and `SCHEDULED` trigger. Audits use IDs, status changes, changed field names, reason codes, versions, and bounded fingerprints rather than credentials, provider payloads, full evidence/variant JSON, payment references, PII, stacks, or lock-owner tokens. Idempotent repeats do not create duplicate transition audits.

## Sections 18-21: production hardening and release gate

### Validation, arithmetic, and privacy contract

All Marketing Intelligence route identifiers are canonical UUIDs and are validated before service/repository access. Empty, whitespace-padded, oversized, non-string, and malformed identifiers return `VALIDATION_ERROR`; they do not reach Prisma. Query objects are strict, page/limit values are bounded, filter values use enums or bounded strings, and sort fields/directions use explicit allowlists. Unknown and nested query fields are rejected.

Calendar dates are exact `YYYY-MM-DD` values, including leap-year validation. Timestamps require ISO-8601 with an explicit timezone. Repository ranges use UTC start-inclusive/end-exclusive boundaries so the final selected day is included without relying on `23:59:59.999`, including across DST changes. Manual synchronization remains capped at 31 inclusive days; reporting and run-query windows remain capped at 366 inclusive days.

Money, ratios, thresholds, scores, confidence, and percentage calculations use Prisma Decimal helpers. Division by zero returns an unavailable result, not infinity or an invented zero. Negative values are accepted only for explicitly signed business values; spend, targets, and other non-negative settings reject them. Persisted monetary/scoring values use their documented database scale and round half-up at the persistence boundary. No FX conversion is introduced.

Bounded JSON accepts only plain serializable JSON. The default limits are 64 KiB, eight nested levels, 100 object fields, 200 array entries, and 4,000 Unicode characters per string. Secret-bearing keys and prototype-pollution keys are rejected for input. Provider-derived or operational JSON is sanitized before persistence; HTML/script/control content, credentials, raw provider bodies, buffers, lock owners, and oversized values are removed or replaced with a stable truncation marker. Run summaries are sanitized on create, update, and finish.

The response serializer recursively omits credentials, tokens, authorization material, raw provider JSON/payloads, lock-owner values and hashes, encrypted credential envelopes, database URLs, stacks, and other private fields at any nesting depth. Decimal, BigInt, Date, arrays, and nested plain objects remain JSON-safe. Partial operations use the normal success envelope with `meta.partial`, bounded platform/connection errors, warnings, and run IDs where available. Full raw provider records and full evidentiary payloads are never an API response contract.

`llmCommentaryEnabled` remains a reserved setting. No LLM adapter, credential, outbound request, generated recommendation, or hidden fallback was added. When enabled without an implementation, evaluation remains deterministic and reports `LLM_COMMENTARY_UNAVAILABLE` as a bounded warning.

### Stable public errors

The module uses the existing `ApiError` hierarchy and adds a canonical definition registry, rather than a competing error hierarchy. Public errors expose a stable code and retryability while provider bodies, request headers, credentials, stacks, and database internals stay private.

| Code | HTTP | Retryable | Meaning |
|---|---:|:---:|---|
| `PROVIDER_UNAVAILABLE` | 503 | yes | Provider timeout, 5xx, or temporary outage |
| `PROVIDER_PERMISSION_DENIED` | 403 | no | Provider/account permission rejected |
| `TOKEN_REFRESH_FAILED` | 503 | yes | Authorization refresh did not complete |
| `LOCK_CONFLICT` | 409 | yes | Another owner currently holds the operation lock |
| `LOCK_OWNERSHIP_LOST` | 409 | yes | Heartbeat renewal or ownership check failed |
| `INSUFFICIENT_DATA` | 422 | no | Deterministic evidence boundary was not met |
| `INVALID_TRANSITION` | 409 | no | Lifecycle state does not permit the action |
| `DUPLICATE_ACTION` | 409 | no | An immutable external identity conflicts or action already completed |
| `PARTIAL_SUCCESS` | 200 | yes | Some independent scopes succeeded and others failed |
| `VALIDATION_ERROR` | 400 | no | Request value or shape is invalid |
| `NOT_FOUND` | 404 | no | Requested record does not exist |
| `FORBIDDEN` | 403 | no | Actor lacks the required active role/permission |
| `RATE_LIMITED` | 429 | yes | Request or provider rate limit reached |
| `STALE_VERSION` | 409 | no | Optimistic version no longer matches |
| `SETTING_INVALID` | 400 | no | Setting type, scope, currency, or bounds are invalid |
| `TASK_INTEGRITY_CONFLICT` | 409 | no | Linked Task state is inconsistent |

Existing domain-specific codes remain compatible: `SETTING_VERSION_CONFLICT` is the settings endpoint's established `STALE_VERSION` specialization, while recommendation/alert/experiment lifecycle conflict codes specialize `INVALID_TRANSITION`. Clients should branch on the returned code and HTTP status and use `retryable` only for safe read/evaluation retry policy; mutation retries still require idempotency knowledge.

### Structured operations and privacy-safe logging

Operational logs are one-line JSON records with an ISO timestamp and stable event name. Events cover creative sync start/completion, provider failure, lock acquisition/collision/stale recovery/renewal/release/ownership mismatch, creative scoring, recommendation and alert evaluation, Task conversion, evaluation-run completion, provider fetch, token refresh, and scheduler status. Relevant records include bounded IDs, platform/connection scope, status, counts, duration, safe provider category/code, retryability, and a validated request ID when available.

Provider failures normalize to `AUTHENTICATION`, `PERMISSION`, `RATE_LIMIT`, `TIMEOUT`, `UNAVAILABLE`, `INVALID_REQUEST`, `PROVIDER_DATA`, or `UNKNOWN`. Logs and stored summaries never include access/refresh tokens, cookies, authorization headers, encrypted credentials, raw provider bodies, full payment references, arbitrary request bodies, stack traces, or raw lock-owner values. Lock telemetry may contain the operation key and safe ownership outcome, but never the owner token.

### Migration history and manifest ownership

Sections 18-21 require no corrective migration. The current schema, indexes, foreign keys, nullable monetary-setting defaults, independent alert scheduler fields, run-ledger fields, and nullable Task-assignee relationship already satisfy the hardening contract. Applied migrations remain immutable.

| Phase | Ordered migration ownership |
|---|---|
| Phase 2A | `20260721_marketing_intelligence_wp0_corrections.sql` |
| Phase 2B | `20260722_marketing_intelligence_phase2_section7_schema.sql`, `20260723_marketing_intelligence_phase2_section8_raw_ingestion.sql`, `20260724_marketing_intelligence_phase2_section9_scoring_enums.sql` |
| Phase 2C | `20260725_marketing_intelligence_phase2_sections10_13.sql`, `20260726_marketing_intelligence_sections10_13_audit_corrections.sql`, `20260727_marketing_intelligence_sections14_17.sql` |
| Sections 18-21 corrective | none required |

`prisma/manual-migrations/manifest.json` is generated from normalized migration content (UTF-8 BOM removed and CRLF/LF canonicalized) and lists 21 immutable entries in migration order. `npm run db:manifest:generate` is the only mutation command; `npm run db:manifest:verify` is non-mutating and must run before safety/replay gates in CI. A content change, addition, removal, rename, missing manifest entry, unexpected entry, duplicate, or ordering drift fails verification. Line-ending-only and BOM-only changes do not create a false mismatch.

### Release and test procedure

Release validation is intentionally offline and uses mocked provider clients plus the network guard. The mandatory order is:

1. `npx prisma validate --schema=prisma/schema.prisma` and `npx prisma generate --schema=prisma/schema.prisma`.
2. `npm run db:manifest:generate`, followed by `npm run db:manifest:verify`.
3. `npm run migrations:safety`, `npm run db:admin:guard`, `npm run db:schema:assert`, and `npm run db:replay:verify`.
4. `npm run config:validate`, `npm run security:secret-scan`, and `npm run security:audit-policy`.
5. `npm run security:network-guard-static`, `npm run test:network-guard`, and `npm run security:static-social`.
6. Run the focused Marketing Intelligence tests with `node --require ./tests/helpers/network-guard.js --test src/modules/marketing/intelligence/__tests__/*.test.js`, then run `npm test`.
7. Run `git diff --check` and review staged/unstaged/untracked scope. This repository currently defines no lint or build script, so those gates are reported as `SCRIPT_NOT_DEFINED` rather than silently invented.

Production enablement still depends on externally supplied provider credentials, account access/approval, operator-recorded validation evidence, a reachable target database for deployment, and deployment-owner approval. Tests do not fabricate those claims and this work does not enable schedulers or perform provider writes.
