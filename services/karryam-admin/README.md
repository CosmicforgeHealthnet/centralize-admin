# Karryam Admin — private same-VPS read-only integration foundation

**Status: IMPLEMENTED SOURCE FOUNDATION; NOT LIVE-CERTIFIED.**

This is the Karryam product-admin service in the Centralized Admin monorepo.
It is not a second KarryGo backoffice and does not access KarryGo databases.
The authoritative backend remains the separate `KarryGo/services/admin-backoffice-service`.
The Karryam admin frontend is `apps/central-admin-web/src/app/dashboard/karryam`.

## Implemented in this first slice

- Standalone Node 22 runtime, **Unix domain socket only**, no public TCP listener, no browser CORS.
- An authenticated Central Admin GET `/api/karryam/capabilities` that uses current staff session,
  requires a valid session schema, explicit `operations/karryam` section VIEW grant
  (or the existing SUPER bypass), and recent server-recorded MFA.
- The main API issues a 15-second HMAC-signed **read-only** local delegation tied to
  actual staff, session, role, market, organization, ACR and the exact operation.
- The standalone service verifies the delegation and an operator-approved role mapping.
  It never accepts a browser token or staff-provided destination/scope.
- Fixed `GET /internal/karryam-admin/v1/capabilities` over TLS 1.3 mutual TLS with
  existing KarryGo HMAC v2 canonicalization, fresh nonce, and Ed25519 staff assertion.
  Returned responses are bounded to 256 KiB. No redirect or arbitrary upstream route.
- Truthful 503 on disabled, unconfigured or unavailable bridge; no fabricated numbers.
- Contract/negative tests. **No domain commands, payment actions or event subscriptions.**

## Same-VPS deployment boundary

Both repositories may live on the **same physical VPS**, but run as different
containers/processes. Do not publish the KarryGo bridge or Karryam Admin socket
through the public API Gateway, Nginx or Docker host ports.

1. Keep the KarryGo bridge `ADMIN_REMOTE_ENABLED=false` until its signed policies,
   staff enrollment, TLS identities, migrations and rollout approval are complete.
2. Give the Central Admin API and Karryam Admin **only** the common private socket
   directory (for example `/run/cosmicforge/`). Allow the intended non-root
   process group to access the socket, deny all other processes. The service
   creates it with mode 0660. Do not mount a privileged Docker socket.
3. Give Karryam Admin a **dedicated, narrowly routed** path to the KarryGo bridge
   TLS endpoint on a host-private/container-private network. Enforce bridge
   firewall/network ACLs. No access to KarryGo's databases, internal services
   generally, SSH or Redis. The bridge still enforces its independent mTLS,
   HMAC, Ed25519 assertion and DB-stored authorization.
4. Use separate secret files for local delegation, bridge HMAC, bridge Ed25519
   signing, mTLS certificate/key and pinned CA. No secrets in Git, browser
   `NEXT_PUBLIC_*` variables, logs or public app containers.
5. Configure the **same** `KARRYAM_ADMIN_MARKET`, `KARRYAM_ADMIN_ORGANIZATION`,
   `KARRYAM_ADMIN_ACR`, `KARRYAM_HQ_DELEGATION_SECRET_FILE`, socket path and
   `KARRYAM_ADMIN_ENABLED` in the *two internal HQ services*.
   The role map and bridge TLS/signing files belong **only** to karryam-admin.
   Exact issuer, audience, key IDs, ACR and scope must match independently approved
   KarryGo trust policy; no default grants exist.
6. Run `npm run check && npm test` inside `services/karryam-admin`; start as
   the unprivileged operator with `npm start`. Check `/health/live` and
   `/health/ready` **via Unix socket only**. Ready means configured, not that
   KarryGo or staff grants are certified.
7. Test negative paths (missing/expired/delegation mismatch, unapproved scope,
   bad TLS/cert/CA, revoked staff, disabled bridge), then real read-only
   capability discovery. Do not enable customer/finance/verification commands
   based on capability discovery alone.

The Central Admin API must have server-side sessions and MFA schema deployed.
Legacy bearer tokens cannot satisfy the recent-MFA requirement. Its configured
staff grants still require audited, authorized provisioning.

## Deployment state and subsequent milestones

Code committed here does not modify VPS environments, Firewall/NAT, Docker,
Vercel, KarryGo policy, or GitHub deployment secrets. Both existing live apps
continue unchanged until an explicit release. The new service has no production
Compose wiring yet and requires an operator-owned private-network and secret
deployment plan.

Next: verify the live read contract and staff grant provisioning; implement
resource-specific read views for the **actually enabled** KarryGo capabilities,
then attach unified Support/Marketing/Finance projections and governed commands.
Each command requires a separate owner contract, authorization, review, replay,
idempotency, outcome and reconciliation certification. Never infer a capability
is live from its existence in the registry.

KarryGo canonical source:
`services/admin-backoffice-service/docs/openapi/signing-profile.md`,
`docs/admin-bridge/sections-16-38-final-report.md`,
`docs/admin-bridge/runbook.md`.
