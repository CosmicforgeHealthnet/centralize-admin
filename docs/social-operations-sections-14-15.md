# Social Operations Sections 14-15

Implementation date: 2026-07-17

## Scope

Sections 14 and 15 complete the local legacy Marketing social migration foundation and the expanded test strategy. This work does not implement Section 16, does not enable live inbox or provider synchronization, and does not make real provider calls.

## Migration Equivalence

| Conceptual migration | Existing file or DB objects | Status |
|---|---|---|
| Foundation | `prisma/manual-migrations/20260716_add_social_operations_section_5.sql`; 31 `social_` tables | Satisfied |
| Provider content/metrics | `social_provider_content`, `social_provider_content_metric_snapshots`, `social_identity_metric_snapshots` | Satisfied |
| Action jobs | `social_action_jobs`, `social_action_attempts`, shared lease indexes | Satisfied |
| Health/privacy | sensitive-data fields, escalation fields, redaction fields, Task nullable migration | Satisfied |
| Webhook partial indexes | `social_webhook_subscription_connection_event_unique`, `social_webhook_subscription_identity_event_unique` | Satisfied |

Existing applied migrations were not rewritten, split, renamed, or re-applied. Section 5 already materially covers conceptual phases 1-5, so Section 14 adds only the missing legacy migration work.

## Legacy Schema Audit

Legacy Prisma models:

- `marketing_social_accounts`
- `marketing_social_posts`
- `marketing_social_analytics_snapshots`

Legacy PostgreSQL tables:

- `marketing_social_accounts`
- `marketing_social_posts`
- `marketing_social_analytics_snapshots`

Important legacy fields:

- `marketing_social_posts.id`: stable legacy source ID.
- `platform`, `caption`, `description`, `excerpt`: platform/text fields.
- `attachmentUrl`, `attachmentUrls`, `thumbnailUrl`, `imageUrl`: media-reference fields.
- `postedAt`, `scheduledFor`, `status`: status/time fields.
- `marketing_social_accounts.username`, `encryptedPassword`, `credentialsSaved`: password-style credential fields excluded from migration.

The actual legacy post table has no creator/author/admin column. Rows without a resolvable creator are not migrated automatically and are reported as `CREATOR_UNRESOLVED`. The current local database has zero legacy post rows and zero legacy credential rows.

## Legacy Write Freeze

Changed files:

- `src/modules/marketing/marketing.service.js`
- `src/modules/marketing/marketing.controller.js`
- `src/modules/marketing/legacy-social-transition.policy.js`

Behavior:

- `createSocialPost()` now stores legacy posts as `Draft`, with `postedAt = null`.
- `createSocialSchedule()` preserves the requested `scheduledFor` but stores `Draft`, not `Scheduled`.
- Legacy account creation no longer persists password-style provider credentials, even when `saveCredentials` is requested.
- Legacy write deprecation is configuration-driven and disabled by default.
- Legacy reads remain available unless explicit compatibility-window settings disable them later.

Compatibility settings:

- `MARKETING_LEGACY_SOCIAL_FRONTEND_CUTOVER_COMPLETE`
- `MARKETING_LEGACY_SOCIAL_WRITE_DEPRECATION_ENABLED`
- `MARKETING_LEGACY_SOCIAL_READ_COMPATIBILITY_ENDS_AT`

No hardcoded cutover or sunset date was added.

## Status Mapping

Legacy backfill uses a captured migration reference time.

- Future `scheduledFor` without provider/worker proof maps to `LEGACY_SCHEDULED_UNVERIFIED`.
- Stored `postedAt` or legacy `Published` without independent provider proof maps to `LEGACY_PUBLISHED_UNVERIFIED`.
- Undated/unpublished rows map to `DRAFT`.
- Conflicting future schedule plus published signal is reported as `CONFLICTING_STATUS_TIMESTAMPS`.

Unverified rows are not mapped to `PUBLISHED` and do not create `SocialPublication`.

## Creator Resolution

`SocialPost.createdById` and `SocialPostRevision.createdById` are required. The mapper accepts only a real creator ID that resolves to `AdminUser`. It does not use the migration operator, first admin row, empty strings, sentinel IDs, or fake users.

Because the actual legacy table has no creator column, any non-empty legacy source row requires manual resolution before a later retry.

## Backfill Idempotency

Migration file:

```text
prisma/manual-migrations/20260717_212000_migrate_legacy_marketing_social_records.sql
```

The migration:

- acquires `pg_advisory_xact_lock(hashtext('social_operations_legacy_marketing_social_backfill'))`;
- validates prerequisite tables and legacy enum values;
- creates `social_posts_legacy_source_id_unique` as a partial unique index;
- inserts only eligible rows with resolved creators;
- inserts exactly one initial version-1 revision for each inserted post;
- never mutates legacy rows;
- never creates targets, publications, publishing jobs, provider content, or account connections.

Dry-run command:

```powershell
node scripts/social-operations/legacy-social-backfill.js --dry-run
```

Apply-check command:

```powershell
node scripts/social-operations/legacy-social-backfill.js --apply-check
```

Machine-readable report:

```text
reports/social-operations/legacy-migration-reconciliation.json
```

Human-readable operational report:

```text
reports/social-operations/legacy-migration-reconciliation.md
```

The reports directory is ignored because it contains environment-specific reconciliation output.

## Backup and Apply

Backup command:

```powershell
C:\Program Files\PostgreSQL\18\bin\pg_dump.exe -h localhost -p 5432 -U postgres -d cosmicforge_admin -F c -f C:\Users\favou\OneDrive\Desktop\ADMIN-Backend\backups\cosmicforge_admin_before_sections_14_15_20260717_212000.dump
```

Backup result: success, 259414 bytes.

Migration application result:

```text
BEGIN
pg_advisory_xact_lock
DO
CREATE INDEX
INSERT 0 0
COMMIT
```

Reconciliation counts:

- Total legacy rows: 0.
- Eligible rows: 0.
- Blocking issues: 0.
- SocialPosts inserted: 0.
- Initial revisions inserted: 0.
- Media assets inserted: 0.
- SocialPublications inserted: 0.
- SocialAccountConnections created from legacy credentials: 0.

## Media Handling

Legacy media references are collected from `attachmentUrl`, `attachmentUrls`, `thumbnailUrl`, and `imageUrl`. Default dry-run does not fetch remote URLs and classifies media validation as `VALIDATION_NOT_EXECUTED`. Network validation is opt-in and must use the SSRF-safe media path. No unreachable, blocked, or unvalidated URL produces a `SocialMediaAsset`.

## Credential Exclusion

Legacy username/password-style provider credentials are not migrated. No legacy password, encrypted password, token, cookie, authorization header, or provider secret is copied into Social Operations. All Social provider connections require fresh human-driven OAuth authorization.

## Legacy API Transition

Legacy Marketing social GET routes remain available and protected by existing auth/RBAC. Legacy writes remain available only under the safe freeze behavior unless explicit cutover/deprecation settings are enabled. Marketing Intelligence routes are unaffected.

## Partial Index Verification

Direct PostgreSQL catalog verification confirmed:

- `social_webhook_subscription_connection_event_unique`, unique, valid, predicate `(identity_id IS NULL)`.
- `social_webhook_subscription_identity_event_unique`, unique, valid, predicate `(identity_id IS NOT NULL)`.
- `social_posts_legacy_source_id_unique`, unique, valid, predicate `(legacy_source_id IS NOT NULL)`.

## Testing

Test matrix:

```text
docs/social-operations-testing-matrix.md
```

New focused tests:

- `tests/marketing-legacy-social-freeze.test.js`
- `tests/social-operations-section14-backfill.test.js`
- `tests/social-operations-section15-database-constraints.test.js`
- `tests/social-operations-section15-provider-acceptance.test.js`

Mocked acceptance result: Meta/Facebook, Instagram, TikTok, X, and LinkedIn scenarios passed with synthetic connectors and no real provider network calls.

Live pre-production acceptance status: `PENDING PRE-PRODUCTION EXECUTION`.

Focused Social Operations test surface:

- 163 total.
- 163 passed.
- 0 failed.
- 0 skipped.

Full `npm test`:

- 299 total.
- 299 passed.
- 0 failed.
- 0 skipped.

Startup verification:

- `npm start` launched cleanly on local port 4418.
- Prisma connected successfully.
- `/health` returned 200.
- `/api/v1/marketing/social/connections` returned 401 without authentication.
- `/api/marketing/social/posts` returned 401 without authentication.
- `POST /api/marketing/social/posts` returned 401 without authentication.
- Marketing Intelligence scheduled sync remained disabled.
- Social Operations workers remained disabled.
- No startup migration ran.
- No provider request occurred.

## Confirmations

- No provider ID was fabricated.
- No password credential was migrated.
- No legacy record was deleted.
- No previous migration was modified.
- Marketing Intelligence migrations were not modified.
- Section 16 was not implemented.
