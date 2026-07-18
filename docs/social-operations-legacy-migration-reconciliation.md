# Social Operations Legacy Migration Reconciliation

Generated from local `cosmicforge_admin` reconciliation on 2026-07-17.

Report checksum:

```text
229d7c722b827d15997658cb6c65f993750bfbf4eb37d6a58e2e274988bc0a34
```

## Counts

| Metric | Count |
|---|---:|
| totalLegacyRows | 0 |
| eligibleRows | 0 |
| alreadyMigratedRows | 0 |
| draftRows | 0 |
| legacyPublishedUnverifiedRows | 0 |
| legacyScheduledUnverifiedRows | 0 |
| independentlyVerifiedProviderRows | 0 |
| skippedUnresolvedCreatorRows | 0 |
| skippedMalformedRows | 0 |
| conflictingStatusTimestampRows | 0 |
| duplicateLegacySourceIds | 0 |
| totalMediaUrlsDiscovered | 0 |
| validMediaUrls | 0 |
| unreachableMediaUrls | 0 |
| unsafeBlockedMediaUrls | 0 |
| invalidMediaContentTypes | 0 |
| mediaUrlsExceedingSizeLimits | 0 |
| mediaRowsMissingValidOwner | 0 |
| legacyCredentialRowsDetected | 0 |
| passwordStyleCredentialRowsSkipped | 0 |
| oauthStyleRowsRequiringAuthorization | 0 |
| rowsRequiringHumanReconnection | 0 |
| socialPostsWouldBeInserted | 0 |
| initialRevisionsWouldBeInserted | 0 |
| mediaAssetsWouldBeInserted | 0 |
| publicationsWouldBeInserted | 0 |
| targetsWouldBeInserted | 0 |
| errors | 0 |
| warnings | 0 |

## Outcome

The local legacy Marketing social source tables are empty, so no rows were inserted. The migration added idempotency protection through the partial unique `social_posts(legacy_source_id)` index and left legacy records unchanged.

Password-style legacy provider credentials are not migrated. Social provider connections require fresh human-driven OAuth authorization.
