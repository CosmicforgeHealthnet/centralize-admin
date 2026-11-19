# CF Meet Admin Bridge signing profile v1 (HQ DRAFT)

Mirrors the agreed interface (centralize-admin docs/product-admin/cfmeet-admin-parallel-workplan.md §3).

- Transport: private network, TLS 1.3 mutual TLS, HQ client certificate pinned by fingerprint.
- HMAC v2: hex HMAC-SHA256 over LF-joined `2`, `cosmicforge-hq-cfmeet-admin`, METHOD, exact request URI with query, unix seconds, nonce, hex sha256(body). Skew ±30 s; nonce single use.
- request_digest: hex sha256 of METHOD LF URI LF `cfmeet` LF hex sha256(body).
- Staff assertion: Ed25519 JWS, header exactly {alg:EdDSA, typ:JWT, kid}; claims iss, sub, aud, product=cfmeet, roles, permissions, market_scopes, organization_scopes, zone_scopes, tenant_scopes (always), session_id, auth_time, acr, jti, iat, nbf, exp (exp-iat ≤ 60), request_digest.
- approval claim (required when the capability's approval is TWO_PERSON): {approval_id, capability, requester_ref, approver_ref, intent_digest, decided_at, expires_at}. Rejected if capability ≠ route, requester_ref ≠ sub, approver_ref = sub, expired, expires_at − decided_at > 43200 s, or approval_id reused.
- Query shapes (exact order): SCOPED = market,organization,zone,tenant,purpose; SCOPED_PAGE = market,organization,zone,tenant,purpose,limit,cursor; SCOPED_WINDOW = market,organization,zone,tenant,purpose,limit,cursor,start,end; SCOPED_SEARCH = market,organization,zone,tenant,purpose,limit,cursor,q.
- Purposes (hyphenated): support-review, verification-review, abuse-review, billing-review, pricing-change, ops-incident, release-request, privacy-request, admin-ui-capabilities, metrics-read, event-sync.
