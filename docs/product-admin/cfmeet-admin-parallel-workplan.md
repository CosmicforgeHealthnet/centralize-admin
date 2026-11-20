# CF Meet Product Admin: parallel work plan and bridge interface (v1)

| | |
|---|---|
| Status | Active (2026-11-19) |
| Design | [cfmeet-admin-design.md](cfmeet-admin-design.md) |
| Track A (CF Meet bridge) | Cloud session, repo `CosmicforgeHealthnet/cfmeet`, branch `staging` |
| Track B (HQ side) | Local session, repo `centralize-admin`, branch `staging` |

Two sessions build CF Meet Product Admin at the same time. Each one owns one repo and never edits the other. They connect only through the interface in §3. If something must change, follow §5.

## 1. Who owns what

| Track | Repo | Owns | Never touches |
|---|---|---|---|
| **A**, cloud | `cfmeet` | The admin bridge service (`/internal/cfmeet-admin/v1`), its OpenAPI and capability matrix, signing profile, event feed, signed access policy, `docs/admin/cfmeet-admin-bridge.md`. Phases A0–A9. | `centralize-admin`; CF Meet `main` or production deploys, unless the owner says so separately |
| **B**, local | `centralize-admin` | `services/cfmeet-admin`, the HQ changes (design §7), CI, gates, staging compose, onboarding evidence. Phases B0–B9. | The `cfmeet` repo; HQ `main` or production |

Both tracks follow the staging-first rules of their own repo: commit only the task's changes, push to `staging`, check the remote SHA, never force-push, and report blockers instead of claiming success.

## 2. Order and sync points

| Step | Track A delivers | Track B does meanwhile | Sync check |
|---|---|---|---|
| 0 | **A0:** contract artifacts (§3.1) on cfmeet `staging`; the pinnable commit SHA recorded in `docs/admin/cfmeet-admin-bridge.md` under "Pinnable commit" | B0 prep: §7 HQ changes; `services/cfmeet-admin` skeleton tested against a **fake bridge built from this spec** | B pins the A0 commit (`CFMEET_CHECKOUT=… node scripts/pin-bridge-contract.js --write`). The drift check passes |
| 1 | A1: bridge running, read-only, auth (§3.3), events (§3.5) | B1: manifest, datasets, worker, onboarding steps 1–12 | Signed `/capabilities` read from HQ staging; first event sync |
| 2 | A2: read capabilities for all modules | B2: read modules, reports, page tokens | Certified reads per module |
| 3 | A3: approval claim enforced (§3.4); verification commands | B3: approvals plus verification commands, certification | One approved command end to end |
| 4–8 | A4–A8: command families, one at a time | B4–B8: the same families | One family per check |
| 9 | A9: production gates | B9: production HQ gates | Owner sign-off |

**Rule:** Track B never guesses the contract. Until A0 lands, B tests only against a fake bridge built from §3. When A0 lands, the pinned registry replaces the fixture, and any mismatch is fixed on the side that broke §3.

## 3. Bridge interface v1 (Track A must deliver exactly this)

These rules mirror the Karryam bridge that HQ already consumes (`services/karryam-admin`), so the same connector code can be reused.

### 3.0 Amendments agreed with Track A (2026-11-19)

Track A and Track B agreed the following before A0. Where they differ from §3.1–§3.6, **these win**. HQ's machine-readable copy is `services/cfmeet-admin/contract-draft/`.

| Topic | Agreed |
|---|---|
| Contract folder | `services/admin-bridge/docs/contract/`, not `docs/openapi/`. It also ships `capabilities.v1.json` (the karryam registry shape plus `query_shape`), `bridge-schemas.v1.json`, `event-adapters.v1.json` and `access-policy.v1.json` |
| Query shapes | No `BASE` shape. Every route uses exactly one of:<br>`SCOPED` = market, organization, zone, tenant, purpose<br>`SCOPED_PAGE` = SCOPED + limit, cursor<br>`SCOPED_WINDOW` = SCOPED_PAGE + start, end<br>`SCOPED_SEARCH` = SCOPED_PAGE + q<br>Limit is 1–100, the window is at most 31 days (`end` at most 60 s in the future), and `q` matches `^[\p{L}\p{N} ._@:-]{1,128}$` |
| Purposes | Hyphenated, fixed list: support-review, verification-review, abuse-review, billing-review, pricing-change, ops-incident, release-request, privacy-request, admin-ui-capabilities (discovery), metrics-read (datasets, health), event-sync (feed and ACK) |
| Approval claim | `{approval_id, capability, requester_ref, approver_ref, intent_digest (64 hex), decided_at, expires_at}`. `requester_ref` is the raw HQ `sub`. Single use at the Bridge. Required on every `TWO_PERSON` capability; TWO_PERSON commands stay DISABLED until A3+ |
| HMAC skew and token lifetime | Bridge allows ±30 s clock skew. Token `exp − iat` ≤ 60 s (HQ sends 20 s) |
| acr, iss, aud | Staff acr `urn:cosmicforge:acr:mfa`, which is also the default strong set for R3/R4. Worker acr `urn:cosmicforge:acr:workload`, valid only with roles exactly `["cfmeet.source_sync"]`. iss `cosmicforge-hq`, aud `cfmeet-admin-bridge` |
| Roles | The 11 HQ grant roles in design §6 map 1:1 to Bridge roles, plus the worker role `cfmeet.source_sync`, whose permission ceiling is `bridge.datasets.read`→metrics-read, `hq.events.read`/`hq.events.ack`/`hq.projections.read`→event-sync |
| Platform capabilities | `bridge.capabilities.read` GET /capabilities (SCOPED)<br>`bridge.health.read` GET /health/aggregate<br>`bridge.datasets.read` GET /datasets/{dataset_id} (SCOPED_WINDOW, `^cfmeet\.[a-z_]{1,48}$`)<br>`hq.events.feed` (permission `hq.events.read`, SCOPED_WINDOW)<br>`hq.events.ack` (SCOPED)<br>`hq.projections.status` (permission `hq.projections.read`, SCOPED) |
| Discovery result | `{contract_version, openapi_sha256, policy_revision, capabilities:[{id, state, blocker≤256}]}`. HQ caches runtime states only when `openapi_sha256` equals the pinned hash. Runtime state is never higher than the artifact state |
| Unbuilt capabilities | `BLOCKED_DEPENDENCY` (reads) or `DISABLED` (commands), with a blocker naming the phase. Their result schema is `{"not":{}}` until the phase lands with a contract minor bump. Published schemas are immutable |
| Datasets (Track A §11) | `cfmeet.engagement_daily`, `meetings_daily`, `messaging_daily`, `partners_daily`, `apps_daily`, `verification_queue`, `trust_safety_queue`, `operations_health`. Result `{dataset_id, coverage COMPLETE/PARTIAL/NONE, window, series[{date, metrics{name: int\|null}}], next_cursor}`. `cfmeet.sync_health` stays HQ-local |
| Event adapters | One entry per (owner, export type): 13 in total.<br>partner.workspace.changed.v1 and app.review.changed.v1: developer-platform<br>verification.case.changed.v1: developer-platform<br>abuse.report.changed.v1: messaging, calling, communications, meeting-service<br>incident.changed.v1: messaging, calling, notifications, meeting-service, developer-platform<br>pricing.version.changed.v1: developer-platform<br>Fields are empty until A7 |
| Verification case | Track A adopts §3.6 in A3. An optional `approvals_required` field may be added |
| Error codes | HQ maps every code in the Bridge's signing-profile "Error codes" table (36 at A2). The five codes in "Command outcomes" (BRIDGE_DISABLED, BRIDGE_UNAVAILABLE, POLICY_UNAVAILABLE, CAPABILITY_DISABLED, AUDIT_UNAVAILABLE) guarantee nothing was done, so a command answered with one of them is FAILED. Any other 5xx after sending is UNKNOWN_OUTCOME (readback only). HQ boundary tests parse both sections |
| Personal-data keys | No published schema may use a key in HQ's FORBIDDEN_FIELD list (services/cfmeet-admin/src/modules/reads.js). Both sides test this |
| Sensitive search (HQ frontend) | A search term that is a contact identifier (email address, phone number) must never appear in a URL, because HQ's edge proxy logs request lines. The HQ gateway refuses, on GET reads, a `q` that contains `@` or 7 or more digits once separators are removed (SENSITIVE_SEARCH_REQUIRES_POST). The web client sends such searches as `POST /api/products/{p}/resources/{capability}/{collection}/search` with a JSON body {market, organization, zone, tenant, purpose, q, limit?, continuation?, parent?}, which HQ forwards to PIC as the same GET read. Affected: accounts.users.search, partners.users.list, identity.partner-users.list, notifications.suppressions.list, identity.records.list and pricing.plan-assignments.list (the last two to be confirmed). CF Meet's address digest is keyed (HMAC) and cannot be computed in the browser |
| Bridge connectivity | Private tunnel (owner decision). The CF Meet host's relay on RFC 1918 tunnel IP:8460 (e.g. 10.250.0.1) admits only HQ's tunnel IP (e.g. 10.250.0.2). 100.64/10 is refused by HQ. SNI admin-bridge.cfmeet.internal; server certificate from CF Meet's private CA, leaf fingerprint pinned by HQ |

### 3.1 Contract artifacts (A0)

All files go in **`services/admin-bridge/docs/openapi/`** in the cfmeet repo. HQ's pin script reads this fixed path. If the path must change, follow §5.

| File | Content |
|---|---|
| `openapi.json` | OpenAPI 3.1. `info.version` = contract version. Every path starts with `/internal/cfmeet-admin/v1`. Every operation's `operationId` **equals its capability ID**. Shared schemas go in `components.schemas` |
| `CFMEET_ADMIN_CAPABILITY_MATRIX.json` | A JSON array with one entry per operation (fields in §3.2) |
| `SHA256SUMS` | sha256 of every contract file and every source file the matrix cites |
| `signing-profile.md` | The exact signing rules from §3.3 and §3.4, as implemented |
| `admin-events.v1.json` | Event registry: the event types, the source service of each, the classification, schema `cosmicforge.product-admin-event.v1`, max **16384** bytes per event |

`docs/admin/cfmeet-admin-bridge.md` must also list:
- the **8 HQ datasets** (ID, description, source capabilities, classification, coverage rule);
- the role → permission → purpose → scope access policy for the roles in design §6.

### 3.2 Capability matrix entry

```json
{
  "id": "accounts.users.list",
  "version": "1.0",
  "owner": "accounts-team",
  "method": "GET",
  "bridge_endpoint": "/accounts/users",
  "source_endpoint": "GET /v1/... (or null)",
  "state": "READ_ONLY | AVAILABLE | DISABLED",
  "permission": "accounts.users.read",
  "risk": "R0 | R1 | R2 | R3 | R4",
  "privacy": "PUBLIC | INTERNAL | OPERATIONS_MINIMIZED | PERSONAL | FINANCIAL_SENSITIVE | SAFETY_EVIDENCE",
  "scope": "plain-language scope rule",
  "source_version_required": false,
  "idempotency_required": false,
  "approval": "NONE | TWO_PERSON",
  "feature_flag": "flag name or NONE",
  "blocker": null,
  "tests": ["TestName"]
}
```

Rules:
- `method` + `/internal/cfmeet-admin/v1` + `bridge_endpoint` must equal the OpenAPI path and method for `operationId == id`.
- **The first ID segment is the HQ module.** Allowed values:
  - modules: `accounts`, `meetings`, `messaging`, `calling`, `communications`, `organizations`, `partners`, `identity`, `apps`, `verification`, `pricing`, `finance`, `notifications`, `privacy`, `operations`, `audit`, `telecom`;
  - platform: `bridge`, `hq`.
- Every R3/R4 command and every ✔ action in design §4 has `approval: "TWO_PERSON"`, `source_version_required: true` and `idempotency_required: true`.
- At A0, every command has `state: "DISABLED"` with a `blocker` reason. Reads are `READ_ONLY`.
- Read-type operations that must be POST are listed in the bridge doc. Everything else that is not GET is a command.

### 3.3 Transport and authentication

| Layer | Requirement |
|---|---|
| Transport | Private network only. TLS 1.3 mutual TLS. HQ's client certificate is pinned by enrolled fingerprint |
| HQ principal | `cosmicforge-hq-cfmeet-admin` |
| HMAC v2 | Headers: `X-HQ-Key-ID`, `X-Service-Name`, `X-Service-Timestamp` (unix seconds), `X-Service-Nonce` (16 random bytes, hex), `X-Service-Signature-Version: 2`, `X-Service-Signature`. The signature is hex HMAC-SHA256 over the LF-joined values `"2"`, principal, METHOD, the exact request URI including the query, timestamp, nonce, and hex sha256 of the exact body bytes. Reject anything with clock skew over 300 s or a reused nonce |
| request_digest | hex sha256 of METHOD LF URI LF `"cfmeet"` LF hex(sha256(body)) |
| Staff assertion | `Authorization: Bearer <JWS>`, Ed25519. The header is exactly `{alg:"EdDSA", typ:"JWT", kid}`. Claims: `iss, sub, aud, product:"cfmeet", roles[], permissions[], market_scopes[], organization_scopes[], zone_scopes[]?, tenant_scopes[]?, session_id, auth_time, acr, jti, iat, nbf, exp (iat + 20 s at most), request_digest`. Reject: a reused `jti`, a digest mismatch, a permission not granted by the signed access policy, or a scope outside the assertion |
| Query parameters | Only these exact ordered sets. `BASE` = `market, organization, purpose`. `SCOPED` = BASE + `zone, tenant`. `SCOPED_WINDOW` = SCOPED + `start, end, limit, cursor`. `limit` is 1–100; the window is at most 31 days. Any new set must be agreed under §5 |
| Path parameters | Every one has `format: uuid` or a `pattern`. No `/` inside a value |
| Retries | HQ never retries a command. The bridge must make commands idempotent on `Idempotency-Key` |

### 3.4 Approval claim (new for CF Meet; enforced from A3)

For any capability with `approval: "TWO_PERSON"`, the staff assertion also carries:

```json
"approval": {
  "ref": "uuid",
  "capability": "<capability id being called>",
  "requester_sub": "<must equal sub>",
  "approver_sub": "<must differ from sub>",
  "intent_digest": "<hex sha256, HQ-computed, recorded in audit>",
  "decided_at": "RFC 3339",
  "expires_at": "RFC 3339, at most 43200 s after decided_at"
}
```

The bridge rejects the call if:
- the claim is missing;
- `capability` is not the route being called;
- `requester_sub` ≠ `sub`, or `approver_sub` = `sub`;
- the approval has expired, or `expires_at` − `decided_at` > 43200 s;
- `ref` has been used before. The bridge stores refs it has used.

The bridge passes `approver_sub` to the CF Meet service, which repeats the approver ≠ requester check.

### 3.5 Response envelope and events

Every JSON response is exactly:

```json
{ "contract_version": "1.0", "product": "cfmeet", "correlation_id": "uuid",
  "as_of": "RFC 3339", "freshness": "LIVE|RECENT|STALE|PARTIAL|UNKNOWN|UNAVAILABLE",
  "result": { }, "error": null }
```

On an error, `result` is absent and `error` is `{code, message}`. Each 2xx JSON schema in OpenAPI must declare `properties.result`.

These capability IDs are fixed so that HQ's existing event consumer can be reused:

| ID | Method and path | Notes |
|---|---|---|
| `bridge.capabilities.read` | `GET /capabilities` (BASE, `purpose=admin_ui_capabilities`) | The live capability states |
| `hq.events.feed` | `GET /hq/events` (SCOPED_WINDOW) | `cursor` = last sequence. Returns events in increasing `sequence` order |
| `hq.events.ack` | `POST /hq/event-acknowledgements` (SCOPED_WINDOW) | The body is `{consumer, sequence}` and the result is `{consumer, acknowledged_sequence}`. One acknowledged sequence per consumer |
| `hq.projections.status` | `GET /hq/projections/status` (BASE) | Used to reconcile gaps |

### 3.6 Verification case shape (shared across products)

```json
{ "case_id": "uuid", "product": "cfmeet", "kind": "PARTNER_GO_LIVE|APP_REVIEW|APP_PUBLISH",
  "subject_ref": "opaque id", "state": "OPEN|CLAIMED|APPROVED|REJECTED|SUSPENDED|PUBLISHED",
  "version": 1, "assignee_ref": null, "submitted_at": "RFC 3339", "updated_at": "RFC 3339",
  "evidence": [{ "kind": "string", "ref": "opaque id", "sha256": "hex" }] }
```

## 4. Track B status (updated by Track B on each push)

| Item | State |
|---|---|
| Design and this plan on HQ `staging` | Done |
| `services/cfmeet-admin` (B1–B3 code against the HQ draft contract) | Done: protocol, connector with approval claim, 17 modules + platform, 15 reports, 8 Bridge datasets + sync health, governed operations with 12 h approvals. 136/137 tests pass on Windows with PostgreSQL; the 1 failure is the Unix-socket test, which fails the same way for karryam-admin on Windows |
| A0 | Merged into cfmeet `main` (PR #121) |
| Pinned CF Meet commit | `7325f30447891ed91ac0b421c8eb363a9c356609` (cfmeet `main`, contract 1.0.0): `contract_status` is `PINNED`. All 246 capabilities are `DISABLED` or `BLOCKED_DEPENDENCY`, so nothing is served yet. Re-pin forward as each A1/A2 slice merges (1.1.0, 1.2.0, ...) |
| A1/A2 slices | #122–#138 verified against HQ before merge (schemas compile, no personal-data keys, every error code mapped, 0 diffs on shared ids, contact-search flags honoured) |

## 5. Changing the interface

- Track A may need to differ from §3. If so, it records the change under **"Deviations from HQ interface v1"** in `docs/admin/cfmeet-admin-bridge.md`, with the reason, and keeps every other part of §3 unchanged.
- Track B reads that section before each pin and either adapts or raises it with the owner.
- No change is final until it is pinned and the drift check passes.
