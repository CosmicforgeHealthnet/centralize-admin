# PR #55 closure addendum — Sections 1–5 fail-closed fixes

Date: 31 October 2026. Branch `feat/product-admin-sections-1-5-verify` →
`staging`. PR: https://github.com/CosmicforgeHealthnet/centralize-admin/pull/55

## A. Executive verdict

**SECTIONS 1–5 CODE COMPLETE — EXTERNAL STAGING CERTIFICATION PENDING**

Both review findings and every additional defect found are fixed, each with a
regression test that fails on the previous code and passes now. All CI jobs
pass on Linux. Nothing has been deployed: no staging deployment of Karryam
Admin or the Product Integration Core (PIC) has happened, and production is
unchanged. The PR is **not merged**: it is waiting for an independent review
(see E).

## B. Security fixes

| # | Finding | Previous behavior | Fixed behavior | Regression test | Result |
|---|---|---|---|---|---|
| 1 | Review finding 1: unclassified change hidden by a classified one (`compatibility.js`) | The `UNCLASSIFIED_CHANGE` fallback ran only when no other change was found, so "title change + unknown field" was `COMPATIBLE_ADDITIVE` | Exhaustive accounting: every rule records the keys it classified; every matched object is compared key by key in canonical form; any unaccounted difference is breaking, even alongside recognised changes | `admin-contracts/tests/compatibility.test.js` "REGRESSION: a known additive change cannot mask…" (7 placements + capability-state case) | 7 of 14 new tests fail on the old comparator; 14/14 pass |
| 2 | Payload schema comparison walked only the old schema's keywords | A new keyword (e.g. `patternProperties`, `additionalProperties: true`) or a dropped `required` passed as additive | Union of keywords compared; only new optional `properties` are additive | same file, "event payload schema changes…" | pass |
| 3 | `version_policy`, lineage keys, duplicates, digest consistency not compared | Silently ignored | Breaking (`EVENT_VERSION_POLICY_CHANGED`, `UNCLASSIFIED_CHANGE`, `DUPLICATE_CATALOG_ENTRY`, `DATASET_SCHEMA_DIGEST_INVALID`) | "set and entry ordering, duplicates…" | pass |
| 4 | Activation trusted the comparison stored at proposal time | A revision compared against a since-superseded contract, or stored by the old comparator, could activate | `activateContract` re-compares against the contract active now; `activationDecision` refuses self-inconsistent comparisons | `sync-gate-postgres` "activation re-compares…" | fails on old code; passes |
| 5 | Review finding 2: drift blocklist (`engine.js`) | Only 3 identity states blocked; `BREAKING_DETECTED` and `ADDITIVE_PENDING_REVIEW` kept synchronizing | One deny-by-default gate (`src/registry/sync-policy.js`): only `NONE` syncs; all other or unknown states block; no request, cursor, ACK or projection | `sync-gate-postgres` breaking / additive cases; `sync-policy.test.js` unknown states | fail on old code; pass |
| 6 | Gate checked only at run start | Drift, expiry or a trust change landing mid-run did not stop later events or the ACK | Gate re-read `FOR SHARE` inside every apply, before every ACK, inside reconciliation; ACK withheld (`SKIPPED_BLOCKED`) and retried after recovery | "drift, revocation or a trust change recorded mid-run…", "the ACK is withheld…" | fail on old code; pass |
| 7 | Quarantine/cursor: an unverifiable event at the next sequence was quarantined, the cursor advanced past it and it was ACKed | Product could discard an event HQ never validated | The event is quarantined and **holds** the partition (`gap_from = gap_to = sequence`, `hold_reason`); nothing after it is applied or ACKed; only a complete approved snapshot covering it recovers. `SCOPE_DENIED` (authentic, schema-valid, out of scope) stays a recorded policy filter | "an unverifiable event at the next sequence holds the cursor…", "a reused event id with a changed payload…", "a payload outside the approved event schema…"; two existing tests that asserted the unsafe behavior were corrected | fail on old code; pass |
| 8 | Navigation vs reads vs runtime | Reads still served during additive drift; only `BREAKING_DETECTED` hid navigation | Navigation and live reads use the same gate (`CONTRACT_DRIFT` / `IDENTITY_NOT_VERIFIED`); manifest and status reads stay available for diagnosis | breaking / additive cases | pass |
| 9 | Health-check refresh and races | A stale check could overwrite state after a contract activation or signer change | A changed catalog never refreshes the manifest; a check whose contract or signer changed mid-check is discarded | breaking / additive cases (no refresh) | pass |
| 10 | New dataset activation during drift | Dataset approval and subscription create/enable were allowed | Refused with `CONTRACT_DRIFT_UNRESOLVED`; the dataset version must be declared by the contract in force | breaking / additive cases | pass |
| 11 | Trust-store lifecycle (6.1) | Loaded once; an operator's revocation in the file had no effect until an unannounced restart, and the process kept trusting the old signer | Store bound to its source bytes (trust file + key files). Within `PIC_TRUST_STORE_RECHECK_SECONDS` (default 5 s) a change latches `TRUST_STORE_CHANGED`: sync, health refresh, onboarding and reads fail closed until restart. **Revocation is not instantaneous**: it is a full stop within the recheck interval and new trust after restart | `sync-policy.test.js` trust-store tests (one Linux-only) | pass |
| 12 | 6.2: the person a DENY restricts could revoke it | Self-grant blocked, self-revoke allowed | `SELF_REVOKE_DENIED`; DB backstop `no_self_revoke` (new rows) | `api-security-postgres` "REGRESSION: an explicit DENY…" | fails on old code; passes |
| 13 | 6.3: keys shared between Product Admin endpoints | Accepted; one product could sign as HQ to another or mint its delegations | `KEY_REUSE_ACROSS_BOUNDARIES` | `unit.test.js` "REGRESSION: no service or delegation key…" | fails on old code; passes |
| 14 | 6.2: command scope (Karryam Admin) | `scope: {}` (meaning "everywhere") passed the delegated-scope check | Every delegated dimension (and market, organization) required, non-empty, contained | `karryam-admin/tests/protocol.test.js` | fails on old code; passes |
| 15 | 6.2: idempotent replay by another requester (Karryam Admin) | Returned `REPLAY` with the other staff member's operation ID | `IDEMPOTENCY_KEY_REUSED`, nothing disclosed (memory and PostgreSQL stores) | `protocol.test.js`, `postgres.test.js` | fails on old code; passes |

Areas reviewed with no defect found: fixed private endpoints (no manifest- or
response-controlled destination), no proxying, redirects refused, timeouts
covering slow bodies, streaming response cap, `cf-svc-v1` signing over
method/path/query/body with nonce, ±30 s window and durable replay claim,
constant-time comparisons, only health endpoints unauthenticated, no SUPER
bypass, explicit DENY wins, malformed DENY denies, expired grants deny,
60 s request-bound delegations, append-only audit/inbox/lineage triggers,
runtime role without DDL or audit DELETE, unique durable event keys.

## C. Contract compatibility (actual results, `compatibility.test.js`)

| Case | Result |
|---|---|
| Identical (also with reordered object keys) | `IDENTICAL`, activates |
| Reviewed additive (field + bump, new dataset, capability, family) | `COMPATIBLE_ADDITIVE`; refused unreviewed, allowed only with `reviewed === true` |
| Breaking (capability removed; privacy, scope, authorization, currency; metric definition/aggregation/grain/unit) | `BREAKING`, refused even when reviewed |
| Unknown field alone | `BREAKING`, `UNCLASSIFIED_CHANGE` at the exact path |
| Additive + unknown (capability, dataset, field, metric, lineage, event family, protocol) | `BREAKING` (was `COMPATIBLE_ADDITIVE`) |
| Breaking + unknown | `BREAKING`, both changes reported |
| MFA / independent approval, either direction, alone or mixed; flag removed | `BREAKING` |
| Protocol minor upgrade / downgrade / major / type change | additive / breaking / breaking (`NEW_MAJOR_REQUIRES_ONBOARDING`) / breaking |
| Activation after an unclassified modification; forged or inconsistent comparison | refused |

## D. Sync and identity certification (PostgreSQL tests, CI and local)

| Behavior | Evidence |
|---|---|
| Signer revoked / expired / unknown / wrong scope | `identity-gate-postgres`: `BLOCKED_IDENTITY`, zero requests |
| Identity drift | `identity-gate-postgres`: blocked, navigation `IDENTITY_NOT_VERIFIED`, recovers after verified check |
| Breaking drift | `sync-gate-postgres`: `BLOCKED_CONTRACT_DRIFT`, zero requests, cursor/inbox/ACK unchanged, reads 503 `CONTRACT_DRIFT`; recovers when the approved catalog is re-verified |
| Unapproved additive drift | same, plus: proposal and certification alone do not unblock; activation by a third person does |
| Manifest expiry and refresh | `identity-gate-postgres`; mid-run expiry blocks (`sync-gate-postgres`) |
| Cursor integrity / ACK safety | hold at the unverified sequence; ACK only of the contiguous committed sequence; withheld if the gate closes before ACK |
| Quarantine | sanitized metadata only, reason recorded, kept after recovery (`SUPERSEDED_BY_SNAPSHOT`) |
| Recovery | snapshot reconciliation clears the hold only when complete and covering it |
| Revocation mid-run | `ABORTED_REVOKED`, one event committed, nothing ACKed |
| Synthetic third-product conformance | 17/17 (20 steps) |

## E. Repository and CI

- Starting SHAs: feature `291d1d9e6123bf7d5222a5adf5b7687085f88568`; staging `ec65d78baee070375598c78ea7e9a5a2703b88df` (merged into the branch as `37872f6`, no conflicts, no force-push).
- Fix commits: `f37787d` (contract, sync gate, holds, trust store, release tooling), `82fbb5f` (authorization and key-separation fixes, runbook); this addendum is a documentation-only commit on top.
- CI on `82fbb5f` (Linux, Node 22, PostgreSQL 16), all jobs succeeded:
  - Product Admin Platform CI https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/41220089395 — packages 33+7+9+8 = 57/57; Karryam Admin 31/31 (KarryGo staging still matches the pinned contract); PIC migrations 5/5, conformance 17/17, full suite 64/64; image smoke: non-root (10001/10002), live 200, ready 503.
  - Social Operations CI https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/41220089396 — Central Admin backend full suite 1561 tests: 1559 pass, 0 fail, 2 skipped (pre-existing); social suites 29/222/537/30; secret scan 846 files, 0 findings (scope: `services/central-admin-api`). Staging deploy jobs **skipped** (PR event), not executed.
  - Monorepo Layout and Container CI https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/41220089348 — success.
- Local (Windows 11, Node 25, embedded PostgreSQL 17): same suites pass except two platform-only tests that also fail on the unmodified code on Windows (Unix socket mode, POSIX config paths) and pass on Linux CI; `pg_dump` restore test skipped locally, passed in CI.
- Not run: frontend lint/typecheck/build and HealthNet CI (no files under their paths changed, so their workflows did not trigger).
- Merge status: **not merged**. `staging` has no branch protection or ruleset, so GitHub would allow a merge, but the PR author is the connected account and the earlier review asked for the normal independent review. A review was requested from another collaborator; the PR stays open until it is approved.

## F. Deployment preparation

- Existing: `product-admin-platform-ci.yml` (PR/push CI, no deploy).
- Added: `product-admin-release-staging.yml` — manual, refuses any ref but `staging`; migration preflight with a restricted runtime role, configuration preflight with disposable fixture keys, immutable `staging-<sha>` images, non-root/read-only/no-network smoke, optional GHCR publish behind `PUBLISH_STAGING_IMAGES` that never overwrites a tag. **It never deploys.** It has not run yet (it can only be dispatched from `staging` after merge).
- Added: `config:check` preflight in both services (sanitized output); migration `002` (forward-only, rollback-compatible); `release-runbook.md` (prerequisites, procedure, checklists, trust changes, drift/holds, rollback).
- Services remain disabled (`*_ENABLED=false`, `PIC_SYNC_ENABLED=false`, `KARRYAM_BRIDGE_ENABLED=false`). No staging deployment occurred. Production unchanged.

## G. Remaining external dependencies (operator)

See `release-runbook.md` §2: database roles and migrations for both services;
secret files and per-product unique keys; Karryam Admin signer enrollment in
PIC's trust store; Bridge certificate, HMAC enrollment and Backoffice
approval; signed policies / three distinct platform grant holders; private
socket networking and `/internal/*` edge deny; then live staging E2E
certification. None of these were fabricated or provisioned.

## H. Next implementation stage

Ready to start Section 6 (Karryam Admin backend modules), Section 7 (complete
Bridge connector), Section 8 (Karryam event pipeline) and Section 9 (product
data models and projections) as engineering work against the protocol and
the synthetic/fixture harness. No engineering prerequisite blocks them.
Live verification of Sections 7–8 needs the operator Bridge enrollment (G).
