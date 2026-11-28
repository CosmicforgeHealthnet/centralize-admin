# Karryam staging continuation ? 7 November 2026

Checked at 03:47:44 Lagos time. This is a read-only readiness checkpoint, not a completion certificate.

## Verified current integration

Karryam remains ENABLED, REACHABLE and HEALTHY in HQ, with drift NONE. Two subscriptions are ACTIVE, enabled and have COMPLETE coverage. Stage A cursor and ACK remain 2 with no recorded feed error. Source observation timestamps are retained; healthy polling is not proof that a metric is fresh. The Bridge currently reports Support freshness as STALE even though its backfill and coverage are COMPLETE. Verification and Notification freshness are UNKNOWN and their backfill status is NONE. These are separate states and must not be collapsed into a green ?all connected? claim.

## Complete source inventory

Container presence and a static READ capability are not evidence of authorized staff access. The installed policy document is version 2 and lists only Taxi, Support and the technical Bridge feed/status/ACK capabilities. Other owners below are not approved by that document.

| Source service | Current container | Docker health | Included in installed source policy |
| --- | --- | --- | --- |
| Analytics Service | No matching known container | Not verified | No |
| Support/Dispute Service | running | healthy | Yes ? exact read capabilities only |
| Payment/Wallet Service | running | healthy | No |
| Verification/Compliance Service | running | healthy | No |
| Notification Service | running | healthy | No |
| Taxi Service | running | healthy | Yes ? exact read capabilities only |
| Customer Service | running | healthy | No |
| Dispatch/Delivery Service | running | healthy | No |
| Hauling Service | running | healthy | No |
| Fleet Partner Service | running | healthy | No |
| Media/File Service | running | healthy | No |
| Pricing Service | running | healthy | No |
| Vendor Service | running | healthy | No |
| Referral Service | running | healthy | No |

No Analytics container matched the known name. This does not prove no Analytics deployment exists elsewhere. Verification and Notification containers are running, but their inspected admin integration switches/credentials are not configured. Bridge coverage remains PARTIAL_COVERAGE for their respective sources. They must not be advertised as connected or represented by successful zero values.

## Staff acceptance and remaining work

David?s actual Central Admin account is ACTIVE; twoFactorEnabled is false and there is no native MFA enrollment. The existing code requires a genuine recent MFA session for live resource reads. The current metrics grant does not include resource.read. Enrollment alone therefore does not create data permissions: a correctly scoped native product-role grant is also required before live Taxi/Support acceptance. Do not fabricate a session, alter MFA timestamps or turn the first-metrics bootstrap into a source-data access workaround.

The signed read role is karryam.customer-care.viewer, with purpose support-review for Taxi and Support. Native HQ grant management remains subject to its existing authorized-manager, no-self-grant and audit controls. The next acceptance package must use that real workflow.

For broader sources, prepare owner-specific minimized read rules, real signed owner allocations and current private reader/publisher/snapshot credentials before activation. Verification/Marketing dataset approval, subscriptions and staff grants are distinct from merely having their source containers running. Finance reporting and Analytics availability must be reported according to the actual implemented source contracts; no finance figures or suppressed analytics may be invented.

## Repeatable evidence

`infrastructure/product-admin/staging/audit-karryam-runtime.py` performs Docker metadata reads and SELECT-only transactions using each integration service?s own runtime connection. Run it only as an authorized staging operator. It prints no environment values, credentials, source records, MFA material or signing keys. Policy metadata is summarized, not independently re-signed or re-certified.

Sanitized output: `docs/product-admin/evidence/karryam-runtime-audit-2026-11-07.json`. The tool covered all fourteen source entries and found thirteen known containers. Both integration database checks succeeded. Source flags, roles, database rows, workers, certificates and services were not changed. Production was untouched.
