# CosmicForge Mail: final gap closure and staging acceptance report

Date: 2026-10-26. Branch: `staging` only (no new branches, no PRs, no force-push; `main` and production untouched).
Specification: "CosmicForge Mail Implementation Specification" v1.0 (24 Oct 2026, sections 1-27).
Starting commit: `d3f1d1da62115b0901daf34d09e9e3e624f21286`. Supersedes the previous version of this report (same path).

## Final decision: **DEVELOPMENT COMPLETE, LIVE ACCEPTANCE BLOCKED**

All eight code-level gaps from the previous report are implemented, tested offline and pushed to `staging`
(migration 37). A re-audit of sections 11-15 after the gap closure found about 20 more defects; all are fixed
with regression tests. The Karryam Go **HQ side** is complete; the Karryam **product side** does not exist and
the KarryGo repository was not modified (no owner authorization).

Live acceptance is still blocked. This environment has no staging database credentials, no Resend account,
no DNS access, no staging bucket/KMS/scanner and no SSH, and no owner approvals were given. No database
writes, DNS changes, real sends or paid services were made. Nothing that needs the live environment is marked PASS.

Exceptions that stay open even after live access (each needs an owner decision, §I):
- **Gap 8 (mixed recipients):** `full-headers` mode is built but stays off. It needs product/security approval,
  a receiving cutover and a live check that Resend preserves headers. An external Cc next to an internal To
  cannot be attributed per recipient, because Resend echoes only To.
- **Gap 2 (provider re-subscription):** Resend documents only `unsubscribed: true`. The API path is off by
  default; the supported path is an audited manual confirmation.
- **Gap 3 (spend):** costs are estimates from approved pricing rows. Billed spend is UNAVAILABLE because
  Resend has no billing API.

## Twelve explicit answers

| # | Question | Answer |
|---|---|---|
| 1 | Are all eight gaps implemented? | **Yes** (§F). Gap 8 is implemented but not accepted (needs approval + live check) |
| 2 | Does each gap have automated tests that pass in the CI environment? | **Yes.** `test:mail` 398/398, S3 30/30, full backend 1379 pass / 0 fail / 3 skip, Playwright 148 pass / 0 fail |
| 3 | Is every §11-15 requirement complete in code? | **Yes**, with the provider-limited exceptions above (§B) |
| 4 | Is the Karryam Go integration complete? | **HQ side yes; product side no.** No publisher exists in KarryGo; repository not modified (§G) |
| 5 | Is migration 37 safe on a database that has not run it? | **Yes.** Every new table is gated by a readiness probe; `mail-pre-gap-migration` proves old behaviour; CI deploy succeeded with Mail off |
| 6 | Were migrations applied to the shared staging database? | **No.** No credentials or DB-owner approval; ledger unreadable |
| 7 | Are the five staging workstreams complete? | **No.** All five BLOCKED (§A) |
| 8 | Did any real email send/receive or broadcast happen? | **No.** No provider, domain or approved recipients |
| 9 | Were DNS, root MX or production sender settings changed? | **No** |
| 10 | Are the required security, privacy, DB, domain and product approvals recorded? | **No.** None received (§I) |
| 11 | Is CI green and is staging deployed with Mail off? | **Yes** (§D): CI green, staging API ready with `enabled:false`, frontend 200 |
| 12 | Is §26 definition of done met / is the project fully accepted? | **No.** Live correctness, approvals and live rehearsals are missing (§K) |

---

## A. Five-workstream status

| Workstream | Status | Evidence | Outstanding blocker (owner) |
|---|---|---|---|
| 1. Staging database | **BLOCKED** | Live `GET /api/mail/v1/health/ready` → `{"ready":true,"enabled":false}`; the shared DB's migration state cannot be read through the API. Offline: 37 migrations, manifest 0 checksum failures, safety 0 findings, replay drift none, rollback drill ok (37→27 and roll-forward), backup/restore verify ok (130 tables, 0 mismatches) on a disposable copy | No DB credentials, no DB-owner approval. Steps in §J.1 (**DB owner**) |
| 2. Infrastructure | **BLOCKED** | Real clamd daemon: `test:mail:clamd-live` 1/1 (local EICAR signature; official signature download blocked here). Real S3/KMS protocol (moto): `test:mail:s3-kms-live` 1/1. `mail:config:validate` (staging profile) no violations | No bucket, KMS key, scanner host, Resend key or worker host; sandbox AWS credentials rejected (`InvalidClientTokenId`) (**Infrastructure**, **Resend owner**) |
| 3. Domain & receiving | **BLOCKED** | Offline only: signed webhooks, duplicate svix-id, unknown-recipient handling, signed-origin echo dedup (gap 8) | No approved test domain, no DNS, no receiving route. Nothing changed (**Domain owner**, **Resend owner**) |
| 4. End-to-end features (§11-15) | **Code complete offline; live BLOCKED** | §B, §F; re-audit fixes §H | Needs workstreams 1-3 and approved test recipients |
| 5. Security & operations | **Code complete offline; live BLOCKED** | Secret scan 804 files 0 findings; network-guard static ok; quarantine UI, deletion queue, quota/pricing panels; Playwright desktop + mobile with axe | No authenticated staging session, live monitoring or live restore/rollback rehearsal (**DevOps**, **Security**) |

## B. PDF sections 11-15, requirement by requirement

Paths are under `services/central-admin-api/src/modules/mail/` unless stated; web paths under `apps/central-admin-web/src/`.
"Live" = needs the staging environment; none of them could run (§A). Rows changed in this round reflect the final gap closure and the re-audit.

### Section 11: Outbound mail

| Req | Code | Automated test | Observed | Status | Live / approval |
|---|---|---|---|---|---|
| 11.1 Send only through authorized mailbox + identity; status, membership, grant, domain, caps, quota, content policy; re-checked at dispatch | `authz/mail.policy.js`, `authz/sending-gate.js`, `services/compose.service.js` (`sendDraft`, `assertContentPolicy`, quota under advisory lock), `pipelines/outbound.processor.js` (`assertStillAuthorized`, org quota re-check) | `mail-postgres` M1/remediation, "staff send policy", "org quota"; unit "staff content policy" | Spoofed/ungranted From refused + audited; queued mail now counts toward quota; suppressed recipients, unsafe links, oversize messages refused | **PASS (offline)** | Live §J.6 |
| 11.2 Durable queued message, immutable snapshot, stable idempotency key, 202 | `compose.service.js`, `http/mail.routes.js` | `mail-postgres` "send returns 202…", "staff send policy" (key reuse 409, concurrent same key → same message) | | **PASS (offline)** | — |
| 11.3 Resend `/emails`: From, Reply-To, To/CC/BCC, Message-ID, In-Reply-To, References, HTML/text, attachments, provider id, audit | `outbound.processor.js`, `adapters/resend.adapter.js`; Reply-To from granted identities (`replyToAddressId`, compose picker) | unit Resend adapter tests; `mail-postgres` threading | Reply-To was never set before this round: fixed | **PASS (offline)**; provider preservation of custom Message-ID **unverified** | Live §J.6: confirm Resend keeps our Message-ID (threading and echo dedup depend on it) |
| 11.4 Recipient-level events incl. suppressed and unknown | `pipelines/delivery-event.processor.js` (shared `aggregateMessageStatus`, `attribute()`, `reapplyUnmatched`) | `mail-postgres` "attribution" block, unit "message status derivation" | Fixed: `email.suppressed` ignored; Cc/Bcc mis-attribution; early events lost; status regressing to QUEUED | **PASS (offline)** | Live §J.5 |
| 11.5 Retries, 429/5xx/timeout, ambiguous, crash, same key, no duplicates | `outbound.processor.js` (`inFlight`/`ambiguous` per batch, plan-driven dispatch) | `mail-postgres` "dispatch follows the batch plan", "earlier ambiguity survives", ambiguity/window tests | Fixed: a later batch could be silently never sent; a dead-letter after an ambiguous attempt said "failed" and invited a duplicate | **PASS (offline)** | Live §J.6 |
| 11.6 UI: Queued / Provider accepted / Delivered to receiving server / Failed / Unknown; never "read" | `components/mail/mail-utils.ts`, `MessageCard.tsx`, `ComposeEditor.tsx` | Playwright compose/thread specs | Fixed: internal copies showed "Delivered" for external recipients; open/click hidden for private mail | **PASS (offline)** | — |
| 11.7 Gmail/Outlook/Yahoo/iCloud | provider-neutral | — | | **NOT TESTED** | Live §J.6 with owner-approved test accounts |
| 11.8 One internal delivery path; mixed recipients; BCC privacy | `compose.service.js`, `outbound.processor.js` (`buildDeliveryPlan`), `security/origin-header.js`, `inbound.processor.js` echo dedup; `docs/cosmicforge-mail-mixed-recipients.md` | `mail-mixed-recipients-unit` (7), `mail-mixed-recipients-postgres` (incl. re-audit 4, 5); `mail-postgres` BCC tests | Gap 8: `full-headers` mode gives external recipients the full visible To/Cc, never internal Bcc, one local copy per internal mailbox, signed-origin echo dedup, provider Message-ID aliases. Default stays `external-only`; `full-headers` also needs `MAIL_RECEIVING_CUTOVER_CONFIRMED=true`. External **Cc** next to an internal To cannot be attributed per recipient (Resend echoes only To) | **Implemented; not accepted** (exception needs product/security approval + receiving cutover + live check) | Live: header/Message-ID preservation, echo dedup |

### Section 12: Attachments, rendering, search, storage, retention

| Req | Code | Automated test | Observed | Status | Live / approval |
|---|---|---|---|---|---|
| Private bounded upload | `http/mail.routes.js` multer limits; `compose.service.js` | m9 "a1" | Fixed: unbounded form fields. **Presigned upload:** the authenticated API proxy is kept. It is private, bounded (10-25 MB), scanned before persistence and never exposes storage URLs; a presigned flow adds a scan-after-upload state machine without a security gain at these limits. Revisit above 25 MB. | **PASS (offline)**; design decision recorded | Security sign-off on the proxy decision |
| Encryption, checksum, integrity, no public URLs | `storage/*`, `security/kms-keyring.js` | S3 mode 30/30; `test:mail:s3-kms-live` | Storage health-probe defect fixed | **PASS (offline + local real protocol)** | Live bucket/KMS §J.2 |
| AV scan before availability, quarantine, fail closed | `scanning/attachment-scanner.js`, `inbound.processor.js` | clamd-live (real daemon); unit + m9 "a4" | Fixed: size/type policy failures were labelled malware and quarantined whole messages | **PASS (offline + local real clamd)** | Live clamd with official signatures §J.2 |
| Inline images (cid), Content-Disposition, raw .eml | `services/mailbox.service.js` `inlineImages`, `message-archive.service.js` | m9 "b1", "b2" | Fixed: raw .eml downloadable with unscanned attachments; clean inline images never shown | **PASS (offline)** | — |
| Received attachment URL expiry / SSRF | `adapters/resend.adapter.js` (`readCapped`, redirects refused, host allowlist) | unit "c1" | Fixed: full buffering before size check | **PASS (offline)** | Confirm Resend owns all subdomains of the allowlisted hosts |
| Sanitized HTML, JS/SVG blocked, remote images blocked, links, phishing, SSRF, SPF/DKIM/DMARC banner | `security/html-sanitizer.js`, `SafeHtmlFrame.tsx`, `MessageCard.tsx` | unit "d1"; `e2e/safe-html` | Fixed: four CSS tracking-image bypasses; frame CSP now `img-src data:` unless the user allows images; suspicious links flagged | **PASS (offline)** | — |
| Search From/To/subject/date/label/body; membership in SQL; cursor | `services/mailbox.service.js` `search`, `MailSearch.tsx` | m9 "e1-e3"; gap-closure body search | Fixed: index-defeating filter, unstable cursor, label-only search 400, unescaped LIKE | **PASS (offline)**; body search **off** | Body search needs security/privacy approval |
| Retention, legal hold, shared objects, deleted content, orphans | `ops/retention.processor.js` | m9 "f1+f2", shared-object test | Fixed: user-deleted threads never purged; orphan objects never removed; replies landed in deleted threads | **PASS (offline)** | Retention periods (legal) |
| GDPR DSAR access/deletion | **new** `services/dsar.service.js`, `POST /admin/dsar/export`, `/admin/dsar/erasure` | `mail-dsar-postgres` (5) | Mail admin + MFA (`MAIL_DSAR_EXPORT` / `MAIL_DSAR_ERASURE`), reason required, dry run default, legal holds skipped, audited by address hash only | **PASS (offline)** | Legal/DPO sign-off on scope |
| Encrypted backup, restored searchable data | `scripts/mail/verify-backup-restore.js` | `mail:backup:verify` ok (130 tables) | Disposable local copy | **PASS (offline)** | Live §J.11 |

### Section 13: Marketing lifecycle

| Req | Code (`marketing/`) | Automated test | Observed / fixed | Status | Live / approval |
|---|---|---|---|---|---|
| 13.1 Legacy campaigns/templates intact; EventView untouched; subnav | `marketing.service.js`, `MarketingSubNav.tsx` | m7, m6 tests | Fixed: unvalidated `legacyCampaignId` (500 on non-UUID); legacy template list gated by section grant (legacy rows have no brand column) | **PASS (offline)** | — |
| 13.2(1) Brand, authorized From/Reply-To | `marketing-sender.js` | m13/14 block | Fixed: a person's alias could be used as a brand sender; Reply-To must reach a SHARED mailbox | **PASS (offline)** | — |
| 13.2(2) Consent audience; CSV with provenance and operator approval | `marketing.service.js` `importCsv`, `ContactsPanel.tsx` | m6 consent test (preview → different approver commits), m13/14 | Fixed: import bypassed double opt-in and had no approval step; file SHA-256 + name stored | **PASS (offline)** | Consent sources (legal) |
| 13.2(3) Versioned editor, preview, QA | `template-renderer.js`, `preflight.js` `runTemplateQa`, `TemplateQaPanel.tsx` | `mail-templates-preflight-*`; `e2e/marketing-template-qa` | Gap 7: desktop/mobile/dark/plaintext/locale previews, brand tokens, accessibility (alt, link text, WCAG AA contrast, lang, headings), missing personalization, unsafe links, client-compatibility lint (heuristics; previews do not prove every client) | **PASS (offline)** | Design sign-off |
| 13.2(4) Preflight | `marketing/preflight.js`, `marketing.service.js` | `mail-templates-preflight-*`, re-audit tests | Gap 7: PASS/WARNING/BLOCKED/UNKNOWN; provider domain verification in the brand's own marketing account (else UNKNOWN), SPF/DKIM/DMARC (UNKNOWN when not reported), hard-bounce/complaint reputation, provider quota, link tracking, unsubscribe, identity, plaintext consistency, approvals; approval binds the preflight hash | **PASS (offline)** | Live provider data |
| 13.2(5) Distinct reviewer, MFA, exact content, audience | `marketing.service.js` approve | m13/14; `e2e/marketing-approval` | Fixed: template authors and intermediate editors could approve; approval now binds `contactSetSha256`; reject bumps revision | **PASS (offline)** | — |
| 13.2(6-7) Eligible-only sync, Broadcasts, schedule/pause/cancel | `broadcast.processor.js`, `broadcast.service.js`, `jobs/mail-worker.js` | m7 | Fixed: no lease heartbeat (duplicate dispatch risk); pause/resume races | **PASS (offline)** | Live broadcast §J.12 |
| 13.2(8) Bounce/complaint/unsubscribe/engagement; suppression before every send | `marketing-events.processor.js`, `consent-enforcement.js` | m7, m13/14 | Fixed: **any bounce withdrew all consents**; provider suppression not mirrored | **PASS (offline)** | Live §J.12 |
| 13.2(9) Replies to marketing inbox | `campaign-replies.js` | gap-closure, m13/14 | Fixed: replies during sending never attributed | **PASS (offline)** | Live §J.12 |
| 13.3 Metrics | `broadcast.service.js`, `ops/pricing.service.js`, `ops/provider-quota.service.js`, `CampaignCostPanel.tsx` | m7, `mail-resubscribe-pricing-*` | Gap 3: estimated spend from approved pricing (fixed at send, UNAVAILABLE without pricing, billed spend UNAVAILABLE: no provider billing API); provider quota from `x-resend-*-quota` headers and configured limits (UNKNOWN otherwise); denominators, windows, "events still arriving" | **PASS (offline)** | Live provider headers |
| 13.4 Consent rules, provider re-subscription | `marketing.service.js`, `resubscription.service.js` | m7, `mail-resubscribe-pricing-*` | Gap 2: provider state per contact; re-subscription only after a new verified double opt-in, approver + step-up, one guard re-checked before the provider call; complaints/hard bounces/suppressions/shared provider accounts refused. Resend documents `unsubscribed:true` only, so the API path is behind `MAIL_MARKETING_PROVIDER_RESUBSCRIBE_ENABLED=false`; default is UNSUPPORTED + audited manual confirmation | **PASS (offline)**; provider path needs Resend confirmation | Resend support / owner |

### Section 14: Automations and templates

| Req | Code | Test | Observed / fixed | Status |
|---|---|---|---|---|
| Triggers, delays, branches, versioning, enrollment caps, pause/resume/cancel, idempotency, restart recovery | `marketing/automation/*` | m7, m13/14 | Fixed: engagement branches always false; schedule silently truncated at 1000; stale occurrence on resume; frequency cap ignored own sends; retry crash-loop | **PASS (offline)** |
| Consent/suppression before every send | `automation.processor.js` | m7 "withdrawal before next step" | | **PASS (offline)** |
| Automation preflight and Reply-To | `automation.service.js` `preflightSteps` | m13/14 | Fixed: automations skipped link scan/domain checks; Reply-To was null | **PASS (offline)** |
| Timezone/DST | `scheduling.js`, `definition.js`, `automation.processor.js` | `mail-automation-timezone-unit` (10), test-replay postgres | Gap 4: recipient/brand/IANA zones, DST gaps shifted forward, ambiguous times (both occurrences), windows, missed windows send once, validated contact time zones (API + CSV) | **PASS (offline)** |
| Testing and replay routes | `automation-test.service.js`, `automation-replay.service.js`, `AutomationTestPanel.tsx`, `AutomationReplayPanel.tsx` | `mail-automation-test-replay-postgres` (14), `e2e/mail-automation-test-replay` | Gap 4: test mode writes nothing and sends nothing; replay dry-run/execute with approver + step-up, one execution per step run, no re-send of accepted mail, key reuse inside the provider window | **PASS (offline)** |
| Templates: transactional vs marketing policy | `template-policy.js`, `template-renderer.js`, migration 37 tables | `mail-templates-preflight-*` | Gap 1: MARKETING / TRANSACTIONAL / TRANSACTIONAL_SECURITY with append-only version snapshots; classification needs approver + step-up; transactional versions refused for marketing at create, approve and dispatch; security templates stricter, separately approved | **PASS (offline)** |
| Live controlled workflow (signup → send → event → report) | — | — | — | **NOT TESTED** (live §J.12) |

### Section 15: HR, IT, Support, Marketing, Profiles, products

| Contract | Code | Test | Observed / fixed | Status | External |
|---|---|---|---|---|---|
| HR / AdminUser | `shared/mail/mail-lifecycle.js`, `hrm/*`, `admin-users.service.js`, `mail-admin.service.js` | `mail-audit-fixes-postgres`, `mail-hr-lifecycle-postgres` (8) | Offboarding on every disable path (HR accounts, HR employment, admin-user deactivate); reactivation restores nothing; HR onboarding can file one PENDING work-email request (IT approves). Login lockout deliberately does not offboard | **PASS (offline)** | HQ Mail organization must be COMPANY kind for default domain selection |
| IT & System | `components/it/*`, `services/quarantine.service.js`, `MailQuarantine.tsx`, `ProviderQuotaPanel.tsx` | `mail-quarantine-postgres` (12+), `e2e/mail-quarantine` | Gap 6: quarantine list/filter/detail with safe metadata only, rescan (never releases), release with clean evidence + step-up, reject/delete via the deletion queue, append-only decisions; provider quota and pricing panels | **PASS (offline)** | — |
| Help & Support | `services/support.service.js`, `help/email/page.tsx` | audit-fixes | Fixed: ticket links unchecked; open/overdue counts never shown. Ticket existence can't be checked without HealthNet DB (by design) → `ticketRefVerified:false` | **PASS (offline)** | — |
| Marketing | email-marketing UI | m7, e2e | | **PASS (offline)** | — |
| Profiles | **new** `services/preferences.service.js`, `MailPreferences.tsx`, migration 36 | `mail-preferences-postgres`, `mail-pre-preferences-migration`, `e2e/mail-preferences` | Default sender + new-mail notifications. Delegation is direct by the mailbox owner (no request step) | **PASS (offline)** | DB owner applies migration 36 |
| Karryam Go | `integrations/*` incl. `karryam-compat.js`, `event-registry.js` | m8, `mail-karryam-contract` (14, vectors signed by the real KarryGo Go code) | HQ side complete (see §C). **No Karryam-side publisher exists** | **HQ PASS; product NOT INTEGRATED** | Karryam engineering |
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
| Karryam integration | **Not run**: no Karryam publisher exists (HQ side tested against vectors signed by the real KarryGo code) |
| HealthNet restrictions | **Not run live** (offline PASS) |
| Quarantine release / storage-deletion retry | **Not run live** (offline PASS) |
| Provider quota / spend reporting | **Not run live**: no provider headers (offline PASS) |
| Emergency stop | **Not run live** (offline PASS, `m10`) |
| Backup/restore | **Not run on staging**; disposable local copy PASS |

## D. Deployment and code evidence

| Item | Value |
|---|---|
| Starting commit | `d3f1d1d` |
| Commits this round | `1e92c05`, `466499c`, `cee2ac0`, `70af7a2`, `c993df3`, `94f6e52`, `78243a7` (migration 37 + gaps), `78d7834` (routes/OpenAPI/config), `92bab1f` (§15 re-audit), `3a076e9` (§11-12 re-audit), `492538d` (§13-14 re-audit), then this docs commit |
| Migration status | 37 prepared (35, 36 and 37 since the last known ledger). **Not applied** to the shared staging DB by this work; the ledger is unreadable without credentials |
| Staging API (live probe) | `https://stagingca.cosmicforge-healthnet.com/api/mail/v1/health/ready` → 200 `{"ready":true,"enabled":false}` after the deploys |
| Staging frontend (live probe) | `https://centralize-admin-staging.vercel.app` → 200; Mail/IT/Marketing routes redirect unauthenticated users to login |

CI (all `success`):
- `78d7834`: Social Operations CI staging.yml (incl. staging API deploy) [40294185532](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40294185532); Frontend CI [40294185622](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40294185622); Social Operations CI [40294185503](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40294185503); Monorepo CI [40294185502](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40294185502).
- `92bab1f`: staging.yml [40296351105](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40296351105); Frontend CI [40296351139](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40296351139); Social Operations CI [40296351170](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40296351170); Monorepo CI [40296351098](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40296351098).
- `492538d`: staging.yml [40298609856](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40298609856); Frontend CI [40298609722](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40298609722); Social Operations CI [40298609921](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40298609921); Monorepo CI [40298609861](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40298609861).

Test totals on `492538d` (offline, PostgreSQL 16, `NODE_ENV=test` as in CI):

| Suite | Result |
|---|---|
| `npm run test:mail` | 398 / 398 pass |
| `test:mail:s3` | 30 / 30 pass |
| Full backend `npm test` (migrated DB) | 1382 tests: 1379 pass, 0 fail, 3 skip (no IPv6 loopback; live clamd/S3 not in the default run) |
| `test:mail:clamd-live` / `test:mail:s3-kms-live` | 1 / 1 and 1 / 1 pass (local real daemon / moto) |
| Manifest / safety / replay | 37 migrations, 0 checksum failures, 0 safety findings, drift none |
| Rollback drill / backup verify | ok / ok (130 tables, 0 mismatches) |
| Secret scan / network-guard static / `config:validate:staging` | 804 files 0 findings / ok / ok |
| Generated client drift (`mail:client:check`) | ok |
| Web `tsc` / ESLint / `next build` | clean / 0 errors / ok |
| Playwright desktop + mobile (mocked API, axe) | 148 pass, 16 skip (pre-existing project skips), 0 fail |

## E. Defects fixed in the previous round (still covered by tests)

Found by auditing §11-15 against the code (not by the existing suites). Each has a regression test.

- **Outbound (§11):** batch silently never sent after an earlier batch's event; dead-letter forgot an ambiguous attempt (duplicate risk); status regression to QUEUED; `email.suppressed` ignored; Cc/Bcc event mis-attribution; early events lost; queued mail bypassed org quota; racy quotas; suppressed recipients not checked; no content policy or total size limit; no Reply-To; false "Delivered" on internal copies; open/click shown on private mail; idempotency key reuse across drafts.
- **§12:** four CSS tracking bypasses; unbounded multipart fields; policy failures labelled malware; unbounded download buffering; raw .eml bypassed quarantine; inline images broken; search index/cursor/label/LIKE defects; deleted content never purged; orphan objects; replies into deleted threads; storage health probe wrong with a prefix. DSAR added.
- **§13-14:** bounces withdrew consent; CSV bypassed double opt-in and had no approval; reviewer-separation bypasses; approval not bound to audience; stale snapshot after reject; automation preflight and Reply-To; personal aliases as brand senders; schedule truncation; stale resume; frequency cap; retry crash-loop; non-monotonic delivered metric; early replies unattributed; provider suppression not mirrored; no lease heartbeat; pause/resume races; legacy link validation; manual re-grant of withdrawn consent.
- **§15:** HR deactivation didn't revoke Mail; forwarding for inactive owners; HR delete 500; silent request reassignment; sender-grant approval bypass (send as CEO); unchecked ticket links; Help Email field mismatch; global IP limit on webhooks/product events; HealthNet classification by product name; clinical free text in alerts; event race; nav/layout not permission-driven. Mail preferences added (migration 36).

## F. Gap closure (Phase 1)

All new tables are in migration 37 `prisma/manual-migrations/20261103_mail_final_gap_closure.sql`
(sha256 `70952bf8a685cfe04e230b522fa103f343cdacd36c97c25b1dba5f04f350d8e6`, new tables only, no change to existing
tables). Rollback: `docs/sql/cosmicforge-mail-final-gap-closure-rollback.sql`; runbook row 37. Every use is gated by the
`finalGapFeature` readiness probe (`MAIL_FINAL_GAP_REQUIREMENTS`). Before migration 37, new endpoints answer
`503 MAIL_FEATURE_NOT_READY` and existing paths behave as before (`tests/mail-pre-gap-migration.test.js`).

| # | Requirement | Previous gap | Implementation | Automated test | Live verification | Final result |
|---|---|---|---|---|---|---|
| 1 | Transactional vs marketing templates (§13-14) | No template-level classification | `marketing/template-policy.js`; classification MARKETING / TRANSACTIONAL / TRANSACTIONAL_SECURITY with append-only per-version snapshots; checked at create, approve and dispatch | `mail-templates-preflight-unit` 13/13, `mail-templates-preflight-postgres` 12/12 | Not needed beyond staging smoke | **PASS (offline)** |
| 2 | Provider re-subscription after DOI (§13.4) | Contact stayed unsubscribed at Resend | `marketing/resubscription.service.js`; provider state per contact; approval + step-up after a new verified DOI; one guard re-checked before the provider call | `mail-resubscribe-pricing-unit` 10/10, `-postgres` 15/15 | Needs Resend confirmation that `unsubscribed:false` is supported | **PASS (offline)**; provider path **EXCEPTION** (flag off) |
| 3 | Spend and quota reporting (§13.3) | Not reported | `ops/pricing.service.js`, `ops/provider-quota.service.js`; quota-exhausted sends defer without consuming attempts (outbound, automation, test sends) | same suites + `mail-postgres` q8, `mail-m7-postgres` quota tests | Needs live `x-resend-*` headers | **PASS (offline)**; billed spend **UNAVAILABLE** |
| 4 | Automation test, replay, timezone (§14) | No test/replay routes; fixed-duration delays only | `automation-test.service.js`, `automation-replay.service.js`, `scheduling.js`, `definition.js`; contact time zone validation (API 422, CSV `INVALID_TIMEZONE`) | `mail-automation-timezone-unit` 10/10, `mail-automation-test-replay-postgres` 14/14 | Live controlled automation (§J.12) | **PASS (offline)** |
| 5 | Durable storage-deletion retry (§12) | Failed removals were lost | `ops/storage-deletion.service.js`: enqueue in the same transaction, SKIP LOCKED claim, reference + legal-hold re-check, backoff, DEAD state, `STORAGE_DELETION_RUN` job; retention, DSAR and quarantine delete use it | `mail-storage-deletion-postgres` 18/18 | Live bucket (§J.2) | **PASS (offline)** |
| 6 | IT quarantine UI (§15) | Rescan only | `services/quarantine.service.js`; `components/it/MailQuarantine.tsx`; append-only decisions | `mail-quarantine-postgres` 13/13, `e2e/mail-quarantine` | Live scanner (§J.9) | **PASS (offline)** |
| 7 | Deliverability preflight and template QA (§13.2) | No SPF/DKIM/DMARC/reputation checks, no QA tooling | `marketing/preflight.js` (PASS/WARNING/BLOCKED/UNKNOWN), `runTemplateQa`; `TemplateQaPanel.tsx`, `QaStatusBadge` | `mail-templates-preflight-*` | Live domain/provider data | **PASS (offline)** |
| 8 | Mixed-recipient header fidelity (§11.8) | External recipients saw only external To/Cc | `MAIL_MIXED_RECIPIENT_MODE=full-headers` (default `external-only`), `security/origin-header.js` HMAC, inbound echo dedup, provider Message-ID aliases (`mail_message_provider_ids`) | `mail-mixed-recipients-unit` 7/7, `-postgres` 19/19 | Needs approval + receiving cutover + live header check | **Implemented, not accepted (EXCEPTION)** |

### Per-gap detail

**Gap 1: templates.**
- Endpoints: `GET/PUT /marketing/{orgId}/templates/{templateId}/classification`; `POST …/versions/{versionId}/approve`.
- Tables: `marketing_template_policies`, `marketing_template_version_policies` (append-only).
- Frontend: `TemplateClassificationControl`.
- Step-up purposes `MARKETING_TEMPLATE_CLASSIFY` and `MARKETING_TEMPLATE_APPROVE`.
- Without a policy row a template stays MARKETING (old behaviour).
- No provider change.

**Gap 2: re-subscription.**
- Endpoints: `GET /marketing/{orgId}/resubscriptions`; `POST …/{id}/approve|refuse|confirm-manual`; `GET /marketing/{orgId}/contacts/{contactId}/provider-state`; `GET /marketing/{orgId}/provider-states`.
- Tables: `marketing_contact_provider_states`, `marketing_provider_resubscriptions` (one open request per contact).
- Frontend: `ResubscriptionsPanel`.
- Provider: an optional adapter call behind `MAIL_MARKETING_PROVIDER_RESUBSCRIBE_ENABLED=false`. Without it the request is UNSUPPORTED and needs an audited manual confirmation.
- Refused: complaints, hard bounces, suppressions, shared provider accounts.

**Gap 3: spend and quota.**
- Endpoints: `GET /admin/provider-quota`; `GET/POST /admin/pricing`; `PATCH/DELETE /admin/pricing/{id}`; `POST /admin/pricing/dispatch-costs/{dispatchId}/re-estimate`.
- Tables: `mail_provider_pricing`, `mail_provider_quota_observations`, `marketing_dispatch_costs`.
- Frontend: `CampaignCostPanel`, `OverviewSpendCard`, `ProviderQuotaPanel`.
- Provider: reads `x-resend-monthly-quota`, `x-resend-daily-quota`, `ratelimit-*` and `retry-after`; handles `daily_quota_exceeded` and `monthly_quota_exceeded`.
- Config: `MAIL_PROVIDER_DAILY_LIMIT` / `MAIL_PROVIDER_MONTHLY_LIMIT` (plus `__MARKETING_SHARED`).
- Exception: billed spend UNAVAILABLE; estimates only.
- Bug fixed: a quota-deferred batch kept its first-attempt time and turned OUTCOME_UNKNOWN after 23h.

**Gap 4: automations.**
- Endpoints: `POST /marketing/{orgId}/automations/{automationId}/versions/{versionId}/test`; `GET …/recovery`; `GET/POST …/replays`.
- Table: `marketing_automation_replays` (one EXECUTED replay per step run).
- Frontend: `AutomationTestPanel`, `AutomationReplayPanel`, `TimingFields`.
- No provider change. The idempotency key is reused inside the provider window.

**Gap 5: storage deletion.**
- Endpoints: `GET /admin/storage-deletions`; `POST …/{deletionId}/requeue|cancel` (cancel needs step-up `MAIL_STORAGE_DELETION_CANCEL`).
- Table: `mail_storage_deletions` (one open deletion per object key).
- Config: `MAIL_STORAGE_DELETION_*` (max attempts 12, backoff 30s to 6h, batch 100, lease 300s, interval 300s).
- Frontend: Operations panel.
- No orphan sweep that lists the bucket (not done; would need list permission).

**Gap 6: quarantine.**
- Endpoints: `GET /admin/quarantine`; `GET /admin/quarantine/messages/{id}` and `/attachments/{id}`; `POST messages/{id}/release|reject|delete`; `POST attachments/{id}/rescan|release|reject|delete`.
- Table: `mail_quarantine_decisions` (append-only).
- Frontend: `MailQuarantine.tsx` in the IT section.
- Shows safe metadata only. A rescan never releases; release needs clean evidence and step-up.

**Gap 7: preflight and QA.**
- Endpoint: `POST /marketing/{orgId}/templates/{templateId}/versions/{versionId}/qa`; preflight runs inside the existing campaign/automation preflight.
- Config: `MAIL_MARKETING_REPUTATION_*`, `MAIL_MARKETING_BOUNCE_*_BPS`, `MAIL_MARKETING_COMPLAINT_*_BPS`, `MAIL_MARKETING_PREFLIGHT_PROVIDER_TIMEOUT_MS`.
- Provider: reads domain verification from the brand's own marketing account. If that is not available the check reports UNKNOWN, never PASS.
- QA checks are heuristics. Previews do not prove rendering in every client.

**Gap 8: mixed recipients.**
- Config: `MAIL_MIXED_RECIPIENT_MODE`, `MAIL_ORIGIN_HEADER_SECRET`, `MAIL_RECEIVING_CUTOVER_CONFIRMED=false`.
- Table: `mail_message_provider_ids`.
- Docs: `docs/cosmicforge-mail-mixed-recipients.md`.
- No endpoint or UI change.
- `full-headers` refuses to activate unless the cutover flag is set.

## G. Karryam Go (Phase 2, reported separately)

| Item | Status |
|---|---|
| HQ contract compatibility | **Done**: `integrations/karryam-compat.js` accepts the KarryGo snake_case shape only for services listed in `MAIL_INTEGRATION_KARRYAM_COMPAT_SERVICES` (empty by default → `MAIL_INTEGRATION_LEGACY_SHAPE_NOT_ENABLED`); `event-registry.js`; idempotency fingerprint (`MAIL_INTEGRATION_IDEMPOTENCY_CONFLICT` on key reuse with a different body) |
| Signature compatibility | **Done**: `tests/fixtures/karryam/karryam-signed-vectors.json` (14 vectors signed by the real KarryGo `shared/go/serviceauth` code); `mail-karryam-contract` 14/14 |
| Handoff | `docs/cosmicforge-mail-karryam-handoff.md`; reference client `docs/integrations/karryam-go-hqmail/` |
| Karryam product consumer/publisher | **NOT INTEGRATED**: no HQ Mail publisher exists in KarryGo. The repository was **not modified** (no owner authorization) |
| Live test | **Not run** |

## H. Re-audit findings fixed (Phase 3)

Each has a regression test in the suites listed in §F or `mail-hr-lifecycle-postgres` (8/8).

- **§11 (`3a076e9`):**
  - Compose re-reads and locks attachments inside the send transaction.
  - Enqueue takes an advisory lock.
  - External-only quota counting.
  - Individual Bcc copies in `full-headers` mode.
  - Quota-wait notice and status detail.
  - Cutover flag required.
- **§12 (`3a076e9`):**
  - A rescan never releases.
  - The legal hold is re-checked before deletion.
  - Cancelling a deletion is protected by step-up.
  - Draft attachment filenames are masked.
  - Retention purges aliases and decisions.
- **§13-14 (`492538d`):**
  - A DB failure after provider acceptance never resends (POST_SEND_RECORD_FAILED).
  - Stale RUNNING runs become OUTCOME_UNKNOWN.
  - Replay gets a fresh key only after a definitive rejection.
  - A single re-subscription guard, and shared-account refusal.
  - Domain check in the brand's own marketing account.
  - Marketing-shared quota scope.
  - Preflight bound to the submission hash.
  - Test sends do not repeat recipients after a quota pause.
  - The second occurrence of an ambiguous local time is used.
  - DSAR export includes provider states.
  - Reputation counts hard bounces only.
- **§15 (`92bab1f`):**
  - Mail offboarding on every account disable path (HR accounts, HR employment status, admin-user deactivation).
  - HR onboarding can file one PENDING work-email request.
  - Product sender-rejection audits store the address id.
  - Login lockout deliberately does not offboard.

## I. Approvals and owner actions still required (none recorded)

| Approval / action | Owner | Unblocks |
|---|---|---|
| Back up, then apply migrations 27-37 to the shared staging DB | DB owner | Workstream 1 and every gated feature |
| Bucket, KMS, scanner, secrets, worker host | Infrastructure / DevOps | Workstream 2 |
| Resend staging key, webhook, receiving route, test domain | Resend account owner | Workstreams 3-4 |
| SPF/DKIM/DMARC/MX for an isolated test subdomain only | Domain owner | Workstream 3 |
| Test recipient accounts (Gmail, Outlook, Yahoo, iCloud) | Product / IT | §11.7 |
| Create the HQ Mail organization as COMPANY kind (HR default domain) | IT / Mail admin | HR onboarding work-email requests |
| `full-headers` mixed-recipient mode, receiving cutover, `MAIL_ORIGIN_HEADER_SECRET` | Product + Security | Gap 8 |
| Resend written confirmation that re-subscribe (`unsubscribed:false`) is supported, before enabling `MAIL_MARKETING_PROVIDER_RESUBSCRIBE_ENABLED` | Resend owner + Legal | Gap 2 provider path |
| Approved pricing rows for cost estimates | Finance | Gap 3 |
| Enable `MAIL_INTEGRATION_KARRYAM_COMPAT_SERVICES` and build the Karryam publisher | Karryam engineering | §15 Karryam |
| Body search confidentiality; raw MIME retention; proxy upload decision | Security + privacy | §12 |
| DSAR scope, retention periods, consent sources, GDPR transfers | Legal / DPO | §12-13 |
| HealthNet alert code catalogue | HealthNet owner | §15 |
| Manual screen-reader audit, design sign-off (template QA) | Accessibility / design | §13, §16.2 |
| Production pilot go/no-go | Leadership | separately authorized |

## J. Exact hand-off for the blocked live work

Do these in order on staging only. Nothing here was done.

1. **Database (DB owner).** Back up the shared staging Admin DB (`docs/cosmicforge-mail-staging-migration-runbook.md` §2), confirm `npm run db:admin:guard` targets the staging Admin DB (never HealthNet/Karryam), check the ledger for orders 27-37, apply the missing ones in order per the runbook, then `npm run db:schema:assert` and `GET /api/mail/v1/health/ready`. Rollback SQL for each step is in `docs/sql/`.
2. **Infrastructure.** Staging bucket + KMS key + scanner, then set `MAIL_STORAGE_PROVIDER=s3`, `MAIL_S3_*`, `MAIL_KMS_PROVIDER=aws-kms`, `MAIL_KMS_*`, `MAIL_ENCRYPTION_KEYS` (KMS-wrapped, `npm run mail:kms:generate-data-key`), `MAIL_SCANNER_PROVIDER=clamd`, `MAIL_CLAMD_*`. Validate with `npm run mail:config:validate`, then run against the real endpoints: `MAIL_S3_LIVE_ENDPOINT=… MAIL_KMS_LIVE_KEY_ID=… npm run test:mail:s3-kms-live` and `MAIL_CLAMD_LIVE_HOST=… npm run test:mail:clamd-live`.
3. **Resend (account owner).** Staging-scoped API key, webhook endpoint `https://stagingca.cosmicforge-healthnet.com/api/mail/v1/webhooks/resend` with its signing secret (`RESEND_WEBHOOK_SECRET`), receiving route for one dedicated test address only. Confirm the attachment download hosts for `RESEND_ATTACHMENT_HOST_ALLOWLIST`.
4. **Domain (domain owner).** An approved isolated test subdomain; SPF/DKIM/DMARC; MX or forwarding for the test address only; **no change to `karryam.com` root MX**. Then `MAIL_DOMAIN_ALLOWLIST=<test domain>`.
5. **Worker.** Keep `MAIL_MIXED_RECIPIENT_MODE=external-only`, `MAIL_MARKETING_PROVIDER_RESUBSCRIBE_ENABLED=false` and `MAIL_INTEGRATION_KARRYAM_COMPAT_SERVICES` empty unless their approvals (§I) exist. Then deploy `npm run mail:worker` as its own process with `MAIL_WORKER_ENABLED=true` only after steps 1-4 report ready; enable `MAIL_ENABLED`, then `MAIL_RECEIVING_ENABLED`, then `MAIL_SENDING_ENABLED` for the pilot cohort only (M10 rollout rules).
6. **Live outbound/inbound.** Gmail and Outlook test accounts (owner-approved): send, reply, attachment, CC/BCC to two local mailboxes; confirm the custom Message-ID survives (threading) and record provider acceptance separately from inbox placement.
7. **Live webhook security.** Replay a delivery, modify a body (expect 401, nothing enqueued), run reconciliation.
8. **Ambiguous send / cancel-while-queued** against the real provider.
9. **Attachments.** EICAR with official signatures; scanner outage; quarantine release.
10. **Body search** only after its approval.
11. **Backup/restore and rollback drill** on a disposable copy of the staging DB.
12. **Marketing.** Test send to staff; one approved campaign to a consented internal list; unsubscribe and complaint handling; reply counted; one controlled automation (signup → consent → trigger → step → send → event → report) and a withdrawal before the next step.
13. **Authenticated staging browser session** with test accounts for EMPLOYEE/ADMIN/EXECUTIVE/SUPER, shared-mailbox member, marketer, mail admin and a revoked user.

## K. Section 26 definition of done

| Item | Status |
|---|---|
| Placement | Met (code) |
| Control | Met (code); owner-approved domain inventory missing |
| Correctness (real round trips on staging) | **Not met**: live tests not run |
| Privacy (SUPER, offboarding on every disable path, retention, DSAR) | Met offline; live and legal sign-off missing |
| Marketing (incl. template policy, preflight, re-subscription, spend) | Met offline; provider exceptions (gaps 2, 3); live broadcast missing |
| Resilience (quota defer, deletion retry, replay, crash recovery) | Met offline; live outage tests missing |
| Security (signed webhooks, AV + quarantine UI, sanitization, secrets, MFA step-up) | Code met; privacy/security sign-off missing |
| Operations (runbooks, metrics, rollback rehearsal, encrypted backups, on-call) | Runbooks and drills offline; live rehearsal and on-call ownership missing |
| Change management | Staging CI green; DNS/rollout sign-offs missing; production and `main` untouched |

## L. Section 22 acceptance matrix

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
| External To + internal CC/BCC | Critical | PASS in both modes (`full-headers` off pending approval, gap 8) | **not run** |
| Unprovisioned local address | High | PASS | **not run** |
| HealthNet Main DB offline | Critical | PASS (earlier probe; no main-DB use added) | not run |
| Existing Help/Marketing/Social parity | Critical | PASS (full backend suite) | not run |
| CSV without verified consent | Critical | PASS (now preview + approver) | not run |
| Cross-brand campaign | Critical | PASS | not run |
| Unsubscribed/complained contact in segment | Critical | PASS | **not run** |
| Content changed after approval | Critical | PASS (+ audience binding) | not run |
| Cancel while queued | High | PASS | **not run** |
| Staging deployment without migration | Critical | PASS (pre-migration tests for 35, 36 and 37) | API live with Mail off: ready 200 |
| Restore backup and search/archive | High | PASS (disposable copy) | **not run** |
| Keyboard/mobile/screen reader | High | PASS (axe, mobile) | manual audit pending |

## M. Earlier sections (1-10, 16-21, 23-25, 27)

The M1-M10 traceability in `docs/cosmicforge-mail-m1-m10-completion-report.md` Appendix A still holds, with these updates:
- §8 now has migrations 36 and 37.
- §9 OpenAPI gained the gap endpoints (generated client in sync).
- §5.4/§15: offboarding covers every account disable path.
- §16: IT now has a quarantine view.
- §20: quota defer, durable storage deletion and automation recovery.
- §21.3: rollback covers migration 37.

M0 sign-offs remain open. M1-M9 exit criteria are met in code. M10 (pilot) has not started because it depends on the blocked workstreams.
