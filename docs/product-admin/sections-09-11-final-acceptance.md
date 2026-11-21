# Sections 9–11 — consolidated acceptance

Specification: *Karryam Admin and Centralized Admin Headquarters — Complete
Backend Implementation Specification v1.0*, Sections 9, 10 and 11.
Branch `staging`. Report date: 1 November 2026.

## Verdict

**SECTIONS 9–11 CODE COMPLETE — TESTED; EXTERNAL STAGING CERTIFICATION PENDING**

Everything implementable in the repositories is implemented and tested on
disposable PostgreSQL and a disposable secure Bridge with real TLS 1.3
mTLS, HMAC v2 and Ed25519. Nothing is live: no Bridge enrollment, no signed
owner policies, no real database roles or credentials, no certified or
enabled command, no deployment. Sections 1–8 behaviour is preserved (all
prior suites pass; the only changed assertions are documented below).

Detail: [Section 9](section-09-implementation-report.md),
[Section 10](section-10-implementation-report.md),
[Section 11](section-11-implementation-report.md),
[API catalog](karryam-admin-api-catalog.json),
[migration runbook](database-migration-runbook.md).

## Acceptance matrix

| Subsection | Implementation | Evidence | Remaining dependency |
|---|---|---|---|
| 9.1 | Dedicated Karryam Admin DB; HQ `hq_integration`; exact runtime grants; runners refuse privileged/shared identities; legacy direct-DB access contained | `section9-postgres` (both services), `static-boundaries` | Operator: roles, DB, credentials, revoke PUBLIC CONNECT |
| 9.2 | 15 Karryam Admin table families (3 new tables, guards on all) | KA `section9-postgres` (14 subtests), Stage A/B suite | Operator: contract approval evidence; Bridge for live discovery |
| 9.3 | 13 HQ families, subscription/contract/grant guards, legal holds | PIC `section9-postgres` (12 subtests), restore drill covers all 13 | — |
| 9.4 | Uniqueness, immutability, money, privacy fields, retention/legal hold/erasure, indexes (EXPLAIN) | as above | Operator: encryption at rest, key management |
| 9.5 | Forward-only 003/004, append-only ledgers, preview, byte-pinned files, backup/restore drill | drills in CI (artifacts), runbook | Operator: staging backup + migration + restore drill |
| 10.1 | 11 families on generic routes; HQ command forwarding; HQ audit route; operations switch | `api-contracts`, `karryam-operations-through-hq-postgres`, `api-security-postgres` | Source-only: Bridge enrollment and owner policies |
| 10.2 | 17 HQ Bridge contracts pinned (finance stays POST) | `api-contracts`, `reports`, KarryGo drift job | — |
| 10.3 | Status policy incl. additive `RATE_LIMITED` 429; `UNKNOWN_OUTCOME` as state | `api-contracts`, regenerated OpenAPI | None |
| 11.1 | Intersection of session, grants, explicit deny, scope, MFA, registry, capability, certification, approval, Bridge, audit/replay | `section11.test.js`, `api-security-postgres`, `high-risk-operations` | Policy enrollment |
| 11.2 | Identity chain; key separation; rotation overlap; emergency revocation | `section11.test.js`, `connector-security`, `identity-gate-postgres` | Real key enrollment |
| 11.3 | R2 rules kept; R3/R4 certification + runtime availability + bound independent approvals; revocation | `high-risk-operations` (3), `section11-postgres` (4), operations through HQ (4) | Real source authorization and risk certification |
| 11.4 | Class rules, prohibited fields, erasure/hold/retention, coverage truth | `governance.test.js`, PIC/KA `section9-postgres` | External privacy policy |
| 11.5 | Negative tests for 14.1–14.9 | see Section 11 report, CI | Real staging/network certification |

## Test results

Local (Windows 11, PostgreSQL 17.5 embedded, pg_dump 18.4, KarryGo checkout
at the pinned commit), final code:

| Suite | Tests | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| Karryam Admin `npm test` | 109 | 108 | 1* | 0 |
| Product Integration Core `npm test` | 87 | 85 | 1* | 1† |
| Packages (admin-contracts, event-contracts, identity, service-clients) | 65 | 65 | 0 | 0 |
| Central Admin product gateway | 11 | 10 | 1* | 0 |

\* Known Windows-only failures (Unix-socket permission bits, POSIX config
paths); they pass on Linux CI. † POSIX-only configuration test skipped on
Windows. Skips are not counted as passes.

GitHub Actions on `b9a5832` (final code; Linux, PostgreSQL 16, pg_dump 16,
KarryGo checkout required):

| Workflow / job | Tests | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| [Product Admin Platform CI](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/41252504989) — packages | 37 + 7 + 13 + 8 | all | 0 | 0 |
| — Karryam Admin (incl. Section 9/11 PostgreSQL, restore drill, high-risk, API contracts) | 109 | 109 | 0 | 0 |
| — KarryGo staging drift report | 2 | 2 | 0 | 0 |
| — PIC migrations / conformance / Section 9 + restore drill / full suite | 5 / 17 / 13 / 87 | all | 0 | 0 |
| — Containers (non-root, disabled-by-default, internal endpoints refused) | — | pass | — | — |
| — Product-admin secret scan | 225 files locally | 0 findings | — | — |
| [Monorepo Layout and Container CI](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/41252504910) | — | success | — | — |

Social Operations CI (Central Admin API, includes the gateway) result for the
final SHA is recorded in the delivery note of the commit that adds this
report.

Changed pre-existing assertions (all intentional):
`karryam-admin/tests/postgres.test.js` (migration list now from the files),
`connector-security` (R3/R4 may be listed but stay DISABLED without a
certification), `operations.test.js` (two-person checks on the enabled R2
command; uncertified R3 proposals refused), `protocol.test.js` and
`karryam-through-hq-postgres` (new local `approval.revoke` command),
`api-security-postgres` (malformed commands 400 instead of 403, per 10.3;
still never forwarded).

## Git delivery

| SHA | Content |
|---|---|
| `644ab48` | starting point |
| `758a427` | Section 9 (migrations 003, runners, preview, governance, drill, tests) — workflow file rejected (`runner` context) |
| `d7d5a5e` | CI fix — all workflows green |
| `4e1f1df` | Section 11 (KA 004, certifications, approvals, key revocation) |
| `7336093` | Section 10 (catalog, 429, HQ command path, operations switch, PIC 004, E2E) — Product Admin + Monorepo CI green |
| `b9a5832` | 004 migrations stored with LF (never applied outside disposable CI databases) — Product Admin + Monorepo CI green |
| (this commit) | reports, operator governance tools |

Fast-forward pushes only; `origin/staging` verified equal to local after
every push. No deployment workflow was run; `main` and production were not
touched; no real database was migrated.

## Operator-only items (not fabricated, not done)

1. Database roles, the Karryam Admin database, credentials, PUBLIC CONNECT
   revocation; staging backups; `--preview` then migrations 003/004 through
   the approved workflow; staging restore drill; encryption at rest and key
   management; database network access certification.
2. Karryam Backoffice Bridge enrollment (client certificate, HMAC key,
   Ed25519 staff key, issuer/audience, scopes, roles) and signed owner
   policies; Bridge feature flags.
3. Contract approval evidence for the pinned Bridge revision; any R3/R4
   certification (`scripts/high-risk-certification.js`) only after source
   risk certification; command allowlisting.
4. HQ onboarding with independent reviewers, dataset certification, staff
   grants, and the product operations switch by an independent approver.
5. Legacy `karrygo/dispatch` direct-database module: owner-approved parity
   and cutover (not performed).

## Next

No engineering blocker remains inside Sections 9–11. The next work is the
operator activation sequence above, then live staging certification.
