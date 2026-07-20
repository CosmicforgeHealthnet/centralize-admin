# CosmicForge Marketing Intelligence Phase 2 Release Runbook

## Release posture

Engineering is complete. Five-provider live validation remains external. The approved immediate destination is Stage 1 schema dark launch with the Phase 2 master flag false.

## Stage 1 deployment

1. Confirm the release branch/worktree and deployment artifact through the normal release process.
2. Run the repository-defined Prisma, manifest, migration-safety, database-target, schema-assertion, replay, configuration, security, network, and test gates.
3. Deploy the ordered 21 migrations without editing any applied SQL.
4. Deploy application code with:

```env
MARKETING_INTELLIGENCE_PHASE2_ENABLED=false
MARKETING_LIVE_VALIDATION_ENABLED=false
MARKETING_RECOMMENDATION_SCHEDULER_ENABLED=false
MARKETING_ALERT_HEALTH_SCHEDULER_ENABLED=false
MARKETING_ALERT_PERFORMANCE_SCHEDULER_ENABLED=false
MARKETING_CREATIVE_SYNC_SCHEDULER_ENABLED=false
MARKETING_CREATIVE_SCORE_SCHEDULER_ENABLED=false
MARKETING_RECOMMENDATION_EXPIRY_SCHEDULER_ENABLED=false
MARKETING_FULL_EVALUATION_SCHEDULER_ENABLED=false
```

5. Keep `MARKETING_INTELLIGENCE_SYNC_ENABLED` at its independently approved Phase 1 value.
6. Confirm Phase 2 reads/settings/connection preparation are available and operational mutations return `MARKETING_INTELLIGENCE_PHASE2_DISABLED`.
7. Confirm Phase 1 campaign sync and event production are unaffected.

## Controlled live validation

Obtain explicit change authorization and provider-account approval. Validate one platform/connection/account at a time. Use at most seven inclusive calendar days.

```powershell
$env:MARKETING_LIVE_VALIDATION_ENABLED='true'
npm run marketing:live-validate -- --confirm-live --platform=META --connection-id=<uuid> --from=2026-07-01 --to=2026-07-02 --account=<account-id>
```

Review connection success, bounded catalog/insight counts, cursor observation, repeated stable IDs, currency, micro-units where applicable, sanitized storage, and safe provider category. Reconcile campaign totals with Phase 1 manually and document provider definition differences. Do not intentionally exhaust rate limits.

## Six-stage controls

| Stage | Master | Ingestion | Scoring | Recommendations/alerts | Task conversion | Exit authority |
|---|:---:|:---:|:---:|:---:|:---:|---|
| 1 Dark launch | Off | Off | Off | Off | Off | Platform + DBA |
| 2 Ingestion observation | On | One validated connection | Off | Off, except approved health | Off | Platform owner |
| 3 Scoring observation | On | On | On | Off | Off | Analytics |
| 4 Advisory | On | On | On | On | Off until review | Marketing/Support |
| 5 Task workflow | On | On | On | On | On for accepted advice | Operations |
| 6 Platform release | On | Passed platforms | On | On | On | Release owner |

## Rollback and kill switch

1. Set `MARKETING_INTELLIGENCE_PHASE2_ENABLED=false`.
2. Disable every Phase 2 scheduler registration flag.
3. Gracefully restart/stop the server so no new callbacks register.
4. Disable a single provider connection when the issue is isolated.
5. Disable `creativeSyncEnabled`, `recommendationEvaluationEnabled`, or `alertEvaluationEnabled` at the narrowest effective scope when appropriate.
6. Inspect evaluation runs for in-flight/failed/lock-lost evidence.
7. Preserve historical rows; do not delete scores, recommendations, alerts, experiments, Tasks, Notifications, audits, or migration history.
8. Leave Phase 1 synchronization operational when healthy.

## Operational verification

- Scheduler status events show master/component eligibility.
- Evaluation-run list/detail exposes safe status, scope, counts, steps, and categories.
- Lock conflict is treated as an overlap outcome; ownership loss stops unsafe continuation.
- Provider errors are handled according to category and retryability.
- Notification/realtime failures do not erase durable alerts or Tasks.
- Alert spam is controlled by scoped disable, dedupe, cooldown, occurrence count, persistence, and recovery review.

## Incident evidence

Collect deployment version, timestamp, operator, run ID, provider/platform and connection ID, bounded account identifier, trigger, range, counts, status, provider category/code, retryability, lock outcome, and rollback action. Exclude tokens, headers, encrypted credentials, raw provider responses, patient/payment PII, stack traces, and lock-owner values.

## Release command set

```powershell
npx prisma validate --schema=prisma/schema.prisma
npx prisma generate --schema=prisma/schema.prisma
npm run db:manifest:generate
npm run db:manifest:verify
npm run migrations:safety
npm run db:admin:guard
npm run db:schema:assert
npm run db:replay:verify
npm run config:validate
npm run security:secret-scan
npm run security:audit-policy
npm run security:network-guard-static
npm run test:network-guard
npm run security:static-social
npm run test:social-operations
npm test
git diff --check
```

Lint is `SCRIPT_NOT_DEFINED`. Build is `NOT_APPLICABLE` for this plain-JavaScript service; Prisma generation, JavaScript syntax checks, static security checks, and tests are the build-equivalent gates.
