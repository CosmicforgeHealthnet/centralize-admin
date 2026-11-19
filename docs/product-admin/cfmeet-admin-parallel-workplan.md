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
| Pinned CF Meet commit | Waiting for A0 |

## 5. Changing the interface

- Track A may need to differ from §3. If so, it records the change under **"Deviations from HQ interface v1"** in `docs/admin/cfmeet-admin-bridge.md`, with the reason, and keeps every other part of §3 unchanged.
- Track B reads that section before each pin and either adapts or raises it with the owner.
- No change is final until it is pinned and the drift check passes.
