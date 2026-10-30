# @cosmicforge/service-clients

Private service-to-service transport (no runtime dependencies besides sibling packages).

- `createFixedTarget(spec)` — one destination from operator configuration: Unix
  socket, or HTTPS to a **pinned private IP** (DNS never consulted at request
  time) with TLS 1.3 mutual TLS and optional server certificate pinning. Public,
  link-local/metadata, CGNAT and unspecified addresses, URL credentials, paths and
  queries are refused. Plain HTTP only for loopback in disposable tests.
- `createServiceClient` / `createProductAdminClient` — no per-request URL, no
  redirects, bounded request/response sizes, JSON only, timeouts, retry
  classification (`RETRYABLE` / `FATAL` / `UNKNOWN_OUTCOME`), correlation IDs, and
  envelope validation against the expected product.
- `signServiceRequest` / `verifyServiceRequest` — `cf-svc-v1` HMAC service
  identity over version, service, key ID, method, request URI, timestamp, nonce
  and body hash; duplicate headers, skew and replays rejected.
- `createProductAdminHandler` — the shared server-side Protocol v1 kit used by
  every Product Admin: endpoint routing, service authentication, delegation
  verification, audit-before-execute (fails closed), bounded bodies and envelope
  validation.

```bash
npm test   # includes real TLS 1.3 mTLS tests (needs openssl)
```
