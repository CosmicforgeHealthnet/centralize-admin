# @cosmicforge/identity-and-permissions

Product-scoped authorization and delegated identity (no runtime dependencies).

- `ACTIONS` — product actions (`product.view`, `metric.read`, `operation.submit`, …)
  and platform actions (`integration.request`, `integration.approve`, …) with
  recent-MFA and independent-approval metadata.
- `authorize({ subject, productId, action, datasetId, requestedScope, grants, productScope })`
  — explicit grants only; **staff tier is never consulted**. Explicit deny wins;
  expired and revoked grants deny; dataset grants; exact scope intersection for
  market / organization / zone / tenant (wildcards rejected); policy store
  unavailable → deny.
- `grantErrors(grant)` — rejects wildcards, kind/action mismatches and product
  grants without market and organization scope.
- `signDelegation` / `verifyDelegation` / `requestBinding` — HS256 compact JWS,
  `cf-hq-delegation+jwt` (Central Admin API → Integration Core) and
  `cf-product-delegation+jwt` (Integration Core → one Product Admin). Bound to the
  exact method, path and body; ≤ 60 s lifetime; strict claim allowlist; replay
  protection is done by the verifier with a durable store.

```bash
npm test
```
