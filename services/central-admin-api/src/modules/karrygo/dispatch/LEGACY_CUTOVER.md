# Legacy Karryam dispatch module — direct database access

`dispatch.service.js` reads and writes the Karryam operational database
directly through `dispatchPrisma` (`DISPATCH_DATABASE_URL`). This bypasses the
Karryam owner services, their business rules and the Karryam Backoffice
policy boundary.

Current state (verified 2026-10-30): this router is **not mounted** in
`src/app.js`, so it serves no traffic. It is kept unchanged (apart from
routing telemetry) and must not be reused for new Karryam integration work.

## Rules until cutover

- No new code may import `dispatchPrisma`, `shared/config/dispatchDatabase`
  or read `DISPATCH_DATABASE_URL`. `tests/product-gateway.test.js` checks that
  the product gateway never does, and that `app.js` does not mount this router.
- If the router is ever re-mounted, `legacy-telemetry.js` logs every request
  as `legacy_direct_db_route` (route, coarse resource, method, correlation id
  only) so the remaining usage is measurable.

## Required future cutover

All Karryam administration moves to the approved path:

```text
Central Admin web -> Central Admin API (/api/products/karryam/...)
  -> Product Integration Core -> Karryam Admin (Product Admin Protocol v1)
  -> Karryam Backoffice Bridge (/internal/karryam-admin/v1, TLS 1.3 mTLS,
     HMAC v2, Ed25519 staff assertion) -> Karryam owner services
```

Cutover steps (later work packages, not part of Sections 1–5):

1. Implement the equivalent provider-verification, trip and bike reads and the
   reviewed commands in Karryam Admin (Section 6) against certified Bridge
   capabilities (Section 7), with Section 11 approvals for every write.
2. Prove field and permission parity in staging, with telemetry showing no
   remaining legacy traffic.
3. Remove this module, `shared/config/dispatchDatabase.js`, the dispatch
   Prisma schema/client and the `DISPATCH_DATABASE_URL` secret from HQ.
