# Social Operations Provider Readiness

Audit date: 2026-07-17

No provider dashboard access or approved staging identities were available. No live provider calls were made. Mocked provider acceptance remains separate from live verification.

| Provider | App status | Approval status | Identity status | Live acceptance | Blocker | Required action |
|---|---|---|---|---|---|---|
| Meta/Facebook Pages | BLOCKED | PENDING_APP_REVIEW | NOT_AVAILABLE | NOT_EXECUTED | Meta app/Page access unavailable | Configure app/products, register URLs, connect approved test Page, run live sandbox |
| Instagram professional | BLOCKED | PENDING_APP_REVIEW | NOT_AVAILABLE | NOT_EXECUTED | Professional account unavailable | Connect approved professional account, reject personal accounts, run live tests |
| TikTok | BLOCKED | PENDING_PROVIDER_APPROVAL | NOT_AVAILABLE | NOT_EXECUTED | TikTok app/creator unavailable | Configure Content Posting API, verify DIRECT_POST and UPLOAD_TO_DRAFT, run live tests |
| X | BLOCKED | PENDING_X_ACCESS_TIER | NOT_AVAILABLE | NOT_EXECUTED | X app/tier unavailable | Confirm organic app, access tier, media/post/reply/DM support, run live tests |
| LinkedIn | BLOCKED | PENDING_LINKEDIN_COMMUNITY_MANAGEMENT_APPROVAL | NOT_AVAILABLE | NOT_EXECUTED | LinkedIn app/org unavailable | Request/verify Community Management, connect organization admin, run live tests |

## Capability Notes

- TikTok comments and DMs remain `NATIVE_ONLY` unless official approved access proves otherwise.
- X unavailable operations remain `REQUIRES_PLATFORM_APPROVAL` with access-tier reason codes.
- LinkedIn Page inbox remains `NATIVE_ONLY` unless official current documentation and approval prove otherwise.
- LinkedIn member publishing remains gated by product policy.
- Meta messaging remains policy-window restricted.
