# CosmicForge Mail M1–M10 completion report

Date: 2026-10-25. Target branch: `staging` (nothing merged, nothing deployed).

**Source of truth gap:** the implementation specification PDF
("CosmicForge_Mail_Implementation_Specification(1).pdf") was not available in
the working environment. This work follows the written completion prompt,
the repository, and the existing M1–M6 documentation. Any requirement that
exists only in the PDF has **not** been checked and must be reviewed against
this report.

## 1. Delivery: stacked draft PRs (review in this order)

| PR | Branch | Base | Content |
|---|---|---|---|
| #16 | `claude/gallant-ramanujan-0h6e6b-integration` | `staging` | Stage A: integrates #13 (M1–M6), #14 (storage/KMS/scanner) and #15 (HQ sessions + MFA); migrations 27/28 ordered; Mail step-up moved onto shared HQ MFA, bound to the live session (migration 29) |
| #17 | `…-m7` | #16 | M7 broadcasts, automation, consent/suppression, DOI, unsubscribe; plus the concurrent-event status race fix |
| #18 | `…-m8` | #17 | M8 product integration contracts (Karryam/HealthNet), admin UI, reference Go client |
| #19 | `…-m9` | #18 | M9 retention executor, quotas, monitoring/alerts, kill switch, backup verifier, accessibility |
| #20 | `…-m10` | #19 | M10 rollout rules, pilot cohorts, DB emergency stops, readiness gates, canary, rollback drill, this report |

Commits carry the session attribution trailer. No commit was made to
`staging` or `main`.

## 2. Code completion vs real-world activation

| | Code complete and tested offline | Activated / validated live |
|---|---|---|
| Staff webmail, support mail (M1–M5) | Yes | **No** (no live provider, DNS, storage, KMS or clamd) |
| Shared HQ MFA + session-bound step-up | Yes | **No** (staging DB migration not applied) |
| Broadcasts, automation, DOI, unsubscribe (M6–M7) | Yes | **No** (dispatch flags off; no marketing account, lists or domains) |
| Product integration (M8) | Yes; HMAC verified against Karryam's real `serviceauth` code (read-only) | **No** (no integration registered; owner approval gate not passed) |
| Retention execution (M9) | Yes | **No** (execution flag off; no approved retention periods) |
| Monitoring / alerts / metrics (M9) | Yes | **No** (no scraper, no token provisioned) |
| Rollout controls, pilot (M10) | Yes; offline canary passes | **No** (no rules, cohorts or live canary) |

## 3. Requirements traceability

Status key: **C** = code complete with automated tests; **C*** = code
complete, partial automation (stated); **L** = needs live validation;
**A** = needs approval before use.

| # | Requirement (from the completion prompt) | Implementation | Evidence | Status |
|---|---|---|---|---|
| A1 | Integrate PRs #13–#15; migration order 27 Mail, 28 Sessions/MFA, 29+ new | integration branch; `manifest.json` | migration-order test; DB replay drift none (33 migrations) | C |
| A2 | Mail step-up on shared HQ MFA | `authz/step-up.service.js` → `shared/auth/mfa.service.js` | `mail-postgres.test.js` "Stage A3" | C |
| A3 | Step-up session-bound, purpose-bound, single-use, short TTL | migration 29 `session_id`; `consume()` re-checks session/enrollment | Stage A3 + M9 wrong-purpose test | C |
| A4 | Auth, storage and scanning verified; M1–M6 gaps closed (ticket `?ref=`, step-up enrollment link) | tickets page redirect; `StepUpDialog` | E2E support/compose specs | C |
| B1 | Broadcast lifecycle (schedule in brand time zone, cancel, pause, resume, report) | `marketing/broadcast.service.js`, `broadcast.processor.js` | `mail-m7-postgres.test.js`, `marketing-broadcast.spec.ts` | C, L |
| B2 | Resend adapter for broadcasts/contacts/segments (verified against docs) | `adapters/marketing/resend-marketing.adapter.js` | unit + fake adapter tests | C, L |
| B3 | Consent, suppression, unsubscribe (one-click, topic), DOI | `consent-enforcement.js`, `public-preferences.service.js`, `confirmation.service.js` | M7 subtests (tampered/cross-brand tokens, DOI) | C, L |
| B4 | Approval integrity (immutable snapshot, approved contacts, TTL, separation) | M6/M7 approvals; immutability triggers | M6/M7 subtests | C |
| B5 | Durable worker, no duplicate broadcast on ambiguity | `processDispatch` status/name resolution; never re-posts | M7 "60 getBroadcast failures" subtest | C |
| B6 | Automation engine (DAG, triggers, schedules, delays, conditions, caps) | `marketing/automation/*` | M7 subtests | C |
| B7 | Concurrent provider events never regress status | conditional UPDATE under the row lock | M7 race test (fails without the fix) | C |
| C1 | Versioned contracts; Karryam boundary; KarryGo not modified | `integrations/contracts.js`, JSON schema, reference Go client | M8 unit/postgres; Go test; cross-language vector | C, A |
| C2 | HealthNet restricted; multi-product isolation | `RESTRICTED_HEALTH` in code + DB CHECK; scope checks | M8 subtests | C |
| C3 | Admin UI, contract tests, mock consumers | `IntegrationsAdmin.tsx`; mock Karryam/HealthNet clients in tests | `mail-integrations.spec.ts`, M8 postgres | C |
| C4 | Transactional mail regression | legacy sender hash tripwire; Mail never imports nodemailer | `mail-m8-unit.test.js` | C |
| C5 | Owner-approval gate documented | activation requires approval reference + step-up | M8 doc §Owner gate; M8 subtests | C, A |
| D1 | Retention + legal holds, dry run, destructive off by default | `ops/retention.*` | `mail-m9-postgres.test.js` (5 subtests) | C, A |
| D2 | Backup/restore validation (disposable) | `scripts/mail/verify-backup-restore.js` | run on replay DB: ok, 109 tables, 0 mismatches | C*, L |
| D3 | Monitoring and alerts | `ops/ops-monitor.service.js` | M9 alerts/metrics subtests, unit rules | C, L |
| D4 | Cost/quota controls, no invented prices | `ops/usage.service.js` | M9 quota subtest; unit (operator rates only) | C |
| D5 | Abuse protection / kill switch | `ops/runtime-controls.js`; quotas; existing limits | M9 emergency-stop subtest | C |
| D6 | Security review | M9 doc §6 | referenced tests | C* |
| D7 | Accessibility (axe) | `@axe-core/playwright` specs | `accessibility.spec.ts`, rollout spec; contrast fix | C* (manual audit pending) |
| D8 | Runbooks | M9 doc §8, M10 doc | — | C* |
| E1 | Rollout flags by env/org/domain/mailbox/cohort/purpose/worker | `ops/rollout.service.js` | `mail-m10-postgres.test.js`, unit | C |
| E2 | Emergency stop without redeploy | `mail_emergency_stops` | M10 subtest, canary | C |
| E3 | Pilot onboarding/offboarding | cohorts + pilot checklist | M10 subtests | C |
| E4 | Offline canary + operator live command (not executed) | `scripts/mail/canary.js` | `mail-m10-drills.test.js` | C (live: L, A) |
| E5 | DNS coexistence plan | M10 doc §4 | — | A, L |
| E6 | Progressive rollout criteria + dashboard | `ops/readiness.js`, Rollout UI | M10 readiness subtest | C |
| E7 | Deployment sequence | M10 doc §6 | — | A |
| E8 | Rollback drills on disposable environments | `scripts/mail/rollback-drill.js` | CI drill: ok, drift none | C |
| F | Full regression | — | §5 below | C |
| G | Draft PRs, traceability, docs | PRs #16–#20, this report | — | C |

M1–M6 traceability is in `docs/cosmicforge-mail-implementation-report.md`.
Its release blockers changed as follows:
- **B1 (sessions) and B2 (MFA):** done in #15, integrated.
- **B8 (accessibility):** automated part done; manual audit pending.
- **B9 (retention):** code done.
- **B10 (DOI) and B11 (dispatch):** code done.
- **B3–B7:** remain infrastructure/approval items.

## 4. Feature-flag inventory (activation-relevant)

All defaults are the safe value. Full list with tuning knobs:
`services/central-admin-api/.env.example`.

| Flag | Default | Effect when on | Approval needed |
|---|---|---|---|
| `MAIL_ENABLED` | false | Mail API and UI available | Yes |
| `MAIL_SENDING_ENABLED` | false | External sending possible (allowlist still applies) | Yes |
| `MAIL_RECEIVING_ENABLED` | false | Inbound processing | Yes |
| `MAIL_WORKER_ENABLED`, `MAIL_WORKER_QUEUES` | false; outbound,inbound,events | Worker process runs these queues (MARKETING opt-in) | Yes (production workers) |
| `MAIL_DOMAIN_ALLOWLIST` | empty (no sending) | Sender domains allowed | Yes |
| `MAIL_MARKETING_ENABLED` | false | Marketing studio | Yes |
| `MAIL_BROADCAST_DISPATCH_ENABLED` | false | Broadcast handoff to provider | Yes |
| `MAIL_AUTOMATION_ENABLED` | false | Automation sends | Yes |
| `MAIL_MARKETING_CONFIRMATION_EMAILS_ENABLED` | false | DOI emails | Yes |
| `MAIL_INTEGRATIONS_ENABLED` | false | Product event ingestion | Yes + owner approval |
| `MAIL_RETENTION_EXECUTION_ENABLED` | false | Permanent retention deletion | Yes + legal/records |
| `MAIL_RETENTION_*_DAYS` | unset | System categories purgeable | Yes + legal/records |
| `MAIL_ROLLOUT_ENFORCED` | on in production only | Default-deny by rollout rules | Recommended on in staging |
| `MAIL_EMERGENCY_STOP_ALL` / `_MARKETING` | false | Hold all / marketing sending | Operator |
| `MAIL_OPS_ALERTS_ENABLED` | true | In-app alerts to mail admins | No (internal only) |
| `MAIL_METRICS_TOKEN` | unset (endpoint 404) | Prometheus scrape | Infra |
| `MAIL_SEARCH_INDEX_BODIES` | refused | Body search stays disabled (request is refused and reported) | Needs a separate safe design |

## 5. Testing evidence (local, offline, this session)

- **Backend:** full `npm test` (CI flow: fresh DB, `db push`,
  `db:admin:prepare`) gives 1105 tests, 1103 pass, 0 fail, 2 skipped. The
  skips are a live clamd host not configured and IPv6 loopback not
  available; both are environment-only.
- **Mail suites** (`npm run test:mail`): M1–M6, M7 (13 subtests), M8 (8), M9
  (10), M10 (8) and drills (3) against a real PostgreSQL 16 replay database,
  plus S3-mode M1–M6.
- **Database:**
  - `db:manifest:verify`: 33 migrations, 0 checksum failures.
  - `migrations:safety`: 0 findings.
  - `db:replay:verify`: drift `none`.
  - Rollback drill: ok, and roll-forward drift `none`.
  - Backup verifier: ok.
- **Security:**
  - `security:secret-scan`: 0 findings.
  - `security:network-guard-static`: ok.
  - The API audit policy reports 5 `brace-expansion`/`minimatch` advisories.
    They are **pre-existing**: the API `package.json`/lockfile dependencies
    are unchanged from `staging`, and they need a separate dependency-update
    change.
- **Frontend:**
  - `tsc` clean; ESLint 0 errors (196 warnings, all pre-existing).
  - Production build OK.
  - Playwright (desktop + mobile, API mocked, external network blocked): 73
    passed, 7 skipped (pre-existing skips), 0 failed. This includes the axe
    checks.
- **Go reference client:** `go vet` and `go test` pass. The signature vector
  matches Karryam's `serviceauth.SignRequest`, checked in a scratch module
  outside both repositories.
- **CI on the draft PRs:** #16 and #17 green, with the staging deploy jobs
  skipped as intended. #18–#20 are pending at the time of writing.

## 6. Bugs found and fixed during this work

1. M7: concurrent `email.sent` and `email.delivered` events could regress a
   recipient's status (race). Fixed with conditional updates; a regression
   test was added.
2. M9: `MAIL_EMERGENCY_STOP_ALL` did not halt staff/support mail, only
   marketing. Fixed: every send path consults runtime controls.
3. M9: app-wide light-theme muted text failed WCAG AA contrast (3.2:1). The
   token was darkened to 5.1:1; this needs design sign-off.
4. Earlier, in Stage A/M7 (summarized in PR #17):
   - automation events from before activation could enrol;
   - waiting-step job keys could collide;
   - a topic-only withdrawal exited all enrolments;
   - a DOI token was visible to admins;
   - a bounce for a non-contact could store a plaintext address.

## 7. Approvals and actions required (none performed)

1. Review and merge PRs #16 → #20 into `staging`. Merging into `main` is
   separate.
2. Staging Admin DB: backup, then apply migrations 27–33 via
   `db:admin:prepare` in a change window (runbook:
   `docs/cosmicforge-mail-staging-migration-runbook.md`).
3. Infrastructure:
   - private S3 bucket + KMS keys per environment;
   - clamd on a private network;
   - secret-manager entries (Resend keys and webhook secrets per brand,
     unsubscribe secret, integration HMAC and hash secrets, metrics token);
   - metrics scraping and alert routing.
4. Resend account owner: test domain, API keys, webhook endpoints (company +
   per brand), receiving route. No real routes were changed.
5. Domain owners: DNS per the M10 coexistence plan. No production DNS/MX was
   changed.
6. Legal/records: retention periods, consent and imported lists, DMARC
   posture.
7. Brand owners: postal addresses, quotas, marketing go-live.
8. Karryam Go owner: contract v1 review, outbox implementation in their own
   repository, test against a disposable HQ, written approval before
   activation.
9. HealthNet owner: confirm ops-alert-only scope.
10. Design: muted-text contrast change.
11. Accessibility: manual keyboard and screen-reader audit.
12. Operations: decide production backup cadence/PITR; run the live canary on
    staging (operator, change ticket).

## 8. Known limitations

- The ingestion rate limiter is per process; use the edge or gateway for a
  cluster-wide limit.
- An object left behind by a failed storage delete is counted, not retried
  automatically.
- Rollout rule caches are per process (5 s TTL); another replica sees a
  change within 5 seconds.
- Alert thresholds are initial values; no stability data exists yet.
- Body search remains disabled by design; no safe encrypted-search design was
  approved.
- Live provider behavior (Resend broadcasts, webhooks, receiving) is
  validated only against documentation and the fake adapter.
