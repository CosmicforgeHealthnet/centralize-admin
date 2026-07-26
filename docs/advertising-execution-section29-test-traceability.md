# Advertising Execution — Section 29 requirement-to-test traceability

Generated 2026-07-23. Every mandatory Section 29 suite row maps to at least one direct automated test. Automated status `COVERED` means the named tests pass offline under the runtime network guard with zero live provider calls. Live status is `NOT_LIVE_VALIDATED` for every provider-facing behavior; the Section 29.2 harness exists but has never been executed. Test levels: U = unit, C = provider contract (fake transport through the production adapter factory), S = service integration, H = HTTP integration, P = PostgreSQL integration (disposable database), M = migration/manifest, D = documentation, L = live-harness offline safety.

Paths are relative to the repository root. `__tests__` = `src/modules/marketing/advertising-execution/__tests__`.

## 29-PLAN — Plans (CRUD, version conflicts, immutable states, fingerprint invalidation)

| ID | Required case | Test file | Test name (prefix) | Level | Pos | Neg | PG | Live stage | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 29-PLAN-001 | Valid manual DRAFT create, zero provider calls | `__tests__/section29.plans.test.js` | "29-PLAN create accepts a valid manual DRAFT…" | S | ✓ | — | — | validate-only | Network-guard counter asserted zero |
| 29-PLAN-002 | Invalid provider/connection/account/currency/empty operations | same | "29-PLAN create rejects invalid provider…" | U | — | ✓ | — | — | |
| 29-PLAN-003 | Raw provider JSON, credential fields, prototype keys, forged sources | same | "29-PLAN create rejects raw provider payloads…" | U | — | ✓ | — | — | `proto` normalization gap fixed in `plan.validator.js` / `plan-fingerprint.js` |
| 29-PLAN-004 | Mixed provider/connection/account/currency rejected | same | "29-PLAN mixed provider…" | U | — | ✓ | — | — | Single `currencyCode` field makes multi-currency inexpressible |
| 29-PLAN-005 | List pagination bounds, filter allowlist, sort allowlist, deterministic ordering | same | "29-PLAN list pagination is bounded…" | U/S | ✓ | ✓ | — | — | Max page size 100; id tiebreaker ordering |
| 29-PLAN-006 | Detail mapper: no secrets, current vs historical validation, compensation and recommendation links | same | "29-PLAN read mappers expose no secrets…" | U | ✓ | ✓ | — | — | |
| 29-PLAN-007 | expectedVersion required, stale conflict, version increment, fingerprint invalidated, approvals invalidated not deleted | same | "29-PLAN update requires expectedVersion…" | S | ✓ | ✓ | — | — | VERSIONED_STALENESS strategy |
| 29-PLAN-008 | Concurrent updates produce one winner | same + `tests/advertising-execution-sections25-28-postgres.test.js` ("production service creates, lists, edits…") | "29-PLAN concurrent durable updates…" | U + P | ✓ | ✓ | ✓ | — | Optimistic `(id, version, DRAFT)` predicate |
| 29-PLAN-009 | Every non-DRAFT state rejects edits; immutable provider/account/currency change requires replacement | same | "29-PLAN every non-DRAFT state rejects edits…" | U | ✓ | ✓ | — | — | Full `PLAN_STATES` sweep |
| 29-PLAN-010 | Cancel: eligible DRAFT only; submitted/approved/queued/running rejected; evidence preserved; no destructive cascade | same | "29-PLAN cancel is DRAFT-scoped…" | U/S | ✓ | ✓ | — | cleanup | EXECUTING requires reconciliation |
| 29-PLAN-011 | Validation lifecycle, fingerprint bound to version, queue demands current packet | same | "29-PLAN validation lifecycle…" | S | ✓ | ✓ | — | — | |
| 29-PLAN-012 | Fingerprint invalidation per material dimension (budget, currency, creative revision, URL, UTM, targeting, placements, bidding, schedule, activation, scope, dependencies); non-material fields stable | same | "29-PLAN fingerprint invalidation covers every material dimension…" | U | ✓ | ✓ | — | — | 15 material dimensions + 6 non-material fields |
| 29-PLAN-013 | Item-set integrity before persistence | same + `__tests__/sections9-10.repositories.test.js` | "29-PLAN item sets reject duplicate sequences…" | U | — | ✓ | — | — | |

## 29-POLICY — Policy (currency, caps, shared budgets, approvals, regulated categories)

| ID | Required case | Test file | Test name (prefix) | Level | Pos | Neg | PG | Live stage | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 29-POLICY-001 | Supported/unsupported currency, account mismatch, decimal safety, no float precision loss, cross-currency caps | `__tests__/section29.policies.test.js` | "29-POLICY currency…" | U | ✓ | ✓ | — | read capability | Binary floats rejected outright |
| 29-POLICY-002 | Per-operation/campaign/daily/monthly(lifetime) caps, zero cap, negative cap, unlimited-null policy, exact boundary, over-limit | same | "29-POLICY caps…" | U | ✓ | ✓ | — | budget cap | |
| 29-POLICY-003 | Stable `EXECUTION_BUDGET_POLICY_VIOLATION` (422) with safe details | same | "29-POLICY violations raise the stable…" | U | ✓ | ✓ | — | — | Production aligned with documented registry (`budget-guard.service.js`) |
| 29-POLICY-004 | Shared budgets: forbidden default, explicit allow, linked-campaign and aggregate exposure, currency mismatch | same + `__tests__/sections16-17.shared.test.js` | "29-POLICY shared budgets…" | U | ✓ | ✓ | — | — | Concurrent shared validation via PG queue serialization (29-QUEUE-001) |
| 29-POLICY-005 | Approval policy: required count, tier, precedence GLOBAL→PLATFORM→CONNECTION, restrictive global cannot be bypassed | same + `tests/advertising-execution-sections25-28-postgres.test.js` ("policy updates are optimistic…") | "29-POLICY approval policy precedence…" | U + P | ✓ | ✓ | ✓ | — | `GLOBAL_RESTRICTIVE` source |
| 29-POLICY-006 | Approver eligibility: provider/connection/currency/tier/threshold | same | "29-POLICY approval eligibility…" | U | ✓ | ✓ | — | — | |
| 29-POLICY-007 | All ten regulated categories rejected server-side; client flags not trusted | same + `__tests__/sections19-24.execution.test.js` | "29-POLICY all regulated categories fail closed…" | U | — | ✓ | — | never in live scope | POLITICAL, HOUSING, EMPLOYMENT, CREDIT, HEALTHCARE, PROTECTED_CHARACTERISTIC, SENSITIVE_TRAIT, CRM_CUSTOMER_LIST, CUSTOM_AUDIENCE_PII, DATA_BROKER |
| 29-POLICY-008 | Decimal micros/minor-unit provider conversion | same | "29-POLICY provider budget conversion…" | U | ✓ | ✓ | — | budget cap | |
| 29-POLICY-009 | Approval expiry / freshness / snapshot staleness | `__tests__/section29.approvals.test.js` + `__tests__/sections16-17.shared.test.js` | "29-APPROVAL expiry…" / "budget guard blocks stale state…" | U | ✓ | ✓ | — | — | |

## 29-APPROVAL — Approvals (self-approval, stale fingerprint, quorum, revoke, expiry, override)

| ID | Required case | Test file | Test name (prefix) | Level | Pos | Neg | PG | Live stage | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 29-APPROVAL-001 | Self-approval forbidden as sole approver; elevated role no bypass; author-in-quorum only by policy; stable 403 mapping | `__tests__/section29.approvals.test.js` | "29-APPROVAL self-approval…" | U | ✓ | ✓ | — | — | `EXECUTION_SELF_APPROVAL_FORBIDDEN` |
| 29-APPROVAL-002 | Stale fingerprint/version rejected at approval, queue and retry; new validation requires new approval | same + `__tests__/section29.idempotency.test.js` (retry review) | "29-APPROVAL stale fingerprint…" | U | — | ✓ | — | — | Claim SQL also qualifies (29-QUEUE-001) |
| 29-APPROVAL-003 | Quorum: insufficient/exact/extra, duplicate actor once, tier, mixed eligibility, rejected/revoked never count | same | "29-APPROVAL quorum…" | U | ✓ | ✓ | — | — | |
| 29-APPROVAL-004 | Decide persists immutable packet; only PENDING_APPROVAL accepts decisions | same | "29-APPROVAL decide persists…" | S | ✓ | ✓ | — | — | |
| 29-APPROVAL-005 | Revoke: append-only event, own current approval only, mandatory reason, quorum recalculated, post-queue revocation blocked | same + `tests/advertising-execution-sections25-28-postgres.test.js` ("validation packets and approval evidence are append-only") | "29-APPROVAL revoke…" | U/S + P | ✓ | ✓ | ✓ | — | |
| 29-APPROVAL-006 | Expiry with injected clock, exact boundary | same | "29-APPROVAL expiry uses injected clocks…" | U | ✓ | ✓ | — | — | No real-time sleeps anywhere |
| 29-APPROVAL-007 | Override: elevated MFA-capable actor, explicit reason/scope, 2h max, global switch never bypassed | same + `tests/advertising-execution-sections25-28-postgres.test.js` ("emergency overrides are exact…") | "29-APPROVAL override requires elevated…" | U + P | ✓ | ✓ | ✓ | — | No fake MFA: current 2FA status reloaded server-side |
| 29-APPROVAL-008 | Override matching: expired/revoked/scope-mismatch/actor-mismatch/control-weakening rejected; non-overridable set complete | same | "29-APPROVAL override matching…" | U | ✓ | ✓ | — | — | |
| 29-APPROVAL-009 | `EXECUTION_OVERRIDE_USED` only on actual consumption; concurrent consumption fails closed | same | "29-APPROVAL EXECUTION_OVERRIDE_USED…" | U | ✓ | ✓ | — | — | |

## 29-QUEUE — Queue and leases (claim, SKIP LOCKED, heartbeat, expiry recovery, shutdown)

| ID | Required case | Test file | Test name (prefix) | Level | Pos | Neg | PG | Live stage | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 29-QUEUE-001 | Claim qualification: states, due retries, priority/age order, bounded batch, disabled providers, stale packets, expiry, rejected/revoked approvals, account serialization | `__tests__/section29.queue-leases.test.js` + `tests/advertising-execution-sections18-24-postgres.test.js` ("SKIP LOCKED, exact approval qualification…") | "29-QUEUE claim SQL excludes…" | U + P | ✓ | ✓ | ✓ | — | |
| 29-QUEUE-002 | SKIP LOCKED with multiple real connections: one claimer, non-blocking, transaction boundaries | `tests/advertising-execution-sections18-24-postgres.test.js` | "SKIP LOCKED, exact approval qualification, and account serialization are enforced" | P | ✓ | ✓ | ✓ | — | Two live PG connections |
| 29-QUEUE-003 | Queue creation atomicity, duplicate/concurrent queue idempotency, failure-injection rollback, no provider call | `tests/advertising-execution-sections25-28-postgres.test.js` ("queue is atomic under injected failure and idempotent under concurrency") + `__tests__/section29.queue-leases.test.js` (packet gates) | — | P + U | ✓ | ✓ | ✓ | — | |
| 29-QUEUE-004 | Heartbeat: owner-only, lease extension, clamped lease, terminal jobs unrevivable | `__tests__/section29.queue-leases.test.js` | "29-QUEUE heartbeat succeeds only for the owner…" | U | ✓ | ✓ | — | — | |
| 29-QUEUE-005 | Expiry recovery matrix: CLAIMED→RETRY_SCHEDULED, RUNNING+UNKNOWN→reconciliation, known-success→POST_WRITE_VERIFICATION, non-retryable→FAILED, exhausted→DEAD_LETTER; reason and previous owner stored; active leases untouched | same | "29-QUEUE expiry recovery routes each expired job…" | U | ✓ | ✓ | — | — | |
| 29-QUEUE-006 | Completion terminal-only; queue packet capability/gate checks | same | "29-QUEUE completion accepts only terminal statuses…" | U | ✓ | ✓ | — | — | |
| 29-QUEUE-007 | Shutdown: stops claims, drains in-flight, releases only owned leases/locks, never marks unfinished work successful; worker/reconciliation worker never start on import or when disabled | same + `__tests__/sections11-17.config.test.js` | "29-QUEUE worker never starts on import…" | U/S | ✓ | ✓ | — | — | |
| 29-QUEUE-008 | Cancellation: lease-owner-scoped observation, durable cascade | same + `tests/advertising-execution-sections25-28-postgres.test.js` ("claimed cancellation is durable…") | "29-QUEUE cancellation observation…" | U + P | ✓ | ✓ | ✓ | — | |

## 29-IDEMPOTENCY — (duplicate submit, duplicate queue, duplicate attempt, unknown outcome, read-back recovery)

| ID | Required case | Test file | Test name (prefix) | Level | Pos | Neg | PG | Live stage | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 29-IDEMPOTENCY-001 | Canonical operation key: every identity dimension changes it; timestamps/attempts/workers do not; malformed identity fails | `__tests__/section29.idempotency.test.js` | "29-IDEMPOTENCY the canonical operation key…" | U | ✓ | ✓ | — | — | Delimiter-collision case in `sections19-24.execution.test.js` |
| 29-IDEMPOTENCY-002 | Duplicate/concurrent submit resolves to one run; changed fingerprint gets new identity | same + `tests/advertising-execution-sections18-24-postgres.test.js` ("duplicate approved plan submission resolves to one durable run") | "29-IDEMPOTENCY duplicate submit…" | U + P | ✓ | ✓ | ✓ | — | P2002 race path exercised |
| 29-IDEMPOTENCY-003 | Duplicate queue: no duplicate run/active job/operations/snapshots | `tests/advertising-execution-sections25-28-postgres.test.js` ("queue is atomic under injected failure and idempotent under concurrency") | — | P | ✓ | ✓ | ✓ | — | |
| 29-IDEMPOTENCY-004 | Unknown outcome: no blind retry, operation UNKNOWN, reconciliation routing, dependents frozen, events emitted | `__tests__/section29.idempotency.test.js` | "29-IDEMPOTENCY runner marks unknown outcomes UNKNOWN…" | S | ✓ | ✓ | — | — | Provider call count asserted = 1 |
| 29-IDEMPOTENCY-005 | Known provider success + local persistence failure → durable recovery with provider identity preserved | same | "29-IDEMPOTENCY known provider success with failed local persistence…" | S | ✓ | ✓ | — | — | |
| 29-IDEMPOTENCY-006 | Read-back recovery / retry review: only known safe failures, provider-processing block, expired packets, exact failed-attempt identity, dependency safety | same + `tests/advertising-execution-sections25-28-postgres.test.js` ("reviewed retry revalidates state and creates job, review, state and audit atomically", "retry-review idempotency…") | "29-IDEMPOTENCY retry review…" | U + P | ✓ | ✓ | ✓ | — | Read-back before mutation retried is enforced by `assertBeforeStateCurrent` |

## 29-GOOGLE / 29-META / 29-TIKTOK / 29-LINKEDIN / 29-X — Provider contract suites

All use provider-specific fake transports (`__tests__/helpers/fake-provider-transports.js`) injected through `createProviderExecutionAdapter` and checked against the production host allowlist (`provider-network.policy.js`). Credentials are witnessed as a boolean and never stored. Live status for every row: NOT_LIVE_VALIDATED; the corresponding live harness stage is listed.

| ID | Required case | Test file | Level | Pos | Neg | Live stage |
|---|---|---|---|---|---|---|
| 29-GOOGLE-001 | Validate-only: no mutation, version captured, capability error mapping | `__tests__/section29.google-ads.test.js` | C | ✓ | ✓ | validate-only |
| 29-GOOGLE-002 | Temporary resource graph: budget→campaign→group→ad, reference resolution, invalid dependency, temp id never final | same | C | ✓ | ✓ | graph validation |
| 29-GOOGLE-003 | Micros: exact conversion, boundaries, no rounding, overflow, pre-converted units forbidden, shared budget flag | same | C/U | ✓ | ✓ | budget cap |
| 29-GOOGLE-004 | Partial failure: indexed mapping, success preserved, no global success, transient classification | same | C | ✓ | ✓ | read-back |
| 29-GOOGLE-005 | Required declarations: EU political declaration required/non-political; unsupported placements | same + `__tests__/section11.google-ads.test.js` | C | ✓ | ✓ | validate-only |
| 29-GOOGLE-006 | Immutable fields: campaign type/ownership change requires replacement | same | C/U | ✓ | ✓ | — |
| 29-GOOGLE-007 | Host allowlist blocks foreign endpoints; idempotent replay never re-mutates; credentials never stored | same | C | ✓ | ✓ | preflight |
| 29-META-001 | Hierarchy campaign→ad set→creative→ad; invalid order; existing parent references | `__tests__/section29.meta.test.js` | C | ✓ | ✓ | hierarchy |
| 29-META-002 | Paused creation for every level; activation separate; ACTIVE read-back is drift | same | C | ✓ | ✓ | paused create |
| 29-META-003 | Batch subresults: mixed codes, per-item ids/errors, bounded messages, no raw body | same | U | ✓ | ✓ | batch verify |
| 29-META-004 | Rate limits: 429, usage headers, retry-after (numeric + HTTP-date), bounded retry, no blind uncertain retry | same | C/U | ✓ | ✓ | — |
| 29-META-005 | Identity ownership + regulated special categories before any provider call | same + `__tests__/section12.meta.test.js` | C | — | ✓ | — |
| 29-TIKTOK-001 | Objective/billing/optimization registry, no silent substitution | `__tests__/section29.tiktok.test.js` | C | ✓ | ✓ | capability |
| 29-TIKTOK-002 | request_id extraction, sanitization, bounds, missing handled, never a credential/key | same | C | ✓ | ✓ | request_id capture |
| 29-TIKTOK-003 | Paused creation for all resources; separate activation | same | C | ✓ | — | paused create |
| 29-TIKTOK-004 | Review states normalize to closed enum; success ≠ APPROVED; non-approved blocks activation; sync failure → UNKNOWN; no auto-resubmit | same + `__tests__/section29.creatives.test.js` | C/U | ✓ | ✓ | review read-back |
| 29-TIKTOK-005 | Smart+/R&F/unauthorized Spark rejected | same + `__tests__/section13.tiktok.test.js` | C | — | ✓ | — |
| 29-LINKEDIN-001 | Version header on every instruction; missing header rejected by fake provider; version in evidence | `__tests__/section29.linkedin.test.js` | C | ✓ | ✓ | version check |
| 29-LINKEDIN-002 | Sunset/malformed versions → capability unavailable; no hardcoded fallback | same | C/U | — | ✓ | version check |
| 29-LINKEDIN-003 | Permissions: rw_ads scope, role, read vs write, development tier, stable errors, no token leakage | same | C | ✓ | ✓ | permissions |
| 29-LINKEDIN-004 | Format limits: supported/unsupported formats, campaign/creative mismatch, protected-characteristic targeting | same | C | ✓ | ✓ | format capability |
| 29-LINKEDIN-005 | Budgets: decimal conversion, provider minimum, policy caps, daily/lifetime semantics, shared unsupported | same | C/U | ✓ | ✓ | minimum budget |
| 29-X-001 | Micro-units: exact conversion, boundaries, precision, overflow, round trip | `__tests__/section29.x.test.js` | C/U | ✓ | ✓ | micro-unit check |
| 29-X-002 | Parent budget limits: campaign/line-item/bid caps, exact boundary pass, over-limit stable errors, funding read-only | same | C | ✓ | ✓ | funding capability |
| 29-X-003 | Line-item targeting: typed criteria, native IDs, conflicts, unsupported types, discovery capability, regulated block | same | U | ✓ | ✓ | targeting read-back |
| 29-X-004 | Deterministic paused hierarchy; transport witnesses MICROS; rate-limit normalization | same | C | ✓ | ✓ | paused create |

## 29-CREATIVE — Creatives (file signature, size/aspect/duration, hash, revision, review rejection)

| ID | Required case | Test file | Level | Pos | Neg | PG | Notes |
|---|---|---|---|---|---|---|---|
| 29-CREATIVE-001 | Signatures: MIME match, declared mismatch, truncated/malformed, executables, polyglots, unsupported types | `__tests__/section29.creatives.test.js` | U | ✓ | ✓ | — | No transport is reachable after failure |
| 29-CREATIVE-002 | Byte/dimension/aspect/duration/codec limits from measured metadata; malware scan policy; provider format registry | same + `__tests__/section18.creatives.test.js` | U | ✓ | ✓ | — | |
| 29-CREATIVE-003 | Unicode-aware copy limits (emoji, combining characters, exact boundary) | same | U | ✓ | ✓ | — | Code-point counting proven vs UTF-16 |
| 29-CREATIVE-004 | Deterministic SHA-256 projection: material changes (copy, URL, UTM, media checksum, format, identity, accessibility) alter hash; review state/request id/timestamps/attempts never do | same + `__tests__/section18.creatives.test.js` | U | ✓ | ✓ | — | |
| 29-CREATIVE-005 | Revisions: sequential/concurrent allocation, exact-duplicate idempotency, immutability of old revisions | `tests/advertising-execution-sections18-24-postgres.test.js` ("creative validation persists, allocates concurrent revisions, deduplicates, scans, and sanitizes") | P | ✓ | ✓ | ✓ | Real advisory-lock concurrency |
| 29-CREATIVE-006 | Review rejection: durable, blocks activation, no auto-resubmit, new human revision with new hash, sync failure → UNKNOWN, audit/event | `__tests__/section29.creatives.test.js` | U/S | ✓ | ✓ | — | Append-only review sync |
| 29-CREATIVE-007 | Checksum dedupe and byte-level divergence | same | U | ✓ | ✓ | — | |

## 29-RECON — Reconciliation (VERIFIED, DRIFTED, UNKNOWN, EXTERNAL_CHANGE, COMPENSATION)

| ID | Required case | Test file | Level | Pos | Neg | PG | Notes |
|---|---|---|---|---|---|---|---|
| 29-RECON-001 | VERIFIED: AFTER snapshot, operation/run/plan aggregates, audit/event | `__tests__/section29.reconciliation.test.js` + `tests/advertising-execution-sections18-24-postgres.test.js` ("reconciliation worker reads back, verifies, and updates durable aggregates") | S + P | ✓ | — | ✓ | |
| 29-RECON-002 | DRIFTED: bounded differences, no global success, no automatic overwrite, drift audit | same | S | ✓ | ✓ | — | |
| 29-RECON-003 | UNKNOWN: read-back unavailable, durable job, bounded retry, escalation, no mutation retry | same | S | ✓ | ✓ | — | Worker escalates at attempt cap |
| 29-RECON-004 | EXTERNAL_CHANGE: previous + current hash retained, external actor classified, incident stays unresolved | same | S | ✓ | ✓ | — | Acknowledgment-never-resolves in `tests/advertising-execution-sections25-28-postgres.test.js` |
| 29-RECON-005 | COMPENSATION: lineage, separate DRAFT, normal lifecycle, COMPENSATED only after full safe-state verification, failed states preserved, spend irreversible | same + `tests/advertising-execution-sections25-28-postgres.test.js` | S + P | ✓ | ✓ | ✓ | |
| 29-RECON-006 | Material comparison normalization (decimals, URLs, unordered collections) | same | U | ✓ | ✓ | — | |

## 29-SECURITY — Security (no raw payload, secret scan, host allowlist, JSON limits, RBAC)

| ID | Required case | Test file | Level | Pos | Neg | Notes |
|---|---|---|---|---|---|---|
| 29-SECURITY-001 | Recursive forbidden-key assertions across every response mapper; no raw request/response, tokens, credential envelopes, signed URLs, upload tokens, paths, lease/lock owners, stacks | `__tests__/section29.security.test.js` + `__tests__/sections25-28.api-security-observability.test.js` | U/H | ✓ | ✓ | Sentinel-value proof |
| 29-SECURITY-002 | Secret scanner runs clean; each rule detects a runtime-assembled synthetic fixture; report leaks nothing | same | U | ✓ | ✓ | Fixtures never appear literally in the tree |
| 29-SECURITY-003 | Host allowlist: approved host, unapproved host, redirects (incl. cross-origin/private), loopback/link-local/reserved DNS, protocol downgrade, embedded credentials, header stripping | same + `__tests__/sections25-28.remediation.test.js` | U | ✓ | ✓ | |
| 29-SECURITY-004 | Network guard runtime: redirect refusal, response-size limit, timeout clamp, scanner-style allowlist required | same | U | ✓ | ✓ | |
| 29-SECURITY-005 | JSON limits: bytes, depth, arrays, keys, strings, prototype keys, credential keys, raw fields, executables | same + `__tests__/sections9-10.contract.test.js` | U | ✓ | ✓ | |
| 29-SECURITY-006 | Transport: JSON/multipart only for mutations | same | U | ✓ | ✓ | |
| 29-SECURITY-007 | Authentication, section RBAC, fine roles, rate limits, correlation IDs on all endpoints | `tests/advertising-execution-sections25-28-http.test.js` + `__tests__/sections25-28.api-security-observability.test.js` | H | ✓ | ✓ | Mounted-app middleware order |

## 29-DOCS — Docs and migrations (route inventory, schema assertions, manifest, replay, no drift)

| ID | Required case | Test file | Level | Pos | Neg | Notes |
|---|---|---|---|---|---|---|
| 29-DOCS-001 | Runtime route inventory: 25 business endpoints + publications list + authenticated health, mounted once, exact methods, no duplicates, no direct-execute, no undocumented high-risk route | `__tests__/section29.docs-migrations.test.js` | U (runtime stack) | ✓ | ✓ | Router stack inspection, not regex |
| 29-DOCS-002 | Exact base path mounted once in the application | same | D | ✓ | ✓ | |
| 29-DOCS-003 | Schema assertion inventory (25 tables / 20 indexes / 7 enums incl. triggers, queue idempotency, retry linkage, cancellation, compensation lineage, override evidence); absent object fails closed | same + `tests/advertising-execution-sections18-24-postgres.test.js` | U + P | ✓ | ✓ | |
| 29-DOCS-004 | Manifest: every migration listed once, canonical checksums, cross-platform canonicalization, read-only verification | same | M | ✓ | ✓ | `utf8-no-bom-lf-one-final-newline` |
| 29-DOCS-005 | Replay: ordered additive migrations, no destructive DDL; empty-database replay via `db:replay:verify` and the PostgreSQL suites | same + `tests/advertising-execution-sections18-24-postgres.test.js` | M + P | ✓ | ✓ | |
| 29-DOCS-006 | Documentation inventory: every stable error code documented, endpoints documented, matrix `NOT_LIVE_VALIDATED`, runbook documents Section 29 commands | same | D | ✓ | ✓ | |

## 29-LIVE — Section 29.2 live-test harness (offline safety proof)

All in `tests/advertising-execution-section29-live-harness.test.js` (level L). Live status: the harness has NEVER been executed; every provider remains NOT_LIVE_VALIDATED.

| ID | Required case | Test name (prefix) |
|---|---|---|
| 29-LIVE-001 | Missing/wrong confirmation → zero provider calls | "live gates fail closed on missing or wrong confirmation…" |
| 29-LIVE-002 | Missing account allowlist / production-like account / non-sandbox connection denied | "live gates require sandbox connection…" |
| 29-LIVE-003 | Budget above Decimal cap, unsupported currency, denied destination domain | "live gates enforce Decimal budget cap…" |
| 29-LIVE-004 | Guarded test process, NODE_ENV=test, CI, worker overlap refused; operator/reason/prefix/cleanup/output-dir mandatory | "live gates refuse guarded test processes…" |
| 29-LIVE-005 | Isolated execution env; worker never enabled; write phase needs the exact `--confirm-write` value | "gate-approved config isolates execution flags…" |
| 29-LIVE-006 | Dry-run/validate-only always precedes writes; no write without human confirmation | "harness runs dry-run first…" |
| 29-LIVE-007 | Read mode is read-only; failed validate-only blocks the write phase | "harness read mode is read-only…" |
| 29-LIVE-008 | Non-sandbox connection and unconfigured transport fail closed before any provider interaction | "harness refuses non-sandbox connections…" |
| 29-LIVE-009 | Full offline lifecycle: paused resources, read-back verification, ledger, verified cleanup | "harness full lifecycle keeps resources paused…" |
| 29-LIVE-010 | Created resources forced paused; an active resource aborts | "harness forces paused creation…" |
| 29-LIVE-011 | Cleanup always attempted after failure; incomplete cleanup exits non-zero with manual follow-up and the ledger retained | "harness always attempts cleanup after failure…" |
| 29-LIVE-012 | Ledger sanitizes secrets, tokens, signed URLs, credential envelopes | "ledger sanitization removes secrets…" |
| 29-LIVE-013 | Live scripts excluded from CI, npm test, focused suites, hooks | "live scripts are excluded from CI…" |
| 29-LIVE-014 | Provider status stays NOT_LIVE_VALIDATED until an explicit successful live run | "live provider status remains NOT_LIVE_VALIDATED…" |

## Network isolation proof

- Runtime guard: `tests/helpers/network-guard.js` is loaded by every `npm test`/`test:*` command (`--require`), blocking non-local HTTP/HTTPS/fetch/undici/sockets/DNS; verified by `tests/network-guard.test.js` and statically by `npm run security:network-guard-static`.
- Provider hosts are additionally allowlist-bound inside production (`provider-network.policy.js`), and the fakes route every simulated request through that policy (29-GOOGLE-007, 29-SECURITY-003/004).
- A missing injected transport fails closed: `PROVIDER_CAPABILITY_UNAVAILABLE / INJECTED_PROVIDER_CLIENT_REQUIRED` (`provider-execution-adapter.factory.js`; covered by `sections9-10.contract.test.js` "unknown providers never fall back and write-gated adapters cannot execute").
- CI (`.github/workflows/*.yml`) references no live command (29-LIVE-013).
