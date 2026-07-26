# Advertising Execution stable errors

| Code | HTTP | Safe meaning |
|---|---:|---|
| `AD_EXECUTION_DISABLED` | 503 | effective global, provider, connection, worker or policy gate is disabled |
| `EXECUTION_PLAN_CONFLICT` | 409 | expectedVersion, fingerprint or lifecycle packet is stale |
| `EXECUTION_VALIDATION_FAILED` | 422 | bounded domain/provider-preflight issues |
| `EXECUTION_APPROVAL_REQUIRED` | 409 | current eligible approval threshold is not met |
| `EXECUTION_SELF_APPROVAL_FORBIDDEN` | 403 | separation-of-duties violation |
| `EXECUTION_BUDGET_POLICY_VIOLATION` | 422 | Decimal-safe spend guardrail failed |
| `EXECUTION_CAPABILITY_UNAVAILABLE` | 409 | provider/account/operation capability unavailable |
| `EXECUTION_PRECONDITION_CHANGED` | 409 | material state changed or reviewed retry is unsafe |
| `EXECUTION_PROVIDER_RATE_LIMITED` | 429 | retryable provider quota response; bounded Retry-After may be returned |
| `EXECUTION_PROVIDER_PERMISSION_ERROR` | 403 | provider authorization or role missing |
| `EXECUTION_OUTCOME_UNKNOWN` | 502 | result uncertain; reconcile, never resubmit blindly |
| `EXECUTION_RECONCILIATION_DRIFT` | 409 | read-back differs from approved desired state |

The production read and write adapter factories both pass provider failures through the neutralizer. It maps sanitized 429, permission, validation, precondition, unknown-outcome and drift categories and never includes raw response bodies; it does not classify every provider 5xx as unknown. A valid provider `Retry-After` delta/date is bounded to one hour before shared middleware returns it. Existing middleware adds the normal failure envelope, request correlation ID and excludes stack traces and native bodies.
