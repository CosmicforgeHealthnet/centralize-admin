# CF Meet Product Admin (`services/cfmeet-admin`)

| | |
|---|---|
| Status | Draft for owner review (2026-11-19) |
| Repo / path | `centralize-admin` (branch `staging`) → `docs/product-admin/cfmeet-admin-design.md` |
| Counterpart | `cfmeet/docs/admin/cfmeet-admin-bridge.md` (owns the bridge contract) |

## 1. Goal

**What we're building.** CF Meet becomes a product managed from HQ, exactly the way Karryam (KarryGo) was added. It uses HQ's existing flow:
- PIC registration and verification
- Protocol v1.1
- product grants
- governed operations
- staging stages S0–S7

**Who builds what:**

| Part | Where | Built by |
|---|---|---|
| `services/cfmeet-admin` and the HQ changes in §7 | This repo | Us |
| The CF Meet admin bridge | CF Meet repo | Us |
| HQ web pages (§10) | HQ web app | HQ frontend team |

```
HQ web → central-admin-api /api/products/cfmeet/* → PIC /internal/pic/v1
   → cfmeet-admin /internal/product-admin/v1 (unix socket)
   → CF Meet bridge /internal/cfmeet-admin/v1 (mTLS, HMAC v2, Ed25519 staff token)
```

**Owner decisions applied:**
- HQ staging connects to CF Meet production, read-only at first.
- Every two-person approval expires after **12 hours**.
- Plans start as **Free / Pro / Business**.
- The service runs as container user **10003**.
- The Verification page is generalized for all products.
- HQ can request CF Meet feature switch-ons.

## 2. Product identity

| Item | Value |
|---|---|
| `product_id` | `cfmeet` |
| Display name | CF Meet |
| IDs | `cfmeet.<module>.<verb>` |
| Service instance | `cfmeet-admin-staging-1` |
| Workload identity | `cf://staging/product-admin/cfmeet` |
| Manifest signer | `cfmeet-staging-manifest-2026-11` (Ed25519) |
| Allowed scope | market `GLOBAL` plus countries as needed; organization `cfmeet`; zone `production` / `sandbox`; tenant = CF Meet tenants |
| HQ name at the bridge | `cosmicforge-hq-cfmeet-admin` |
| Departments | Protocol department `cfmeet-operations`; HR department `CF_MEET_OPERATIONS` |

## 3. The new service: `services/cfmeet-admin`

It follows `services/karryam-admin` file for file.

| Path | Purpose |
|---|---|
| `package.json`, lock | `@cosmicforge/cfmeet-admin`, `pg` only, Node 22+. Scripts: start, check, test, migrate, config:check |
| `Dockerfile`, `Dockerfile.dockerignore` | Built from the repo root with the shared packages copied in. **uid 10003**, unix socket, no exposed port, off by default |
| `.env.example` | All `CFMEET_ADMIN_*` settings. Secrets only as absolute file paths |
| `src/config/index.js` | `PRODUCT_ID = "cfmeet"`. Fails closed. Role map, bridge pins, certified datasets, enabled commands |
| `src/server/`, `src/transport/` | Protocol handler kit (`createProductAdminHandler`), socket with mode 0660, private metrics |
| `src/protocol/` | Signed manifest with honest states: everything starts READ_ONLY or DISABLED, with a reason |
| `src/modules/` | The 17 CF Meet modules (§4) mapped onto the pinned bridge contract. Sealed page tokens, freshness and coverage |
| `src/bridge/client/` | mTLS (TLS 1.3, pinned private IP), HMAC v2, Ed25519 staff token with the `approval` claim. The digest includes `"cfmeet"`. Never retries |
| `src/bridge/contracts/` | Pinned CF Meet contract plus `cfmeet-backoffice-v1.json` (source commit and hashes) |
| `src/sync/`, `src/worker/` | Stage A: bridge feed → summaries → HQ outbox. Stage B: HQ pulls `/events` |
| `src/operations/`, `src/db/` | Governed command pipeline. Receipts, approvals, certifications, holds and retention, sensitive-access log |
| `src/audit`, `src/security`, `src/observability`, `src/logger.js` | Audit before execution, keys and replay store, metrics, redacting logs |
| `migrations/001–004` | Same shape as karryam-admin |
| `scripts/` | migrate, check-config, check-syntax, pin-bridge-contract (reads a CF Meet checkout), api-catalog, governance-ops, pipeline-ops, high-risk-certification |
| `tests/` | The 22 karryam-admin suites, adapted, with a fake CF Meet bridge |

## 4. Modules shown in HQ

Each module has one read capability, `cfmeet.<module>.read`. Its collections and reports come from the pinned CF Meet contract. Commands are named `cfmeet.<bridge capability>`. ✔ means a second person must approve.

| Module | What staff see | What staff can do |
|---|---|---|
| accounts | users, detail, sessions, devices, security history, duplicates | status, role, email ✔; sign out everywhere ✔; remove devices ✔; MFA reset ✔; data export ✔; account deletion ✔ |
| meetings | spaces, meetings, live, participants, recordings, webinars, meeting audit, meeting reports | end meeting ✔; archive or transfer ✔; delete recording ✔; review report ✔ |
| messaging | reports, moderation, policy, holds, exports, deletion requests, audit, off-switches, failed messages, key transparency | moderation ✔; policy ✔; holds ✔; export ✔; deletion ✔; off-switch ✔; retry |
| calling | calls, live, abuse reports, blocks, limits, spend, routing, enterprise features, recordings, holds, incidents, webhook keys, audit | resolve report; release block ✔; limits ✔; spend ✔; routing or features ✔; hold ✔; reseal key ✔ |
| communications | profiles, reports, holds, audit, metrics | suspend or restore ✔; review report ✔; backfill or replay |
| organizations | organizations, audit, members, teams, policies, bindings, events | create; suspend or archive ✔; ownership recovery ✔; export ✔; bindings ✔; members, teams, policies ✔; replay |
| partners | workspaces, projects, environments, members, keys, service accounts, websites, push keys (details only), partner users, webhooks, usage, incidents, activity | workspace state ✔; revoke key ✔; sign out partner users ✔; retry webhook; support tier; record incident |
| identity | tenants, apps, environments, service accounts, scopes, keys, identity records, OAuth apps, audit | status ✔; scopes ✔; keys ✔; remove identity ✔ |
| apps | apps, versions, installs | suspend or lift ✔ |
| **verification** | `cases` (shared case shape), case history | claim; approve or reject partner go-live ✔; approve, reject or publish app ✔; suspend ✔ |
| pricing | price books, versions, activations, freezes, plans (Free/Pro/Business), plan assignments, overrides, simulator | draft or submit; approve or reject ✔; activate or roll back ✔; freeze or unfreeze ✔; assign plan ✔; overrides ✔ |
| finance | usage, estimated charges, plan spread | — |
| notifications | deliveries, failed deliveries, suppressions, routing, providers | retry; remove suppression; routing ✔; cancel reroute ✔ |
| privacy | requests and per-service status | register; complete per service ✔ |
| operations | health, incidents, switches, switch-on requests, release history | resolve incident; flip switch ✔; **request feature switch-on ✔** |
| audit | one search across all CF Meet audit | — |
| telecom | read-only summaries, disabled | — |

**Local approval commands** (no CF Meet call): `cfmeet.governance.approval.propose`, `.decide` and `.revoke`.

**Datasets:**
- The 8 datasets listed in the CF Meet document, §11.
- All are INTERNAL, for department `cfmeet-operations`, plus `finance` and `compliance` where relevant.
- A dataset counts as certified only when listed in `CFMEET_ADMIN_CERTIFIED_DATASETS`.
- A figure is shown only when coverage is complete; otherwise it is `null`.

## 5. Two-person approvals (HQ Section 11 model)

1. **Propose.** Call `cfmeet.governance.approval.propose` with:
   - the intent digest, covering the action, the target with its expected version, the body, the scope and the requester;
   - a lifetime from 60 s up to **43,200 s (12 hours, the default)**.
2. **Decide.** `…decide` (APPROVE or REJECT) is made by a different person who holds the whole scope and has passed MFA within the last 300 s.
3. **Run.** The requester runs the real command with `params.approval_ref`. cfmeet-admin then:
   - re-checks certification, bridge availability, expiry, intent, scope and version;
   - records the intent and the audit entry;
   - uses the approval exactly once.
4. **Send.** The staff token sent to the bridge carries the `approval` claim. The bridge and the CF Meet service each re-check that the approver is not the requester.
5. **Status.** RECORDED → DISPATCHING → SUCCEEDED, FAILED or UNKNOWN_OUTCOME.
   - UNKNOWN_OUTCOME is settled only by reading back.
   - Status is shown at `/api/products/cfmeet/operations/{id}` and `/audit`.

**Before a command family is switched on:**
- R3 and R4 commands need a certification from two reviewers (`scripts/high-risk-certification.js`).
- R1 and R2 commands must be listed in `CFMEET_ADMIN_ENABLED_COMMANDS`.
- PIC's operations switch for cfmeet must be on.

## 6. Staff roles

Roles are carried on HQ product grants. The bridge's signed access policy maps each role to permissions, purposes and scopes.

| Role | Can do |
|---|---|
| `cfmeet.viewer` | Metrics and reports |
| `cfmeet.support` | Users, meetings and profiles reads; request status, session and email changes |
| `cfmeet.trust_safety` | Abuse queues, moderation, suspensions, holds |
| `cfmeet.verification.reviewer` | Verification cases |
| `cfmeet.partner_ops` | Partners, apps, identity; workspace and key actions |
| `cfmeet.finance` | Finance reports, usage |
| `cfmeet.pricing.editor` / `cfmeet.pricing.approver` | Editor: draft or submit prices and plans. Approver: approve, activate, freeze |
| `cfmeet.platform_ops` | Operations, notifications, chat and calling tools |
| `cfmeet.security_admin` | Identity, keys, scopes, privacy requests |
| `cfmeet.release_manager` | Request feature switch-ons |

## 7. HQ changes needed

All of these are Karryam-only today.

| Area | Change |
|---|---|
| `infrastructure/scripts/product-admin-staging-gates.mjs` | Allow `services/cfmeet-admin/` in the release scope; naming and bridge-network checks per product |
| `product-admin-infra-check.mjs`, `product-admin-contract-audit.mjs`, `product-admin-section14-closure.mjs` | Make them work for any product, or add cfmeet |
| `infrastructure/scripts/check-layout.mjs` | Required files for `services/cfmeet-admin` |
| `infrastructure/product-admin/coverage-policy.json` | cfmeet-admin entry and per-file thresholds |
| `.github/workflows/product-admin-platform-ci.yml` | A cfmeet-admin job: CF Meet checkout at the pinned commit (the repo is public), contract audit, plus coverage, smoke and gates jobs |
| `product-admin-infrastructure-ci.yml`, `product-admin-release-staging.yml`, `product-admin-staging-ops.yml` | cfmeet-admin image and database rehearsal |
| `infrastructure/product-admin/release/pa-staging-ops.sh` | Image name check, new database container, migration preview and apply, new subnets, uid 10003 |
| `staging/docker-compose.yml`, `network-policy.json` | Services `cfmeet-admin`, `cfmeet-admin-worker`, `cfmeet-admin-db`. Networks `cf-staging-cfmeet-bridge` and `cf-staging-cfmeet-admin-db`. PIC gets `group_add` 10003 and a read-only socket mount |
| `staging/cfmeet-admin.env.template`, `db-b-roles.sql` | Database `cfmeet_admin`; roles `cfmeet_admin_migrator` and `cfmeet_admin_runtime` |
| PIC runtime files | `endpoints.json` entry `cfmeet-staging` (unix); a cfmeet entry in `trusted-signers.json` |
| `services/product-integration-core/scripts/staging-operator-onboarding.js` | Make it work for any product (today it is fixed to Karryam), with review |
| `monitoring/alerts.yml` | cfmeet-admin alerts |
| Mail integration | Register `cfmeet` for `ops.alert`. Staff with `mail / integration:cfmeet` receive the alerts |
| HR | Department `CF_MEET_OPERATIONS` (Prisma enum and migration), ownership entry, web enum; optional `cfmeet` module |
| **Product gateway and PIC** | **New read-only routes to list and read product grants.** None exist today, and the grants screen needs them |
| `docs/product-admin/cfmeet-admin-api-catalog.json` | Generated, and checked for drift |

## 8. Onboarding: HQ's verification lifecycle

1. **Operator prerequisites (S1/S2).**
   - Database and roles, then migrations.
   - Keys, each at least 32 bytes and unique: the PIC↔cfmeet service key, delegation key and manifest signer, plus the HQ→bridge HMAC, mTLS and staff-token keys.
   - PIC endpoint and signer entries, then restart PIC.
2. **Deploy cfmeet-admin** switched off, then switch it on. `GET /manifest` must return the signed manifest.
3. **Platform grants.** Three different staff members receive platform grants, each with MFA set up.
4. **Request.** Call `POST /api/admin/product-integrations` with product `cfmeet`, display name, instance, environment, endpoint ref, workload identity, signer key ID and allowed scope.
5. **Verify identity:** `verify-identity`.
6. **Validate contract:** `validate-contract`.
7. **Review policy:** `review-policy`, done by a second person.
8. **Approve datasets.**
9. **Certify staging:** `certify-staging`, with evidence, by someone other than the validator.
10. **Approve:** `approve`, by someone other than the certifier. The product becomes ENABLED.
11. **Subscriptions.** Create them, then set `PIC_SYNC_ENABLED=true`.
12. **Staff grants** per §6. Alternatively, start with a read-only grant valid for at most 72 hours.
13. **Commands.** Enable operations one command family at a time, with evidence, after certification (S6).

Evidence goes in `docs/product-admin/evidence/cfmeet-*.json`, in the same form as the Karryam files.

## 9. Deployment stages

| Stage | CF Meet specifics |
|---|---|
| S0 | Reviewed code on `staging`; CI green; image digests recorded |
| S1 | Database and network, roles, backup, migration preview and apply |
| S2 | Deploy the private services; attach to the gateway |
| S3 | CF Meet enrolls HQ's certificate, HMAC key and staff-token key in the bridge, and signs a **read-only** access policy |
| S4 | First event sync |
| S5 | Certified reads and dashboards; staff grants reviewed |
| S6 | Command families, one at a time: verification → accounts and safety → chat and calls → pricing → operations and switch-ons |
| S7 | Retire the old ways: reviewer name lists, server tools for routine work, GitHub buttons for switch-ons |

**Blocker today:** the privileged S1/S2 steps can't run from GitHub Actions (`BLOCKED_PRIVILEGED_HOST_OPERATION`). As with Karryam, an authorized operator must run them on the server, unless the elevation path is approved first.

## 10. Pages for the HQ frontend team

**Conventions to follow:**
- a thin page under `app/dashboard/...`, with the components in `components/cfmeet/*`;
- a sub-navigation component and the `?section=` parameter;
- react-query hooks over `lib/products.service.ts`;
- `ServiceDataState` to tell "unavailable" apart from "empty";
- every figure shows its as-of time, freshness and coverage.

**Shared pieces to build first.** These serve every product, not just CF Meet:
1. **Session MFA step-up helper.** It catches `RECENT_MFA_REQUIRED` and `MFA_STEP_UP_REQUIRED`, shows `MfaCodeForm`, calls `/api/auth/mfa/step-up`, then retries the request.
2. **Product grants manager.** It uses the new list route from §7.
3. **Product integration admin.** Registry, datasets, subscriptions, operations on and off, contracts.
4. **Approvals inbox.** Tabs for "waiting for me" and "my requests", with a decide action. It reuses the card style of the existing advertising "Approval Centre".
5. **Operation status and audit drawer.**

**CF Meet section.** The sidebar entry is shown based on `/api/products`, not on staff tier.

| Page | Data |
|---|---|
| Overview | Metric cards (reuse the ProductMetrics logic) |
| Users | `resources/cfmeet.accounts.read/users`, detail, actions |
| Meetings | Meeting lists, live, recordings, reports |
| Chat safety | Reports, moderation, holds, off-switches |
| Calls | Calling lists and actions |
| Profiles | Communications |
| Organizations | Organization lists and actions |
| Partners | Workspaces → projects → environments → keys, users, webhooks, usage |
| Apps | Apps, installs |
| Pricing | Price books, version editor, approve, schedule, freeze; Free/Pro/Business plans and assignments; simulator |
| Finance | Reports |
| Notifications | Deliveries, failures, routing |
| Privacy | Requests and per-service status |
| Operations | Health, incidents, switches, **feature switch-on requests** with run status |
| Audit | One audit search |

**Generalized Verification page:**
- Product tabs come from products that have a `<product>.verification.read` capability.
- CF Meet cases come from `/api/products/cfmeet/resources/cfmeet.verification.read/cases`.
- The detail view shows evidence and history.
- Approve and reject go through propose → second person decides → run, with MFA step-up.
- The HealthNet tabs stay unchanged.

## 11. Tests and CI

- **Test suites.** The karryam-admin suites, adapted:
  - protocol, transport, connector security, bridge, modules, reports;
  - operations and high-risk operations;
  - Postgres, pipeline, recovery, section 9, section 11, restore drill;
  - staging preflight, worker, observability.
- **Contract pin test.** It recomputes the CF Meet contract hashes from a checkout at the pinned commit, regenerates the registry and compares the two byte for byte.
- **Coverage.** Per-file thresholds on the security files. No required test may be skipped.
- **PIC cross-service test.** "cfmeet through HQ", run against a fake bridge.

## 12. Phases (matched to the CF Meet document)

| Phase | Work | Pairs with |
|---|---|---|
| B0 | Pin the contract; the HQ changes in §7 | A0 |
| B1 | cfmeet-admin skeleton, manifest, datasets, worker; onboarding steps 1–12 on staging | A1 |
| B2 | Read modules, reports, page tokens | A2 |
| B3 | Approvals and verification commands, certification | A3 |
| B4–B8 | Command families, in the same order as the CF Meet document | A4–A8 |
| B9 | Production HQ and certification gates | A9 |

Each pair ends with a check between HQ staging and CF Meet production: read-only first, then one command family at a time.
