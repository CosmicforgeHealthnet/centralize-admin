# Product Admin services — staging release runbook

Services: **Karryam Admin** (`services/karryam-admin`) and the HQ **Product
Integration Core** (PIC, `services/product-integration-core`). Both are
private, non-root, read-only containers that start **disabled**. This runbook
is for the operator; the coding agent has no VPS access and performs none of
these steps.

Status on 31 October 2026: release tooling exists; **no staging deployment of
either service has happened**, and production is untouched.

## 1. What the repository provides

| Item | Where |
|---|---|
| CI on every PR (tests, PostgreSQL, conformance, image smoke) | `.github/workflows/product-admin-platform-ci.yml` |
| Manual staging release: migration preflight, config preflight, immutable image build + smoke, optional GHCR publish. **Never deploys.** | `.github/workflows/product-admin-release-staging.yml` (dispatch from `staging` only) |
| Config preflight (no DB or network access; sanitized output) | `npm run config:check` in each service, also inside the image: `node scripts/check-config.js` |
| Forward-only migrations (checksummed, advisory-locked, runtime grants) | `npm run migrate` in each service |
| Secret-reference templates (no real values) | `infrastructure/product-admin/*.example.*` |
| Private layout reference (Unix sockets, no published ports) | `infrastructure/product-admin/docker-compose.product-admin.example.yml` |

Image tags are immutable: `ghcr.io/cosmicforgehealthnet/{karryam-admin,product-integration-core}:staging-<commit SHA>`. The publish job refuses to overwrite an existing tag.

## 2. Operator prerequisites (must exist before any staging start)

1. **Database roles** (`postgres-roles.example.sql`): separate migration and
   runtime roles for PIC (HQ database, schema `hq_integration`) and for
   Karryam Admin (its own database). The runtime credential must differ from
   the migration credential (both services refuse otherwise).
2. **Secret files**, mounted read-only, referenced only by path:
   - PIC: `PIC_ENDPOINTS_FILE`, `PIC_TRUSTED_SIGNERS_FILE`,
     `PIC_HQ_DELEGATION_KEYS_FILE`; `PIC_DATABASE_URL` from the env file.
   - Karryam Admin: service keys, delegation keys, manifest signing key, Bridge
     material (see its README).
   - Every key ≥ 32 random bytes, unique per purpose **and per product**. PIC
     refuses a key shared between endpoints, between a service and delegation
     key, or with an HQ delegation key (`KEY_REUSE_ACROSS_BOUNDARIES`).
3. **Signer enrollment**: the Karryam Admin manifest signing public key in
   PIC's trusted-signers file for `karryam` / `staging`, with `not_after`.
4. **Bridge enrollment** (Karryam Admin → Karryam Backoffice): client
   certificate, HMAC key and the Backoffice's approval. Until then
   `KARRYAM_BRIDGE_ENABLED=false`.
5. **Signed owner policies / platform grants**: bootstrap at least three
   distinct people (requester, reviewer, approver) with
   `scripts/bootstrap-platform-grant.js`.
6. **Private networking**: socket directory shared only by the two
   containers and the Central Admin API; `nginx-internal-deny.example.conf`
   applied so `/internal/*` is never public.

## 3. Release procedure (staging)

1. Merge to `staging` through the normal review.
2. Run **Product Admin Release (staging, manual)** from `staging` with
   `publish=false`. All jobs must pass on that exact commit.
3. Re-run with `publish=true`, `confirm=PUBLISH_STAGING_IMAGES` to publish the
   same commit's images.
4. On the host (operator): run each service's migrations with the migration
   credential, then `node scripts/check-config.js` inside the image with the
   real env file and `*_EXPECT_ENVIRONMENT=staging`. It must print
   `config_valid` and the expected counts and trust-store fingerprint.
5. Start both services with `*_ENABLED=false`; check `/health/live` = 200 and
   `/health/ready` = 503 over the sockets.
6. Enable (`*_ENABLED=true`, `PIC_SYNC_ENABLED=false`), then onboard through
   the HQ API: register → verify identity → validate contract → review →
   approve datasets → certify staging (with conformance evidence) → approve.
7. Enable subscriptions and `PIC_SYNC_ENABLED=true` only after certification.

## 4. Checklists

**Before enabling**: migrations applied (ledger matches), runtime role cannot
DDL or delete audit rows, `config:check` valid, signer enrolled with expiry,
keys unique, sockets private, `/internal/*` denied at the edge.

**Before enabling sync**: product `ENABLED`, contract `ACTIVE`, drift `NONE`,
dataset approved, subscription scope ⊆ product scope, health check verified.

## 5. Trust changes (revocation, expiry, rotation)

Edit the trusted-signers file (or the referenced public-key file), then
**restart PIC**. Between the edit and the restart PIC fails closed: within
`PIC_TRUST_STORE_RECHECK_SECONDS` (default 5 s) it notices the change and
stops synchronization, health refresh, onboarding and staff reads with
`TRUST_STORE_CHANGED`. After the restart, the next health check verifies
against the new trust. Rotation: enroll the new key ID next to the old one,
restart, switch the product signer, re-verify, remove the old ID, restart.

## 6. Drift and holds (what blocks and how to clear it)

| State | Effect | Clear by |
|---|---|---|
| `IDENTITY_MISMATCH`, `MANIFEST_INVALID`, `MANIFEST_EXPIRED` | sync stopped, product unavailable | fix identity/signer; next verified health check |
| `ADDITIVE_PENDING_REVIEW` | sync stopped, no new datasets/subscriptions | propose → certify (other person) → activate (third person) |
| `BREAKING_DETECTED` | sync stopped, revision rejected | product returns to the approved catalog, or a new major onboarding |
| Cursor hold (`hold_reason`) | partition stopped at the unverified event, never ACKed past it | reconciliation from a complete approved snapshot covering it (automatic each run) |

## 7. Rollback

- **Image**: redeploy the previous `staging-<sha>` tag. Migrations are
  forward-only; migration `002` is rollback-compatible (older images never
  write the new values and can still clear gaps).
- **Service**: set `*_ENABLED=false` (or `PIC_SYNC_ENABLED=false`) and
  restart; committed data and history are preserved.
- **Product**: suspend through the HQ API (stops sync at the next event
  boundary; no further requests, no ACK). Revocation is permanent.
