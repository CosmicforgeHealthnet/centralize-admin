# Advertising Execution RBAC matrix

The module reuses Marketing VIEW/EDIT grants. Fine roles reuse `AdminSectionGrant` with sections `advertising-execution:author`, `:approver`, `:execution-admin`, `:emergency-operator`, or `advertising-execution:*`. SUPER is the platform-level explicit bypass; UI visibility is never authorization.

| Capability | Marketing mode | Fine role |
|---|---|---|
| capabilities, policies, plans, runs, operations, drift, publications, health | VIEW | none |
| create/edit/cancel/validate/submit/queue plan | EDIT | AUTHOR |
| recommendation conversion, publication revision, compensation DRAFT | EDIT | AUTHOR |
| approve, reject, revoke own approval | EDIT | APPROVER |
| policy update, reviewed operation retry | EDIT | EXECUTION_ADMIN |
| drift acknowledgment | EDIT | EXECUTION_ADMIN; service also enforces incident state/scope |
| create/use emergency override | EDIT | EMERGENCY_OPERATOR; service reloads an ACTIVE SUPER account with platform 2FA, exact plan/account scope and a maximum two-hour expiry |

The author cannot be the sole approver. Required approver tier and count are frozen with the submitted packet. A worker cannot approve, and revocation affects only the actor's current approval before execution begins. All reviewed retries use Option B: EXECUTION_ADMIN is required; AUTHOR or APPROVER alone cannot schedule one. An override can bypass only the exact connection-write gate and cannot bypass global/provider shutdown, capability, credentials, network, audit, idempotency, regulated-category or unknown-outcome controls.
