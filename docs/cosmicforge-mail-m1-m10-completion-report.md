# CosmicForge Mail M1–M10 completion report

Date: 2026-10-25. Target branch: `staging`. Nothing has been merged or
deployed, and no real database was migrated.

**Specification reviewed:** "CosmicForge Mail Implementation Specification",
version 1.0, 24 Oct 2026, 17 pages (sections 1–27). All 17 pages were read
and checked against the code on PRs #16–#20 in a final audit. The
traceability matrix is in Appendix A; the §22 acceptance matrix is in
Appendix B.

**Verdict:** CODE COMPLETE — READY FOR REVIEWED STAGING INTEGRATION; LIVE
PILOT NOT YET APPROVED.

## 1. Three readiness levels

| Level | Meaning | Status |
|---|---|---|
| **A. Code complete** | Every code-level requirement in the specification is implemented, or documented as a non-critical PARTIAL with a reason. All suites pass offline against real PostgreSQL. | **Reached.** Critical gaps found in the audit were fixed (§3). Remaining PARTIAL items are listed in Appendix A. |
| **B. Staging deployment ready** | Each PR head can be deployed to staging with Mail off, and with Mail on before migrations, without breaking login or other modules. Migrations replay with no drift and roll back cleanly. | **Reached in code and rehearsal.** Proven for every intermediate head (§5). Needs the human steps in §8 (review, merge, backup, migrate). |
| **C. Live pilot accepted** | Real provider, DNS, storage, KMS, scanner, round trips and owner sign-offs on staging. | **Not reached.** Requires the approvals and live validations in Appendix A (LIVE VALIDATION / APPROVAL REQUIRED) and the §8 checklist. |

## 2. Delivery: stacked draft PRs (merge in this order)

| PR | Branch | Base | Content | Head |
|---|---|---|---|---|
| #16 | `claude/gallant-ramanujan-0h6e6b-integration` | `staging` | M1–M6 (#13), storage/KMS/scanner (#14), HQ sessions + MFA (#15), shared step-up (migrations 27–29) and the closure fixes | `0ba3bbc` |
| #17 | `…-m7` | #16 | M7 broadcasts, automation, consent, DOI, unsubscribe; campaign test sends | `b88b7c1` |
| #18 | `…-m8` | #17 | M8 product integration contracts, HealthNet restriction, admin UI, Go client | `b9db4a7` |
| #19 | `…-m9` | #18 | M9 retention, quotas, monitoring, kill switch, backup verifier, accessibility; inbound reconciliation and §20 metrics | `0d3d6ee` |
| #20 | `…-m10` | #19 | M10 rollout rules, cohorts, DB emergency stops, readiness, canary, rollback drill; this report | `03cf2b7` |

**PR reconciliation:**
- #13, #14 and #15 are fully contained in #16; ancestry is verified. Do **not** merge them separately: that would duplicate #16's content.
- Keep #13–#15 open as review references until #16 merges, then close them as superseded.
- `staging` (`2ea4d0d`) is an ancestor of #16, so #16 needs no rebase.
- Merge #16 → #20 in order, each into `staging` after the previous one, or merge #20 alone after reviewing the stack. Either way, migrations are applied separately (§8).

No commit was made to `staging` or `main`. History was never rewritten on a pushed branch, and no force-push was used.

## 3. Audit findings fixed in this round

The fixes went to the lowest branch that owns the code, then were merged forward with merge commits.

| # | Spec | Finding | Fix | Branch |
|---|---|---|---|---|
| 1 | §20, §22 (Critical) | With Mail enabled before migrations, Mail routes returned **500**. | Schema readiness probe: every Mail route, webhook and integration call answers 503 `MAIL_SCHEMA_NOT_READY` (retryable, not acknowledged). Workers idle. New public `/health/live` and `/health/ready`. Each milestone adds its tables to the probe. | #16, then each later branch |
| 2 | §19.7 | No technical block on clinical/HealthNet content through Resend. | The send gate refuses restricted-health organizations (default `healthnet*`) at enqueue and at dispatch, and fails closed when the organization is unknown. Override needs `MAIL_RESTRICTED_HEALTH_PROVIDER_APPROVED`. Applied to broadcasts, automation, confirmations and test sends. | #16, #17 |
| 3 | §19.3 | No webhook secret rotation grace period. | `RESEND_WEBHOOK_SECRET_PREVIOUS` and `RESEND_WEBHOOK_SECRET__<SLUG>_PREVIOUS`. | #16, #17 |
| 4 | §13.2 step 4 | Preflight had no link/phishing scan and no quota check. | Offline link scan (`links_safe`), `brand_provider_allowed`, `quota_available`. | #16, #19 |
| 5 | §13.4 | Consent did not record country. | Optional ISO country on consent evidence. | #16 |
| 6 | §5.8, §9 | No redacted admin views of audits, webhooks, delivery events, jobs or dead letters. | `/admin/audit-events`, `/admin/webhook-events`, `/admin/delivery-events`, `/admin/jobs`. They contain no content or payloads, recipients are reduced to their domain, and enum filters are validated. | #16 |
| 7 | §16.1, §24 | No IT Mail administration UI; HR could not request a mailbox for an employee. | IT > Mail Administration: domains/DNS, shared mailboxes, approvals, send-as grants, legal holds, retention policies and audit/events. HR > Accounts "Work email" card, where HR account managers raise requests and IT approves. | #16 |
| 8 | §10.3, §20 | Webhook events were never marked processed: the backlog would grow forever, lag could not be measured, and webhook retention never applied. | Events are settled with their job (`PROCESSED` or `FAILED` with code). | #16 |
| 9 | §5.5, §13.2 step 3 | No test sends. | `POST …/campaigns/:id/test-send`: a [TEST] copy to at most 5 active staff addresses. Flag-gated (default off), behind the same gate, emergency stop, rollout rules and quotas, rate-limited and audited. UI in campaign detail. | #17, #19, #20 |
| 10 | §10.8 | No inbound reconciliation (`MAIL_RECONCILIATION_ENABLED` did nothing). | `listReceivedEmails` adapter method and `RECONCILE_INBOUND` job. Missed emails go through normal idempotent processing. | #19 |
| 11 | §20 | Missing metrics: auth denials, provider 429/5xx, reconciliation lag. | Counters and gauges, alerts (`MAIL_PROVIDER_DEGRADED`, `MAIL_WEBHOOK_LAG_HIGH`, `MAIL_RECONCILIATION_STALE`, `MAIL_INBOUND_WEBHOOKS_MISSED`) and operations tiles. | #19 |
| 12 | §19.2 | No EXECUTIVE-tier negative privacy test. | Added: an EXECUTIVE user sees no private mailbox. | #16 |
| 13 | — | `brace-expansion` advisory (4.0.0–5.0.11) in the API. | Override pinned to 5.0.12; API `npm audit` reports 0. | #16 |
| 14 | §16.2 | IT sub-navigation labels failed the axe contrast check. | Labels use the normal muted color. | #19 |

Regression tests were added for every row (unit, real-PostgreSQL, Playwright and axe). No applied migration was modified; the manifest still lists 33 migrations with 0 checksum failures.

## 4. Testing evidence (offline, this session)

| Head | Backend `npm test` | `npm run test:mail` (PostgreSQL 16) + S3 mode | Playwright (desktop + mobile, mocked API) | Lint / tsc / build |
|---|---|---|---|---|
| #16 integration | 1044 tests: 1042 pass, 0 fail, 2 skip | 62 pass + 25 pass | 45 pass, 9 skip | 0 errors / clean / OK |
| #17 M7 | 1071: 1069 pass, 0 fail | 88 + 25 | 64 pass, 10 skip | 0 errors / clean / OK |
| #18 M8 | 1086: 1084 pass, 0 fail | 103 + 25 | 70 pass, 10 skip | 0 errors / clean / OK |
| #19 M9 | 1103: 1101 pass, 0 fail | 120 + 25 | 84 pass, 10 skip (includes axe) | 0 errors / clean / OK |
| #20 M10 | 1118: 1116 pass, 0 fail | 135 + 25 | 90 pass, 10 skip (includes axe) | 0 errors / clean / OK |

The 2 backend skips are environment-only: no live clamd host, and no IPv6 loopback. The Playwright skips are pre-existing desktop/mobile-specific cases. ESLint shows 196 warnings, all pre-existing.

The M10 head contains everything. Integrated checks on it:

| Check | Result |
|---|---|
| `db:manifest:verify` | 33 migrations, 0 checksum failures, 0 missing/extra/duplicate |
| `db:replay:verify` (disposable DB) | status ok, 33 migrations, drift none |
| `mail:rollback:drill` (disposable DB) | M7–M10 removed cleanly, 5 reapplied, roll-forward drift none |
| `mail:backup:verify` (disposable replay copy) | ok, 113 tables, guards match (5 triggers, 37 checks), 0 mismatches. It refuses non-disposable databases by design. |
| `migrations:safety` | pass |
| `security:secret-scan` | pass |
| `security:static-social`, `security:network-guard-static`, `test:network-guard` | pass |
| Social Operations focused suite | pass |
| API `npm audit` (production and all) | 0 vulnerabilities |
| Web `npm audit` | production 9 (2 moderate, 6 high, 1 critical); all 29. **Identical to `staging`** (pre-existing, not introduced by Mail) |
| Go reference client `go test` | ok |

CI on the PR heads:
- GitHub Actions: #16, #17 and #19 green. #18 and #20 were green on their previous heads; their current heads are re-running.
- Staging deploy jobs are skipped on PRs, as designed.

## 5. Staging deploy safety at every intermediate head

Method: each head booted with `NODE_ENV=production` against a database built **only from `staging`'s schema** (no Mail/session migrations). The HealthNet main DB was unreachable, which also covers the "HealthNet offline" case. Login and core routes were then probed.

| Head | Mail off | Mail on, migrations not applied |
|---|---|---|
| #16–#20 (all five) | Health 200; login and `/auth/me` 200; Mail 503 `MAIL_DISABLED`; webhook 503; integrations 503 (M8+); `/health/ready` 200 (`enabled:false`); Social 200; no crash; no worker started; nothing sent | Health 200; login 200; Mail 503 `MAIL_SCHEMA_NOT_READY` (was 500 before this round); integrations 503; `/health/ready` 503 with `schema:false`; one clear log line; no worker; nothing sent; no crash |

The API image runs only `node src/server.js`. Migrations never run at startup, and the Mail worker is a separate entrypoint (`src/mail-worker.js`). The frontend handles 503s as "Mail is turned off or not ready", never as an error or empty data.

## 6. CI / Vercel picture (owner action, no settings changed)

- **GitHub Actions:** green on the PR heads as listed in §4.
- **Vercel `centralize-admin-staging`** (root directory `apps/central-admin-web`): preview builds **Ready**.
- **Vercel `centralize-admin`** (no root directory set): every build reports **Error**, on these PRs and before them.
  - The likely cause is that this second project builds the monorepo root, which is not a Next.js app.
  - **Owner action:** in Vercel, either set this project's Root Directory to `apps/central-admin-web` or disconnect it if it is a duplicate.
  - This is a project setting, not a code defect. It was not changed.

## 7. Dependency advisories

- **API:** `brace-expansion` override raised from 5.0.8 to 5.0.12 (published 2026-09-14), clearing the `brace-expansion`/`minimatch` advisories. Audit policy unchanged. Result: 0.
- **Web:** 9 production / 29 total, identical to `staging` (`next`, `axios`, `follow-redirects`, `form-data`, `nanoid`, `postcss`, `sharp` and others).
  - The fix needs a `next` 16.x patch upgrade and a major `shadcn` bump, which can change behavior.
  - **Owner decision:** schedule a separate dependency-upgrade PR with a full UI regression. Not done here: it is outside Mail and not a safe narrow fix.

## 8. Operator handover checklist (19 steps)

Each step needs the named human approval. Nothing here has been performed.

1. **Review** PRs #16 → #20 (code owners for auth, Mail, marketing, HR/IT UI). Confirm Appendix A.
2. **Close #13–#15 as superseded** once #16 is approved. Do not merge them separately.
3. **Merge #16 into `staging`** only (never `main`). Confirm the staging API deploy stays green: Mail stays off, and login works.
4. **Back up the staging Admin DB** and record the backup ID, following `docs/cosmicforge-mail-staging-migration-runbook.md`.
5. **Apply migrations 27–29** to the staging Admin DB in a change window with `db:admin:prepare`. Only on staging, by the DB owner. Then run `db:admin:verify`.
6. **Merge #17 → #20 in order.** After each merge, apply that milestone's migration (30, 31, 32, 33) the same way, and confirm `/api/mail/v1/health/ready`.
7. **Provision infrastructure:** private S3 bucket + KMS data keys per environment, clamd on a private network, secret-manager entries. Run `mail:config:validate`.
8. **Resend (account owner):** a test domain, scoped API keys, webhook endpoints (company and per brand) and secrets, and a receiving route on a **dedicated test address** only. Do not change existing Karryam routes.
9. **DNS (domain owner):** SPF/DKIM/DMARC for the test domain per the M10 coexistence plan. **No root MX change.**
10. **Configure staging Mail** with `MAIL_ENABLED=true` and sending/receiving off, plus `MAIL_DOMAIN_ALLOWLIST` (test domain only) and `MAIL_ROLLOUT_ENFORCED=true`. Check `/health/ready` is 200.
11. **Mail administration (IT):** in IT > Mail Administration, register the test domain and run "Check DNS" until sending is verified. Create the pilot shared mailbox.
12. **Provisioning:** HR raises pilot mailbox requests from HR > Accounts; a different IT administrator approves them.
13. **Rollout (IT, with step-up):** create the pilot cohort, add STAFF_MAIL and worker rules for the cohort only, and run the readiness page for stage S0/S1.
14. **Start workers** (`mail:worker`) for OUTBOUND, INBOUND and EVENTS. Optionally enable `MAIL_RECONCILIATION_ENABLED`.
15. **Live validation:** run the offline canary, then the **live canary with a change ticket**. Do Gmail/Outlook round trips to the test address, an attachment scan, a webhook replay and an ambiguous-timeout case (Appendix B LIVE rows).
16. **Drills on a disposable copy:** `mail:backup:verify` and `mail:rollback:drill`. Record the results in the rollout ticket.
17. **Sign-offs:** privacy/legal (retention periods, consent sources, DMARC posture), security review, a manual screen-reader and keyboard audit, and design sign-off on contrast changes.
18. **Marketing (brand owner):** postal address, quotas, test sends to staff, and a first approved pilot campaign to a consented internal list. Requires `MAIL_BROADCAST_DISPATCH_ENABLED`, approved by the brand owner.
19. **Go/no-go for a production pilot:** a separate, written approval after observed staging stability. Production DB migrations, production DNS and `main` stay untouched until then.

## 9. Known limitations and owner decisions

- **Body search** is disabled by design (encrypted bodies; the plaintext index was removed). Search covers subject, participants, labels and dates. An approved encrypted-search design is needed (§12).
- **Mailbox filters (rules):** the engine runs on inbound mail, but there is no API or UI to manage rules yet (§1.2). PARTIAL; follow-up.
- **Raw MIME preservation:** the `MAIL_ARCHIVE_RAW_MIME` flag exists, but nothing stores raw MIME. It is needed only if policy requires it (§10.6).
- **Generated frontend client / typed OpenAPI schemas:** the OpenAPI document lists every route, but the client is hand-written (§9). PARTIAL.
- **Marketing "replied" metric** is not counted (§13.3). PARTIAL.
- **Rate limits and rollout caches** are per process. The edge or gateway should enforce cluster-wide limits; a rule change takes up to 5 s to reach other replicas.
- **Alert thresholds** are initial values; no stability data exists yet.
- **Load tests** (§22.1) were not run. They need a staging-sized environment.
- **Live provider behavior** (Resend broadcasts, receiving list pagination, webhooks) is validated against documentation and the fake adapter only.
- **Legacy temporary-password email** (`email.util`) is unchanged and pinned. Migrating legacy senders is a separate approved change (§24).

---

## Appendix A. Specification traceability (sections 1–26)

Status key:
- **PASS:** implemented and covered by automated tests.
- **PARTIAL:** implemented in part; the gap is stated.
- **FAIL:** not implemented.
- **LIVE:** needs live validation on staging.
- **APPROVAL:** needs an owner or legal decision.
- **N/A:** not applicable to the code.

A file merely existing never counts as PASS.

| § | Requirement | Implementation / evidence | Status |
|---|---|---|---|
| 1.1 | One permissioned Mail module in Centralized Admin; staff see only authorized mailboxes | `modules/mail`, `mail.policy.js`; privacy subtests (EMPLOYEE/ADMIN/EXECUTIVE/SUPER) | PASS |
| 1.2 | Gmail-like UI: folders, labels, star/unread, search, threads, compose/reply/forward, CC/BCC, signatures, attachments, notifications, keyboard, accessibility | `components/mail/*`; E2E + axe; keyboard handlers | PASS (filters PARTIAL, §9) |
| 1.3 | Domain/address management, aliases, provisioning, approvals, suspension, delegation, offboarding | admin service + IT UI + HR card; postgres subtests | PASS (forwarding rules PARTIAL) |
| 1.4 | Email Marketing inside existing Marketing | `marketing/email-marketing`; M6/M7 suites | PASS |
| 1.5 | Email Support shared mailbox, tickets, assignment, SLA | support service; M5 subtests; E2E | PASS |
| 1.6 | Resend send/receive/broadcast behind an adapter | adapters + contract; fake-adapter tests | PASS, LIVE |
| 1.7 | External recipients (Gmail/Outlook/…) | provider transport | LIVE |
| 1.8 | Keep deployment boundaries; module + own worker | `src/mail-worker.js`; boundary CI | PASS |
| 1.9 | CosmicForge-owned encrypted storage, backup/restore | S3/KMS storage; backup verifier | PASS, LIVE |
| 1.10 | Staging rollout without touching prod MX/routes/schemas | flags off; deploy-safety probe; no live changes | PASS |
| 2 | Evidence boundaries; karryam.com spelling; domains unverified | fixtures use `.example` domains; no seeded real domains | PASS |
| 3, 3.1 | Placement red flags (no Main DB in Mail, no SUPER blanket access, no reuse of social/marketing tables, no auto schema changes) | boundary test `mail-app-wiring`; SUPER deny tests; manual migrations | PASS |
| 4, 4.1 | Ownership matrix | module boundaries; integration contracts | PASS |
| 5.1 | Personal webmail | M3/M4 | PASS |
| 5.2 | Shared departmental inboxes | M5 | PASS |
| 5.3 | Domains/identities: DNS verify (sending/receiving), reserved names, collisions, test-send, key rotation, emergency pause | admin service; IT UI; test sends; webhook rotation; emergency stops | PASS (DNS, test-receive: LIVE) |
| 5.4 | Onboarding/invitations, offboarding revocation | HQ invites (existing HR); HR provisioning; offboarding revokes memberships and send-as grants and suspends the personal mailbox | PARTIAL (invite email uses the legacy sender; §9) |
| 5.5 | Marketing platform incl. preview/test sends | M6/M7; test sends | PASS, LIVE |
| 5.6 | Automations | M7 automation engine | PASS |
| 5.7 | Product transactional mail stays product-owned | M8 contracts; no HQ dependency in booking | PASS, APPROVAL |
| 5.8 | Admin/IT reporting: delivery, webhook lag, queues, quotas, audits, dead letters | admin views; ops snapshot/metrics; IT UI | PASS (storage capacity / search staleness: N/A, no search index) |
| 6 | Conceptual model (org/domain/address/mailbox/user/sender identity) | schema; not forced 1:1 | PASS |
| 7 | Roles/permissions/privacy matrix; SUPER no bypass; resource-level membership | `mail.policy.js`; privacy subtests | PASS |
| 8 | Data model and DB rules (unique, partial indexes, append-only audit, tombstones) | migrations 27–33; triggers; replay | PASS |
| 9 | API `/api/mail/v1`, 202 for queued, 409/403/422/429/503 semantics, admin ops endpoints, OpenAPI | routes; OpenAPI; status tests | PARTIAL (generated client) |
| 10.1–10.7 | Inbound: raw webhook, transactional acceptance, fetch/scan/store, routing, threading, rules | webhook controller; inbound processor; M2 subtests | PASS (raw MIME preservation PARTIAL) |
| 10.8 | Reconciliation against the provider; unknown recipients; no catch-all | reconciler; unknown-recipient reject/quarantine | PASS, LIVE |
| 11 | Outbound: checks, durable outbox, idempotency, no duplicate on timeout, honest states, mixed recipients | compose/outbound; ambiguity subtests | PASS, LIVE |
| 12 | Attachments/AV, sanitizing, remote images, search, retention, legal holds | scanner, sanitizer, retention executor | PARTIAL (body search disabled by design; APPROVAL) |
| 13.1 | Don't replace legacy campaigns | legacy templates read-only bridge | PASS |
| 13.2 | Campaign journey steps 1–9 incl. link/phishing scan and quota preflight | preflight checks; approvals; broadcasts; reply-to policy | PASS, LIVE |
| 13.3 | Metrics with denominators; deduplicated | campaign report | PARTIAL ("replied" not counted) |
| 13.4 | Contact rules: source/time/purpose/country/policy/DOI/withdrawal | consent model + country | PASS |
| 14 | Automations + reusable templates | automation engine; template versions | PASS |
| 15 | HR/IT/Support/Marketing/Profiles/Karryam/HealthNet integrations | HR card, IT admin, support, M8 | PASS, APPROVAL (Karryam/HealthNet owners) |
| 16.1 | Frontend placement incl. HR provisioning and IT domain admin | `dashboard/mail/**`, `components/it/MailAdministration.tsx`, `components/hr/accounts/MailProvisioningCard.tsx` | PASS |
| 16.2 | UX: responsive, states, accessibility, no false "sent" | E2E + axe; status labels | PASS (manual screen-reader audit: APPROVAL) |
| 17, 17.1 | Backend placement; raw parser before JSON/XSS; separate worker | `app.js` wiring tests | PASS |
| 18 | Provider adapter contract, normalized errors | contract + Resend/fake adapters | PASS, LIVE |
| 19.1 | MFA for privileged actions; no shared passwords | shared HQ MFA step-up | PASS |
| 19.2 | Object-level authorization; positive/negative tests per tier | privacy subtests incl. EXECUTIVE | PASS |
| 19.3 | Secrets separation; webhook key rotation | env separation; rotation grace | PASS |
| 19.4 | Inbound security | signature, tolerance, dedup, scan, quarantine | PASS |
| 19.5 | Outbound security: allowlist, quotas, kill switch | send gate; quotas; emergency stops | PASS |
| 19.6 | Data handling: encryption, ACL, backups, redaction, retention | storage/KMS; redacted views; retention | PASS, APPROVAL (GDPR/transfer review) |
| 19.7 | No clinical content via Resend, technically enforced | restricted-health gate | PASS, APPROVAL (HealthNet policy) |
| 19.8 | DNS/SPF/DKIM/DMARC; no root MX change | DNS records in IT UI; coexistence plan | LIVE, APPROVAL |
| 19.9 | No HTML execution / SSRF | sanitizer; safe frame; remote image block | PASS |
| 19.10 | Abuse/complaints hard stop; unusual rate alerts | suppression; complaint alerts; provider alerts | PASS |
| 20 | State machines; metrics incl. auth denials, 429/5xx, reconciliation lag; separate live/ready; HealthNet/Resend outage honesty; kill switch | status models; §3 rows 1, 8, 11; probe | PASS (state names map to equivalents; storage capacity / unusual-export metrics PARTIAL) |
| 21.1 | Environment variables, no committed values | `.env.example`; secret scan | PASS |
| 21.2 | Deployment order | §8 checklist | APPROVAL |
| 21.3 | Rollback | rollback drill; runbook | PASS (live: APPROVAL) |
| 22 | Testing matrix and release gates | Appendix B | see Appendix B |
| 22.1 | Unit/integration/E2E/security suites; load tests | suites listed in §4 | PARTIAL (load tests not run) |
| 23 | Phased backlog M0–M10 | M1–M10 delivered; M0 sign-offs pending | APPROVAL (M0) |
| 24 | Exact modification map | files per map; legacy sender untouched | PASS |
| 25 | Open owner decisions | listed in §8 | APPROVAL |
| 26 | Formal acceptance | Correctness, Operations, Change-management parts need staging/live | LIVE, APPROVAL |

## Appendix B. §22 acceptance matrix

| Scenario | Gate | Evidence | Status |
|---|---|---|---|
| Staff A opens Staff B private inbox by guessed ID | Critical | 404, no metadata, audit (postgres privacy subtests) | PASS |
| SUPER without break-glass | Critical | denied; break-glass flow with MFA (postgres, E2E) | PASS |
| Removed from shared mailbox mid-session | Critical | denied on next request (M5 revocation test) | PASS |
| Non-owned From / ceo@ | Critical | denied and audited (spoof tests) | PASS |
| Alias + primary, one login | High | alias tests; no duplicate mailbox | PASS |
| Gmail round trip with thread + attachment | Critical | offline thread/attachment tests | LIVE |
| Outlook/Yahoo/iCloud round trip | High | — | LIVE |
| Webhook replay / duplicate svix-id | Critical | exactly one event; 2xx replay | PASS |
| Webhook body modified | Critical | 401, nothing enqueued | PASS |
| Accepted then worker crash | Critical | lease recovery; job retried | PASS |
| Ambiguous timeout | Critical | same idempotency key, reconcile, no duplicate | PASS (LIVE confirmation) |
| 50 MB / malicious attachment / script HTML | Critical | size limit, EICAR quarantine, sanitizer | PASS |
| External To + internal CC/BCC | Critical | mixed-recipient test; BCC hidden | PASS |
| Unprovisioned local address | High | reject/quarantine policy test | PASS |
| HealthNet Main DB offline | Critical | deploy probe with main DB unreachable: login and Mail work | PASS |
| Existing Help/Marketing/Social parity | Critical | full backend suite + Social suite unchanged | PASS |
| CSV without verified consent | Critical | import rejected without consent | PASS |
| Cross-brand campaign | Critical | denied, no leak (M6/M7) | PASS |
| Unsubscribed/complained contact in segment | Critical | excluded at preflight and dispatch | PASS |
| Content changed after approval | Critical | approval invalidated | PASS |
| Cancel while queued | High | cancel/pause tests; provider cancel | PASS (LIVE confirmation) |
| Staging deployment without migration | Critical | 503 `MAIL_SCHEMA_NOT_READY`, readiness 503, no DB writes (`mail-schema-readiness.test.js`, probe) | PASS (was FAIL before this round) |
| Restore backup and search/archive | High | backup verifier on a disposable copy | PASS (LIVE on staging) |
| Keyboard/mobile/screen reader | High | axe + mobile E2E | PARTIAL (manual audit: APPROVAL) |
