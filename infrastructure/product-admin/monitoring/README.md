# Product Admin observability (Section 12.5)

What exists in the repository: private metrics and status endpoints in both
services, alert rules, and tests. What does **not** exist yet: a deployed
Prometheus/Alertmanager, scrape configuration on the staging host, or any
alert routing. Nothing here claims a running monitoring stack.

## Endpoints (private listener only)

Both services listen on a Unix socket (`0660`, group-restricted) or, when
moved to another host, TLS 1.3 mutual TLS. None of these routes is proxied by
the Central Admin API, and public Nginx denies `/internal/*` and never routes
to these sockets.

| Service | Path | Content | Auth / exposure |
|---|---|---|---|
| Karryam Admin | `GET /health/live` | liveness | private socket |
| Karryam Admin | `GET /health/ready` | database state; `bridge_state` (configured, never `certified`, last recorded Bridge outcome); `worker` (feed state, partitions, held, leased, last success) | private socket |
| Karryam Admin | `GET /metrics` | Prometheus text 0.0.4; when disabled only process and `*_enabled` gauges | private socket |
| Karryam Admin | `GET /sync/status` | sanitized cursors, holds, quarantine counts, last runs, coverage, HQ outbox heads/ACKs; `503 DISABLED` when disabled | private socket |
| Karryam Admin | `GET /internal/product-admin/v1/sync/status` | protocol endpoint (unchanged) | cf-svc-v1 service auth (PIC only) |
| PIC | `GET /health/live`, `GET /health/ready` | database; `trust_store` (`CURRENT`, `CHANGED_RESTART_REQUIRED` → 503, `UNBOUND`); sync mode | private socket |
| PIC | `GET /metrics` | Prometheus text 0.0.4 | private socket |

Health, metrics and status never contain keys, connection strings, file
paths, staff IDs, tokens, request bodies or source records. Label values are
bounded codes (endpoint IDs, route classes such as `/products/:p/metrics/:p`,
reason/category codes, product and dataset IDs, enrolled partition keys, key
IDs). The shared registry (`packages/service-clients/src/metrics.js`) refuses
identity/credential/path label names at declaration, sanitizes values and
caps each metric at a fixed number of series (`__overflow__` beyond it).

Logs in both services are structured JSON with the same redaction: sensitive
keys are replaced, and credentials inside strings (`user:password@` in any
URI, bearer/basic values, compact JWS/JWT, PEM blocks) are scrubbed.
Correlation IDs are logged on every request (PIC also logs the upstream
Central Admin API correlation ID).

## Scraping (operator step, not deployed)

A Prometheus on the same host can scrape the sockets through a local
socket-to-loopback bridge owned by the monitoring account (for example a
`socat` sidecar in the service's socket group), or a node-exporter textfile
job running `curl --unix-socket … /metrics`. Use `job="karryam-admin"` and
`job="product-integration-core"` (the rules rely on these names). Do not
publish the metrics ports and do not add them to public Nginx.

## Alert rules

`alerts.yml` (Prometheus rule format). CI validates it with promtool and with
`services/product-integration-core/tests/alert-rules.test.js`, which checks
every rule has `for:`, a severity and a summary, that the required alerts
exist, and that every referenced metric is exported by a service.

```
docker run --rm -v "$PWD/infrastructure/product-admin/monitoring:/w:ro" --entrypoint promtool prom/prometheus:v2.53.0 check rules /w/alerts.yml
```

Default thresholds (operational starting points, **not** business SLOs; tune
per environment):

| Alert | Default |
|---|---|
| Service / metrics endpoint down | `up == 0` for 5 m |
| Database unavailable | 3 m |
| Crash loop | > 3 restarts in 30 m (process start time changes) |
| Certificate / key expiry | < 14 days, for 1 h |
| Manifest near expiry | < 10 min remaining, for 10 m |
| Trust store changed (revocation/rotation pending restart) | 2 m |
| Signer / identity / manifest drift | 5 m |
| Revoked key presented, transport-security failure, replay | any in 10 m |
| Bridge feed lag | > 500 events for 15 m |
| Worker stalled (feed enabled, no successful run) | > 30 min since last success, for 10 m |
| Unacked Bridge events / HQ outbox / HQ cursor | > 100 / > 1000 / > 100 |
| Integrity hold | 5 m |
| Entity-version gap / HQ gap | open for 30 m |
| Repeated quarantine | > 5 unresolved for 15 m |
| Persistent `UNKNOWN_OUTCOME` | oldest > 15 min |
| Source rate-limit saturation | > 20 % of Bridge calls for 10 m |
| Migration pending / checksum mismatch | 15 m / 1 m |

`for:` durations and `increase()` windows keep a single bad scrape from
paging. Scope-filtered holes in the Bridge's global sequence are normal and
never alert; only entity-version gaps, integrity holds and HQ sequence gaps
do.

**Restore failures** have no runtime signal: the backup/restore drill runs in
CI (`karryam-admin-restore-drill`, `hq-integration-restore-drill` artifacts)
and the operator's staging drill is evidence in the release record. Treat a
failed drill job as the alert.

## Recovery behaviour (tested)

### Database outage

Readiness returns 503 with `database: UNAVAILABLE`, `/metrics` stays
scrapeable with `*_database_up 0` and a counted collector failure, nothing is
acknowledged to the Bridge (Stage A) or to the Product Admin (HQ), and after
the database returns each event is applied exactly once.
Tests: `karryam-admin/tests/recovery-postgres.test.js`,
`product-integration-core/tests/observability-recovery-postgres.test.js`.

### Crash loop

The Stage A worker has no listener; its health is read from the database by
the Karryam Admin server (`bridge_feed_last_success_age_seconds`,
`worker_lease_active`, `sync_runs_failed_1h`). A restarted worker or PIC
resumes from the persisted cursor (tested with a new pool and worker
identity); an expired lease is taken over; a superseded lease holder cannot
commit.

Other recovery cases and where they are tested:

| Case | Test |
|---|---|
| Crash before commit / after commit before ACK, ACK retry | `karryam-admin/tests/pipeline-postgres.test.js`, `product-integration-core/tests/karryam-two-stage-postgres.test.js` |
| Bridge outage, revoked transport identity, lease collision | `karryam-admin/tests/pipeline-postgres.test.js` |
| Late-visible events, duplicate redelivery | `karryam-admin/tests/pipeline-postgres.test.js`, `product-integration-core/tests/sync-postgres.test.js` |
| HQ offline while Stage A continues | `product-integration-core/tests/karryam-two-stage-postgres.test.js` |
| Emergency signer revocation / trust change, key rotation overlap | `product-integration-core/tests/sync-policy.test.js`, `sync-gate-postgres.test.js`, `karryam-admin/tests/section11-postgres.test.js` |
| Restart from persisted cursor, PostgreSQL outage | the two recovery suites above |
