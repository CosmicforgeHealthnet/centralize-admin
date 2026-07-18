# Social Operations Live Sandbox Results

Audit date: 2026-07-17

No live sandbox provider tests were executed. Mocked provider acceptance does not count as live verification.

| Scenario | Status | Evidence | Blocker |
|---|---|---|---|
| Facebook Page publish/comment/reply/message | NOT_EXECUTED | none | Meta app, Page, staging callback/webhook, secrets unavailable |
| Instagram professional publish/comment/private reply/message | NOT_EXECUTED | none | Meta app, professional identity, app review, staging unavailable |
| TikTok DIRECT_POST | NOT_EXECUTED | none | TikTok app and creator access unavailable |
| TikTok UPLOAD_TO_DRAFT | NOT_EXECUTED | none | TikTok app and creator access unavailable |
| X post/media/reply/DM | NOT_EXECUTED | none | X app/access tier unavailable |
| LinkedIn organization post/media/comment/reaction | NOT_EXECUTED | none | LinkedIn Community Management and org admin access unavailable |
| HealthNet live synthetic safety | NOT_EXECUTED | none | Live inbox/provider scope not approved |

## Evidence Rules

When executed later, evidence must be sanitized and include:

- environment;
- provider app id label only, not secret;
- identity label/id where safe;
- internal Social ids;
- provider ids/URLs where safe;
- timestamps;
- screenshots or logs with tokens removed;
- proof that `PUBLISHED` happened only after provider confirmation.

