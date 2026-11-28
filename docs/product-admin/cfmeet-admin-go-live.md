# CF Meet Admin go-live: connecting HQ to the CF Meet Admin Bridge

Joint checklist for HQ (centralize-admin) and CF Meet (cfmeet). It covers
everything between "code is built" and "CF Meet Admin reads are live in HQ
staging". The HQ half is maintained here. The CF Meet half is drafted by the
CF Meet bridge track and lives in `docs/operations/admin-bridge-runbook.md` in
the cfmeet repository (cfmeet PR #133). Where the two differ, stop and
reconcile them before continuing.

**Who does what.** Host steps (Bridge network and relay, S1/S2, CF Meet releases) are privileged
operator steps. Coding agents never access either host. HQ host steps run
through the `Product Admin staging operations` GitHub Actions workflow.
**Secrets never go into git, chat, tickets or CI logs.** Operators carry them
as sealed files.

## Where things stand (2026-11-23)

| Item | State |
|---|---|
| HQ: `services/cfmeet-admin` | Built. The image is built and smoke-tested in CI. In staging it starts with every flag off |
| HQ: pinned Bridge contract | cfmeet `main` `67b65404`, contract 2.0.0 (response envelope `1.0`): 129 reads and 111 commands are in the contract. **This is a contract pin only: nothing is live** |
| HQ: Bridge network | HQ staging and CF Meet production share one VPS, so the default transport is **same-host** (`PA_CM_BRIDGE_MODE=same-host`): `cf-staging-cfmeet-bridge` (`10.231.14.0/28`) is internal and holds exactly CF Meet Admin (`.3`), its worker (`.4`) and CF Meet's relay `cfmeet-admin-bridge-hq-relay` (`.2`). Rehearsed in Infrastructure Security CI with a stand-in relay; the tunnel transport stays available for separate hosts |
| CF Meet: Bridge runtime | **Dark.** The code is on cfmeet `main`, but cfmeet #133 (dark deployment) is not merged, HQ is not enrolled and no activation has run |
| CF Meet: event feed | `hq.events.feed`/`hq.events.ack` are served from contract 2.0.0, so the HQ worker uses them once the Bridge is live and `CFMEET_BRIDGE_FEED_ENABLED=true` |
| CF Meet: datasets | All 8 datasets have owner sources in contract 2.0.0. Figures appear only after the Bridge is live and its collector has run |
| CF Meet: commands | In the contract, but **keep every command disabled** (`CFMEET_ADMIN_ENABLED_COMMANDS` empty) until CF Meet confirms each family is live. See step 7 |

## Gates (decisions, not technical steps)

| Gate | Decision | Owner |
|---|---|---|
| G1 | HQ **staging** connects to CF Meet **production**; CF Meet has one environment. **Decided 2026-11-20 by the product owner: read and modify, full functionality.** Every command still goes through HQ's governance: allowlist, independent approval for R3/R4 and two-person commands, audit, and readback on an unknown outcome. Commands only become possible as CF Meet serves them (see step 7) | Product owner (decided) |
| G2 | A window in CF Meet's single production release slot, to merge #133 and run the dark release. It is shared with the CF MEET and CF Meet Platform sessions, and needs their "slot free" plus the owner's go-ahead | Product owner, CF Meet release |
| G3 | Each HQ stage S3–S7 is closed with `complete-stage` evidence and an independent approver | HQ operator, approver |

## Agreed values (not secret)

| Setting | HQ (`cfmeet-admin.env`) | CF Meet bridge |
|---|---|---|
| Transport (same-host, primary) | `PA_CM_BRIDGE_MODE=same-host` (default); HQ creates `cf-staging-cfmeet-bridge` (`--internal`, `10.231.14.0/28`, `.1` Docker gateway); `cfmeet-admin` `10.231.14.3`, `cfmeet-admin-worker` `10.231.14.4` (fixed in HQ's compose) | relay `cfmeet-admin-bridge-hq-relay` joins `cf-staging-cfmeet-bridge` from CF Meet's compose with `ipv4_address: 10.231.14.2`, no host port; ACL allows `10.231.14.3` and `10.231.14.4` only |
| Endpoint (same-host) | `CFMEET_BRIDGE_ORIGIN=https://admin-bridge.cfmeet.internal:8460` (SNI), `CFMEET_BRIDGE_ADDRESS=10.231.14.2`, leaf fingerprint pinned (`CFMEET_BRIDGE_SERVER_FINGERPRINTS`); repository variables `PRODUCT_ADMIN_CM_BRIDGE_MODE` unset or `same-host`, `PRODUCT_ADMIN_CM_BRIDGE_ADDRESS` unset or `10.231.14.2`, `PRODUCT_ADMIN_CM_BRIDGE_PORT=8460` | nginx stream passthrough (pure TCP/TLS) on `10.231.14.2:8460` to the bridge on 8443; the Bridge terminates mTLS; 8460 is never published on the host |
| Transport (tunnel, separate hosts only) | `PA_CM_BRIDGE_MODE=tunnel`, HQ end `10.250.0.2`; `CFMEET_BRIDGE_ADDRESS=10.250.0.1`; repository variables `PRODUCT_ADMIN_CM_BRIDGE_MODE=tunnel`, `PRODUCT_ADMIN_CM_BRIDGE_ADDRESS=10.250.0.1` | `10.250.0.1`, `ADMIN_BRIDGE_HQ_LISTEN_ADDRESS=10.250.0.1`, `ADMIN_BRIDGE_HQ_ALLOWED_SOURCE=10.250.0.2`; 8460 allowed only on `wg0` from `10.250.0.2` |
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

### 1. Same-host Bridge network (operators; can start now)

HQ staging and CF Meet production run on one VPS, so HQ reaches the relay on
an internal Docker network; no tunnel and no egress allowlist are needed.
Details and checks: `infrastructure/product-admin/staging/README.md`,
"CF Meet Bridge connectivity".

1. On HQ: leave `PRODUCT_ADMIN_CM_BRIDGE_MODE` unset (or `same-host`) and
   `PRODUCT_ADMIN_CM_BRIDGE_ADDRESS` unset (or `10.231.14.2`; clear an old
   tunnel address, same-host refuses it), `PRODUCT_ADMIN_CM_BRIDGE_PORT=8460`.
   `prepare-host` creates `cf-staging-cfmeet-bridge` as `--internal`
   `10.231.14.0/28`. A host prepared earlier in tunnel mode is switched by
   `prepare-host` only while nothing is attached: run `disable` first.
2. On CF Meet: attach `cfmeet-admin-bridge-hq-relay` to the external network
   `cf-staging-cfmeet-bridge` with `ipv4_address: 10.231.14.2`, no host port,
   ACL `10.231.14.3` and `10.231.14.4` only. It joins no other HQ network, and
   HQ's CF Meet Admin and worker join no CF Meet network.
3. `preflight` then reports `cfmeet_bridge_same_host_boundary` PASS (exact
   membership, fixed addresses, no 8460 on the host); before the relay is
   attached it is `PENDING_EXTERNAL`.

**Alternative for separate hosts (tunnel).** Only if the CF Meet Bridge moves
to another host: configure WireGuard peers on the HQ staging host
(`10.250.0.2`) and the CF Meet host (`10.250.0.1`), on `10.250.0.0/30`
(RFC 1918 only; HQ refuses `100.64/10`); on CF Meet allow TCP 8460 only on
`wg0`, only from `10.250.0.2`; on HQ set `PRODUCT_ADMIN_CM_BRIDGE_MODE=tunnel`,
`PRODUCT_ADMIN_CM_BRIDGE_ADDRESS=10.250.0.1` and
`PRODUCT_ADMIN_CM_BRIDGE_PORT=8460`, then re-run `prepare-host`. The HQ host
must not publish 8460 in either mode.

### 2. HQ S1/S2 (HQ operator; no CF Meet dependency)

Follow `infrastructure/product-admin/staging/README.md`. Run `prepare-host`
(including the CF Meet Bridge network and its firewall rules), write the env and secret
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

Use the helper `services/cfmeet-admin/scripts/bridge-enrollment.js`
(`node scripts/bridge-enrollment.js --help`). `prepare` needs Node 22 and the
openssl CLI (1.1.1 or newer). The cfmeet-admin image does not install the
openssl CLI, so run `prepare` from a checkout of this repository on the host:

```sh
cd <checkout>/services/cfmeet-admin
node scripts/bridge-enrollment.js prepare --dir /etc/cosmicforge/staging/secrets/cfmeet-admin --environment staging
chown root:10003 /etc/cosmicforge/staging/secrets/cfmeet-admin /etc/cosmicforge/staging/secrets/cfmeet-admin/*
```

`prepare` writes `bridge-client.key` (EC P-256, 0440), `bridge-client.csr`
(SHA-256, CN `cosmicforge-hq-cfmeet-admin`, EKU clientAuth, exactly one URI SAN
`cf://staging/product-admin/cfmeet`) and `bridge-staff-ed25519.pem` (0440). It
refuses to run if any of them already exists, and checks its own CSR before
writing it. It prints only public material: the CSR path and sha256, the staff
public key as 64 hex characters, and the kids (`--staff-kid` defaults to
`hq-cfmeet-staff-2026-11`).

**Fallback without the helper** (the same material by hand):

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

**HQ checks the returned material** as soon as it is in the secrets directory
(files 0440 root:10003), before the Bridge is enabled. `verify` needs no
openssl, so it also runs in the deployed cfmeet-admin image:

```sh
node scripts/bridge-enrollment.js verify --dir /etc/cosmicforge/staging/secrets/cfmeet-admin --environment staging
# or, in the image (read-only mount, no network):
docker run --rm --network none -v /etc/cosmicforge/staging/secrets/cfmeet-admin:/secrets:ro \
  --entrypoint node "$CFMEET_ADMIN_IMAGE" scripts/bridge-enrollment.js verify --dir /secrets
```

It uses cfmeet-admin's own startup checks and prints PASS/FAIL for each check:

- `bridge-client.pem` matches `bridge-client.key`;
- it has exactly the URI SAN `cf://staging/product-admin/cfmeet` and EKU clientAuth;
- it stays valid for at least `--min-days` (default 2);
- it chains to `bridge-ca.pem`, which must hold CA certificates;
- `bridge-hmac-key` decodes from base64url to at least 32 bytes. The tool prints
  the sha256 of the decoded key, never the key, so it can be compared with CF
  Meet's enrolment;
- the staff key loads.

It also prints the client certificate's sha256 fingerprint and expiry. It exits
1 if any check fails. Do not continue until it prints `RESULT: PASS`.

Fallback without the helper: `openssl x509 -in bridge-client.pem -noout -ext subjectAltName,extendedKeyUsage -enddate -fingerprint -sha256`,
`openssl verify -CAfile bridge-ca.pem bridge-client.pem`, and compare
`openssl x509 -in bridge-client.pem -noout -pubkey` with
`openssl pkey -in bridge-client.key -pubout`.

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
installs the relay (TLS passthrough): same-host, `cfmeet-admin-bridge-hq-relay`
on `cf-staging-cfmeet-bridge` at `10.231.14.2:8460`, admitting only
`10.231.14.3` and `10.231.14.4`; tunnel, `10.250.0.1:8460` admitting only
`10.250.0.2`. Until the relay exists, HQ sees no answer on 8460 (the
`network-probe` result is `PENDING_EXTERNAL`), not a TLS error. Rollback
removes the relay first, then returns the bridge to dark.

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

### 5. S4 first event sync

Set `CFMEET_BRIDGE_FEED_ENABLED=true` with the worker settings above, including
an approved `CFMEET_BRIDGE_FEED_CONSUMER` (the feed's ACK uses it). Contract
2.0.0 serves the event feed and its ACK, so the worker syncs events and pulls
the 8 datasets. A dataset shows real figures only once CF Meet's collector has
written days for it; until then it shows coverage NONE with null metrics, never
zero. If a pin ever stops serving the feed, the worker logs
`bridge_event_feed_not_served` and only pulls datasets.

### 6. S5 reads in HQ

On CF Meet: run the activation `activate-admin-bridge` for the Organizations
grants and set `ADMIN_BRIDGE_MODULE_ORGANIZATIONS=true`. On HQ: grant staff the
CF Meet product roles they need. The HQ web pages for CF Meet are frontend
work. Re-pin HQ as further CF Meet slices merge; each slice switches on more
reads.

### 7. S6 commands (owner approved "read and modify")

**Current instruction from CF Meet: keep every command disabled** until it
confirms that command family is live. Contract 2.0.0 lists them, but the Bridge
is dark.

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

**Stay on hold even after the Bridge is live** (in contract 2.0.0, but not
deliverable end to end on the CF Meet side). Keep these out of `CFMEET_ADMIN_ENABLED_COMMANDS`
until CF Meet confirms each one:

| Command | Waiting for |
|---|---|
| `cfmeet.identity.key.issue`, `cfmeet.identity.key.rotate` | Code-complete end to end (the reveal-once screen is in cfmeet #150). Waiting for cfmeet #149 (Platform Access) and #150 (Developer Platform) to be merged **and released to production**, confirmed explicitly by CF Meet |
| `cfmeet.organizations.organization.export` | A Notification Service template for the download email (the owner refuses with a definite 409 until then) |
| `cfmeet.messaging.export.request` | The recipient's claim screen |
| `cfmeet.accounts.user.export` | The Meeting Service's download page for the user (the email link is DOWNLOAD_LINK_EMAIL) |

Secrets and exports never pass through HQ. The owner delivers them to the
rightful recipient (claim link or reveal-once), and HQ receives a reference
only: delivery channel, `recipient_masked`, `expires_at`, and key or export
identifiers.

## Rollback

- **HQ:** set `CFMEET_BRIDGE_ENABLED=false` (and `CFMEET_BRIDGE_FEED_ENABLED=false`),
  then redeploy, or run the workflow's `disable` operation.
- **CF Meet:** set `ADMIN_BRIDGE_ENABLED=false`. Revoke HQ with
  `revoke-principal` and `revoke-staff`, and check the audit chain with
  `verify-audit-chain`.
- **Relay (same-host):** CF Meet detaches `cfmeet-admin-bridge-hq-relay` from
  `cf-staging-cfmeet-bridge`. The internal network then reaches nothing.
- **Tunnel (separate hosts):** take down the WireGuard peer. HQ's egress rule
  then reaches nothing.

## Resolved with CF Meet

- The client key is EC P-256 with SHA-256 (the bridge also accepts P-384 and
  Ed25519), with EKU clientAuth and exactly one URI SAN.
- The HMAC key file is the identical base64url file on both sides. The bridge
  change ships in cfmeet #134, before any deployment.
