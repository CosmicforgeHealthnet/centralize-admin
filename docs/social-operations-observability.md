# Social Operations Observability

Protected endpoint:

`GET /api/v1/marketing/social/operations/health`

Authorization:

`requireSection("marketing", "social_operations", "VIEW")`

Metric categories:

- `publishingQueue`
- `actionQueue`
- `workers`
- `webhooks`
- `connections`
- `privacy`
- `healthNet`
- `generatedAt`

The response contains aggregate operational state only. It does not include message text, comment text, note text, attachment URLs, provider payloads, tokens, credentials, or personal identifiers.

Worker process metrics are provider-neutral in-process counters for lease recovery, claim failures, last heartbeat, and processing duration aggregates. Database-backed metrics cover queue status, stale leases, webhook backlog, invalid signatures, connection expiry, subscription health, redaction backlog, and HealthNet safety escalations.

Monitoring-vendor dashboards and alert delivery remain external pending work.
