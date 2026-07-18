# Social Operations Provider URL Registration

Audit date: 2026-07-17

The approved staging domain was not available from this backend repository or environment. Exact provider URLs cannot be finalized without that domain. Do not register wildcard, prefix, or non-HTTPS redirect URLs.

## Route Structure

Base path:

```text
/api/v1/marketing/social
```

OAuth callback path:

```text
GET /api/v1/marketing/social/oauth/:provider/callback
```

Webhook challenge path:

```text
GET /api/v1/marketing/social/webhooks/:provider
```

Webhook ingest path:

```text
POST /api/v1/marketing/social/webhooks/:provider
```

## URL Templates

Replace `<staging-origin>` only with the actual approved HTTPS staging origin.

| Provider | OAuth callback URL | Webhook URL | GET challenge URL | Registration status |
|---|---|---|---|---|
| Meta | `<staging-origin>/api/v1/marketing/social/oauth/META/callback` | `<staging-origin>/api/v1/marketing/social/webhooks/META` | `<staging-origin>/api/v1/marketing/social/webhooks/META` | PENDING_INFRASTRUCTURE |
| TikTok | `<staging-origin>/api/v1/marketing/social/oauth/TIKTOK/callback` | `<staging-origin>/api/v1/marketing/social/webhooks/TIKTOK` | provider-specific challenge not implemented unless provider requires it | PENDING_INFRASTRUCTURE |
| X | `<staging-origin>/api/v1/marketing/social/oauth/X/callback` | `<staging-origin>/api/v1/marketing/social/webhooks/X` | provider-specific challenge not implemented unless provider requires it | PENDING_INFRASTRUCTURE |
| LinkedIn | `<staging-origin>/api/v1/marketing/social/oauth/LINKEDIN/callback` | `<staging-origin>/api/v1/marketing/social/webhooks/LINKEDIN` | provider-specific challenge not implemented unless provider requires it | PENDING_INFRASTRUCTURE |

## Verification Status

- Exact allow-list matching: implemented locally through `SOCIAL_OAUTH_REDIRECT_URIS` or `SOCIAL_OPERATIONS_OAUTH_REDIRECT_URIS`.
- HTTPS requirement: enforced except exact localhost in development/test.
- Wildcard redirect: not supported.
- Prefix matching: not supported.
- Untrusted query redirect: not trusted.
- Route reachability: local route protected/available; staging not deployed.
- Webhook raw bytes: local route-specific raw body parser exists for Social webhook POST.
- Signature-before-persistence: covered by automated tests.
- Provider dashboard registration: blocked by provider and infrastructure access.
