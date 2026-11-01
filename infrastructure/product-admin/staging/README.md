# Product Admin services on the staging VPS (Sections 12.1–12.5)

Everything here is deployed **only** by
[`product-admin-staging-ops.yml`](../../../.github/workflows/product-admin-staging-ops.yml)
running [`release/pa-staging-ops.sh`](../release/pa-staging-ops.sh) on the host.
No coding agent connects to the VPS. Production, `main`, the Central Admin
API image, Mail and source-owned Karryam services are never touched.

| File | Purpose |
|---|---|
| [`network-policy.json`](network-policy.json) | Single source of truth: networks, members, sockets, allowed and forbidden flows, public ingress |
| [`docker-compose.yml`](docker-compose.yml) | Project `cf-product-admin-staging`: PIC, Karryam Admin, Stage A worker, DB-B |
| [`db-a-roles.sql`](db-a-roles.sql), [`db-b-roles.sql`](db-b-roles.sql) | Operator role templates for DB-A (HQ) and DB-B (Karryam Admin) |
| `*.env.template` | Sanitized configuration templates (no values) |
| [`../nginx/internal-deny.conf`](../nginx/internal-deny.conf) | Public-ingress guard to `include` in the API server block |
| [`../firewall/docker-user-rules.sh`](../firewall/docker-user-rules.sh) | DOCKER-USER host rules (UFW alone does not filter published Docker ports) |
| [`../release/`](../release/) | Host operations, S0–S7 state machine, evidence collection, CI rehearsal fixtures |
| [`../monitoring/`](../monitoring/) | Metrics, alert rules, recovery notes |

## 1. Topology

```
Internet ─ Nginx (stagingca.cosmicforge-healthnet.com) ─ 127.0.0.1:4001 ─ Central Admin API (admin-server-staging-app-1)
                                                                              │ unix socket (read-only mount, attach-gateway)
                                                       Product Integration Core ── cf-staging-hq-private ── DB-A (admin-server-staging-db-1, alias hq-db)
                                                                              │ unix socket (group 10001, 0660)
                                                       Karryam Admin + worker ── cf-staging-karryam-admin-db ── DB-B (karryam-admin-db)
                                                                              │ cf-staging-karryam-bridge, TLS 1.3 mTLS :8110
                                                       Karryam Backoffice Bridge (source-owned) ── DB-C and source DBs (source-owned)
```

All four networks are Docker `internal` networks (no route out, no
masquerade) with fixed subnets `10.231.10–13.0/28`. No container publishes a
host port. The Central Admin API never joins a Product Admin network and
reaches PIC only through PIC's socket; nothing in HQ can reach the Bridge,
DB-B or any source database (`network-probe` proves it on every deploy).
The Bridge's owner attaches it to `cf-staging-karryam-bridge` with a fixed
address (`KARRYAM_BRIDGE_ADDRESS`); the Bridge's own DB-C stays on the
owner's side.

## 2. Configuration inventory (Section 12.3)

Spec names are mapped to the variables the services actually implement; no
working variable was renamed.

**HQ (Central Admin API gateway + PIC)**

| Spec family | Implemented as | Where | Notes |
|---|---|---|---|
| `PRODUCT_INTEGRATION_ENABLED` | `PRODUCT_INTEGRATION_ENABLED` | API env | default false |
| — | `PRODUCT_INTEGRATION_CORE_SOCKET_PATH` | API env | `/run/cosmicforge/pic/product-integration-core.sock` |
| — | `PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE`, `_KID` | API env | HQ delegation key (≠ every product key) |
| `PRODUCT_INTEGRATION_REGISTRY_DB_URL` | `PIC_DATABASE_URL` | PIC env | runtime role `pic_runtime`, schema `hq_integration` |
| `PRODUCT_ADMIN_CONTRACT_TRUST_STORE_FILE` | `PIC_TRUSTED_SIGNERS_FILE` (+ `PIC_TRUST_STORE_RECHECK_SECONDS`, 1–60, default 5) | PIC | change → fail closed until restart |
| `PRODUCT_ADMIN_SYNC_WORKER_ENABLED` | `PIC_SYNC_ENABLED` (+ `PIC_SYNC_INTERVAL_SECONDS` 5–3600, `PIC_SYNC_LEASE_SECONDS` 5–600, `PIC_WORKER_ID`) | PIC | default false |
| `PRODUCT_ADMIN_DEFAULT_TIMEOUT_MS` | fixed constants (PIC→Product Admin 4 s; API→PIC gateway timeout) | code | deliberately not configurable: no unsafe value possible |
| — | `PIC_ENDPOINTS_FILE`, `PIC_HQ_DELEGATION_KEYS_FILE` | PIC | endpoints bound to product + environment |

**Karryam Admin** — every spec variable exists with the same name:
`KARRYAM_ADMIN_ENABLED`, `KARRYAM_ADMIN_DATABASE_URL`, `KARRYAM_BRIDGE_ORIGIN`,
`KARRYAM_BRIDGE_CLIENT_CERT_FILE`, `KARRYAM_BRIDGE_CLIENT_KEY_FILE`,
`KARRYAM_BRIDGE_CA_FILE`, `KARRYAM_BRIDGE_HMAC_KEY_FILE`,
`KARRYAM_BRIDGE_SERVICE_KID`, `KARRYAM_BRIDGE_STAFF_PRIVATE_KEY_FILE`,
`KARRYAM_BRIDGE_STAFF_KID`, `KARRYAM_BRIDGE_ISSUER`, `KARRYAM_BRIDGE_AUDIENCE`,
`KARRYAM_ADMIN_MARKET`, `KARRYAM_ADMIN_ORGANIZATION`, `KARRYAM_ADMIN_ACR`,
`KARRYAM_ADMIN_ROLE_MAP`; the socket is `KARRYAM_ADMIN_LISTEN=unix:<path>`
(spec `KARRYAM_ADMIN_SOCKET_PATH`). Additional implemented families: identity
(`_SERVICE_INSTANCE_ID`, `_WORKLOAD_IDENTITY`, `_BUILD_SHA`), Bridge pinning
(`KARRYAM_BRIDGE_ADDRESS`, `_CLIENT_URI`, `_SERVER_FINGERPRINTS`,
`_REVOKED_FINGERPRINTS`), scope (`KARRYAM_ADMIN_ZONES`, `_TENANTS`, never `*`),
HQ trust (`_HQ_SERVICE_KEYS_FILE`, `_DELEGATION_KEYS_FILE`,
`_MANIFEST_SIGNING_KEY_FILE`/`_KID`), continuation tokens (`_CURSOR_KEY_FILE`),
feed (`KARRYAM_BRIDGE_FEED_*`), certification (`_CERTIFIED_DATASETS`,
`_ENABLED_COMMANDS`), retention (`_INBOX_RETENTION_DAYS`). See
[`karryam-admin.env.template`](karryam-admin.env.template).

**Bridge (source-owned, never copied into HQ)** — verified in KarryGo
`services/admin-backoffice-service` (commit `a4adee68`): `ADMIN_REMOTE_ENABLED`,
`ADMIN_BACKOFFICE_DATABASE_URL` (DB-C), `ADMIN_TRUST_FILE`,
`ADMIN_ACCESS_POLICY_FILE`, `ADMIN_REMOTE_WRITES_ENABLED`; default listener
`:8110`. They are set and held by the Karryam Backoffice owner only.

### Secret mount manifest

| Host path (root-owned) | Mode | Container path | Files |
|---|---|---|---|
| `/etc/cosmicforge/staging/product-integration-core.env` | 0600 | (compose env) | runtime config |
| `/etc/cosmicforge/staging/karryam-admin.env` | 0600 | (compose env) | runtime config |
| `/etc/cosmicforge/staging/*.migrate.env` | 0600 | one-shot migration containers only | migration roles |
| `/etc/cosmicforge/staging/secrets/product-integration-core/` | dir 0750 root:10002, files 0440 | `/run/secrets/product-integration-core` (ro) | `endpoints.json`, `trusted-signers.json` (+ signer `.pem`), `hq-delegation-keys.json` |
| `/etc/cosmicforge/staging/secrets/karryam-admin/` | dir 0750 root:10001, files 0440 | `/run/secrets/karryam-admin` (ro) | `hq-service-keys.json`, `delegation-keys.json`, `manifest-signer.pem`, `cursor-key`, Bridge `bridge-ca.pem`, `bridge-client.pem`, `bridge-client.key`, `bridge-hmac-key`, `bridge-staff-ed25519.pem` |
| `/etc/cosmicforge/staging/secrets/karryam-admin-db/` | dir 0750 root:70, file 0440 | `/run/secrets/karryam-admin-db` (ro) | `postgres-password` (DB-B superuser; never given to a service) |

`preflight` fails on group-writable or world-readable files and reports
missing files as `PENDING_EXTERNAL`.

## 3. Validation (what refuses what)

Run by `deploy` inside the release images before anything changes, and by
`preflight`:

| Defect | Refused as |
|---|---|
| missing variable / unreadable file | `<NAME>_REQUIRED` / `<NAME>_UNREADABLE` (name only, never the value) |
| expired or not-yet-valid client certificate | `KARRYAM_BRIDGE_CLIENT_CERT_NOT_CURRENTLY_VALID` |
| key does not belong to the certificate | `KARRYAM_BRIDGE_CLIENT_KEY_CERT_MISMATCH` |
| CA file not a current CA | `KARRYAM_BRIDGE_CA_FILE_INVALID` / `_NOT_A_CA` / `_CA_NOT_CURRENTLY_VALID` |
| wrong workload identity (SAN) | `KARRYAM_BRIDGE_CLIENT_CERT_URI_MISMATCH` |
| revoked certificate | `KARRYAM_BRIDGE_CLIENT_CERT_REVOKED` |
| wildcard scope | `KARRYAM_ADMIN_ZONES_INVALID` / `_TENANTS_INVALID` |
| key reused across boundaries | `KEY_REUSE_ACROSS_BOUNDARIES` |
| untrusted/expired signer | PIC trust store build errors |
| wrong environment | `*_ENVIRONMENT_NOT_EXPECTED` (compose forces `staging`) |
| production endpoint in staging | `PRODUCTION_ENDPOINT_IN_STAGING` (`PRODUCT_ADMIN_PRODUCTION_DENYLIST`; absent → reported `NOT_PROVIDED`) |
| superuser runtime identity | `DATABASE_SUPERUSER_IDENTITY`; `db-audit` also checks role attributes |
| runtime = migration credential | `RUNTIME_AND_MIGRATION_CREDENTIALS_MUST_DIFFER` |
| cross-boundary credentials | `db_no_cross_credentials` FAIL (PIC env with Bridge/DB-B, Karryam env with DB-A) |
| published port, host network, privileged, missing limits, mutable image tag | `compose_policy` (resolved model + `product-admin-infra-check.mjs --require-digests`) |

## 4. Rotation and emergency revocation

- **HQ↔PIC↔Karryam Admin keys**: add the new key ID next to the old one in
  both files, `deploy` (same digests) to load them, switch the signer side,
  wait out the 60-second token window, remove the old ID, `deploy` again.
- **Manifest signer**: enroll the new public key in PIC `trusted-signers.json`;
  PIC fails closed within `PIC_TRUST_STORE_RECHECK_SECONDS` (default 5 s,
  measured in journey 11) until restarted by `deploy`.
- **Bridge client certificate**: the Bridge owner issues the new certificate;
  place cert+key (checked as a pair) and `deploy`. To revoke the old one, add
  its fingerprint to `KARRYAM_BRIDGE_REVOKED_FINGERPRINTS`.
- **Emergency**: `disable` (stops PIC, Karryam Admin and the worker; DB-B,
  receipts, audit and evidence stay), or set `revoked: true` on a key entry
  and `deploy`. Product-level: suspend/revoke through the HQ API.

## 5. Operator sequence (S0–S7)

| Stage | Workflow operation(s) | Passes only with |
|---|---|---|
| S0 | automatic in `deploy` | commit on `origin/staging`; Product Admin Platform CI, Infrastructure Security CI and Monorepo CI green **for that commit** (a path-filtered run that did not happen is a failure) |
| S1 | `prepare-host`, write env/secret files, run `db-a-roles.sql`/`db-b-roles.sql`, `preflight`, `db-audit`, `backup`, `migrate-preview`, `migrate-apply`, `public-probe`, then `complete-stage S1` with operator evidence | every S1 check PASS, operator evidence, confirm phrase |
| S2 | `deploy` (S2 recorded automatically) and `attach-gateway` | all S2 checks PASS incl. API→PIC socket |
| S3–S7 | `complete-stage Sx` with operator evidence and an independent `approved_by` | see [`../release/stages.json`](../release/stages.json) |

The release state lives on the host in `/srv/cosmicforge/staging/release`
(`state.json`, append-only `events.jsonl`, `evidence/` by sha256) and in each
run's artifacts. A later stage cannot start until earlier ones passed for the
same commit; rollback marks dependents `ROLLED_BACK` and deletes nothing.

Automatic delivery after an approved staging push is **off** until the
repository variable `PRODUCT_ADMIN_STAGING_AUTO_DEPLOY=true` is set, and even
then runs only onto a host where S1 has passed.

## 6. Staging isolation test procedure

1. `public-probe` (runner → public hostname): no private path answers 2xx/3xx
   or reveals a private service.
2. `network-probe` (host): PIC→hq-db open; PIC→DB-B, PIC→Bridge, API→Bridge,
   API→DB-B, Karryam Admin→hq-db, any→internet closed; Karryam Admin→Bridge
   open once the Bridge is attached.
3. `preflight`: networks internal with policy membership only, socket dirs,
   file modes, DOCKER-USER rules, no wildcard 5432/8110 listener.
4. `db-audit`: unprivileged roles, no HQ roles on DB-B and no Karryam roles on
   DB-A, PUBLIC CONNECT revoked on `cosmicforge_admin`.

The same operations run on every CI push in the **rehearsal** job of
[Infrastructure Security CI](../../../.github/workflows/product-admin-infrastructure-ci.yml)
against disposable stand-ins; rehearsal evidence is labelled `rehearsal` and
can never satisfy a staging stage or gate.
