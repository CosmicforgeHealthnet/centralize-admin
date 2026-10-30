# Section 1 — Source audit and verified baseline

Audit date: 30 October 2026. Re-run of the previous audit against the latest
remote state; everything below was recomputed in this session, not copied.

## 1.1 Repository state

| Repository | Branch | Previous audit | Current HEAD at start | Changed? |
|---|---|---|---|---|
| CosmicforgeHealthnet/centralize-admin | `staging` | `49bdfbbd6e68b09c360d078e2d7a00c6890b523f` | `680b315ea9ad2275bb9630d8390cd2dc01f4ae77` | Yes — Mail and ops only |
| CosmicforgeHealthnet/KarryGo | `staging` | `a4adee680f88705641c6a204caac83125d1970a5` | `a4adee680f88705641c6a204caac83125d1970a5` (2026-10-28) | No |
| Central Admin PR #36 (draft) | `feat/karryam-admin-private-read-foundation-20261029` | `0a3b401d833f81c5696797f3c67388940be69699` | `0a3b401d833f81c5696797f3c67388940be69699` | No |

Centralized Admin commits since the previous audit (`49bdfbb..680b315`):
`2194149` feat(mail): self-hosted storage, keys and backups; `db0ef94` fix(mail)
comment wording; `84fdcdd` fix(ops): staging deploy account can read the
staging `.env`; merges #46 and #47. None touch Sections 1–5 scope.

Open pull requests on centralize-admin: only #36 (draft).

## 1.2 Karryam Backoffice (KarryGo `a4adee68`)

Artifacts in `services/admin-backoffice-service/docs/openapi/`:

| Artifact | SHA-256 |
|---|---|
| `KARRYGO_ADMIN_CAPABILITY_MATRIX.json` | `a0766c36003d6a5e8cf6d3395cd36b532f33521943a207fbccf86431f3210a61` |
| `openapi.json` (OpenAPI 3.1.0, info.version 1.0.0, 432 paths) | `f43527954357d9673bace7e1adaded8da128edafb9dd3ce0bda065e7e157c823` |
| `SHA256SUMS` (104 entries, `sha256sum -c`: 104 OK, 0 failed) | `09e28faca415ff91a7965d394134ef4abcb9907d49ec676fd34dc3417aaf600d` |
| `signing-profile.md` | `2157f6747a05b41526384f1747656d551965bbcd89741f4b4057ad5053f5b986` |

Capability inventory regenerated from the matrix: **435** capabilities =
**370 READ_ONLY**, **52 AVAILABLE**, **7 BLOCKED_DEPENDENCY**, **6 DISABLED**
(unchanged). The artifact state is not runtime authorization: `AVAILABLE`
means the bridge can expose the route; every call still needs mTLS, the HQ
HMAC key, a valid staff assertion, exact scope, the owner's signed policy and
— for domain commands — execution that the bridge currently refuses
(`capability_blocked`). Karryam Admin pins these hashes and counts in
`services/karryam-admin/src/bridge/contracts/karrygo-backoffice-v1.json` and
re-verifies them in a test when a KarryGo checkout is present.

Signing and authentication profile verified in source:

- Transport: TLS 1.3 minimum, `RequireAndVerifyClientCert`
  (`internal/config/config.go`), fixed principal `cosmicforge-hq-karryam-admin`.
- HMAC v2: canonical lines `2, service, METHOD, request URI, unix seconds,
  nonce, hex sha256(body)`, hex HMAC-SHA256 (`shared/go/serviceauth.signatureFor`).
- Staff assertion: Ed25519 JWS, `alg=EdDSA`, `typ=JWT`, pinned `kid`; claims
  `iss, sub, aud, product, roles, permissions, market_scopes,
  organization_scopes, (zone_scopes, tenant_scopes), session_id, auth_time,
  acr, jti, iat, nbf, exp, request_digest` (`internal/security/assertion.go`).
- `request_digest` = sha256(`METHOD LF RequestURI LF "karryam" LF hex sha256(body)`)
  (`security.Digest`).
- Base path `/internal/karryam-admin/v1`; every route needs `market`,
  `organization`, `purpose` query parameters.

Release status (`docs/admin-bridge/sections-16-38-final-report.md`,
`a-z-final-security-and-release-gates.md`, `runbook.md`): staging-only,
**not END_TO_END_CERTIFIED and not PRODUCTION_READY**; no Centralized Admin
caller, production key, signed policy, staff grant or rollout approval exists;
several scope mappings remain `BLOCKED_POLICY`. No breaking change or drift
since the previous audit.

## 1.3 Centralized Admin

| Area | Finding at `680b315` |
|---|---|
| `apps/central-admin-web` | Existing Next.js app; no product registry consumer. Unchanged by this work. |
| `services/central-admin-api` | Express 5 + Prisma. Auth: server-side sessions, cookie/bearer, CSRF, MFA (`requireRecentMfa`), RBAC tiers + section grants. `requireSection` lets `SUPER` bypass — therefore **not** reused for product access. |
| `services/karryam-admin` | README-only placeholder. |
| `services/healthnet-admin` | Real independent service (read-only `/v1/dashboard/*`, HS256 HQ service JWT). Not Protocol v1; not connected to HQ. |
| `packages/*` | README-only placeholders. |
| `admin-ops` | `admin_ops_service_registry` in the main DB — an ops service list, not a product registry. Not reused. |
| Sections 3–5 components | None existed before this work. |
| Deployment | `staging.yml` auto-builds and deploys the API image to the staging VPS on pushes that change `services/central-admin-api/**` (non-test). No DB migrations run. Root `Dockerfile` copies only the API directory; `.dockerignore` excludes `packages/`. |

Legacy direct database dependency:
`services/central-admin-api/src/modules/karrygo/dispatch/dispatch.service.js`
reads and writes Karryam operational tables through `dispatchPrisma`
(`DISPATCH_DATABASE_URL`). Its router is **not mounted** in `src/app.js`, so it
serves no traffic today. It is kept unchanged functionally, now emits
`legacy_direct_db_route` telemetry if ever mounted, is guarded by a test that
fails if it gets mounted, and the cutover requirement is documented in
`src/modules/karrygo/dispatch/LEGACY_CUTOVER.md`. No new code uses it.

## 1.4 PR #36 audit

15 files, 10 commits on base `cfff5b2`. It still merges without textual
conflicts, and the shared files it edits (`app.js`, `Sidebar.tsx`, `README.md`)
have not changed since its base.

| Component | Verdict | Where it went |
|---|---|---|
| HMAC v2 canonical signing | Matches KarryGo exactly | Ported to `services/karryam-admin/src/bridge/client/signing.js` |
| Ed25519 staff assertion + request digest | Matches KarryGo claims and digest | Ported (same module) |
| TLS 1.3 mTLS bridge client, fixed capabilities path, bounded response | Valid | Ported, plus pinned private address (no DNS) |
| Bridge origin validation | Valid | Ported with tests |
| Non-root Unix-socket container | Valid pattern | Reused in both new Dockerfiles |
| Local delegation (`X-CF-HQ-Delegation` HMAC, tier→role map) | Replaced | Generic `cf-product-delegation+jwt`; bridge role mapped from the explicit product-grant role, never staff tier |
| HQ route `GET /api/karryam/capabilities` (direct socket caller in HQ) | Not reused | PR was never merged or deployed and has no consumer; replaced by generic `/api/products/:productId/capabilities` through PIC → Karryam Admin |
| `Sidebar.tsx`, `dashboard/karryam/page.tsx`, `app.js` snapshots | Not imported | Frontend unchanged; the page still has the unescaped apostrophe (`Karryam's`, line 60) that failed lint |
| `karryam-admin-ci.yml` | Superseded | `product-admin-platform-ci.yml` |

PR #36 itself is left open and untouched.
