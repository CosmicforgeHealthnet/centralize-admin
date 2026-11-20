# CF Meet Admin Bridge signing profile v1 (HQ DRAFT)

Mirrors the agreed interface (centralize-admin docs/product-admin/cfmeet-admin-parallel-workplan.md §3).

- Transport: private network, TLS 1.3 mutual TLS, HQ client certificate pinned by fingerprint.
- HMAC v2: hex HMAC-SHA256 over LF-joined `2`, `cosmicforge-hq-cfmeet-admin`, METHOD, exact request URI with query, unix seconds, nonce, hex sha256(body). Skew ±30 s; nonce single use.
- request_digest: hex sha256 of METHOD LF URI LF `cfmeet` LF hex sha256(body).
- Staff assertion: Ed25519 JWS, header exactly {alg:EdDSA, typ:JWT, kid}; claims iss, sub, aud, product=cfmeet, roles, permissions, market_scopes, organization_scopes, zone_scopes, tenant_scopes (always), session_id, auth_time, acr, jti, iat, nbf, exp (exp-iat ≤ 60), request_digest.
- approval claim (required when the capability's approval is TWO_PERSON): {approval_id, capability, requester_ref, approver_ref, intent_digest, decided_at, expires_at}. Rejected if capability ≠ route, requester_ref ≠ sub, approver_ref = sub, expired, expires_at − decided_at > 43200 s, or approval_id reused.
- Query shapes (exact order): SCOPED = market,organization,zone,tenant,purpose; SCOPED_PAGE = market,organization,zone,tenant,purpose,limit,cursor; SCOPED_WINDOW = market,organization,zone,tenant,purpose,limit,cursor,start,end; SCOPED_SEARCH = market,organization,zone,tenant,purpose,limit,cursor,q.
- Purposes (hyphenated): support-review, verification-review, abuse-review, billing-review, pricing-change, ops-incident, release-request, privacy-request, admin-ui-capabilities, metrics-read, event-sync.

## Error codes

Same codes as the CF Meet Admin Bridge signing profile (agreed with Track A).

| Code | HTTP |
|---|---|
| `BRIDGE_DISABLED` | 503 |
| `BRIDGE_UNAVAILABLE` | 503 |
| `REQUEST_SHAPE_INVALID` | 400 |
| `BODY_TOO_LARGE` | 413 |
| `CLIENT_CERTIFICATE_REFUSED` | 401 |
| `HQ_KEY_UNKNOWN` | 401 |
| `SIGNATURE_INVALID` | 401 |
| `TIMESTAMP_SKEW` | 401 |
| `STAFF_ASSERTION_INVALID` | 401 |
| `STAFF_ASSERTION_EXPIRED` | 401 |
| `REQUEST_DIGEST_MISMATCH` | 401 |
| `REVOKED` | 401 |
| `REPLAY` | 409 |
| `CAPABILITY_NOT_FOUND` | 404 |
| `QUERY_INVALID` | 400 |
| `POLICY_UNAVAILABLE` | 503 |
| `PURPOSE_NOT_ALLOWED` | 403 |
| `PERMISSION_DENIED` | 403 |
| `SCOPE_DENIED` | 403 |
| `RECENT_MFA_REQUIRED` | 403 |
| `STRONG_AUTH_REQUIRED` | 403 |
| `APPROVAL_REQUIRED` | 403 |
| `APPROVAL_INVALID` | 403 |
| `APPROVAL_EXPIRED` | 403 |
| `APPROVAL_REUSED` | 409 |
| `CAPABILITY_DISABLED` | 503 |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 |
| `IDEMPOTENCY_CONFLICT` | 409 |
| `RATE_LIMITED` | 429 |
| `AUDIT_UNAVAILABLE` | 503 |
| `DATASET_NOT_FOUND` | 404 |
| `RESOURCE_NOT_FOUND` | 404 |
| `OWNER_UNAVAILABLE` | 503 |
| `OWNER_REFUSED` | 422 |
| `UNKNOWN_OUTCOME` | 502 |
| `INTERNAL` | 500 |
