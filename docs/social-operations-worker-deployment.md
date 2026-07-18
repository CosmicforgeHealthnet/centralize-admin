# Social Operations Worker Deployment

Audit date: 2026-07-17

## Local State

- Workers are registered from `src/server.js`.
- `SOCIAL_WORKERS_ENABLED=false` keeps all Social workers disabled.
- Publishing worker consumes `SocialPublishingJob`.
- Action worker consumes `SocialActionJob`.
- Redaction worker remains separate and disabled unless compliance settings pass.

## Required Staging Services

| Service | Command or entrypoint | Queue | Current status |
|---|---|---|---|
| API | `npm start` or container command `node src/server.js` | none | local only |
| Publishing worker | same process runner or dedicated wrapper calling `runPublishingWorkerOnce` loop | `social_publishing_jobs` | not deployed to staging |
| Action worker | same process runner or dedicated wrapper calling `runActionWorkerOnce` loop | `social_action_jobs` | not deployed to staging |
| Redaction worker | `redaction-worker.js` wrapper | privacy redaction batches | disabled pending Phase D/legal approval |

## Deployment Requirements

- One logical consumer group per queue.
- Unique worker instance IDs.
- Explicit concurrency and batch size.
- Explicit lease duration.
- Explicit heartbeat interval.
- Explicit recovery interval.
- Graceful shutdown.
- Provider I/O after transaction commit.
- Workers enabled only in controlled staging test windows.
- Local startup remains disabled by default.

## Current Gap

`SOCIAL_WORKER_POLL_INTERVAL_MS` is environment-backed. Batch size and lease duration currently default inside worker functions unless a deployment wrapper passes explicit arguments. Heartbeat interval and shutdown grace period are implemented in code paths/tests but need staging service configuration documentation once the deployment platform is available.

## Restart Test Status

Automated unit tests cover lease recovery and exactly-once behavior. Real staging restart tests are blocked by staging infrastructure and provider approval.

