# CF Meet Admin go-live: connecting HQ to the CF Meet Admin Bridge

Joint checklist for HQ (centralize-admin) and CF Meet (cfmeet). It covers
everything between "code is built" and "CF Meet Admin reads are live in HQ
staging". The HQ half is maintained here. The CF Meet half is drafted by the
CF Meet bridge track and lives in `docs/operations/admin-bridge-runbook.md` in
the cfmeet repository (cfmeet PR #133). Where the two differ, stop and
reconcile them before continuing.

**Who does what.** Host steps (tunnel, S1/S2, CF Meet releases) are privileged
operator steps. Coding agents never access either host. HQ host steps run
through the `Product Admin staging operations` GitHub Actions workflow.
**Secrets never go into git, chat, tickets or CI logs.** Operators carry them
as sealed files.

## Where things stand (2026-11-20)

| Item | State |
|---|---|
| HQ: `services/cfmeet-admin` | Built. The image is built and smoke-tested in CI. In staging it starts with every flag off |
| HQ: pinned Bridge contract | cfmeet `main` `568328cc`, contract 1.2.0. Read-only: the 4 platform reads plus the 8 Organizations reads |
| HQ: egress | `cf-staging-cfmeet-bridge` (`10.231.14.0/28`) may reach only `PA_CM_BRIDGE_ADDRESS:8460`, enforced in DOCKER-USER and rehearsed in Infrastructure Security CI |
| CF Meet: Bridge runtime | Merged (cfmeet #122) but **not running anywhere**. The release tool only knows the service after cfmeet #133 (dark deployment) merges |
| CF Meet: event feed | `hq.events.feed`/`hq.events.ack` are BLOCKED_DEPENDENCY until CF Meet phase A7. The HQ worker skips the feed while the pin says it is not served, and only pulls datasets |
| CF Meet: datasets | `bridge.datasets.read` is served, but nothing writes dataset days yet. Every dataset returns coverage NONE with null metrics |
| CF Meet: commands | All DISABLED until CF Meet phase A3 |

## Gates (decisions, not technical steps)

| Gate | Decision | Owner |
|---|---|---|
| G1 | HQ **staging** connects to CF Meet **production**; CF Meet has one environment. **Decided 2026-11-20 by the product owner: read and modify, full functionality.** Every command still goes through HQ's governance: allowlist, independent approval for R3/R4 and two-person commands, audit, and readback on an unknown outcome. Commands only become possible as CF Meet serves them (see step 7) | Product owner (decided) |
| G2 | A window in CF Meet's single production release slot, to merge #133 and run the dark release. It is shared with the CF MEET and CF Meet Platform sessions, and needs their "slot free" plus the owner's go-ahead | Product owner, CF Meet release |
| G3 | Each HQ stage S3–S7 is closed with `complete-stage` evidence and an independent approver | HQ operator, approver |

## Agreed values (not secret)

| Setting | HQ (`cfmeet-admin.env`) | CF Meet bridge |
|---|---|---|
| Tunnel | HQ end `10.250.0.2` | `10.250.0.1`, `ADMIN_BRIDGE_HQ_LISTEN_ADDRESS=10.250.0.1`, `ADMIN_BRIDGE_HQ_ALLOWED_SOURCE=10.250.0.2` |
| Endpoint | `CFMEET_BRIDGE_ORIGIN=https://admin-bridge.cfmeet.internal:8460`, `CFMEET_BRIDGE_ADDRESS=10.250.0.1`; repository variables `PRODUCT_ADMIN_CM_BRIDGE_ADDRESS=10.250.0.1`, `PRODUCT_ADMIN_CM_BRIDGE_PORT=8460` | nginx stream passthrough on `10.250.0.1:8460` to the bridge on 8443; 8460 allowed only on `wg0` from `10.250.0.2` |
| HQ client identity | `CFMEET_BRIDGE_CLIENT_URI=cf://staging/product-admin/cfmeet` | `ADMIN_BRIDGE_HQ_WORKLOAD_URI=cf://staging/product-admin/cfmeet` |
| Bridge-internal | (none) | `CF_ORGANIZATIONS_BASE_URL` (set by `activate-admin-bridge`); the bridge's own signing key `CF_SERVICE_AUTH_KEY_ID` / `CF_SERVICE_AUTH_PRIVATE_KEY_FILE` (from the release template) |
| Signing | `CFMEET_BRIDGE_ISSUER=cosmicforge-hq`, `CFMEET_BRIDGE_AUDIENCE=cfmeet-admin-bridge` | `enroll-staff-key --issuer cosmicforge-hq --audience cfmeet-admin-bridge` |
| Key ids | `CFMEET_BRIDGE_SERVICE_KID=hq-cfmeet-hmac-2026-11`, `CFMEET_BRIDGE_STAFF_KID=hq-cfmeet-staff-2026-11` | the same kids at enrolment |
| Scope | `CFMEET_ADMIN_MARKET=GLOBAL`, `CFMEET_ADMIN_ORGANIZATION=cfmeet`, `CFMEET_ADMIN_ZONES=production` | `ADMIN_BRIDGE_ENROLLED_MARKETS=GLOBAL`. There is no bridge-side zone setting: the zone is enforced per request against HQ's token `zone_scopes`, so production-only is decided by `CFMEET_ADMIN_ZONES` |
| Tenant | `CFMEET_ADMIN_TENANTS=<first-party Platform Access tenant UUID>`, lowercase. Staging refuses anything else | `ADMIN_BRIDGE_ENROLLED_TENANTS=<the same UUID>`, lowercase enforced. The operator reads it from Platform Access (the FIRST_PARTY tenant) at S3 |
| Assurance | `CFMEET_ADMIN_ACR=urn:cosmicforge:acr:mfa`; feed `CFMEET_BRIDGE_FEED_ACR=urn:cosmicforge:acr:workload` | `ADMIN_BRIDGE_STRONG_ACR`, `ADMIN_BRIDGE_WORKLOAD_ACR` with the same values |
| Roles | `CFMEET_ADMIN_ROLE_MAP` is the identity map over `cfmeet.viewer`, `cfmeet.support`, `cfmeet.trust_safety`, `cfmeet.verification.reviewer`, `cfmeet.partner_ops`, `cfmeet.finance`, `cfmeet.pricing.editor`, `cfmeet.pricing.approver`, `cfmeet.platform_ops`, `cfmeet.security_admin`, `cfmeet.release_manager`; worker `CFMEET_BRIDGE_FEED_ROLE=cfmeet.source_sync` | the same 11 staff roles plus `cfmeet.source_sync` in the signed access policy |
| Worker | `CFMEET_BRIDGE_FEED_SUBJECT=hq-cfmeet-worker`; `CFMEET_BRIDGE_FEED_CONSUMER=<any approved name>` (it only matters for ACK, from A7) | the subject is not pinned |

## Steps

### 1. Private tunnel (operators, both hosts; can start now)

1. Configure WireGuard peers on the HQ staging host (`10.250.0.2`) and the CF
   Meet host (`10.250.0.1`), on `10.250.0.0/30`. Addresses are RFC 1918 only;
   HQ refuses `100.64/10`.
2. On CF Meet: allow TCP 8460 only on `wg0`, only from `10.250.0.2`.
3. On HQ: set the repository variables `PRODUCT_ADMIN_CM_BRIDGE_ADDRESS=10.250.0.1`
   and `PRODUCT_ADMIN_CM_BRIDGE_PORT=8460`. The HQ host must not publish 8460.

### 2. HQ S1/S2 (HQ operator; no CF Meet dependency)

Follow `infrastructure/product-admin/staging/README.md`. Run `prepare-host`
(including the CF Meet network and egress rules), write the env and secret
files, prepare the database roles, `preflight`, `migrate-apply`, `deploy`,
`attach-gateway`, then `complete-stage S1`/`S2`. CF Meet Admin is deployed with
`CFMEET_ADMIN_ENABLED=false`, `CFMEET_BRIDGE_ENABLED=false` and
`CFMEET_BRIDGE_FEED_ENABLED=false`.

### 3. CF Meet dark release (CF Meet; gate G2)

Merge cfmeet #133, then run a coordinated release: bridge database, roles,
migrations, container, every `ADMIN_BRIDGE_*` flag off. See the CF Meet
runbook.

### 4. S3 trust enrolment (both sides)

**HQ generates its keys on the HQ host.** The private keys never leave it.
Write them under `/etc/cosmicforge/staging/secrets/cfmeet-admin/` (dir 0750
root:10003, files 0440).

```sh
cd /etc/cosmicforge/staging/secrets/cfmeet-admin
# mTLS client key and CSR: EC P-256 / SHA-256, EKU clientAuth, exactly one URI SAN
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out bridge-client.key
openssl req -new -sha256 -key bridge-client.key -subj "/CN=cosmicforge-hq-cfmeet-admin" \
  -addext "subjectAltName=URI:cf://staging/product-admin/cfmeet" \
  -addext "extendedKeyUsage=clientAuth" -out bridge-client.csr
# Ed25519 staff assertion key, and its raw public key as 64 hex characters
openssl genpkey -algorithm ED25519 -out bridge-staff-ed25519.pem
openssl pkey -in bridge-staff-ed25519.pem -pubout -outform DER | tail -c 32 | xxd -p -c 64
```

**HQ → CF Meet (sealed):** `bridge-client.csr`, the staff public key hex, and
the staff kid `hq-cfmeet-staff-2026-11`. These are public material, but they
still travel through the operator channel so they cannot be swapped in transit.

**CF Meet → HQ (sealed):**

- `bridge-client.pem`: the signed client certificate.
- `bridge-ca.pem`: the bundle of CF Meet's private CA that issued
  `admin-bridge.cfmeet.internal`.
- The sha256 fingerprint of the `admin-bridge.cfmeet.internal` leaf, which goes
  in `CFMEET_BRIDGE_SERVER_FINGERPRINTS`.
- `bridge-hmac-key`: the HMAC v2 key, generated on the CF Meet side as base64url
  text of at least 32 bytes:
  `head -c 32 /dev/urandom | basenc --base64url -w0 | tr -d '='`.
  **It is the identical file on both sides.** HQ reads it as `bridge-hmac-key`;
  the bridge reads it as `ADMIN_BRIDGE_HMAC_KEY_DIR/hq-cfmeet-hmac-2026-11.key`.
  Both decode it, and the bridge refuses a raw binary file.

**CF Meet enrols HQ** with `admin-bridge-admin`: `enroll-cert`,
`enroll-hmac --kid hq-cfmeet-hmac-2026-11`,
`enroll-staff-key --kid hq-cfmeet-staff-2026-11 ... --issuer cosmicforge-hq --audience cfmeet-admin-bridge`.
Then `policy-ceiling` → edit → `policy-sign` (offline) → `policy-put`, for
policy revision 1: read-only, the 11 staff roles plus `source_sync`,
Organizations reads plus discovery, health and datasets.

**CF Meet activates the bridge for HQ** with the gated release operation
`activate-admin-bridge-hq` (`confirm=hq-enrolled-read-only`). It changes
nothing unless all of the following hold:

- HQ's client certificate and staff key are enrolled and valid for at least
  another day;
- the decoded sha256 of the staged HMAC file equals its enrolment;
- the pinned read-only policy revision is stored and is the newest.

It then enables the bridge (writes stay off), checks `/ready`, and only then
installs the relay on `10.250.0.1:8460`, admitting only `10.250.0.2` (TLS
passthrough). Until the relay exists, HQ sees *connection refused* on 8460,
not a TLS error. Rollback removes the relay first, then returns the bridge to
dark.

**HQ enables trust:** fill in the Bridge section of `cfmeet-admin.env` with the
agreed values, set `CFMEET_ADMIN_ENABLED=true` and `CFMEET_BRIDGE_ENABLED=true`,
then redeploy. cfmeet-admin refuses to start if anything is wrong. For example:

- the client certificate URI or expiry is wrong;
- the client key does not match the certificate;
- the CA file is not a CA;
- the tenant is not a lowercase UUID;
- the contract is not pinned.

**Prove S3:** through HQ, `bridge.health.read` and `bridge.capabilities.read`
(scoped discovery) succeed for a staff member with a CF Meet grant. Record the
evidence, then `complete-stage S3`.

### 5. S4 sync pilot (limited until CF Meet A7)

Set `CFMEET_BRIDGE_FEED_ENABLED=true` with the worker settings above. While the
pinned contract does not serve `hq.events.feed`, the worker logs
`bridge_event_feed_not_served` and only pulls datasets. Expect every dataset to
show coverage NONE with null metrics. S4 proves the `cfmeet.source_sync`
identity and the honest-empty path, **not real figures**. Real event
synchronization starts once CF Meet A7 is pinned.

### 6. S5 reads in HQ

On CF Meet: run the activation `activate-admin-bridge` for the Organizations
grants and set `ADMIN_BRIDGE_MODULE_ORGANIZATIONS=true`. On HQ: grant staff the
CF Meet product roles they need. The HQ web pages for CF Meet are frontend
work. Re-pin HQ as further CF Meet slices merge; each slice switches on more
reads.

### 7. S6 commands (owner approved "read and modify"; gated on CF Meet A3)

Every CF Meet command is DISABLED in the contract until CF Meet phase A3.
HQ cannot switch on a command the Bridge does not serve:
`CFMEET_ADMIN_ENABLED_COMMANDS` refuses any capability that is DISABLED or
BLOCKED_DEPENDENCY in the pin. As each command family is served:

1. **CF Meet:** serve the command in the contract and set
   `ADMIN_BRIDGE_WRITES_ENABLED=true`. Sign a new access policy revision that
   adds the command permissions for the right roles, then `policy-put`.
2. **HQ:** re-pin, then list the command ids in `CFMEET_ADMIN_ENABLED_COMMANDS`.
   Before an R3/R4 command is exposed, its high-risk certification must be in
   force (Section 11.3).
3. **Governance (unchanged):** every command needs an Idempotency-Key and is
   audited. R3/R4 and two-person commands need an independent approver (12 h
   approvals). An unknown outcome is settled by reading back, never by
   resending.
4. Record the evidence, then run `complete-stage S6`.

## Rollback

- **HQ:** set `CFMEET_BRIDGE_ENABLED=false` (and `CFMEET_BRIDGE_FEED_ENABLED=false`),
  then redeploy, or run the workflow's `disable` operation.
- **CF Meet:** set `ADMIN_BRIDGE_ENABLED=false`. Revoke HQ with
  `revoke-principal` and `revoke-staff`, and check the audit chain with
  `verify-audit-chain`.
- **Tunnel:** take down the WireGuard peer. HQ's egress rule then reaches
  nothing.

## Resolved with CF Meet

- The client key is EC P-256 with SHA-256 (the bridge also accepts P-384 and
  Ed25519), with EKU clientAuth and exactly one URI SAN.
- The HMAC key file is the identical base64url file on both sides. The bridge
  change ships in cfmeet #134, before any deployment.
