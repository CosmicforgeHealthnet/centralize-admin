# CosmicForge Mail: staging end-to-end acceptance report

Date: 2026-10-26. Branch: `staging` only (no feature branches, no PRs, `main` and production untouched).
Specification: "CosmicForge Mail Implementation Specification" v1.0 (24 Oct 2026, sections 1-27).
Previous report: `docs/cosmicforge-mail-m1-m10-completion-report.md` (still valid for M1-M10 code; this report supersedes its §8-§10).

## Final decision: **BLOCKED** for staging acceptance; code is CONDITIONALLY READY

The code-level work for sections 11-15 is complete and tested offline, including 60+ defects that this
round's audit found and fixed. None of the five live staging workstreams could be executed: this
execution environment has **no** staging database credentials, Resend account access, DNS access,
object-storage/KMS credentials, scanner host or SSH access to the staging server, and no owner
approvals were provided. Nothing below that needs the live environment is marked PASS.

| Gate | Answer | What is missing |
|---|---|---|
| 1. All code-level requirements complete | **Yes, with listed exceptions** (§F) | Transactional-template flag, provider re-subscribe call, spend metric, automation test/replay routes, storage-removal retry table |
| 2. All five staging workstreams complete | **No** | All five need credentials/approvals (§A) |
| 3. All critical §22 acceptance tests passed | **Offline: yes. Live: no** | Every row marked "live" in §G |
| 4. All required live staging tests passed | **No** | None could run (§H) |
| 5. Security, privacy, DB and domain approvals recorded | **No** | None received (§I) |
| 6. §26 definition of done satisfied | **No** | §J |

---

## A. Five-workstream status

| Workstream | Status | Evidence | Outstanding blocker (owner) |
|---|---|---|---|
| 1. Staging database | **BLOCKED** | Live API reports Mail `enabled:false` (`GET /api/mail/v1/health/ready` → `{"ready":true,"enabled":false}`), so the shared DB's Mail migration state cannot be read through the API. Offline: 36 migrations, manifest 0 checksum failures, replay drift none, rollback drill ok (36→27 and roll-forward), backup/restore verify ok (119 tables, 0 mismatches) on a disposable copy. | No staging DB credentials and no DB-owner approval. Operator steps in §H.1. (**DB owner**) |
| 2. Infrastructure | **BLOCKED** | Real **clamd 1.5.4** daemon: `test:mail:clamd-live` passed (INSTREAM, EICAR detected, 2 MB clean file accepted, oversize not passed as clean). Signature DB download is blocked from this sandbox, so EICAR used a one-line local signature; the protocol and client are real. Real **S3 + KMS protocol** (moto server): new `test:mail:s3-kms-live` passed (KMS data key wrap/unwrap bound to context, wrong context refused, SSE-KMS private objects, ciphertext at rest, tamper detection, immutability, anonymous read denied, delete, fail-closed). This found and fixed a defect: the storage health probe sent HEAD to the key prefix, so readiness could never pass with `MAIL_S3_PREFIX` set (`631702d`). The emulator does not verify SigV4 signatures; the offline fake S3 does. | No staging bucket, KMS key, scanner host, Resend key or worker deployment. The sandbox's AWS credentials are rejected by AWS STS (`InvalidClientTokenId`). (**Infrastructure**, **Resend account owner**) |
| 3. Domain & receiving | **BLOCKED** | Offline only: signed raw webhook, duplicate svix-id, unknown-recipient reject/quarantine, catch-all prevention (`mail-postgres`, `mail-concurrency-postgres`). | No approved test domain, no DNS access, no Resend receiving route. No DNS was changed. (**Domain owner**, **Resend account owner**) |
| 4. End-to-end features (§11-15) | **Code PASS offline; live BLOCKED** | Audit of §11-15 against code; all confirmed defects fixed with regression tests (§B, §E). `test:mail` 237/237, S3 mode 30/30. | Live sends/receives and live broadcasts need workstreams 1-3 plus approved test recipients. |
| 5. Security & operations | **Code PASS offline; live BLOCKED** | Security fixes in §E; full backend suite; Playwright desktop+mobile; secret scan 0 findings; staging frontend deployed and reachable (§D). | No authenticated staging session, no live monitoring data, no live restore/rollback rehearsal on a staging copy. (**DevOps**, **Security**) |

## B. PDF sections 11-15, requirement by requirement

Paths are under `services/central-admin-api/src/modules/mail/` unless stated; web paths under `apps/central-admin-web/src/`.
"Live" = needs the staging environment; none of them could run (§A).

### Section 11: Outbound mail

| Req | Code | Automated test | Observed | Status | Live / approval |
|---|---|---|---|---|---|
| 11.1 Send only through authorized mailbox + identity; status, membership, grant, domain, caps, quota, content policy; re-checked at dispatch | `authz/mail.policy.js`, `authz/sending-gate.js`, `services/compose.service.js` (`sendDraft`, `assertContentPolicy`, quota under advisory lock), `pipelines/outbound.processor.js` (`assertStillAuthorized`, org quota re-check) | `mail-postgres` M1/remediation, "staff send policy", "org quota"; unit "staff content policy" | Spoofed/ungranted From refused + audited; queued mail now counts toward quota; suppressed recipients, unsafe links, oversize messages refused | **PASS (offline)** | Live §H.6 |
| 11.2 Durable queued message, immutable snapshot, stable idempotency key, 202 | `compose.service.js`, `http/mail.routes.js` | `mail-postgres` "send returns 202…", "staff send policy" (key reuse 409, concurrent same key → same message) | | **PASS (offline)** | — |
| 11.3 Resend `/emails`: From, Reply-To, To/CC/BCC, Message-ID, In-Reply-To, References, HTML/text, attachments, provider id, audit | `outbound.processor.js`, `adapters/resend.adapter.js`; Reply-To from granted identities (`replyToAddressId`, compose picker) | unit Resend adapter tests; `mail-postgres` threading | Reply-To was never set before this round: fixed | **PASS (offline)**; provider preservation of custom Message-ID **unverified** | Live §H.6: confirm Resend keeps our Message-ID (threading and echo dedup depend on it) |
| 11.4 Recipient-level events incl. suppressed and unknown | `pipelines/delivery-event.processor.js` (shared `aggregateMessageStatus`, `attribute()`, `reapplyUnmatched`) | `mail-postgres` "attribution" block, unit "message status derivation" | Fixed: `email.suppressed` ignored; Cc/Bcc mis-attribution; early events lost; status regressing to QUEUED | **PASS (offline)** | Live §H.5 |
| 11.5 Retries, 429/5xx/timeout, ambiguous, crash, same key, no duplicates | `outbound.processor.js` (`inFlight`/`ambiguous` per batch, plan-driven dispatch) | `mail-postgres` "dispatch follows the batch plan", "earlier ambiguity survives", ambiguity/window tests | Fixed: a later batch could be silently never sent; a dead-letter after an ambiguous attempt said "failed" and invited a duplicate | **PASS (offline)** | Live §H.6 |
| 11.6 UI: Queued / Provider accepted / Delivered to receiving server / Failed / Unknown; never "read" | `components/mail/mail-utils.ts`, `MessageCard.tsx`, `ComposeEditor.tsx` | Playwright compose/thread specs | Fixed: internal copies showed "Delivered" for external recipients; open/click hidden for private mail | **PASS (offline)** | — |
| 11.7 Gmail/Outlook/Yahoo/iCloud | provider-neutral | — | | **NOT TESTED** | Live §H.6 with owner-approved test accounts |
| 11.8 One internal delivery path; mixed recipients; BCC privacy | `compose.service.js`, `outbound.processor.js` (`buildDeliveryPlan`) | `mail-postgres` mixed-recipient, BCC tests; gap-closure CC/BCC copies | BCC never leaked. **Known deviation:** external recipients see only external To/Cc in headers (Resend sets headers from its to/cc fields) | **PARTIAL** | Decision needed (§I): accept the documented limitation, or test provider-side delivery to internal addresses with echo dedup |

### Section 12: Attachments, rendering, search, storage, retention

| Req | Code | Automated test | Observed | Status | Live / approval |
|---|---|---|---|---|---|
| Private bounded upload | `http/mail.routes.js` multer limits; `compose.service.js` | m9 "a1" | Fixed: unbounded form fields. **Presigned upload:** the authenticated API proxy is kept. It is private, bounded (10-25 MB), scanned before persistence and never exposes storage URLs; a presigned flow adds a scan-after-upload state machine without a security gain at these limits. Revisit above 25 MB. | **PASS (offline)**; design decision recorded | Security sign-off on the proxy decision |
| Encryption, checksum, integrity, no public URLs | `storage/*`, `security/kms-keyring.js` | S3 mode 30/30; `test:mail:s3-kms-live` | Storage health-probe defect fixed | **PASS (offline + local real protocol)** | Live bucket/KMS §H.2 |
| AV scan before availability, quarantine, fail closed | `scanning/attachment-scanner.js`, `inbound.processor.js` | clamd-live (real daemon); unit + m9 "a4" | Fixed: size/type policy failures were labelled malware and quarantined whole messages | **PASS (offline + local real clamd)** | Live clamd with official signatures §H.2 |
| Inline images (cid), Content-Disposition, raw .eml | `services/mailbox.service.js` `inlineImages`, `message-archive.service.js` | m9 "b1", "b2" | Fixed: raw .eml downloadable with unscanned attachments; clean inline images never shown | **PASS (offline)** | — |
| Received attachment URL expiry / SSRF | `adapters/resend.adapter.js` (`readCapped`, redirects refused, host allowlist) | unit "c1" | Fixed: full buffering before size check | **PASS (offline)** | Confirm Resend owns all subdomains of the allowlisted hosts |
| Sanitized HTML, JS/SVG blocked, remote images blocked, links, phishing, SSRF, SPF/DKIM/DMARC banner | `security/html-sanitizer.js`, `SafeHtmlFrame.tsx`, `MessageCard.tsx` | unit "d1"; `e2e/safe-html` | Fixed: four CSS tracking-image bypasses; frame CSP now `img-src data:` unless the user allows images; suspicious links flagged | **PASS (offline)** | — |
| Search From/To/subject/date/label/body; membership in SQL; cursor | `services/mailbox.service.js` `search`, `MailSearch.tsx` | m9 "e1-e3"; gap-closure body search | Fixed: index-defeating filter, unstable cursor, label-only search 400, unescaped LIKE | **PASS (offline)**; body search **off** | Body search needs security/privacy approval |
| Retention, legal hold, shared objects, deleted content, orphans | `ops/retention.processor.js` | m9 "f1+f2", shared-object test | Fixed: user-deleted threads never purged; orphan objects never removed; replies landed in deleted threads | **PASS (offline)** | Retention periods (legal) |
| GDPR DSAR access/deletion | **new** `services/dsar.service.js`, `POST /admin/dsar/export`, `/admin/dsar/erasure` | `mail-dsar-postgres` (5) | Mail admin + MFA (`MAIL_DSAR_EXPORT` / `MAIL_DSAR_ERASURE`), reason required, dry run default, legal holds skipped, audited by address hash only | **PASS (offline)** | Legal/DPO sign-off on scope |
| Encrypted backup, restored searchable data | `scripts/mail/verify-backup-restore.js` | `mail:backup:verify` ok (119 tables) | Disposable local copy | **PASS (offline)** | Live §H.11 |

### Section 13: Marketing lifecycle

| Req | Code (`marketing/`) | Automated test | Observed / fixed | Status | Live / approval |
|---|---|---|---|---|---|
| 13.1 Legacy campaigns/templates intact; EventView untouched; subnav | `marketing.service.js`, `MarketingSubNav.tsx` | m7, m6 tests | Fixed: unvalidated `legacyCampaignId` (500 on non-UUID); legacy template list gated by section grant (legacy rows have no brand column) | **PASS (offline)** | — |
| 13.2(1) Brand, authorized From/Reply-To | `marketing-sender.js` | m13/14 block | Fixed: a person's alias could be used as a brand sender; Reply-To must reach a SHARED mailbox | **PASS (offline)** | — |
| 13.2(2) Consent audience; CSV with provenance and operator approval | `marketing.service.js` `importCsv`, `ContactsPanel.tsx` | m6 consent test (preview → different approver commits), m13/14 | Fixed: import bypassed double opt-in and had no approval step; file SHA-256 + name stored | **PASS (offline)** | Consent sources (legal) |
| 13.2(3) Versioned editor, preview | template renderer | m7 | Dark-mode/mobile QA, per-brand tokens, locale: **not implemented** | **PARTIAL** | Design sign-off |
| 13.2(4) Preflight | `marketing.service.js` | m7 | Domain status, counts, suppression, link scan, quota, frequency, address; explicit SPF/DKIM/DMARC, reputation and link-tracking checks **not implemented** | **PARTIAL** | — |
| 13.2(5) Distinct reviewer, MFA, exact content, audience | `marketing.service.js` approve | m13/14; `e2e/marketing-approval` | Fixed: template authors and intermediate editors could approve; approval now binds `contactSetSha256`; reject bumps revision | **PASS (offline)** | — |
| 13.2(6-7) Eligible-only sync, Broadcasts, schedule/pause/cancel | `broadcast.processor.js`, `broadcast.service.js`, `jobs/mail-worker.js` | m7 | Fixed: no lease heartbeat (duplicate dispatch risk); pause/resume races | **PASS (offline)** | Live broadcast §H.12 |
| 13.2(8) Bounce/complaint/unsubscribe/engagement; suppression before every send | `marketing-events.processor.js`, `consent-enforcement.js` | m7, m13/14 | Fixed: **any bounce withdrew all consents**; provider suppression not mirrored | **PASS (offline)** | Live §H.12 |
| 13.2(9) Replies to marketing inbox | `campaign-replies.js` | gap-closure, m13/14 | Fixed: replies during sending never attributed | **PASS (offline)** | Live §H.12 |
| 13.3 Metrics | `broadcast.service.js` | m7, m13/14 | Fixed: delivered fell when complaints arrived. Subscribed/opted-out + denominators/windows added. **Spend and provider quota not reported** | **PARTIAL** | — |
| 13.4 Consent rules | `marketing.service.js` | m7, m13/14 | Fixed: manual re-grant of withdrawn consent | **PASS (offline)** | Legal |

### Section 14: Automations and templates

| Req | Code | Test | Observed / fixed | Status |
|---|---|---|---|---|
| Triggers, delays, branches, versioning, enrollment caps, pause/resume/cancel, idempotency, restart recovery | `marketing/automation/*` | m7, m13/14 | Fixed: engagement branches always false; schedule silently truncated at 1000; stale occurrence on resume; frequency cap ignored own sends; retry crash-loop | **PASS (offline)** |
| Consent/suppression before every send | `automation.processor.js` | m7 "withdrawal before next step" | | **PASS (offline)** |
| Automation preflight and Reply-To | `automation.service.js` `preflightSteps` | m13/14 | Fixed: automations skipped link scan/domain checks; Reply-To was null | **PASS (offline)** |
| Timezone/DST | `scheduling.js` | m7 unit | Delays are fixed durations; recipient-timezone delays **not implemented** | **PARTIAL** |
| Testing and replay routes | — | — | **Not implemented** | **GAP** |
| Templates: transactional vs marketing policy | — | — | No template-level transactional flag (needs schema) | **GAP** |
| Live controlled workflow (signup → send → event → report) | — | — | — | **NOT TESTED** (live §H.12) |

### Section 15: HR, IT, Support, Marketing, Profiles, products

| Contract | Code | Test | Observed / fixed | Status | External |
|---|---|---|---|---|---|
| HR / AdminUser | `hrm/accounts/accounts.service.js`, `mail-admin.service.js` (`offboardForAccountLifecycle`, `validateSenderGrant`) | `mail-audit-fixes-postgres` | Fixed: **HR deactivation never revoked Mail access**; delete gave a 500; requests silently reassigned; sender-grant approval let an employee send as the CEO | **PASS (offline)** | — |
| IT & System | `components/it/*` | `e2e/mail-administration` | No secrets returned. No quarantined-message list view (admin rescan only) | **PARTIAL** | — |
| Help & Support | `services/support.service.js`, `help/email/page.tsx` | audit-fixes | Fixed: ticket links unchecked; open/overdue counts never shown. Ticket existence can't be checked without HealthNet DB (by design) → `ticketRefVerified:false` | **PASS (offline)** | — |
| Marketing | email-marketing UI | m7, e2e | | **PASS (offline)** | — |
| Profiles | **new** `services/preferences.service.js`, `MailPreferences.tsx`, migration 36 | `mail-preferences-postgres`, `mail-pre-preferences-migration`, `e2e/mail-preferences` | Default sender + new-mail notifications. Delegation is direct by the mailbox owner (no request step) | **PASS (offline)** | DB owner applies migration 36 |
| Karryam Go | `integrations/*` | m8 | Fixed: global IP rate limit throttled product events; event races; HMAC matches KarryGo `serviceauth`. **No Karryam-side consumer exists** in the KarryGo repo; its notification payloads (snake_case) would be refused by the HQ contract | **HQ PASS; product EXTERNAL-BLOCKED** | Karryam engineering |
| HealthNet | `integrations/*`, `authz/sending-gate.js` | m8 | Fixed: restriction keyed on product name, not organization; free-text clinical summaries now refused (code catalogue) | **PASS (offline)** | HealthNet owner |
| Future products | `integrations/*` | m8 | Personal alias refused as product sender (new) | **PASS (offline)** | — |
| Navigation / employee layout | `Sidebar.tsx`, `dashboard/layout.tsx`, `GET /api/hrm/accounts/me/grants` | `e2e/nav-permissions`, `e2e/mail-administration` | Fixed: Mail nav shown to everyone; employees saw every admin section | **PASS (offline)** | — |

## C. Actual functionality (live)

| Flow | Worked live? |
|---|---|
| Staff → Gmail send | **Not run**: no provider/domain |
| Gmail → staff receive | **Not run** |
| Staff ↔ Outlook | **Not run** |
| Internal staff → staff | **Not run live** (offline PASS) |
| Shared Support inbox | **Not run live** (offline PASS) |
| Attachments + antivirus | **Not run on staging**; real clamd locally PASS |
| Search (body search) | **Not run live**; body search off pending approval |
| Rules and forwarding | **Not run live** (offline PASS) |
| Address provisioning | **Not run live** (offline PASS) |
| Marketing test broadcast | **Not run** |
| Unsubscribe and suppression | **Not run live** (offline PASS) |
| Marketing reply reporting | **Not run live** (offline PASS) |
| Scheduled automation | **Not run live** (offline PASS) |
| HR/IT integration | **Not run live** (offline PASS) |
| Karryam integration | **Not run**: no Karryam consumer exists |
| HealthNet restrictions | **Not run live** (offline PASS) |
| Emergency stop | **Not run live** (offline PASS, `m10`) |
| Backup/restore | **Not run on staging**; disposable local copy PASS |

## D. Deployment and code evidence

| Item | Value |
|---|---|
| Starting `staging` HEAD | `9843def` (CI green, staging deploy succeeded) |
| Storage probe fix + live S3/KMS test | `631702d` |
| Section 11-15 fixes, DSAR, preferences, migration 36 | `d7ddd01` (100 files) |
| This report | the commit after `d7ddd01` (docs only) |
| New migration | 36 `20261102_mail_user_preferences.sql`, sha256 `f99c79176acf7a3f36e154d742ff487943e485413d88472a20731be1848ab3ea`; rollback `docs/sql/cosmicforge-mail-user-preferences-rollback.sql`; runbook row 36. Migrations 1-35 unchanged |
| Shared staging migration ledger | **Unknown**: not readable without DB credentials |
| Staging API (live probe) | `https://stagingca.cosmicforge-healthnet.com`: `/api/mail/v1/health/live` 200, `/health/ready` 200 `enabled:false` |
| Staging frontend (live probe) | `https://centralize-admin-staging.vercel.app`: 200; `/dashboard/mail`, `/dashboard/marketing/email-marketing`, `/dashboard/it` redirect unauthenticated users to login (desktop 1440×900 and iPhone 13); `/account-setup` renders. No authenticated session was available |

Test totals on the final code (offline, PostgreSQL 16):

| Suite | Result |
|---|---|
| `npm run test:mail` | 237 / 237 pass |
| `test:mail:s3` | 30 / 30 pass |
| Full backend `npm test` (migrated DB, as CI) | 1221 tests: 1216 pass, 3 skip, 2 fail → the migration-count test was updated for migration 36 (now passes); the OAuth redirect test fails only without `NODE_ENV=test` (CI sets it; passes with it). Skips: no IPv6 loopback, no live clamd/S3 in the default run |
| `test:mail:clamd-live` (real clamd 1.5.4) | 1 / 1 pass |
| `test:mail:s3-kms-live` (real S3/KMS protocol, moto) | 1 / 1 pass |
| Manifest / safety / replay | 36 migrations, 0 checksum failures, 0 safety findings, replay drift none |
| Rollback drill / backup verify | ok / ok (119 tables, 0 mismatches) |
| Secret scan / static checks | 777 files 0 findings / ok |
| Generated client drift | ok |
| Web `tsc` / ESLint / `next build` | clean / 0 errors / ok |
| Playwright desktop + mobile (mocked API, axe) | 112 pass, 16 skip (pre-existing project-specific skips), 4 failures (2 specs × 2 projects) that asserted the old behaviour; specs updated for the new section gate and audience-bound approval and re-run: 17 pass, 3 skip |

CI on `d7ddd01` (all `success`): Social Operations CI (staging.yml, incl. "Deploy staging API to Contabo and verify login") [run 40250333741](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40250333741); Centralized Admin Frontend CI [run 40250333762](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40250333762); Social Operations CI [run 40250333792](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40250333792); Monorepo Layout and Container CI [run 40250333789](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40250333789). After the deploy the live API still answers `/health/live` 200 and `/health/ready` 200 `enabled:false`, and the staging frontend answers 200.

## E. Defects found and fixed in this round

Found by auditing §11-15 against the code (not by the existing suites). Each has a regression test.

- **Outbound (§11):** batch silently never sent after an earlier batch's event; dead-letter forgot an ambiguous attempt (duplicate risk); status regression to QUEUED; `email.suppressed` ignored; Cc/Bcc event mis-attribution; early events lost; queued mail bypassed org quota; racy quotas; suppressed recipients not checked; no content policy or total size limit; no Reply-To; false "Delivered" on internal copies; open/click shown on private mail; idempotency key reuse across drafts.
- **§12:** four CSS tracking bypasses; unbounded multipart fields; policy failures labelled malware; unbounded download buffering; raw .eml bypassed quarantine; inline images broken; search index/cursor/label/LIKE defects; deleted content never purged; orphan objects; replies into deleted threads; storage health probe wrong with a prefix. DSAR added.
- **§13-14:** bounces withdrew consent; CSV bypassed double opt-in and had no approval; reviewer-separation bypasses; approval not bound to audience; stale snapshot after reject; automation preflight and Reply-To; personal aliases as brand senders; schedule truncation; stale resume; frequency cap; retry crash-loop; non-monotonic delivered metric; early replies unattributed; provider suppression not mirrored; no lease heartbeat; pause/resume races; legacy link validation; manual re-grant of withdrawn consent.
- **§15:** HR deactivation didn't revoke Mail; forwarding for inactive owners; HR delete 500; silent request reassignment; sender-grant approval bypass (send as CEO); unchecked ticket links; Help Email field mismatch; global IP limit on webhooks/product events; HealthNet classification by product name; clinical free text in alerts; event race; nav/layout not permission-driven. Mail preferences added (migration 36).

## F. Code-level exceptions (not implemented)

1. Transactional-vs-marketing template flag (needs a schema column).
2. Provider re-subscribe after a confirmed double opt-in (adapter contract has no call; contact stays withdrawn at the provider).
3. Marketing spend and provider-quota metrics in campaign reports.
4. Automation test and replay endpoints; recipient-timezone delays.
5. Retry of failed storage removals (needs a pending-removals table).
6. IT quarantine list view (only per-attachment rescan exists).
7. Explicit SPF/DKIM/DMARC/reputation checks inside marketing preflight; template dark-mode/mobile QA tooling.
8. RFC header fidelity for mixed internal/external sends (§B 11.8; provider-limited, needs a decision).

## G. Section 22 acceptance matrix

| Scenario | Gate | Offline | Live |
|---|---|---|---|
| Staff A opens Staff B private inbox | Critical | PASS | not run |
| SUPER without break-glass | Critical | PASS | not run |
| Removed from shared mailbox mid-session | Critical | PASS | not run |
| Non-owned From / ceo@ | Critical | PASS (incl. new sender-grant approval test) | not run |
| Alias + primary, one login | High | PASS | not run |
| Gmail round trip with thread + attachment | Critical | PASS (fake provider) | **not run** |
| Outlook/Yahoo/iCloud | High | n/a | **not run** |
| Webhook replay / duplicate svix-id | Critical | PASS | **not run** |
| Webhook body modified | Critical | PASS | **not run** |
| Accepted then worker crash | Critical | PASS (incl. in-flight tracking) | not run |
| Ambiguous timeout | Critical | PASS | **not run** |
| 50 MB / malicious attachment / script HTML | Critical | PASS (+ real clamd locally) | **not run** |
| External To + internal CC/BCC | Critical | PASS (header limitation §F.8) | **not run** |
| Unprovisioned local address | High | PASS | **not run** |
| HealthNet Main DB offline | Critical | PASS (earlier probe; no main-DB use added) | not run |
| Existing Help/Marketing/Social parity | Critical | PASS (full backend suite) | not run |
| CSV without verified consent | Critical | PASS (now preview + approver) | not run |
| Cross-brand campaign | Critical | PASS | not run |
| Unsubscribed/complained contact in segment | Critical | PASS | **not run** |
| Content changed after approval | Critical | PASS (+ audience binding) | not run |
| Cancel while queued | High | PASS | **not run** |
| Staging deployment without migration | Critical | PASS (pre-migration tests for 35 and 36) | API live with Mail off: ready 200 |
| Restore backup and search/archive | High | PASS (disposable copy) | **not run** |
| Keyboard/mobile/screen reader | High | PASS (axe, mobile) | manual audit pending |

## H. Exact hand-off for the blocked live work

Do these in order on staging only. Nothing here was done.

1. **Database (DB owner).** Back up the shared staging Admin DB (`docs/cosmicforge-mail-staging-migration-runbook.md` §2), confirm `npm run db:admin:guard` targets the staging Admin DB (never HealthNet/Karryam), check the ledger for orders 27-36, apply the missing ones in order per the runbook, then `npm run db:schema:assert` and `GET /api/mail/v1/health/ready`. Rollback SQL for each step is in `docs/sql/`.
2. **Infrastructure.** Staging bucket + KMS key + scanner, then set `MAIL_STORAGE_PROVIDER=s3`, `MAIL_S3_*`, `MAIL_KMS_PROVIDER=aws-kms`, `MAIL_KMS_*`, `MAIL_ENCRYPTION_KEYS` (KMS-wrapped, `npm run mail:kms:generate-data-key`), `MAIL_SCANNER_PROVIDER=clamd`, `MAIL_CLAMD_*`. Validate with `npm run mail:config:validate`, then run against the real endpoints: `MAIL_S3_LIVE_ENDPOINT=… MAIL_KMS_LIVE_KEY_ID=… npm run test:mail:s3-kms-live` and `MAIL_CLAMD_LIVE_HOST=… npm run test:mail:clamd-live`.
3. **Resend (account owner).** Staging-scoped API key, webhook endpoint `https://stagingca.cosmicforge-healthnet.com/api/mail/v1/webhooks/resend` with its signing secret (`RESEND_WEBHOOK_SECRET`), receiving route for one dedicated test address only. Confirm the attachment download hosts for `RESEND_ATTACHMENT_HOST_ALLOWLIST`.
4. **Domain (domain owner).** An approved isolated test subdomain; SPF/DKIM/DMARC; MX or forwarding for the test address only; **no change to `karryam.com` root MX**. Then `MAIL_DOMAIN_ALLOWLIST=<test domain>`.
5. **Worker.** Deploy `npm run mail:worker` as its own process with `MAIL_WORKER_ENABLED=true` only after steps 1-4 report ready; enable `MAIL_ENABLED`, then `MAIL_RECEIVING_ENABLED`, then `MAIL_SENDING_ENABLED` for the pilot cohort only (M10 rollout rules).
6. **Live outbound/inbound.** Gmail and Outlook test accounts (owner-approved): send, reply, attachment, CC/BCC to two local mailboxes; confirm the custom Message-ID survives (threading) and record provider acceptance separately from inbox placement.
7. **Live webhook security.** Replay a delivery, modify a body (expect 401, nothing enqueued), run reconciliation.
8. **Ambiguous send / cancel-while-queued** against the real provider.
9. **Attachments.** EICAR with official signatures; scanner outage; quarantine release.
10. **Body search** only after its approval.
11. **Backup/restore and rollback drill** on a disposable copy of the staging DB.
12. **Marketing.** Test send to staff; one approved campaign to a consented internal list; unsubscribe and complaint handling; reply counted; one controlled automation (signup → consent → trigger → step → send → event → report) and a withdrawal before the next step.
13. **Authenticated staging browser session** with test accounts for EMPLOYEE/ADMIN/EXECUTIVE/SUPER, shared-mailbox member, marketer, mail admin and a revoked user.

## I. Approvals still required (none recorded)

| Approval | Owner | Unblocks |
|---|---|---|
| Backup + apply migrations 27-36 to shared staging DB | DB owner | Workstream 1 |
| Bucket, KMS, scanner, secrets | Infrastructure / DevOps | Workstream 2 |
| Resend test domain, keys, webhook, receiving route | Resend account owner | Workstreams 3-4 |
| SPF/DKIM/DMARC/MX for the test subdomain only | Domain owner | Workstream 3 |
| Test recipient accounts (Gmail, Outlook, Yahoo, iCloud) | Product / IT | §11.7 |
| Body search confidentiality; raw MIME retention | Security + privacy | §12 |
| DSAR scope and erasure semantics | Legal / DPO | §12 |
| Retention periods, consent sources, GDPR transfers | Legal / privacy | §12-13 |
| Presigned vs proxy upload decision | Security | §12 |
| Mixed-recipient header limitation | Product + Security | §11.8 |
| Karryam Go consumer of the HQ contract | Karryam engineering | §15 |
| HealthNet alert code catalogue | HealthNet owner | §15 |
| Manual screen-reader audit, design sign-off | Accessibility / design | §16.2 |
| Production pilot go/no-go | Leadership | separately authorized |

## J. Section 26 definition of done

| Item | Status |
|---|---|
| Placement | Met (code) |
| Control | Met (code), owner-approved domain inventory missing |
| Correctness (real round trips on staging) | **Not met**: live tests not run |
| Privacy (incl. SUPER, offboarding, retention) | Met offline; live and legal sign-off missing |
| Marketing | Met offline (exceptions §F); live broadcast missing |
| Resilience | Met offline; live outage tests missing |
| Security (signed webhook, AV, sanitization, secrets, MFA, code scanning, privacy sign-off) | Code met; privacy/security sign-off missing |
| Operations (runbooks, metrics, rollback rehearsal, encrypted backups, on-call) | Runbooks and drills offline; live rehearsal and on-call ownership missing |
| Change management | Staging CI green expected; DNS/rollout sign-offs missing; production and `main` untouched |

## K. Earlier sections (1-10, 16-21, 23-25, 27)

Re-checked against the code changed in this round. The M1-M10 traceability in
`docs/cosmicforge-mail-m1-m10-completion-report.md` Appendix A still holds, with these updates:
§1.2/§5.1 gained Reply-To and preferences; §5.4/§15 HR offboarding is now automatic;
§7 sender-grant approvals are validated; §8 adds migration 36; §9 adds DSAR, preferences and
import/approval fields to OpenAPI (generated client in sync); §16 navigation is permission-driven;
§17 the raw webhook/integration paths bypass the global limiter; §19.2 adds the new authorization
tests; §20 adds the marketing lease heartbeat and in-flight send tracking; §21.3 rollback covers
migration 36. M0 sign-offs remain open; M1-M9 exit criteria are met in code; M10 (pilot) is not
started because it depends on the blocked workstreams.
