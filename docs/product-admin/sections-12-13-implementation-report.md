# Sections 12–13 — infrastructure, release, testing and certification

Specification: *Karryam Admin and Centralized Admin Headquarters — Complete
Backend Implementation Specification v1.0*, Sections 12 and 13.
Branch `staging`. Report date: 1 November 2026. Starting point `3e1cd99`.

## Verdict

**SECTIONS 12–13 CODE COMPLETE AND CI-CERTIFIED ON DISPOSABLE INFRASTRUCTURE —
STAGING DEPLOYMENT AND LIVE CERTIFICATION PENDING (OPERATOR)**

Staging gates result: **`CODE_CERTIFIED_STAGING_PENDING`** — never
`FULLY_CERTIFIED` while a gate needs real staging evidence.

Everything that can be built and proven without real credentials exists and
runs in CI on every push: the hardened same-VPS layout, network policy,
Nginx guard, host firewall rules, configuration preflight, the staging
operations workflow, the S0–S7 release state machine, observability and
alert rules, recovery tests, the coverage gate, the contract audit, all
twelve business journeys and the fourteen staging gates. The complete host
procedure (prepare host → deploy by digest → probe → back up → migrate →
redeploy → second release → rollback → refused bad configuration →
emergency disable) runs as root on a disposable GitHub runner with the exact
script used on the VPS.

Nothing is live: no VPS operation was run, nothing was deployed or
migrated, no Bridge was enrolled, no command enabled, `main` and production
untouched.

## Baseline audit (before this work)

| Area | Found at `3e1cd99` | Gap closed here |
|---|---|---|
| Containers | Non-root, read-only, `cap_drop ALL`, no `EXPOSE`, disabled by default | pids/memory/CPU limits, log rotation, bounded tmpfs, `init`, digest-pinned images, enforced by a checker |
| Networks | Example compose with one internal network; no Bridge or DB networks | Four internal networks with fixed subnets and policy membership (`network-policy.json`), DB-B as its own server |
| Transport | Unix sockets 0660, stale-socket handling, mTLS for non-loopback | Socket directories, owners, group membership and mounts defined and checked; API mount via `attach-gateway` |
| Ingress | Four `^~` deny locations (prefix only) | Case-insensitive regex guard + double-encoding refusal, private health/metrics paths, Host/forwarding hardening template, 41-case raw-request probe |
| Firewall | Not addressed | DOCKER-USER rules (UFW does not filter published Docker ports), verify mode, refuses to cut existing public 5432/8110 publishers silently |
| Deployment | Image build + smoke + optional publish; **no deploy** | Staging operations workflow (protected environment), deploy by digest with automatic rollback, rehearsal in CI |
| Release stages | Runbook prose | Executable S0–S7 state machine with evidence, independent authorization, rollback |
| Configuration | Strict fail-closed loaders | Bridge key/certificate pairing, CA validity, cert expiry days, production-endpoint denylist, superuser refusal, inventory + templates |
| Observability | Sanitized PIC integration status; health routes | Prometheus metrics in both services, `/sync/status`, readiness detail, 35 alert rules, redacting loggers |
| Testing | Unit/DB/security/E2E suites; no coverage gate; no journey suite | Security coverage gate (54 modules), contract audit, required-skip detector, 12 journeys, recovery tests, 14 gates |
| Legacy | `karrygo/dispatch` uses `dispatchPrisma`; **router not mounted** | S7 inventory of all 12 routes, capability mapping, parity tool |

## Coverage matrix

### Section 12 — infrastructure and release

| Requirement | Implementation | Evidence (CI) | Remaining dependency |
|---|---|---|---|
| 12.1 topology, boundary `API → PIC → Karryam Admin → Bridge` | `staging/network-policy.json`, `staging/docker-compose.yml` | static checker on the resolved model; rehearsal `network-probe` (allowed open, forbidden closed incl. API→Bridge, PIC→Bridge, PIC→DB-B, Karryam→DB-A, any→internet) | Operator: `prepare-host` on the VPS; Bridge owner attaches the Bridge |
| 12.1 public ingress | `nginx/internal-deny.conf`, server template | real Nginx + 41 raw-request cases (encoding, double encoding, dot segments, slashes, case, `;`, `\`, NUL, absolute-form, Host spoofing, forwarded headers, no redirects) | Operator: include the snippet in the live server block; `public-probe` |
| 12.1 independent networks / allowlists | 4 internal networks, fixed subnets, membership audit | checker (35 mutation tests); rehearsal audit | as above |
| 12.1 Docker firewall | `firewall/docker-user-rules.sh` | rules applied and verified on the runner | Operator: apply on the VPS (decide on any public 5432/8110 publisher) |
| 12.1 transport | sockets 0750 dirs / 0660 sockets, group-based access, read-only reader mounts | rehearsal: socket modes/owners, PIC→Karryam socket, API→PIC socket | Operator: `attach-gateway` |
| 12.1 separate databases | DB-A (existing HQ server, schema `hq_integration`), DB-B dedicated container, DB-C source-owned | rehearsal: role templates, `db-audit` (privileges, no cross roles, PUBLIC CONNECT), runtime DDL refused | Operator: roles, credentials, PUBLIC CONNECT revocation on DB-A |
| 12.2 container security | compose hardening + checker | checker; rehearsal: uid 10001/10002/70, no ports, not privileged | — |
| 12.2 private health/metrics | `/health/live`, `/health/ready`, `/metrics`, `/sync/status` on private sockets only | observability tests; Nginx probe denies the paths | — |
| 12.2 environment separation / secrets | compose forces `staging`; denylist; key-reuse refusal; templates without values; secret scan | KA/PIC preflight tests; secret scan 0 findings | Operator: real files and `PRODUCT_ADMIN_PRODUCTION_DENYLIST` |
| 12.2 immutable images | revision + contract labels, digest references only, label = release commit | rehearsal: real registry digests, mismatched label refused | — |
| 12.2 GitHub Actions deployment | `product-admin-staging-ops.yml` (S0 job, image build/publish, protected `product-admin-staging` environment, pinned host key, root check, bundle checksum) | `validate` job on push; rehearsal of every host operation | Operator: create the environment + secrets; optionally `PRODUCT_ADMIN_STAGING_AUTO_DEPLOY=true` |
| 12.2 production protection | staging-only branch gates; no production targets; gate 14 | gate 14 PASS | — |
| 12.3 configuration inventory | `staging/README.md` §2, templates, secret manifest | — | — |
| 12.3 validation | see README §3 | `connector-security`, `staging-preflight` tests (KA, PIC) | — |
| 12.4 S0–S7 | `release/stages.json`, `release-state.mjs`, `collect-evidence.mjs` | 11 state-machine tests; rehearsal: S0–S2 PASSED, S3 BLOCKED_EXTERNAL, S4 refused, rollback recorded | Real staging evidence per stage |
| 12.4 S7 legacy | `release/s7-legacy-inventory.json`, `s7-parity.mjs` | inventory = router source; capabilities exist; router unmounted | Owner: parity captures, approval, 24 h window, removal |
| 12.4 rollback | `deploy` auto-rollback, `rollback`, `disable`, state `ROLLED_BACK` (nothing deleted) | rehearsal | — |
| 12.5 signals, metrics, logs | metrics registry + service metrics; redacting structured logs with correlation IDs | observability tests | — |
| 12.5 alerting | `monitoring/alerts.yml` (35 rules) | promtool + metric-reference test | Operator: Prometheus/Alertmanager and socket scraping |
| 12.5 recovery | recovery tests (worker restart, PostgreSQL outage, holds, PIC restart) + existing suites | `recovery-postgres`, `observability-recovery-postgres` | Live staging drill |

### Section 13 — testing and certification

| Requirement | Implementation | Evidence (CI) |
|---|---|---|
| 13.1 unit + security branch coverage | `product-admin-coverage-gate.mjs`, `coverage-policy.json` (54 modules, line and branch thresholds, unlisted security-named files fail) | `product-admin-security-coverage.json` |
| 13.1 contract | `product-admin-contract-audit.mjs` (435 capabilities, exact method/path vs pinned OpenAPI, digests, protocol 1.1, schemas regenerate, API catalog, 38 HQ gateway routes reach real PIC routes) | `product-admin-contract-audit.json` |
| 13.1 database | existing Section 9 suites + rehearsal on real roles | required-suite reports; restore-drill artifacts |
| 13.1 security integration / sync / registry / workflow / security | existing suites + journeys + recovery tests | required-suite reports (a skipped required suite fails CI) |
| 13.1 release testing | rehearsal job | `product-admin-release-rehearsal` |
| 13.2 twelve journeys | `tests/journeys-postgres.test.js` (`JOURNEYS_REQUIRED=1`) | `product-admin-e2e-journeys.json` (12/12 required) |
| 13.3 fourteen gates | `product-admin-staging-gates.mjs` | `product-admin-staging-gates.json` + `.md` (job summary) |

### Journey notes (behaviour verified, not weakened)

- **J5**: when every value is withheld during a genuine gap, the HQ envelope's
  top-level coverage is `UNKNOWN` (the protocol forbids `PARTIAL` without an
  observation time); each observation carries `PARTIAL`. A scope-filtered
  global-sequence hole is proven **not** to be a gap.
- **J9**: "approver executes" is refused as `APPROVAL_BINDING_MISMATCH`
  because the intent digest binds the requester.
- **J11**: Bridge session/certificate revocation and HQ grant revocation take
  effect on the next request; trust-file revocation is bounded by
  `PIC_TRUST_STORE_RECHECK_SECONDS` (default 5 s; measured with a 1 s window:
  last served 946 ms, first denial 994 ms).

## Staging gates (current)

| # | Gate | Status | Why |
|---|---|---|---|
| 1 | Repository integrity | PASS | on `origin/staging`, task-scoped range, no Mail/HealthNet/Marketing/auth changes |
| 2 | Product naming | PASS | `product_id=karryam`; KarryGo only for the repository, pinned contract and legacy paths |
| 3 | Database isolation | PENDING_EXTERNAL | disposable suites pass; S1 on staging needed |
| 4 | Headquarters boundary | PENDING_EXTERNAL | static policy + rehearsal probes pass; S1/S2 on staging needed |
| 5 | Private Bridge | PENDING_EXTERNAL | Bridge enrollment (S3) |
| 6 | Capability discovery | PENDING_EXTERNAL | contract audit passes; live discovery (S3) |
| 7 | Database migrations | PENDING_EXTERNAL | disposable + rehearsal pass; staging S1 |
| 8 | Synchronization | PENDING_EXTERNAL | J3–J7 + recovery pass; pilot partition (S4) |
| 9 | Product Admin Protocol | PASS | synthetic third product (J12) + conformance |
| 10 | Authorized resource reads | PENDING_EXTERNAL | J1–J2 pass; S5 |
| 11 | Governed commands | PENDING_EXTERNAL | J9–J10, high-risk suites pass; S6 (none enabled) |
| 12 | Observability and emergency recovery | PENDING_EXTERNAL | rehearsal + promtool pass; deployed services and monitoring |
| 13 | Existing platform compatibility | PASS when Social Operations CI is green for the commit | no protected module changed |
| 14 | Production separation | PASS | `main` unchanged; staging-only workflows |

## Findings and decisions

1. **Legacy `karrygo/dispatch` is not mounted** (verified, and now tested):
   it serves no traffic, so S7 is inventory, capability mapping, parity
   captures and owner-approved removal — there is no live switch to flip.
   Writes map to two-person command families (stricter than legacy, by
   design). Several mappings need the owner's confirmation of the exact
   command type (listed in the inventory).
2. **Central Admin API container runs as root** (pre-existing root
   `Dockerfile`). Not changed here (it would affect Mail storage and the
   existing deploy); it can read the PIC socket. Recommended follow-up.
3. **PIC readiness** now returns 503 after a trust-store change until restart
   (previously 200), matching its existing fail-closed behaviour for sync and
   reads.
4. **Duplicate at a newer sequence** (raised during the journey work): not
   reachable — the event digest covers the sequence, so a re-emitted event
   becomes `EVENT_ID_DIGEST_CONFLICT` (quarantine + hold for reconciliation).
5. **Timeouts** stay fixed constants (PIC→Product Admin 4 s); the spec's
   `PRODUCT_ADMIN_DEFAULT_TIMEOUT_MS` is documented as deliberately not
   configurable.
6. **Firewall port rules** refuse to apply while an existing container
   publishes 5432/8110 on a public address — that is an operator decision.
7. The staging operations workflow uses its **own** protected environment
   (`product-admin-staging`) instead of the production environment's VPS
   credentials used by Mail operations.

## CI evidence

See the delivery note of the commit that adds this report for the final
run links (Platform CI, Infrastructure Security CI, Monorepo CI, Social
Operations CI). Artifacts: `product-admin-contract-audit`,
`product-admin-security-coverage`, `product-admin-e2e-journeys`,
`product-admin-network-policy-report`, `product-admin-ingress-probe`,
`product-admin-release-rehearsal` (state, evidence, logs, image digests),
`product-admin-staging-gates`, restore-drill artifacts.

Artifact name mapping to the requested set: security test report =
`product-admin-security-coverage.json` + `*-required-suites.json`; database
certification and restore drill = restore-drill artifacts + rehearsal
`backup.log`/`migrate-apply.log`; release preflight and migration evidence =
rehearsal state/evidence (staging: the ops workflow's per-run evidence).

## Operator-only items (not done, not fabricated)

1. Create the `product-admin-staging` GitHub environment (required
   reviewers) with `PA_STAGING_VPS_HOST`, `PA_STAGING_VPS_USER` (root),
   `PA_STAGING_VPS_SSH_KEY`.
2. `prepare-host`; write env/secret files from the templates; run
   `db-a-roles.sql` / `db-b-roles.sql`; revoke PUBLIC CONNECT on
   `cosmicforge_admin` after explicit grants; include the Nginx snippet;
   `preflight`, `db-audit`, `backup`, `migrate-preview`, `migrate-apply`,
   `public-probe`, `complete-stage S1`.
3. `deploy` (S0+S2), `attach-gateway`, `network-probe`.
4. Bridge enrollment and signed READ_ONLY pilot policy (S3); pilot partition
   (S4); dataset certification and grants (S5); per-family command approval
   (S6); legacy parity, owner approval and the 24 h window (S7).
5. Monitoring stack scraping the private sockets and alert routing.
