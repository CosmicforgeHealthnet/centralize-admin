# Advertising Execution Phase 3 — Sections 11–17 completion report

Report date: 2026-07-22. Scope stops at Section 17.

1. **Initial branch:** `staging`.
2. **Initial commit:** `c5680ca12beb271dfcbcdd13bfe729bcd7cdd2ce` (`chore(prisma): apply canonical schema formatting`).
3. **Initial Git status:** modified `.env.example`, admin Prisma schema/generated client, manifest, config validation, app mount, and migration CI test; untracked execution module, Sections 9–10 migration, and test artifacts; nothing staged.
4. **Existing uncommitted work:** Sections 6–10 and generated Prisma output were already uncommitted and were preserved. The large generated `index.d.ts` diff is generator churn with a net line increase, not an 8,000-line hand deletion.
5. **Provider documentation versions:** Google v24 stable; LinkedIn `202607`; X Ads API v12. Meta and TikTok remain required configuration with no claimed default because a reliably authoritative current public version was not obtainable during verification. See [provider baseline](./advertising-execution-provider-baseline.md).
6. **Scopes/roles:** Google `adwords` with ADMIN/STANDARD; Meta `ads_management` with ADMIN/ADVERTISER plus Page/Instagram identity; TikTok Ad Management with ADMIN/OPERATOR; LinkedIn `rw_ads` with CAMPAIGN_MANAGER/ACCOUNT_MANAGER/ACCOUNT_BILLING_ADMIN; X Ads write access with ACCOUNT_ADMIN/AD_MANAGER.
7. **Files created:** provider factory/definitions/network policy; Google auth and GAQL preflight; campaign hierarchy/immutable/replacement/status modules; Decimal/budget modules; observability; provider baseline; focused Section 11–17 tests.
8. **Files modified:** five adapter entry points, registry, capability result/discovery, execution config/errors, budget and policy services, `.env.example`, validation script, and compatible Sections 6–10 tests. Existing Sections 9–10 schema/generated/migration files remain present but were not changed for Sections 11–17.
9. **Dependencies:** none added. Reused generated `Prisma.Decimal`, existing validation/security utilities, existing audit infrastructure, and dependency-injected provider clients. Existing Axios remains available behind transport composition; adapters import no transport.
10. **Configuration:** five required provider-version variables added; values are validated; an enabled provider without a version fails closed. Global/provider/worker defaults remain false and dry-run remains true.
11. **Schema/migrations:** no Section 11–17 schema or migration change was necessary; Sections 9–10 durable models already cover plans, operations, attempts, snapshots, policies, jobs, and creative publication.
12. **Google authentication:** ten-digit customer/login-customer normalization and lazy credential resolution in execution context; incomplete credentials fail as a permission error.
13. **Google capabilities:** version, scope, role, account, Search support, validation availability, immutable fields, budget semantics, and blockers are structurally reported while write readiness is false.
14. **Google Search scope:** only approved Search objectives/placements and budget → campaign → criteria → ad group → criteria/assets/ads/links hierarchy.
15. **Google GAQL preflight:** bounded allowlisted fields, `LIMIT 1`, normalized before-state, account currency/timezone, shared-budget state, and SHA-256 snapshot hash.
16. **Google validate-only:** injected validation client receives `validateOnly: true` and `partialFailure: false`; normal tests use synthetic clients only.
17. **Google operation graph:** deterministic budget/campaign/language/location/negative/group/group-criteria/assets/ad/link order, temporary resource names, stable hashes; no BatchJob.
18. **Google read-back:** known successes require normalized read-back and become VERIFIED or DRIFTED; unknown outcomes remain UNKNOWN and non-retryable.
19. **Google safety:** PAUSED creates, Decimal-to-micros at boundary, shared-budget default block, EU non-political declaration required, political/regulated plans rejected.
20. **Meta scope:** Auction campaign → ad set → creative → ad, allowlisted objectives/placements, Page/Instagram ownership, PAUSED creates, and review-state result support.
21. **Meta batch/rate limits:** every subresponse gets an independent normalized outcome; transport success cannot mask logical failure; Retry-After is normalized; bounded rate-limit retry classification is distinct.
22. **Meta safety:** special categories rejected, objective/optimization/billing compatibility checked, permission/policy/validation errors non-retryable, compensation proposes separately approved PAUSE and never deletion.
23. **TikTok scope:** manual campaign → ad group → creative/ad only, with typed objective/optimization/billing compatibility and PAUSED creates.
24. **TikTok idempotency/review:** deterministic SHA-256 `providerOperationKey` is independent of supplementary `request_id`; normalized provider review state is retained.
25. **TikTok blocked features:** Smart+, Reach & Frequency, unauthorized Spark Ads, and unvalidated allowlisted placements fail as capability blockers; rejected/unknown results are not automatically recreated.
26. **LinkedIn version/headers:** configuration-driven rolling monthly version; `/rest/`, `Linkedin-Version`, and Rest.li `2.0.0` headers are adapter-owned; monthly review calendar documented.
27. **LinkedIn access:** `rw_ads`, eligible account role, Standard/Development tier, edit readiness, and provider-reported limits are exposed as sanitized capability data.
28. **LinkedIn safety:** supported sponsored-content formats only, campaign/creative format compatibility, protected-characteristic targeting rejection, PAUSED creates, and separate activation.
29. **X hierarchy/funding:** funding instrument preflight is read-only, followed by campaign → line item → targeting/promoted resource; every funding mutation is rejected.
30. **X micro-units:** campaign/line-item budget and bid monetary fields convert exactly once from Decimal major units to local micros.
31. **X access:** v12 and Ads API write/account access are mandatory; restricted access is a permission capability blocker; campaign, line-item, and bid limits are checked.
32. **Campaign DTO:** strict top-level schema, normalized objective/type, UTC schedule, resolved budget reference, PAUSED-only construction, typed bidding/placements/declarations/tracking, and secret/raw rejection.
33. **Hierarchy:** unresolved, orphaned, cyclic, cross-provider, cross-connection, and cross-account dependencies fail; ordering is provider-specific and deterministic.
34. **Immutable fields:** provider/account/currency/type and provider-specific fields are explicitly listed; ordinary updates return `IMMUTABLE_FIELD_CHANGE` with current/requested values and required action.
35. **Replacement plans:** explicit author action produces a draft with PAUSED replacement, preserved old resource/evidence, explicit retirement, spend exposure, and separate activation approval.
36. **PAUSE/RESUME:** independent status operations; activation cannot hide in CREATE/UPDATE; provider read-back is required.
37. **Activation exposure:** RESUME requires current/fresh before-state, bounded exposure without blockers, and an exact approval fingerprint; stale status returns `EXECUTION_PRECONDITION_CHANGED`.
38. **Budget Decimal:** generated `Prisma.Decimal` accepts strings/Decimal only, enforces currency precision/range, rejects binary floating-point Number, negative, zero when forbidden, and overflow.
39. **Unit conversion:** Google/X use exact micros; Meta/TikTok/LinkedIn retain verified account-currency representation; preconverted provider-unit input is rejected.
40. **Budget caps:** provider min/max, account, campaign, plan, daily, lifetime, parent, child, percentage increase/decrease, maximum exposure, committed spend, remaining schedule, and child constraints are evaluated.
41. **Shared budgets:** undiscovered impact blocks; all affected campaigns remain in exposure evidence; mutation requires explicit `allowSharedBudgetMutation=true`.
42. **Approvals:** spend increases require at least two approvals and configured tier/eligibility; existing approval services exclude author-only, stale, rejected, revoked, duplicate, and worker approvals.
43. **Fresh preconditions:** default 15-minute window; approved/current provider-state hashes detect material changes; stale/changed state returns `EXECUTION_PRECONDITION_CHANGED` and requires revalidation.
44. **Policy defaults:** increase/decrease false, percentage caps null, maximum exposure null, two approvals, 15-minute freshness, shared mutation false; null means unavailable, not unlimited.
45. **Capability API:** continues under authenticated Marketing VIEW, validates provider/connection/account/query, selects safe connection metadata only, distinguishes configuration/auth/permission/account/operation/gate readiness, and returns no credentials.
46. **Audit/metrics:** immutable policy-update audit added; sanitized event helper and counters cover validation, blockers, latency, rate limits, permission failures, unknown outcomes, read-back verification/drift, and budget violations.
47. **Network allowlist:** exact HTTPS hosts only for Google Ads/OAuth, Meta Graph, TikTok Business API, LinkedIn, and X Ads; embedded credentials, arbitrary hosts, and cross-host redirects are rejected.
48. **Tests added:** Google, Meta, TikTok, LinkedIn, X, configuration, campaign/hierarchy/immutable/status, Decimal/budget/caps/shared/precondition, network, audit, and observability tests; all provider clients are synthetic injected fakes.
49. **Commands run:** focused provider/shared/config tests; full Advertising Execution suite; Marketing Intelligence suite; Social Operations focused suite; `npm test`; config validation; manifest verify; migration safety; schema assertions; replay/drift; secret/static/network guards; `node --check`; `git diff --check`; full and production npm audit policy.
50. **Results:** Advertising Execution 148/148; final full repository 740/740; Social Operations 222/222; Marketing Intelligence exit 0; network guard 29/29; manifest 22 migrations/0 findings; migration safety 22/0; replay 22 migrations/drift none; schema, config, secret (595 files/0), static, syntax, and diff checks passed. Dependency audit alone failed as described below.
51. **Deferred features:** Google BatchJob/non-Search, Meta regulated categories, TikTok Smart+/R&F and broad creative workflows, LinkedIn broader formats/regulated targeting, X funding mutations/organic publishing, live validation, and all Section 18+ work.
52. **Official-documentation deviations:** Google v24 selected instead of upcoming v25; Meta/TikTok versions intentionally have no default due public-documentation verification limits; provider versions therefore fail closed and require operational re-verification.
53. **Credential/access blockers:** no real credentials, test advertiser accounts, manager relationships, Page/Instagram ownership, TikTok app approval, LinkedIn access tier, X Ads allowlisting, or connection write enablement was supplied. Npm audit also reports existing Prisma-tooling transitives: high `fast-uri` GHSA-V2HH-GCRM-F6HX and unbaselined moderate `@hono/node-server` GHSA-FRVP-7C67-39W9; no dependency was introduced by this work.
54. **Migration history:** no existing migration was edited for Sections 11–17; the uncommitted Sections 9–10 additive migration remains as found.
55. **Database boundary:** `mainPrisma` and `prisma.main.config.ts` were not used; schema assertions target `cosmicforge_admin`.
56. **Live calls:** no live provider call occurred.
57. **Provider mutations:** no real mutate, campaign creation, budget change, deletion, or activation occurred.
58. **Write flags:** global/provider/worker flags remain disabled in `.env.example` and runtime validation.
59. **Dry-run:** `MARKETING_AD_EXECUTION_DRY_RUN=true` remains the default.
60. **Connection writes:** capability remains hard false; configured API versions never imply write readiness.
61. **Worker:** imports start no worker; worker remains disabled and claim attempts fail closed.
62. **Git/external actions:** nothing was staged, committed, pushed, merged, deployed, or submitted as a PR.
63. **Final Git status:** dirty by design: the pre-existing modified schema/generated/config/app files remain; `artifacts/`, the Sections 9–10 migration, the Advertising Execution module, and these two report documents are untracked. No staged files.
