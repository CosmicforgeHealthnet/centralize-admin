# Product Admin infrastructure templates

Configuration **templates** for the Product Integration Core (PIC) and Product
Admins such as Karryam Admin. Nothing here is deployed by any workflow, and no
value here is a real credential. Every `<...>` value is an operator decision.

| File | Used by | Purpose |
|---|---|---|
| `endpoints.example.json` | PIC `PIC_ENDPOINTS_FILE` | Allowlisted Product Admin destinations bound to one product + environment, with per-product service and delegation keys |
| `trusted-signers.example.json` | PIC `PIC_TRUSTED_SIGNERS_FILE` | Enrolled manifest signer public keys |
| `hq-delegation-keys.example.json` | PIC `PIC_HQ_DELEGATION_KEYS_FILE` and the Central Admin API | Keys for `cf-hq-delegation+jwt` between the API and PIC |
| `karryam-admin-keys.example.json` | Karryam Admin key files | PIC service and delegation keys as seen by Karryam Admin |
| `postgres-roles.example.sql` | DBA | Separate migration and runtime roles |
| `docker-compose.product-admin.example.yml` | reference only | Private, non-root, read-only, no-published-port layout on one VPS |
| `nginx-internal-deny.example.conf` | public ingress | Guarantees `/internal/*` (protocol, PIC and bridge paths) is never public |

## Same VPS today, several VPSs later

Today all services can share one host: they talk over Unix sockets in a
directory mounted only into the containers that need it, so co-location never
creates implicit trust — every hop still authenticates (HQ delegation,
`cf-svc-v1` service signatures, product delegation, audit). Moving a Product
Admin to another host changes only its endpoint entry from `transport: unix`
to `transport: https` with a pinned private address and TLS 1.3 mutual TLS;
the protocol, contracts, registry rows and business logic do not change.

## Key handling rules

- Generate every key with at least 32 random bytes; store them in the host
  secret store and mount read-only. Never put them in the database, in a
  manifest, in the browser or in git.
- One key per purpose and per product: PIC rejects the same bytes used as both
  a service key and a delegation key, or shared with the HQ delegation key.
- Every key has an expiry. Rotate by adding a new key ID next to the old one,
  switching the signer, waiting out the 60-second token window, then removing
  the old ID.

## Activation order (operator)

1. Provision database roles (`postgres-roles.example.sql`), run
   `npm run migrate` for PIC (and Karryam Admin in its own database).
2. Bootstrap the first platform grants with
   `scripts/bootstrap-platform-grant.js` (two or more distinct people, so
   requester, reviewer and approver can differ).
3. Generate keys, enroll the Product Admin's manifest signer public key,
   write the endpoint entry, deploy both services with `*_ENABLED=false`.
4. Enable the services, then run the onboarding flow through the HQ API:
   register → verify identity → validate contract → review → approve
   datasets → certify staging (with conformance evidence) → approve.
5. Enable subscriptions and `PIC_SYNC_ENABLED` only after certification.
