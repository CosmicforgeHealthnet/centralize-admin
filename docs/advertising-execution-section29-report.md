# Advertising Execution — Section 29 (Test Strategy) completion report

Date: 2026-07-23. Branch `staging`, base commit `c5680ca` ("chore(prisma): apply canonical schema formatting"). All Sections 6–28 work remained uncommitted on this branch before Section 29 began and was preserved unchanged; nothing was staged, committed, pushed, merged, reset, stashed, rebased, cleaned or deployed during this work.

## 1. Scope and outcome

Section 29.1 (mandatory suites) and Section 29.2 (live tests) are implemented. A requirement-to-test audit of the existing ~180 Sections 6–28 tests was performed first; missing mandatory cases were added as fifteen new Section 29 suites (14 module suites + the live-harness offline suite), one production-quality fake-provider-transport helper, and a fail-closed live-validation harness that has **never been executed**. Every provider remains `NOT_LIVE_VALIDATED`.

Verdicts:

| Area | Verdict |
|---|---|
| Section 29.1 mandatory suites | COMPLETE |
| Section 29.2 live-test harness | COMPLETE (implemented, never executed) |
| Automated provider safety | PASS (zero live calls; runtime + static network guards active) |
| PostgreSQL coverage | COMPLETE (SKIP LOCKED, queue atomicity/idempotency, cancellation, revisions, evidence immutability, replay, drift) |
| Requirement traceability | COMPLETE (`docs/advertising-execution-section29-test-traceability.md`) |
| Documentation | COMPLETE (runbook, matrix, handoff, traceability, this report) |
| Live-provider safety | PASS (fail-closed gates; NOT_LIVE_VALIDATED everywhere) |
| Repository regressions | PASS |
| **Overall Section 29** | **COMPLETE** |

## 2. Files created

Test suites (all offline, all under the runtime network guard):

- `src/modules/marketing/advertising-execution/__tests__/section29.plans.test.js` (13 tests)
- `…/section29.policies.test.js` (9), `…/section29.approvals.test.js` (9), `…/section29.queue-leases.test.js` (9), `…/section29.idempotency.test.js` (6)
- `…/section29.google-ads.test.js` (7), `…/section29.meta.test.js` (5), `…/section29.tiktok.test.js` (5), `…/section29.linkedin.test.js` (6), `…/section29.x.test.js` (4)
- `…/section29.creatives.test.js` (6), `…/section29.reconciliation.test.js` (6), `…/section29.security.test.js` (6), `…/section29.docs-migrations.test.js` (6)
- `tests/advertising-execution-section29-live-harness.test.js` (14)
- `src/modules/marketing/advertising-execution/__tests__/helpers/fake-provider-transports.js` — provider-specific fake transports + fixtures

Live harness (Section 29.2, never executed):

- `scripts/advertising-execution/live-validation-gates.js` — 20-condition fail-closed gate evaluation (pure, offline-testable)
- `scripts/advertising-execution/live-validation-harness.js` — fixed stage machine with finally-path cleanup and sanitized ledger
- `scripts/advertising-execution/live-validate.js` — CLI entry; refuses to run without a reviewed transport module

Documentation:

- `docs/advertising-execution-section29-test-traceability.md` (requirement-to-test map)
- `docs/advertising-execution-section29-report.md` (this report)

## 3. Files modified

- `package.json` — Section 29 test scripts (`test:advertising-execution:{plans,policies,approvals,queue-leases,idempotency,providers,creatives,reconciliation,security,docs-migrations,live-harness,section29,all-offline}`) and per-provider `live:read:*` / `live:validate:*` commands. No default/CI path references any live command.
- `.gitignore` — added `artifacts/` so the live resource ledger directory (and existing focused-test artifacts) can never be committed.
- `docs/advertising-execution-operations-runbook.md` — Section 29 test-strategy and Section 29.2 live-validation procedures.
- `docs/advertising-execution-live-validation-matrix.md` — Section 29.2 status paragraph; all rows remain `NOT_LIVE_VALIDATED` with explicit criteria for change.
- `docs/advertising-execution-api-handoff.md` — testing note.
- Production fixes discovered by the audit (behavior-strengthening only, no test weakened):
  - `plans/plan.validator.js` and `plans/plan-fingerprint.js` — the literal `__proto__` key normalized to `proto`, which was missing from the forbidden-key sets, so `__proto__` keys previously passed the plan validator (they were only caught later at persistence). Both sets now include `proto`.
  - `policy/budget-guard.service.js` — cap violations now raise the documented stable `EXECUTION_BUDGET_POLICY_VIOLATION` (422) instead of the generic `APPROVAL_NOT_ELIGIBLE` (403); precondition-style failures still raise `EXECUTION_PRECONDITION_CHANGED`. The stable code existed in the error registry and error-code documentation but previously had no throw site.

No previously applied migration was modified; no schema, Prisma client or server wiring changed; `mainPrisma`, `prisma.main.config.ts` and `cosmicforge_test` were never used.

## 4. Test architecture

- **Unit / service tests** drive production services with injected fake repositories, clocks and sinks (never real-time sleeps).
- **Provider contract tests** inject provider-specific fake transports through the production `createProviderExecutionAdapter` factory. Fakes route every simulated request through the production host allowlist (`provider-network.policy.js`), enforce `createStatus=PAUSED` on creates, witness credentials as a boolean without storing them, replay idempotency keys without re-mutating, and script rate limits, permissions, validation failures, transient 5xx, uncertain timeouts, partial failures, review states, read-back and drift.
- **HTTP integration** (Sections 25–28 suites) runs the mounted app with real middleware.
- **PostgreSQL integration** uses disposable replayed databases (`tests/advertising-execution-*postgres*`): SKIP LOCKED with real concurrent connections, serializable queue atomicity with failure injection, idempotent duplicate submit/queue, lease-owner cancellation, concurrent creative revisions, append-only evidence, retry-review atomicity.
- **Migration/manifest/docs tests** verify runtime route inventory (router-stack inspection, not regex), 25/20/7 schema inventory with fail-closed absence, canonical checksummed manifest (read-only verification), additive ordered migrations, stable-error documentation and the live matrix.

## 5. Network isolation and zero-live-call proof

1. Every test command loads `tests/helpers/network-guard.js` via `--require`; it patches http/https/fetch/undici/net/tls/dns and throws `UNEXPECTED_EXTERNAL_NETWORK_REQUEST` for any non-local destination (29 dedicated guard tests pass). Static enforcement: `npm run security:network-guard-static` (18 checks, pass).
2. Provider domains are unreachable twice over: the runtime guard blocks sockets/DNS, and production adapters only accept explicitly injected clients — a missing transport fails closed with `INJECTED_PROVIDER_CLIENT_REQUIRED`.
3. No automated script or CI workflow references the live commands (proven by `tests/advertising-execution-section29-live-harness.test.js`).
4. No provider credentials are required by any automated test; fakes witness `credentialsProvided` as a boolean with `stored: null` asserted.
5. During this implementation: no live validation script was executed, no provider request occurred, no provider resource was created, no media was uploaded, and every provider row remains `NOT_LIVE_VALIDATED`.
6. Safe defaults are unchanged: `MARKETING_AD_EXECUTION_ENABLED=false`, `MARKETING_AD_EXECUTION_DRY_RUN=true`, `MARKETING_AD_EXECUTION_WORKER_ENABLED=false`, all five provider flags `false`, per-connection write capability `false` (verified by `config:validate` output: `ad_execution=false ad_execution_dry_run=true ad_execution_worker=false providers_enabled=0`).

## 6. Section 29.2 live harness design

- **Gates (all mandatory, fail closed with zero provider calls):** explicit mode + provider; `MARKETING_AD_EXECUTION_LIVE_TEST_CONFIRMED=true`; unique value `MARKETING_AD_EXECUTION_LIVE_TEST_CONFIRMATION=I_UNDERSTAND_THIS_CREATES_PAUSED_PROVIDER_OBJECTS`; sandbox connection UUID (runtime-verified `testAccount`/`sandbox` flag); account allowlist with production denylist always winning; Decimal budget cap `MARKETING_AD_EXECUTION_LIVE_TEST_MAX_BUDGET_MINOR` that no API payload can override (zero-spend default); currency allowlist; destination-domain allowlist; resource prefix containing `TEST`; cleanup plan; operator identity; reason/ticket; ledger directory inside ignored `artifacts/`; refusal under NODE_ENV=test, CI, an installed test network guard, or an enabled application worker. Write phases additionally require `--confirm-write=YES_CREATE_PAUSED_OBJECTS`.
- **Stages (fixed order):** preflight safety → read-only capability → validate-only/dry-run → human write confirmation → paused-resource creation → immediate read-back → ledger write → cleanup (finally) → cleanup verification (read-back, never assumed) → final report. Per-provider stage plans (Google validate-only + temporary graph + micros cap; Meta role/identity + paused hierarchy + batch verification; TikTok objective/billing + request_id + review read-back; LinkedIn version header + permissions + format + minimum budget; X funding capability + micro-units + targeting read-back) are documented in the runbook and traceability matrix.
- **Ledger:** sanitized JSON per run (run id, provider, API version, safe connection/account references, operator, times, confirmation state, created resource types/native ids/parents/statuses, read-back status, cleanup action+result, final status, sanitized provider request ids, errors, manual-follow-up flag). Secret-shaped keys are stripped recursively; tokens, authorization headers, credential envelopes, raw bodies and signed URLs can never persist.
- **Failure behavior:** any created resource stays paused; incomplete cleanup marks manual follow-up, prints the created ids, exits non-zero and never erases the ledger.
- **Transport:** no live transport ships in this repository (provider access is still blocked — see `docs/advertising-execution-provider-access-blockers.md`). The CLI requires a reviewed module via `MARKETING_AD_EXECUTION_LIVE_TEST_<PROVIDER>_TRANSPORT_MODULE` and otherwise exits with `LIVE_TRANSPORT_NOT_CONFIGURED` before touching credentials. The 14 offline harness tests drive the full lifecycle with fake live transports.

## 7. Verification results (all commands exit 0 unless noted)

| Command | Result |
|---|---|
| `npm run test:advertising-execution:section29` | 111/111 pass (~5.2s) — plans 13, policies 9, approvals 9, queue-leases 9, idempotency 6, providers 27, creatives 6, reconciliation 6, security 6, docs-migrations 6, live-harness 14 |
| `npm run test:advertising-execution:all-offline` | 348/348 pass (~29s) — all module suites + Sections 18–24/25–28 PostgreSQL + HTTP + live-harness |
| `npm run test:advertising-execution:postgres` / `:postgres:sections25-28` | pass (contained in all-offline; disposable replayed databases) |
| `npm run test:social-operations` | 222/222 pass (~24s) |
| `npm test` (full repository) | pass — see final tally below |
| `npm run test:network-guard` | 29/29 pass |
| `npm run security:network-guard-static` | 18 checks, status=ok |
| `npm run security:secret-scan` | 684 files scanned, findings=0 |
| `npm run security:audit-policy` | total=0 critical=0 high=0 moderate=0 |
| `npm run db:manifest:verify` | 26 migrations, 0 checksum/missing/extra/duplicate failures |
| `npm run migrations:safety` | 26 files scanned, findings=0 |
| `npm run db:replay:verify` | status=ok, 26 migrations replayed into a disposable empty database, drift=none |
| `npm run db:admin:guard` + `npm run db:schema:assert` | target=cosmicforge_admin; social 31/31; advertising execution tables 25/25, indexes 20/20, enums 7/7 |
| `npm run config:validate` | status=ok; execution, dry-run and worker defaults confirmed safe |
| `node --check` on all created/modified JS | pass |
| `git diff --check` | pass (no conflict/whitespace markers) |

Full repository suite: `npm test` — 940 tests, 940 pass, 0 fail (~33s), network guard active throughout.

No tracked file was changed by any test run (verified by comparing `git status` before/after; the only new untracked artifacts are the intentionally ignored `artifacts/` outputs of the social focused runner).

## 8. Strict audit summary

Every mandatory case in the Section 29 specification maps to at least one direct test (see the traceability document; IDs 29-PLAN-001…29-LIVE-014). Concurrency-sensitive rows (SKIP LOCKED, queue atomicity/idempotency, cancellation, creative revisions, approval/audit immutability, retry atomicity, compensation lineage, migration replay/drift) all have real PostgreSQL coverage. Provider rows use realistic provider-specific fake transports through production composition. The live harness fails closed on every one of its 20 gate conditions, requires explicit double confirmation plus a per-write confirmation, enforces sandbox/account/currency/destination allowlists and a Decimal budget cap, forces paused resources, writes a sanitized ledger, and always attempts verified cleanup. Live scripts are excluded from `npm test`, CI, focused suites, hooks and migration verification. Provider status remains `NOT_LIVE_VALIDATED` for Google Ads, Meta, TikTok, LinkedIn and X.

Section 29 is COMPLETE. No work beyond Section 29 was performed.
