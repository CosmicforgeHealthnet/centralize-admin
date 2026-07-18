# Social Operations Alerting Runbook

Audit date: 2026-07-17

No monitoring platform access was available from this workspace. This runbook defines required alerts and safe payload rules.

## Required Alerts

| Alert | Condition | Severity | Safe payload |
|---|---|---|---|
| Publishing queue backlog | pending or retry-scheduled jobs exceed threshold | warning/critical | counts, oldest age, queue name |
| Action queue backlog | pending or retry-scheduled action jobs exceed threshold | warning/critical | counts, oldest age, queue name |
| Oldest pending job age | oldest due job exceeds SLA | critical | queue, age, job id only if non-sensitive |
| Repeated retryable failures | same provider/action repeated failures | warning | provider, operation, sanitized reason code |
| Permanent failures | terminal provider failure | warning | provider, operation, sanitized reason code |
| Retry exhaustion | max attempts reached | critical | provider, operation, sanitized reason code |
| Reauthorization required | connection enters reauth state | warning | provider, connection id |
| Token expiry | token near/at expiry | warning | provider, connection id, expiry bucket |
| Webhook subscription health | degraded subscription or failed verification | critical | provider, event type |
| Webhook processing backlog | received events not processed | warning/critical | counts and age |
| Invalid webhook signatures | signature failures above threshold | warning | provider and count only |
| Provider rate limits | retry-after/rate-limit responses | warning | provider, operation, retry bucket |
| Redaction batch failures | redaction worker failures | critical | batch id/counts only |
| HealthNet escalation SLA | unresolved safety escalation exceeds SLA | critical | escalation id, classification code, no content |

## Safe Logging Rules

- Do not include message text, comment text, internal notes, webhook raw payloads, provider raw responses, credentials, tokens, cookies, authorization headers, attachment URLs, or PHI.
- Use safe reason codes and counts.
- Link to restricted admin views only where RBAC protects the target.

## Current Status

Alerting is blocked by monitoring-platform access and staging deployment. Code emits safe domain events and sanitized audit metadata, but no real monitor/alert routing is configured in this workspace.
