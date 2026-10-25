# CosmicForge Mail M1–M10 completion report

Date: 2026-10-25. Branch: `staging` (the only branch used for this work).

**Specification:** "CosmicForge Mail Implementation Specification", version
1.0, 24 Oct 2026, 17 pages (sections 1–27). Every section was re-checked
against the code on `staging` for this report.

**Verdict:** CODE COMPLETE ON `staging`. Staging deployment is safe with the
current database. The live pilot is NOT yet approved: it needs the database,
infrastructure, provider and owner steps in §9 and the live tests in §10.

## 1. Where the code is

| Item | Value |
|---|---|
| Starting point (verified merge of PRs #16–#20) | `6523719` |
| P0 fix: setup links instead of emailed passwords | `9f762c5` |
| Specification gap closure (migration 35) | `e05aec8` |
| Concurrency fix + load/concurrency tests | `ea4a9a5` |
| Filter switch fix (found by the mobile E2E run) | `c3e8669` |
| Final code SHA on `staging` | `c3e8669` (this report is the commit after it; docs only) |

- PRs #16–#20 are **merged into `staging`** (merge commits `0a673eb` … `6523719`). They are not on `main`.
- Each push to `staging` triggers the automatic staging deployment. Every pushed head was proven deploy-safe first (§6).
- No feature branch, no new PR, no commit to `main`, no force-push, no history rewrite.

## 2. Readiness

| Level | Status |
|---|---|
| **A. Code complete** | **Reached.** Every code-level requirement is implemented and covered by automated tests (Appendix A). Body search and raw MIME capture are built but **off** pending approval (§9). |
| **B. Staging deployment safe** | **Reached.** The deployed code works on a staging DB at migration 33, 34 or 35, with Mail on or off (§6). |
| **C. Staging Mail live** | **Not reached.** Migrations 27–35 have **not** been applied to the shared staging DB by this work: that needs the DB owner's approval and a verified backup. Provider, DNS, storage, KMS and scanner are not provisioned. |
| **D. Live pilot accepted** | **Not reached.** Needs the live tests in §10 and the sign-offs in §9. |

## 3. Gaps closed in this round

| # | Spec | Gap | What was built | Default |
|---|---|---|---|---|
| 1 | §3, §24 (P0) | Lab approval, HR invites/resends and HR password resets emailed a temporary password | Single-use, expiring setup links. Only a SHA-256 hash is stored; the secret travels in the URL fragment; one live link per person/purpose; atomic redemption; public `/account-setup` page; reset approval no longer sets a password. Old temp-password generators removed. | On once migration 34 exists; before that nothing is emailed and reset approval answers 503 |
| 2 | §12 | No body search | Keyed blind index: per-mailbox HMAC of each word, truncated; no plaintext stored. Search runs only inside mailboxes the user can open; break-glass mailboxes are excluded from unified search and audited. Key rotation and backfill job. Threat model in `docs/cosmicforge-mail-body-search.md`. | **Off** (`MAIL_BODY_SEARCH_ENABLED=false`) pending confidentiality approval |
| 3 | §1.2, §10.7 | No filter management | Rules API (list/create/update/delete/reorder, owner or manager only, fixed safe operators, audited) and a Filters section in Mail settings | On (uses the existing `mail_rules` table) |
| 4 | §1.3 | No forwarding | Forwarding is a request that a different administrator approves. Internal targets only, or external targets on an allow-listed domain with a step-up. Hop limit, hourly cap, loop headers, clean attachments only. Disabled automatically on suspension and offboarding; checked again at dispatch. No open relay. | No external domain allowed until `MAIL_FORWARDING_EXTERNAL_ALLOWED_DOMAINS` is set |
| 5 | §10.6 | Original headers / raw MIME not kept | Encrypted, integrity-checked archive; "Show original" and `.eml` download for mailbox members only | Headers on; raw MIME **off** (`MAIL_ARCHIVE_RAW_MIME=false`) |
| 6 | §10.4, §19.4 | No sender-authentication handling | SPF/DKIM/DMARC read only from the provider's result or a trusted `Authentication-Results` host. A warning banner for unverified senders; mail spoofing our own domains is quarantined. | On (`MAIL_INBOUND_AUTH_POLICY=warn`) |
| 7 | §10.4, §10.8 | Reconciler counted failed/dead-letter jobs as processed; CC/BCC routing gaps | Reconciler retries a dead-lettered inbound job once, then reports it (`MAIL_INBOUND_UNRECOVERED`); admin job requeue with step-up. Every local To/CC/BCC/envelope recipient gets a private copy. Unknown recipients: reject or quarantine. Over-quota policy. | Reconciliation off until `MAIL_RECONCILIATION_ENABLED` |
| 8 | §9 | Hand-written frontend client | OpenAPI document with typed schemas → generated `apps/central-admin-web/src/lib/generated/mail-api.ts`; the web Mail service uses it. Contract tests compare routes, operations and envelopes. CI fails on drift (`npm run mail:client:check`, new step in `staging.yml`). | — |
| 9 | §13.3 | Marketing "replied" not counted | Replies attributed to a campaign by evidence (In-Reply-To/References), deduplicated, brand-scoped; `replied` and reply rate in the report | — |
| 10 | §19.5, §20 | Rate limits and rollout caches per process | Shared PostgreSQL fixed-window limiter; falls back to the same limit per process (never unlimited) and can fail closed. Rollout rules and emergency stops use a versioned cache, so a change reaches every replica on the next request. | On once migration 35 exists |
| 11 | §5.8, §20 | Missing operations reporting | Storage capacity and quota, search-index freshness, unusual exports, scanner failures, unrecovered inbound, rate-limit fallback: snapshot fields, Prometheus metrics and alerts with thresholds | — |
| 12 | §12 retention | (found in audit) Retention deleted shared storage objects still used by another copy | Retention deletes an object only when nothing references it | — |
| 13 | §20 | (found by the new concurrency test) Two workers on the same email: the loser failed with a raw unique-violation error | Counted as a duplicate | — |

Every new feature checks its tables first. Until migration 35 is applied it answers `503 MAIL_FEATURE_NOT_READY` (retryable), and core Mail keeps working (`tests/mail-pre-gap-migration.test.js`).

## 4. Database changes

Existing migrations 1–33 were not changed; checksums are preserved. Two additive migrations were added:

| Order | File | Content | Rollback |
|---|---|---|---|
| 34 | `20261031_account_setup_tokens.sql` | `account_setup_tokens` (hash only, CHECKs, partial unique index for one live link) | `docs/sql/account-setup-tokens-rollback.sql` |
| 35 | `20261101_mail_spec_gap_closure.sql` | New tables only: `mail_message_search_index` (GIN), `mail_message_archives`, `mail_forwarding_rules`, `mail_rate_limit_buckets`, `marketing_campaign_replies` | `docs/sql/cosmicforge-mail-gap-closure-rollback.sql` |

Prisma client regenerated; manifest updated; runbook rows 34 and 35 added.

**Not applied to the shared staging database.** That needs the DB owner's approval and a verified backup (§9).

## 5. Test evidence (final code, offline, real PostgreSQL 16)

Backend numbers are from `ea4a9a5`; `c3e8669` changes one web component only, and the Playwright and web checks below were run on it.

| Suite | Total | Pass | Fail | Skip |
|---|---|---|---|---|
| Backend `npm test` | 1161 | 1159 | 0 | 2 |
| `npm run test:mail` | 178 | 178 | 0 | 0 |
| `test:mail` S3 storage mode | 25 | 25 | 0 | 0 |
| Playwright desktop + mobile, mocked API, with axe | 114 | 104 | 0 | 10 |

The 2 backend skips are environment-only: no live clamd host (`mail-clamd-live`) and no IPv6 loopback. They were not suppressed.

| Check | Result |
|---|---|
| `db:manifest:verify` | 35 migrations, 0 checksum failures, 0 missing/extra/duplicate |
| `db:replay:verify` (disposable DB) | ok, 35 migrations, drift none |
| `mail:rollback:drill` (disposable DB) | ok: migrations 35 and 34 rolled back first, then M7–M10; no leftover tables or types; 7 reapplied; roll-forward drift none |
| `mail:backup:verify` (disposable copy) | ok, 118 tables, 0 mismatches |
| `migrations:safety` | 35 files, 0 findings |
| `security:secret-scan` | 769 files, 0 findings |
| `mail:client:check` (generated client current) | ok |
| Web `tsc` / ESLint / `next build` | clean / 0 errors / OK |

New test files in this round:
- `tests/account-setup-links.test.js` (12), `tests/account-setup-callers.test.js` (5): setup links, and the real lab-approval / HR invite / HR reset code paths.
- `tests/mail-gap-closure-postgres.test.js` (13 subtests): filters, body search privacy, sender auth, routing, archive, forwarding, reconciliation, replies, shared limits, rollout consistency, operations alerts.
- `tests/mail-pre-gap-migration.test.js`: new code on a DB without migration 35.
- `tests/mail-openapi-contract.test.js` (5): route ↔ OpenAPI ↔ generated client.
- `tests/mail-concurrency-postgres.test.js` (6 subtests): 8 workers × 200 jobs claimed exactly once; 10 concurrent deliveries of one email → one copy; 100 parallel deliveries with 25 concurrent inbox reads; shared limit across 4 limiter instances admits exactly the budget; DB-failure fallback bounded or fail-closed; quarantine policy.
- `e2e/mail-gap-closure.spec.ts` (7 tests × desktop/mobile): filters, forwarding, sender warning, original headers, step-up, account-setup page.
- `tests/mail-m9-postgres.test.js` updated for shared storage objects.

### 5.1 Playwright

The 10 skips are pre-existing desktop-only or mobile-only cases. The first full run had 1 failure (the filter switch on mobile); it was a real UI timing defect, fixed in `c3e8669`. After the fix: full suite 104 pass / 0 fail, and the filters test passed 10 of 10 when repeated 5 times on both projects.

## 6. Staging deploy safety (final code)

Method: the final API booted with `NODE_ENV=production`, the HealthNet main DB unreachable, against a database built only from an older schema.

| DB state | Mail | Login, `/auth/me` | Mail | New features | Other modules | Errors |
|---|---|---|---|---|---|---|
| Migration 33 (`6523719`) | off | 200 | 503 `MAIL_DISABLED`; ready 200 `enabled:false` | account setup 503 `ACCOUNT_SETUP_NOT_READY` | Social 200 | none (only the expected main-DB connection log) |
| Migration 33 | on | 200 | 200; ready 503 (storage not configured in the probe) | 503 not-ready | Social 200 | none |
| Migration 34 (`9f762c5`) | on | 200 | as above | account setup 400 on a bad link | Social 200 | none |
| Migration 35 (`e05aec8`) | on | 200 | as above | as above | Social 200 | none |

No 500s. No worker started (the worker is a separate entrypoint). Nothing was sent.

## 7. CI and deployment

| Workflow on `e05aec8` | Result |
|---|---|
| Centralized Admin Frontend CI | success |
| Social Operations CI | success |
| Monorepo Layout and Container CI | success |
| Staging workflow (`staging.yml`) | success: backend verify incl. the new Mail contract step, Mail tests, full suite; image published; **"Deploy staging API to Contabo and verify login" succeeded** |

`ea4a9a5`, `c3e8669` and this report are pushed together; their CI runs follow the same workflows (status in the hand-off message).

Deployment status: the staging deploy runs the API image (`node src/server.js`); migrations never run at startup. Mail stays off unless `MAIL_ENABLED` is set in the staging environment, and no Mail worker is deployed by this work.

## 8. Unresolved items

- **Load at staging scale** (§22.1): concurrency invariants are tested (§5), but no staging-sized load test was run. It needs a staging-sized environment.
- **Web dependency advisories:** 9 production advisories, identical to `staging` before Mail (`next`, `axios` and others). A separate upgrade PR with full UI regression is needed.
- **Vercel project `centralize-admin`** (no root directory) fails every build, before and after this work. Set Root Directory to `apps/central-admin-web` or disconnect it.
- **Alert thresholds** are starting values with no production data yet.
- **Provider behavior** (Resend raw download URL host, `authentication` fields, list pagination, broadcasts) is validated against documentation and the fake adapter only.

## 9. Approvals needed

| Approval | Owner | Unblocks |
|---|---|---|
| Back up the shared staging Admin DB, then apply migrations 27–35 in order (runbook) | DB owner | Mail on staging (level C) |
| Body search confidentiality trade-off (`docs/cosmicforge-mail-body-search.md`) | Security + privacy | `MAIL_BODY_SEARCH_ENABLED`, key provisioning, backfill |
| Raw MIME retention | Privacy/legal | `MAIL_ARCHIVE_RAW_MIME` |
| External forwarding domain list | Security | `MAIL_FORWARDING_EXTERNAL_ALLOWED_DOMAINS` |
| Sender-auth policy (`warn` vs `quarantine`), trusted authserv-ids | Security | `MAIL_INBOUND_AUTH_POLICY`, `MAIL_TRUSTED_AUTHSERV_IDS` |
| Unknown-recipient and over-quota policy, mailbox quota size | IT | `MAIL_UNKNOWN_RECIPIENT_POLICY`, `MAIL_MAILBOX_STORAGE_QUOTA_MB`, `MAIL_OVER_QUOTA_POLICY` |
| S3 bucket + KMS keys, clamd, secrets | Infrastructure | storage/encryption/scanner readiness |
| Resend test domain, keys, webhooks, a receiving route for a dedicated test address only | Resend account owner | live send/receive |
| SPF/DKIM/DMARC for the test domain; **no root MX change** | Domain owner | sending verification |
| HealthNet clinical-content policy (§19.7) | HealthNet owner | restricted-health override |
| Retention periods, consent sources, GDPR/transfer review | Privacy/legal | retention policies, marketing |
| Manual screen-reader and keyboard audit; design sign-off | Accessibility / design | §16.2 |
| Production pilot go/no-go | Leadership, in writing | level D |

## 10. Live tests needed (staging, with approval)

1. Apply migrations 34–35 after backup; confirm `/api/mail/v1/health/ready` and that the new features stop answering `MAIL_FEATURE_NOT_READY`.
2. Gmail and Outlook round trips to the test address: thread, attachment, reply, CC/BCC to two local mailboxes.
3. Sender auth: one message that passes DMARC and one that fails; check the banner and the stored verdict match Resend's `authentication` field.
4. Original headers and (if approved) raw MIME download from a real inbound message; confirm the raw download host is allowed.
5. Webhook replay and modified-body rejection against the real endpoint; reconciliation run against Resend's list API.
6. Ambiguous-timeout send and cancel-while-queued against the real provider.
7. One approved internal forward and one external forward to an allow-listed test domain; check loop headers and the hourly cap.
8. Attachment scan with a live clamd (EICAR) and a scanner outage.
9. Body search (if approved): backfill, freshness metric, key rotation.
10. Two API replicas: shared rate limit and emergency stop take effect across both.
11. Backup restore drill and rollback drill on a disposable copy of the staging DB.
12. Marketing: test send to staff and one approved campaign to a consented internal list; confirm a reply is counted.

---

## Appendix A. Traceability matrix

Result key: **PASS** = implemented and the named automated test passes on the final code. **PASS (off)** = implemented and tested, disabled by default pending approval. **PARTIAL** = gap stated. A file merely existing never counts as PASS.

Test shorthand: `pg` = `tests/mail-postgres.test.js`; `m7`…`m10` = `tests/mail-m7-postgres.test.js` etc.; `gap` = `tests/mail-gap-closure-postgres.test.js`; `conc` = `tests/mail-concurrency-postgres.test.js`; `pre` = `tests/mail-pre-gap-migration.test.js`; `oa` = `tests/mail-openapi-contract.test.js`; `e2e:` = `apps/central-admin-web/e2e/*.spec.ts`. Code paths are under `services/central-admin-api/src/modules/mail/` unless stated.

| PDF requirement | Code location | Automated test | Result | External approval or live test |
|---|---|---|---|---|
| §1.1 One permissioned Mail module; staff see only authorized mailboxes | `mail.policy.js`, `services/mailbox.service.js` | `pg` privacy subtests (EMPLOYEE/ADMIN/EXECUTIVE/SUPER); `e2e:mailbox-isolation` | PASS | — |
| §1.2 Gmail-like UI incl. filters | `apps/central-admin-web/src/components/mail/*`, `MailFilters.tsx` | `e2e:compose`, `e2e:mail-gap-closure` (filters), `e2e:accessibility` | PASS | manual screen-reader audit |
| §1.3 Addresses, aliases, provisioning, suspension, delegation, offboarding, forwarding | `services/mail-admin.service.js`, `services/forwarding.service.js` | `pg` alias/offboarding; `gap` forwarding; `e2e:mail-gap-closure` forwarding | PASS | forwarding domain list |
| §1.4 Email Marketing inside Marketing | `marketing/email-marketing` | `m7`, `e2e:marketing-*` | PASS | brand owner |
| §1.5 Support shared mailbox, tickets, SLA | `services/support.service.js` | `pg` M5 subtests; `e2e:support-queue` | PASS | — |
| §1.6 Resend behind an adapter | `adapters/resend.adapter.js`, `adapters/fake.adapter.js` | adapter contract tests in `pg`, `mail-infra` | PASS | live §10.2 |
| §1.7 External recipients | outbound processor | `pg` outbound subtests (fake provider) | PASS offline | live §10.2 |
| §1.8 Deployment boundaries; own worker | `src/mail-worker.js` | `mail-app-wiring` | PASS | — |
| §1.9 Encrypted storage, backup/restore | `storage/*`, `scripts/mail/backup-verify` | S3 mode (25), `mail:backup:verify` | PASS | infra + live §10.11 |
| §1.10 Staging rollout without touching prod MX/routes/schemas | flags default off | `mail-schema-readiness`, `pre`, §6 probes | PASS | DB owner |
| §2 Evidence boundaries, domains unverified | `.example` fixtures | secret scan, fixtures | PASS | — |
| §3 Placement red flags incl. no emailed passwords | `mail-app-wiring`; `shared/auth/account-setup.service.js` | `mail-app-wiring`; `account-setup-links`, `account-setup-callers` | PASS | — |
| §4 Ownership matrix | module boundaries; `integrations/*` | `m8` | PASS | — |
| §5.1 Personal webmail | mailbox/compose services | `pg`, `e2e:compose` | PASS | — |
| §5.2 Shared departmental inboxes | support/shared mailbox | `pg` M5 | PASS | — |
| §5.3 Domains/identities, DNS, test send, key rotation, emergency pause | admin service; `ops/rollout.service.js` | `pg`, `m10`, `gap` rollout consistency | PASS | DNS + Resend live |
| §5.4 Onboarding invitations, offboarding | `hrm/accounts.service.js` setup links; offboarding in admin service | `account-setup-callers`; `pg` offboarding; `gap` forwarding disabled on offboarding | PASS | — |
| §5.5 Marketing incl. preview/test sends | broadcasts, test sends | `m7`, `m10` | PASS | live §10.12 |
| §5.6 Automations | automation engine | `m7` | PASS | — |
| §5.7 Product transactional mail stays product-owned | `integrations/*` | `m8` | PASS | product owners |
| §5.8 Admin/IT reporting incl. storage capacity, search staleness, exports, dead letters | `ops/ops-monitor.service.js`, admin views | `m9`; `gap` operations subtest | PASS | thresholds after live data |
| §6 Conceptual model | `prisma/schema.prisma` | replay drift none | PASS | — |
| §7 Roles/permissions; SUPER no bypass | `mail.policy.js` | `pg` privacy; `gap` rules/forwarding permissions | PASS | — |
| §8 Data model and DB rules | migrations 27–35 | `db:replay:verify`, `migrations:safety`, rollback drill | PASS | DB owner applies |
| §9 API, status semantics, admin ops, OpenAPI, generated client | `http/mail.routes.js`, `openapi/mail.openapi.js`, `scripts/mail/generate-web-client.js` | `oa` (5); `mail:client:check` in CI | PASS | — |
| §10.1–10.3 Raw webhook, acceptance, idempotent fetch/scan/store | webhook controller, inbound processor | `pg`; `conc` duplicate delivery | PASS | live §10.5 |
| §10.4 Routing incl. CC/BCC; sender authentication | `pipelines/inbound.processor.js`, `security/sender-auth.js` | `gap` routing + sender auth; `e2e:mail-gap-closure` banner | PASS | live §10.3 |
| §10.5 Threading | message store | `pg` threading | PASS | live §10.2 |
| §10.6 Original headers / raw MIME | `services/message-archive.service.js` | `gap` archive | PASS (raw MIME off) | privacy approval; live §10.4 |
| §10.7 Rules/filters | `services/mail-rules.js`, `mail-rules.service.js` | `gap` filters; `pre`; `e2e:mail-gap-closure` | PASS | — |
| §10.8 Reconciliation; unknown recipients; no catch-all | `pipelines/inbound-reconciler.js` | `gap` reconciliation; `pg` reject; `conc` quarantine | PASS | live §10.5 |
| §11 Outbound: outbox, idempotency, ambiguous timeout, honest states | compose + outbound processor | `pg` ambiguity subtests; `conc` job claims | PASS | live §10.6 |
| §12 Attachments/AV, sanitizing, remote images | scanner, sanitizer | `pg`, `e2e:safe-html`, `mail-clamd-live` (skipped: no host) | PASS offline | live clamd §10.8 |
| §12 Search incl. bodies | `services/search-index.service.js` | `gap` body search (owner only, no plaintext) | PASS (off) | confidentiality approval; live §10.9 |
| §12 Retention, legal holds | `ops/retention.processor.js` | `m9` incl. shared-object retention | PASS | retention periods |
| §13.1 Legacy campaigns untouched | read-only bridge | `m7` | PASS | — |
| §13.2 Campaign journey incl. link scan and quota preflight | preflight, approvals | `m7`, `e2e:marketing-approval` | PASS | live §10.12 |
| §13.3 Metrics incl. replied | `marketing/campaign-replies.js`, broadcast report | `gap` marketing replies | PASS | live §10.12 |
| §13.4 Consent rules | consent model | `m7` | PASS | legal |
| §14 Automations and templates | automation engine | `m7` | PASS | — |
| §15 HR/IT/Support/Marketing/product integrations | HR card, IT admin, `m8` | `pg`, `m8`, `e2e:mail-administration`, `e2e:mail-integrations` | PASS | Karryam/HealthNet owners |
| §16.1 Frontend placement | `dashboard/mail/**`, `components/it/MailAdministration.tsx`, `MailForwardingAdmin.tsx` | `e2e:nav-permissions`, `e2e:mail-administration` | PASS | — |
| §16.2 UX, responsive, accessibility, honest states | web components | `e2e:mobile`, `e2e:accessibility` (axe) | PASS | manual audit |
| §17 Backend placement; raw parser; separate worker | `app.js` | `mail-app-wiring` | PASS | — |
| §18 Provider adapter contract | adapters | `pg`, `mail-infra` | PASS | live |
| §19.1 MFA for privileged actions | step-up service | `pg`, `gap` (requeue, external forwarding) | PASS | — |
| §19.2 Object-level authorization | policy | `pg` privacy; `conc` privacy under load | PASS | — |
| §19.3 Secrets separation, webhook rotation | config | `pg` rotation | PASS | secret manager |
| §19.4 Inbound security incl. sender auth | webhook, `security/sender-auth.js` | `pg`, `gap` | PASS | live §10.3 |
| §19.5 Outbound security, quotas, cluster-wide limits | send gate, `ops/shared-rate-limit.js` | `pg`, `gap` shared limits, `conc` 4-instance limit | PASS | live §10.10 |
| §19.6 Data handling | storage/KMS, redacted views | `pg`, S3 mode | PASS | GDPR review |
| §19.7 No clinical content via Resend | restricted-health gate | `pg`, `m7` | PASS | HealthNet policy |
| §19.8 DNS; no root MX change | IT DNS view | `pg` DNS checks (offline) | PASS offline | domain owner |
| §19.9 No HTML execution / SSRF | sanitizer, safe frame | `e2e:safe-html`, `pg` | PASS | — |
| §19.10 Abuse/complaints, unusual rates and exports | suppression, ops alerts | `m7`, `gap` operations | PASS | — |
| §20 State machines, metrics, alerts, live/ready, outage honesty, job recovery, cross-replica consistency | `ops/*`, `jobs/*`, `schema-readiness.js` | `m9`, `m10`, `gap`, `conc`, `mail-schema-readiness`, `pre` | PASS | thresholds after live data |
| §21.1 Environment variables | `.env.example` | secret scan | PASS | secret manager |
| §21.2 Deployment order | runbook | — | Documented | DB owner, ops |
| §21.3 Rollback | rollback SQL, drill | `mail:rollback:drill` | PASS | live §10.11 |
| §22 Acceptance matrix | Appendix B | Appendix B | see Appendix B | — |
| §22.1 Unit/integration/E2E/security/load | suites in §5 | §5; `conc` | PASS (staging-scale load: PARTIAL) | staging-sized load test |
| §23 Phased backlog M0–M10 | M1–M10 on `staging` | all suites | PASS (M0 sign-offs pending) | M0 sign-offs |
| §24 Modification map incl. legacy senders | `shared/utils/email.util.js` | `mail-m8-unit` pinned hash, `account-setup-callers` | PASS | — |
| §25 Open owner decisions | §9 | — | Listed | owners |
| §26 Formal acceptance | §9, §10 | — | Pending live tests | all owners |

## Appendix B. §22 acceptance matrix

| Scenario | Gate | Automated test | Result | Live |
|---|---|---|---|---|
| Staff A opens Staff B private inbox by guessed ID | Critical | `pg` privacy; `conc` (404 under load); `e2e:mailbox-isolation` | PASS | — |
| SUPER without break-glass | Critical | `pg`; `e2e:mailbox-isolation`; `gap` (break-glass excluded from search) | PASS | — |
| Removed from shared mailbox mid-session | Critical | `pg` M5 revocation | PASS | — |
| Non-owned From / ceo@ | Critical | `pg` spoof tests | PASS | — |
| Alias + primary, one login | High | `pg` alias | PASS | — |
| Gmail round trip with thread + attachment | Critical | `pg` thread/attachment (fake provider) | PASS offline | §10.2 |
| Outlook/Yahoo/iCloud round trip | High | — | Not testable offline | §10.2 |
| Webhook replay / duplicate svix-id | Critical | `pg`; `conc` duplicate delivery | PASS | §10.5 |
| Webhook body modified | Critical | `pg` (401, nothing enqueued) | PASS | §10.5 |
| Accepted then worker crash | Critical | `pg` lease recovery; `gap` dead-letter reconciliation | PASS | — |
| Ambiguous timeout | Critical | `pg` ambiguity | PASS | §10.6 |
| 50 MB / malicious attachment / script HTML | Critical | `pg` size, EICAR, sanitizer; `e2e:safe-html` | PASS | §10.8 |
| External To + internal CC/BCC | Critical | `pg` mixed recipients; `gap` CC/BCC private copies | PASS | §10.2 |
| Unprovisioned local address | High | `pg` reject; `conc` quarantine | PASS | — |
| HealthNet Main DB offline | Critical | §6 probes (main DB unreachable) | PASS | — |
| Existing Help/Marketing/Social parity | Critical | full backend suite (1159 pass) | PASS | — |
| CSV without verified consent | Critical | `m7` | PASS | — |
| Cross-brand campaign | Critical | `m7`; `gap` replies brand-scoped | PASS | — |
| Unsubscribed/complained contact in segment | Critical | `m7` | PASS | — |
| Content changed after approval | Critical | `m7` | PASS | — |
| Cancel while queued | High | `m7` | PASS | §10.6 |
| Staging deployment without migration | Critical | `mail-schema-readiness`, `pre`, §6 probes | PASS | — |
| Restore backup and search/archive | High | `mail:backup:verify` (disposable copy) | PASS offline | §10.11 |
| Keyboard/mobile/screen reader | High | `e2e:accessibility` (axe), `e2e:mobile` | PASS (manual audit pending) | manual audit |
| Emailed password never sent (§3) | Critical | `account-setup-links`, `account-setup-callers`, `e2e:mail-gap-closure` | PASS | — |
| Competing workers / concurrent load | High | `conc` | PASS (small scale) | staging-sized load |
