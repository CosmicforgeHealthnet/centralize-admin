# CF Meet Admin: independent Product Admin service

CF Meet Admin is HQ's Product Admin runtime for **CF Meet** (`product_id` `cfmeet`). It implements the Universal Product Admin Protocol for HQ, and it owns the private connection to the **CF Meet Admin Bridge** in the cfmeet repo.

- It is **disabled by default**.
- No CF Meet command runs until all of these hold:
  - the command family is enabled by an operator;
  - R3/R4 commands are certified by two reviewers;
  - the Bridge reports the capability AVAILABLE at runtime;
  - a second staff member approves the exact intent.

```text
HQ Product Integration Core ──(cf-svc-v1 + delegation, unix socket)──▶ CF Meet Admin
CF Meet Admin ──(TLS 1.3 mTLS + HMAC v2 + Ed25519 staff token + approval claim)──▶ CF Meet Admin Bridge ──▶ CF Meet owner services
```

Design: [docs/product-admin/cfmeet-admin-design.md](../../docs/product-admin/cfmeet-admin-design.md).
Two-track plan and Bridge interface v1: [docs/product-admin/cfmeet-admin-parallel-workplan.md](../../docs/product-admin/cfmeet-admin-parallel-workplan.md).

This service is a file-for-file sibling of [services/karryam-admin](../karryam-admin/README.md). Transport, protocol handlers, governed operations, approvals, certifications, Stage A/B pipeline and database governance work the same way. What differs is listed below.

## Bridge contract: DRAFT until Track A's A0 is pinned

| File | Meaning |
|---|---|
| `src/bridge/contracts/cfmeet-backoffice-v1.json` | Pinned metadata, including `contract_status` (`DRAFT` or `PINNED`) and `source_commit` |
| `src/bridge/contracts/cfmeet-capabilities.v1.json`, `cfmeet-bridge-schemas.v1.json`, `cfmeet-event-adapters.v1.json` | Registry, schemas and event adapters, generated from the contract |
| `contract-draft/` | HQ's draft of interface v1, laid out like the cfmeet repo (`services/admin-bridge/docs/contract/`), and its generator `build-draft.js` |

- While `contract_status` is `DRAFT`, configuration **refuses to enable the Bridge in staging or production** (`CFMEET_BRIDGE_CONTRACT_NOT_PINNED`). The draft is only for local development and tests.
- The draft models the agreed wire format and the target end state, so the governed pipeline can be tested.

Re-pinning is a reviewed change:

```bash
# Draft (default checkout = contract-draft/)
node contract-draft/build-draft.js && node scripts/pin-bridge-contract.js --write
# Real contract, after Track A's A0 merges (public repo):
CFMEET_CHECKOUT=/path/to/cfmeet node scripts/pin-bridge-contract.js --write --commit <40-hex merge sha>
# Drift check (CI): exit 1 on any difference
CFMEET_CHECKOUT=/path/to/cfmeet node scripts/pin-bridge-contract.js
```

Before every pin, read "Deviations from HQ interface v1" in `cfmeet/docs/admin/cfmeet-admin-bridge.md`.

## What is specific to CF Meet

- **Scope.** Every Bridge route is zone- and tenant-scoped. The query shapes are a closed, ordered set:
  - `SCOPED`: market, organization, zone, tenant, purpose
  - `SCOPED_PAGE`: SCOPED + limit, cursor
  - `SCOPED_WINDOW`: SCOPED_PAGE + start, end
  - `SCOPED_SEARCH`: SCOPED_PAGE + q

  Discovery uses the first enrolled zone and tenant that the delegation also grants, never "every zone".
- **Purposes.** Only the Bridge's fixed, hyphenated list:
  - support-review, verification-review, abuse-review, billing-review, pricing-change, ops-incident, release-request, privacy-request;
  - metrics-read (staff reads and dataset pulls);
  - admin-ui-capabilities (discovery);
  - event-sync (the worker only).

  Commands use their module's purpose. Feature switch-on requests are `release-request`.
- **Approval claim.** Every `TWO_PERSON` capability carries this claim in the staff token: `{approval_id, capability, requester_ref, approver_ref, intent_digest, decided_at, expires_at}`.
  - It is built from the consumed approval and checked locally with the same rules as the Bridge, before any network call.
  - TWO_PERSON or R3/R4 means `requires_independent_approval`.
- **12-hour approvals.** `cfmeet.governance.approval.propose` allows `ttl_seconds` from 60 to 43,200. The default is 43,200.
- **Modules.** 17 modules plus platform metadata, from accounts to telecom (design §4). Each has one `cfmeet.<module>.read` capability; commands are `cfmeet.<bridge capability id>`. See `src/modules/catalog.js`.
- **Reports.** 15 reports (`src/modules/reports.js`):
  - Bridge summaries: meeting activity, communications metrics, partner usage, finance usage, estimated charges (withheld under partial coverage), plan spread, and service health.
  - Local projection queues: verification, safety (4 owners), partner workspaces, and incidents (5 owners). Owners are never added together.
  - Pipeline reports.
  - Telecom stays an explicit blocked dependency.
- **Datasets.** The 8 Bridge datasets (Track A §11) are pulled by the worker every `CFMEET_BRIDGE_DATASET_PULL_SECONDS` from `GET /datasets/{id}` (SCOPED_WINDOW, `metrics-read`).
  - Each metric per UTC day becomes one HQ metric observation.
  - A value is OBSERVED only for a non-null integer under COMPLETE coverage; otherwise it is UNAVAILABLE.
  - Unknown metric names are refused.
  - `cfmeet.sync_health` is HQ-local.
  - Only datasets listed in `CFMEET_ADMIN_CERTIFIED_DATASETS` are pulled or served.
- **Events.** One adapter per (owner service, export type). Abuse reports come from 4 owners and incidents from 5. Events whose owner, type or fields don't match are quarantined.
  - Track A ships the A0 adapters without fields until A7, so every payload is quarantined until then (fail closed).
  - No snapshot-backfill contract exists: open entity gaps are reported (`BACKFILL_CONTRACT_NOT_AVAILABLE`), never filled in.
- **Container.** uid/gid **10003**, unix socket `/run/cosmicforge/cfmeet-admin.sock` (mode 0660), no `EXPOSE`.

## Run, test, migrate

```bash
cd services/cfmeet-admin
npm ci
npm run check
npm test                                   # PostgreSQL suites skip without a database
CFMEET_ADMIN_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres npm test   # disposable server only
```

- The PostgreSQL suites create and drop their own databases and roles. Never point them at staging or production.
- The restore drill also needs `pg_dump` and `pg_restore` on `PATH` (or `PG_BIN`).
- Migrations are forward-only and use a separate credential that the server never reads:

```bash
CFMEET_ADMIN_MIGRATION_DATABASE_URL=postgresql://<migrator>@<host>/cfmeet_admin CFMEET_ADMIN_RUNTIME_ROLE=cfmeet_admin_runtime npm run migrate
```

## Configuration

See `.env.example`.
- Every secret comes from an operator-mounted file, referenced by an absolute path.
- Each trust boundary needs its own key. The service keys, delegation keys, Bridge HMAC key and continuation-token key may never share key material.
- Staff tokens use acr `urn:cosmicforge:acr:mfa`; the worker uses `urn:cosmicforge:acr:workload` with bridge role `cfmeet.source_sync`.
- Default issuer and audience: `cosmicforge-hq` and `cfmeet-admin-bridge`.
- HQ product-grant roles (design §6) map 1:1 to Bridge roles through `CFMEET_ADMIN_ROLE_MAP`.

## External blockers (operator action required)

- Track A's A0 merged and pinned (`contract_status: PINNED`). Until then the Bridge cannot be enabled outside test and development.
- HQ ↔ CF Meet Admin service and delegation keys, and the manifest signer `cfmeet-staging-manifest-2026-11` enrolled in PIC's trust store.
- Database `cfmeet_admin`, with roles `cfmeet_admin_migrator` and `cfmeet_admin_runtime`, on the staging host.
- Bridge enrollment at CF Meet (S3): HQ client certificate fingerprint, HMAC key, staff-token key, and a signed read-only access policy.
  On the HQ host, `node scripts/bridge-enrollment.js prepare --dir <secrets dir>` generates the client key, CSR and staff key (the keys never leave the host; needs the openssl CLI). Once CF Meet returns the certificate, CA bundle and HMAC key, `node scripts/bridge-enrollment.js verify --dir <secrets dir>` runs the startup trust checks on them before the Bridge is enabled. See `--help` and step 4 of `docs/product-admin/cfmeet-admin-go-live.md`.
- Privileged S1/S2 host steps run by an authorized operator, as for Karryam (`BLOCKED_PRIVILEGED_HOST_OPERATION` from GitHub Actions).
