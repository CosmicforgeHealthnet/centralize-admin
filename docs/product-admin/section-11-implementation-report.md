# Section 11 — Security, staff permissions and approvals

Specification Section 11.1–11.5. Report date: 1 November 2026.

## A. Executive verdict

**SECTION 11 CODE COMPLETE — REAL KEY ENROLLMENT, SOURCE POLICIES AND STAGING CERTIFICATION PENDING**

The authorization intersection, the three-stage identity chain, key
rotation/revocation and the full high-risk (R3/R4) approval workflow are
implemented and tested with real cryptography against a disposable Bridge
and real PostgreSQL. The earlier blanket "R3/R4 cannot be enabled" rule was
a development restriction, not a source policy: it is replaced by a real
gate (two-reviewer certification in the database + operator allowlist +
runtime Bridge availability + recent MFA + independent approval of the
exact intent + the Bridge's own authorization). No environment flag
bypasses it, and no R3/R4 command is certified or enabled anywhere.

## B. Authorization intersection (11.1)

A request is permitted only when every layer agrees; each denies on missing,
ambiguous or conflicting authority:

| # | Condition | Enforced in |
|---|---|---|
| 1 | Active, unrevoked staff session; active account; CSRF + trusted origin for cookie writes | Central Admin auth middleware (`requireSession` in the gateway) |
| 2 | HQ product grant: explicit ALLOW for the exact action, not before `not_before`, not expired, not revoked; explicit DENY wins over any ALLOW; staff tier never counts | `identity-and-permissions/authorize`, PIC `authorizeStaff` |
| 3 | Product registry ENABLED with an ACTIVE certified contract, sync gate clear | PIC `enabledRegistration`, DB deferred check |
| 4 | Requested market/organization/zone/tenant ⊆ grant ∩ product scope; missing/empty scope never means global | `effectiveScope`, Karryam `withinScope`, Bridge staff context |
| 5 | Recent MFA (≤ 300 s) for sensitive actions | PIC `authorize`, Karryam staff context |
| 6 | Exact capability: AVAILABLE command of the ACTIVE contract; operations switched on for the product | PIC `submitOperation` |
| 7 | Karryam re-check: delegation action, role → approved Bridge role, scope enrolled, capability exposure | `operations/service.js`, `bridge/capabilities.js` |
| 8 | R3/R4: certification in force, runtime Bridge availability, independent approval bound to intent/scope/version/policy | `operations/service.js`, `db/approvals.js`, `db/certifications.js` |
| 9 | Bridge: mTLS identity, HMAC v2, Ed25519 assertion with request digest, owner policy | Bridge (tested with the disposable Bridge) |
| 10 | Audit and replay persistence healthy | PIC audit fails closed (503); Karryam audit fails closed; durable nonce/JTI stores |

Explicit DENY cannot be lifted by the person it restricts (database
constraint + service check, pre-existing); role overlap never unions scope
(new tests).

## C. Staff identity chain (11.2)

1. **Browser → HQ**: existing Central Admin authentication (server-side,
   revocable sessions; CSRF; recent-MFA gate for admin routes). No separate
   Karryam login.
2. **HQ → PIC → Karryam Admin**: short-lived (≤ 30 s) HS256 delegations
   binding staff ID, session ID, auth time, MFA time, product, exact action,
   effective scope, role, grant ID, unique JTI and a hash of method + path +
   body. Staff cannot mint them (keys are server-side files). Service
   authentication (HMAC) keys, delegation keys, Bridge HMAC key and the
   continuation-token key must all differ (`KEY_REUSE_ACROSS_BOUNDARIES`),
   and per-product keys must differ.
3. **Karryam Admin → Bridge**: TLS 1.3 mTLS with the enrolled client URI SAN
   and fingerprint, HMAC v2 canonical signature, Ed25519 staff assertion
   (pinned kid, issuer, audience, nonce/JTI, request digest, scope, session).
   The original staff identity is the assertion subject (tested from HQ
   through to the Bridge for reads, R2 and R3 commands).

Rotation and revocation:

| Item | Mechanism | Test |
|---|---|---|
| Delegation key rotation | old and new kid live together during overlap | `identity-and-permissions/tests/section11.test.js` |
| Delegation key emergency revocation | `revoked: true` → `KEY_REVOKED` (new) in the shared verifier, Karryam and PIC loaders | same |
| Delegation key expiry | `not_after` → `KEY_EXPIRED` | same |
| Service key revocation/expiry | pre-existing (`KEY_REVOKED`) | `service-clients` tests |
| Manifest signer revocation/expiry | pre-existing trust store | `identity-gate-postgres` |
| Bridge client certificate expiry/revocation, server pin | pre-existing | `connector-security` |
| Bridge session revocation | pre-existing | `connector-security` |
| Product grant removal | immediate (grants loaded per request) | `api-security-postgres` |

Private keys are referenced by protected file paths only; nothing secret is
committed (secret scan: 0 findings).

## D. Approvals and high-risk operations (11.3)

State machine (database-enforced):

```
approval:  PROPOSED -> APPROVED -> CONSUMED
           PROPOSED -> REJECTED | REVOKED
           APPROVED -> REVOKED
operation: RECORDED -> DISPATCHING -> SUCCEEDED | FAILED | UNKNOWN_OUTCOME
           RECORDED -> REJECTED          UNKNOWN_OUTCOME -> SUCCEEDED | FAILED (owner readback only)
```

R3/R4 flow (all steps tested):

1. Operator records a certification with the migration identity
   (`scripts/high-risk-certification.js`): exact R3/R4 command enabled at
   the source, two distinct reviewers, evidence, owner policy revision,
   pinned contract revision, ≤ 180 days; revocable once. Exposure becomes
   AVAILABLE only if the command is also in `KARRYAM_ADMIN_ENABLED_COMMANDS`.
2. Requester computes the intent digest (capability, target with expected
   version, exact body, exact scope, requester) and proposes an approval;
   proposing for an uncertified R3/R4 target is refused. The approval binds
   the certification, owner policy revision and expected source version.
3. An independent approver decides: not the requester, holds the approval's
   whole scope, recent MFA, approved Bridge role. Racing approvers: one
   decision recorded. The requester cannot revoke an approved reference;
   another authorized staff member can (e.g. when approver access is removed).
4. Submission (requester, recent MFA): certification still in force, runtime
   Bridge observation AVAILABLE for the staff role (UNKNOWN/expired refused),
   intent and audit recorded, approval consumed once in one transaction
   (expiry, intent, scope, version, certification, policy, requester all
   re-checked; concurrent consumers: one wins), one dispatch, owner result
   recorded. Refused attempts never consume the approval.
5. The Bridge independently authorizes; a Bridge refusal is FAILED and never
   retried; uncertain results are UNKNOWN_OUTCOME until owner readback.

R2+ commands keep the Sections 6–8 rules (typed schema, purpose, expected
version, idempotency, durable intent, scope, owner readback, immutable audit).
There is no generic execute endpoint. Exports: the single-use download token
returned by the owner is never stored or returned in receipts (tested); the
download itself is the source's `hq.exports.download` retrieval.

## E. Privacy and regulated data (11.4)

- Protocol privacy classes: PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED_PII.
  RESTRICTED_PII can never be approved for HQ; CREDENTIAL and HEALTH are not
  expressible and are refused by schema validation (no new enum invented).
- Prohibited fields (NIN, BVN, OTP, passwords, PINs, card/bank data,
  secrets/tokens, identity documents, raw location trails/coordinates,
  diagnoses/medical records) are refused in any manifest dataset or event
  schema (`catalog.js`) and by a database check on the HQ inbox and
  quarantine detail.
- Lifecycle: privacy requests through the source's register/read/fulfilment
  commands; local erasure only after an owner-confirmed fulfilment, refused
  under legal hold; two-person legal holds; per-class retention; sensitive
  reads logged and failing closed when logging fails (Section 9 report).
- Coverage: missing observations stay UNAVAILABLE, partial coverage stays
  PARTIAL; incomplete cohorts are not reported as complete (Sections 6–8,
  re-verified by the Section 9 metric constraints).

## F. Threat tests (11.5)

| Spec case | Tests (all automated, real TLS/HMAC/Ed25519 or real PostgreSQL) |
|---|---|
| 14.1 Forged identity: bad mTLS cert, wrong URI SAN, unenrolled fingerprint, wrong/invalid HMAC, wrong service, invalid Ed25519, wrong iss/aud, wrong digest | `karryam-admin/tests/connector-security.test.js` (transport identity; HMAC v2 and staff assertion negatives), `service-clients/tests/clients.test.js` |
| 14.2 Cross-market/organization/zone/tenant/product | `connector-security` (scope claims), `modules.test.js`, `api-security-postgres` (grants/scope), `section11.test.js` (no union), operations through HQ (tenant outside grant) |
| 14.3 Replay/token theft: duplicate nonce/JTI, expired/future assertion, stale timestamp, revoked/expired/unknown key, reused approval | `connector-security`, `service-clients` (signatures, skew, replay), `api-security-postgres` (replayed/rebound delegations), `section11.test.js` (key lifecycle), `high-risk-operations` + `section11-postgres` (approval reuse) |
| 14.4 SSRF / arbitrary routes | `clients.test.js` (fixed targets refuse public, metadata, credentialed, non-HTTPS; redirects refused), `api-contracts.test.js` (unknown paths/methods 404/405), registry-pinned routes only |
| 14.5 Unauthorized writes: no grant, no policy, disabled capability, no MFA, no approval, self-approval, expired approval, payload/scope/version change, reused operation | `operations.test.js`, `high-risk-operations.test.js`, `karryam-operations-through-hq-postgres.test.js`, `api-security-postgres` |
| 14.6 Split-brain/worker collision: leases, fencing, duplicates, out-of-order, regression, ACK conflicts, crash between commit and ACK | `pipeline-postgres.test.js`, `sync-postgres.test.js`, `sync-gate-postgres.test.js`, `karryam-two-stage-postgres.test.js` |
| 14.7 Partial data misreporting | `reports.test.js`, `pipeline-postgres` (coverage), `section9-postgres` (null vs zero, money), `sync-postgres` (NO_SOURCE_OBSERVATION) |
| 14.8 Deployment exposure | CI container smoke tests (no network, private sockets, `/internal` endpoints 503/404 while disabled), `nginx-internal-deny.example.conf`, product-admin secret scan (keys are server-side file references only). Static/CI evidence only — **not** a VPS firewall certification |
| 14.9 Key expiry/rotation/revocation | `section11.test.js`, `connector-security` (certificate expiry/revocation, pinned server), `identity-gate-postgres` (signer revocation stops sync) |

## G. Remaining dependencies

Real Bridge enrollment (client certificate, HMAC key, Ed25519 staff key,
issuer/audience), signed owner policies per capability, operator
certification and enablement of any R3/R4 command after source-side risk
certification, HQ staff grants and operations switch-on by independent
approvers, real key rotation drills, and staging network/firewall
certification. Limitation: removing an approver's HQ grant does not
automatically revoke approvals they already gave; such approvals must be
revoked explicitly (`karryam.governance.approval.revoke`) and expire within
at most one hour by construction.
