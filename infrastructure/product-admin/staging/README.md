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
| [`cfmeet-admin-db-roles.sql`](cfmeet-admin-db-roles.sql), [`cfmeet-admin.env.template`](cfmeet-admin.env.template) | CF Meet Admin database roles and configuration template (see [section 7](#7-cf-meet-admin-cfmeet)) |
| `*.env.template` | Sanitized configuration templates (no values) |
| [`../nginx/internal-deny.conf`](../nginx/internal-deny.conf) | Public-ingress guard to `include` in the API server block |
| [`../firewall/docker-user-rules.sh`](../firewall/docker-user-rules.sh) | DOCKER-USER host rules (UFW alone does not filter published Docker ports) |
| [`../release/`](../release/) | Host operations, S0–S7 state machine, evidence collection, CI rehearsal fixtures |
| [`../monitoring/`](../monitoring/) | Metrics, alert rules, recovery notes |

## Existing staging SSH identity — read-only connection check

The Product Admin workflow now reuses the protected GitHub `staging` environment and
the existing `STAGING_SSH_KEY` secret. As in the established `staging.yml`,
the already-verified host `173.249.30.55` and deploy account
`cf-staging-deploy` are pinned directly in the workflow rather than
assuming the optional `STAGING_HOST`/`STAGING_USER` environment secrets
contain those values.
Do **not** create a second SSH key or a `product-admin-staging` environment for
this initial check. It checks the pinned Contabo host and the established
`cf-staging-deploy` account against the existing SSH client and server key fingerprints.

The Product Admin workflow currently exists only on `staging`, while `main`
is the repository's default branch. GitHub may therefore hide its **Run workflow**
button. **Every push to `staging` that changes this workflow or Product Admin
infrastructure now automatically executes the read-only `connection-check`**
using the protected `staging` environment. Inspect the resulting Actions run
and its `Host connection-check` job; do not attempt a manual dispatch.
The check only reads the remote account, existing staging directory and Docker
project metadata. It does not upload a bundle, write files or start services.

**Privilege boundary:** the Product Admin host script performs root-only S1/S2
operations. The reused `cf-staging-deploy` account is not root. Other host
operations fail with `BLOCKED_PRIVILEGED_HOST_OPERATION` until a trusted
operator independently provisions and audits a narrowly scoped privileged
entry point. Never grant passwordless sudo for an uploaded, mutable script.
Application and Bridge keys remain under `/etc/cosmicforge/staging` on the VPS.
The successful connection check additionally records a **read-only VPS inventory**
as the `product-admin-staging-readonly-inventory.json` Actions artifact.
It reports the expected container/network presence, Docker access, and whether
the staging secret/release directories are visible to the deploy account. It
does not read secret values or modify anything. This inventory is *not* S1/S2
certification; do not mistake missing directory visibility for permission to
perform root operations.

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
   file modes, DOCKER-USER rules (exact set), no wildcard 5432/8110/8460 listener.
4. `db-audit`: unprivileged roles, no HQ roles on DB-B and no Karryam roles on
   DB-A, PUBLIC CONNECT revoked on `cosmicforge_admin`.

The same operations run on every CI push in the **rehearsal** job of
[Infrastructure Security CI](../../../.github/workflows/product-admin-infrastructure-ci.yml)
against disposable stand-ins; rehearsal evidence is labelled `rehearsal` and
can never satisfy a staging stage or gate.

## 7. CF Meet Admin (`cfmeet`)

CF Meet Admin (`services/cfmeet-admin`, product `cfmeet`) is the second
Product Admin. When included in a release (see the rule below) it runs in the
same compose project as Karryam Admin, with the same hardening, and shares **nothing** with it: own uid/gid,
own socket directory, own Bridge network, own database server, own keys.
Design: [`docs/product-admin/cfmeet-admin-design.md`](../../../docs/product-admin/cfmeet-admin-design.md).

| Item | Value |
|---|---|
| Services | `cfmeet-admin`, `cfmeet-admin-worker` (Stage A, `node src/worker/index.js`, same image), `cfmeet-admin-db` |
| Container user | `10003:10003` (Karryam Admin is 10001, PIC 10002) |
| Socket | host `${PA_HOST_ROOT}/run/cfmeet-admin` (dir `10003:10003 0750`), container `/run/cosmicforge/cfmeet/cfmeet-admin.sock` (`0660`); PIC mounts it read-only with `group_add: ["10003"]` |
| Networks | `cf-staging-cfmeet-bridge` `10.231.14.0/28`: CF Meet Admin + worker egress to the CF Meet Admin Bridge on CF Meet's own host, over the private tunnel at `PA_CM_BRIDGE_ADDRESS:8460` (TLS 1.3 mTLS). It is the only **non-internal** Product Admin network; the DOCKER-USER egress allowlist permits exactly that one destination and drops everything else (see [CF Meet Bridge connectivity](#cf-meet-bridge-connectivity-private-tunnel)). `cf-staging-cfmeet-admin-db` `10.231.15.0/28` (internal): CF Meet Admin + worker to `cfmeet-admin-db`. No HQ component joins either, no Bridge container joins either, and Karryam services never join them |
| Database | `cfmeet_admin` on `cfmeet-admin-db`; owner `cfmeet_admin_migrator`, runtime `cfmeet_admin_runtime` (no UPDATE/DELETE on append-only audit), from [`cfmeet-admin-db-roles.sql`](cfmeet-admin-db-roles.sql) |
| Identity | instance `cfmeet-admin-staging-1`, workload `cf://staging/product-admin/cfmeet`, manifest signer kid `cfmeet-staging-manifest-2026-11` (Ed25519) |
| Bridge | base `/internal/cfmeet-admin/v1`, HQ principal `cosmicforge-hq-cfmeet-admin`; owned and enrolled by the CF Meet team |

Operator files (root-owned, same modes as Karryam Admin):

| Host path | Mode | Container path | Files |
|---|---|---|---|
| `/etc/cosmicforge/staging/cfmeet-admin.env` | 0600 | (compose env) | from [`cfmeet-admin.env.template`](cfmeet-admin.env.template); `CFMEET_ADMIN_ENABLED=false`, `CFMEET_BRIDGE_ENABLED=false`, `CFMEET_BRIDGE_FEED_ENABLED=false` |
| `/etc/cosmicforge/staging/cfmeet-admin.migrate.env` | 0600 | one-shot migration container only | see [`migrate.env.template`](migrate.env.template) |
| `/etc/cosmicforge/staging/secrets/cfmeet-admin/` | dir 0750 root:10003, files 0440 | `/run/secrets/cfmeet-admin` (ro) | `hq-service-keys.json`, `delegation-keys.json`, `manifest-signer.pem`, `cursor-key`, Bridge `bridge-ca.pem`, `bridge-client.pem`, `bridge-client.key`, `bridge-hmac-key`, `bridge-staff-ed25519.pem` |
| `/etc/cosmicforge/staging/secrets/cfmeet-admin-db/` | dir 0750 root:70, file 0440 | `/run/secrets/cfmeet-admin-db` (ro) | `postgres-password` (cfmeet-admin-db superuser; never given to a service) |

PIC needs two more entries, then a restart (`deploy`): endpoint
`cfmeet-staging` (`transport: unix`, `socket_path:
/run/cosmicforge/cfmeet/cfmeet-admin.sock`, its own service and delegation
keys) in `endpoints.json`, and signer `cfmeet-staging-manifest-2026-11` in
`trusted-signers.json`. Shapes: [`../endpoints.example.json`](../endpoints.example.json),
[`../trusted-signers.example.json`](../trusted-signers.example.json),
[`../cfmeet-admin-keys.example.json`](../cfmeet-admin-keys.example.json).
Every CF Meet key is at least 32 random bytes and differs from every Karryam
and HQ key.

The service starts **disabled** (ready 503) until the operator enables it
after S1. Stages S0–S7 are the same as for Karryam (design section 9). As
for Karryam, the privileged S1/S2 host steps (networks, directories, roles,
backup, migrations, deploy) cannot run from GitHub Actions today
(`BLOCKED_PRIVILEGED_HOST_OPERATION`): an authorized operator runs them on
the server unless a narrowly scoped elevation path is approved first.

CF Meet Admin is **optional** in a release (`release/pa-staging-ops.sh`):

- **The rule.** CF Meet Admin joins a release iff `PA_CM_IMAGE` is set to a
  `cfmeet-admin@sha256:<digest>` (revision label = release commit) **and**
  `/etc/cosmicforge/staging/cfmeet-admin.env` exists. Otherwise the release is
  PIC + Karryam Admin exactly as before, and existing Karryam-only deploys
  need no CF Meet files.
- **Partial setup is refused.** `PA_CM_IMAGE` set but `cfmeet-admin.env`,
  `run/cfmeet-admin`, `secrets/cfmeet-admin-db/postgres-password` or a
  `cf-staging-cfmeet-*` network missing: `deploy` stops before anything
  changes. `cfmeet-admin.env` present but no `PA_CM_IMAGE`: the release is
  PIC + Karryam only and the log says CF Meet Admin was skipped.
- **Decided once, recorded.** `deploy` writes the decision into the release's
  `images.env` (`CFMEET_ADMIN_IMAGE` and `CFMEET_ADMIN_DB_IMAGE`, the same
  PostgreSQL digest as DB-B, present or absent). `verify`, `network-probe`,
  `status`, `db-audit`, `backup`, `migrate-preview`/`migrate-apply`,
  `rollback` and `disable` read it from there. The compose profile `cfmeet` is
  activated only for such a release, and explicit service lists mean no
  cfmeet container is created otherwise.
- **Not deployed means skipped, never failed or passed.** Checks that need CF
  Meet running (`pic_to_cfmeet_socket`, `bridge_network_reachable_only_from_cfmeet`,
  `migration_*_cfmeet`) report `SKIPPED_NOT_DEPLOYED`. Stage evidence records
  `pic_to_cfmeet_socket` as `NOT_APPLICABLE` (allowed only because S2 lists it
  in `optional_product_checks`), and the S1 migration composites leave the
  CF Meet part out while every other part must pass. Isolation checks that
  assert the *absence* of CF Meet paths still run: no CF Meet roles in
  DB-A/DB-B, no route to `cfmeet-admin-db`, and Karryam Admin cannot reach
  the CF Meet socket.
- **Rollback.** A release without `CFMEET_ADMIN_IMAGE` (including any
  release from before CF Meet support) is a valid target: PIC + Karryam are
  restored and any running CF Meet containers are stopped (their data volume
  is kept).
- **Host preparation.** `prepare-host` always creates `cf-staging-cfmeet-bridge`
  and `cf-staging-cfmeet-admin-db` (`PA_SUBNET_CMBRIDGE`, `PA_SUBNET_CMDB`),
  `run/cfmeet-admin` (10003:10003 0750), the CF Meet secret directories and the
  DOCKER-USER rules for both subnets. PIC always bind-mounts the (empty)
  `run/cfmeet-admin` directory read-only with `group_add` 10003; `deploy`
  creates that empty directory if a host prepared before CF Meet support
  lacks it. Re-run `prepare-host` (idempotent) on such a host to add the
  networks and firewall rules; until then `preflight` reports the CF Meet
  networks as "not created" without failing, but the firewall verification
  lists their DOCKER-USER rules as missing.
- **Cross-product credentials** fail preflight whenever the files exist, for
  example a `KARRYAM_*` variable in `cfmeet-admin.env` or a CF Meet variable
  in `karryam-admin.env`.
- **CI.** `product-admin-staging-ops.yml` builds and passes the CF Meet image
  only with `include_cfmeet=true`, or for automatic delivery when the
  repository variable `PRODUCT_ADMIN_STAGING_CFMEET` is `true`.
  `product-admin-release-staging.yml` builds and publishes it only with
  `include_cfmeet=true`.
- Each Stage A worker runs only when its own `*_BRIDGE_FEED_ENABLED=true`.

### CF Meet Bridge connectivity (private tunnel)

The CF Meet Admin Bridge does **not** run on the HQ staging host. It runs on
CF Meet's own host and listens on TCP **8460** (an nginx stream passthrough to
the Bridge's TLS 1.3 mTLS listener). Its base path is `/internal/cfmeet-admin/v1`,
and its server certificate carries the DNS SAN `admin-bridge.cfmeet.internal`
from CF Meet's private CA. The owner chose a **private tunnel** between the two
hosts (WireGuard or equivalent). Karryam's model, with the Bridge container
attached locally to `cf-staging-karryam-bridge` on :8110, is unchanged.

**This is a privileged operator step (S1/S2), done by an authorized operator on
both hosts.** It is not run by GitHub Actions or by a coding agent
(`BLOCKED_PRIVILEGED_HOST_OPERATION`, as for the rest of S1/S2).

Operator steps:

1. **Tunnel.** Configure WireGuard peers on the HQ staging host and on the CF
   Meet host over a dedicated /30, for example `10.250.0.0/30`: CF Meet host
   `10.250.0.1` (the bridge address HQ connects to), HQ host `10.250.0.2`. The
   tunnel addresses must be **RFC 1918** (10/8, 172.16/12 or 192.168/16).
   **Never 100.64/10 (CGNAT):** HQ's shared `isPrivateAddress` refuses it, so
   cfmeet-admin, `prepare-host` and `deploy` would all refuse it too. The
   addresses must not overlap any `cf-staging-*` subnet (10.231.10–15.0/28).
2. **CF Meet side.** Over the tunnel, allow only TCP 8460 from HQ's tunnel IP.
   Set CF Meet's `ADMIN_BRIDGE_HQ_ALLOWED_SOURCE` to HQ's tunnel IP
   (`10.250.0.2`). Docker masquerades CF Meet Admin's traffic to that address.
3. **HQ side.** Run `prepare-host` with `PA_CM_BRIDGE_ADDRESS=10.250.0.1`
   (`PA_CM_BRIDGE_PORT` defaults to 8460). The workflow takes these from the
   repository variables `PRODUCT_ADMIN_CM_BRIDGE_ADDRESS` and
   `PRODUCT_ADMIN_CM_BRIDGE_PORT`. `prepare-host` validates the address
   (RFC 1918, outside every cf-staging subnet) and creates
   `cf-staging-cfmeet-bridge` **without** `--internal`. It then installs the
   egress allowlist in DOCKER-USER (and INPUT):
   - **Allowed:** from `10.231.14.0/28`, NEW and ESTABLISHED TCP to
     `PA_CM_BRIDGE_ADDRESS:PA_CM_BRIDGE_PORT` only, plus its replies.
   - **Dropped from that subnet:** every other egress (internet, DNS, other
     ports on the CF Meet host, other `cf-staging` subnets) and any connection
     to the HQ host itself.
   - **Nothing else may open the bridge address:** PIC, Karryam Admin and the
     HQ API are refused.
   - **The HQ host must not publish 8460:** it joins 5432/8110 in the
     public-listener refusal list.
   - **Without `PA_CM_BRIDGE_ADDRESS`:** the subnet gets no egress at all.
   - **Re-pointing the address:** re-running `prepare-host` with another
     address replaces the allowlist exactly. `verify` checks the exact rule
     set: every expected rule is present and no extra tagged rule exists.
4. **Deploy.** A release with CF Meet Admin is refused unless all of these hold:
   - `PA_CM_BRIDGE_ADDRESS` is set and valid;
   - the allowlist for that exact address and port is in place;
   - `CFMEET_BRIDGE_ADDRESS` and the port in `CFMEET_BRIDGE_ORIGIN`, in
     `cfmeet-admin.env`, match it.

   The values are recorded in the release's `images.env`.
5. **Verification** (`deploy` and `network-probe`, check
   `bridge_network_reachable_only_from_cfmeet`):
   - **PASS:** CF Meet Admin opens `PA_CM_BRIDGE_ADDRESS:8460`, and cannot reach:
     - the internet (443, 53);
     - the HQ host;
     - another port on the bridge host;
     - the HQ database.

     PIC, Karryam Admin and the API cannot open the bridge address.
   - **PENDING_EXTERNAL:** the tunnel or the Bridge is not up yet. Isolation is
     still verified; this is never reported as a pass.
   - **FAIL:** any isolation breach.

S3 out-of-band hand-offs. These values go operator to operator through the
approved secure channel. They are **never** put in git, in chat, in tickets
or in workflow logs; secrets go only into files under
`/etc/cosmicforge/staging/secrets/cfmeet-admin/`.

| From | To | What |
|---|---|---|
| HQ | CF Meet | HQ **client certificate** (URI SAN `cf://staging/product-admin/cfmeet`) and its **CA chain**, for the Bridge's mTLS enrollment and fingerprint pin |
| HQ ↔ CF Meet | both | **HMAC key**, **key id** (`CFMEET_BRIDGE_SERVICE_KID`) and **expiry** |
| HQ | CF Meet | **Staff-token Ed25519 public key** and **kid** (`CFMEET_BRIDGE_STAFF_KID`); claims `iss cosmicforge-hq`, `aud cfmeet-admin-bridge` |
| CF Meet | HQ | **Bridge CA bundle** (`bridge-ca.pem`, CF Meet's private CA for `admin-bridge.cfmeet.internal`) and the **leaf certificate fingerprint** (`CFMEET_BRIDGE_SERVER_FINGERPRINTS`) |
| CF Meet | HQ | **Enrolled scope**: market `GLOBAL`, organization `cfmeet`, zones `production,sandbox`, tenant `first-party` (`CFMEET_ADMIN_MARKET`, `CFMEET_ADMIN_ORGANIZATION`, `CFMEET_ADMIN_ZONES`, `CFMEET_ADMIN_TENANTS`) |

The CF Meet Admin env file then names the tunnel endpoint and TLS identity:
- `CFMEET_BRIDGE_ORIGIN=https://admin-bridge.cfmeet.internal:8460`
- `CFMEET_BRIDGE_ADDRESS=<the tunnel IP of the CF Meet host>`
- `CFMEET_BRIDGE_CLIENT_URI=cf://staging/product-admin/cfmeet`

`CFMEET_BRIDGE_ENABLED` stays `false` until S3 is approved.
