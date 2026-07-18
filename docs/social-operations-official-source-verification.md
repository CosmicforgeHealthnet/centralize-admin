# Social Operations Official Source Verification

Access date: 2026-07-17

Official sources only were used: Meta for Developers, TikTok for Developers, X API docs, and Microsoft Learn for LinkedIn.

| Provider | Product | Official URL | Verification notes | Required code/config action |
|---|---|---|---|---|
| Meta | Pages permissions and page tasks | https://developers.facebook.com/docs/pages-api/manage-pages | Pages API requires Page permissions including page management/post/engagement scopes and a user with Page tasks such as content creation, management, or moderation. | Keep Page operations capability-gated until Page task and permission proof exists. |
| Meta | Pages webhooks | https://developers.facebook.com/docs/pages-api/webhooks-for-pages | Page webhooks require endpoint setup, Page app installation, and approved subscribed fields such as feed/messages where permitted. | Register exact HTTPS webhook URL and keep signature verification before persistence. |
| Meta | Instagram private replies | https://developers.facebook.com/docs/messenger-platform/instagram/features/private-replies | Private replies are limited; one private reply can be sent for a comment within provider policy windows and requires approved permissions/access. | Keep Instagram reply behavior policy-window gated. |
| TikTok | Direct Post | https://developers.tiktok.com/doc/content-posting-api-reference-direct-post | Direct Post uses `video.publish`; unaudited clients are restricted and must pass audit to lift visibility restrictions. | Keep DIRECT_POST live verification blocked until app and creator approval exist. |
| TikTok | Upload to draft/inbox | https://developers.tiktok.com/doc/content-posting-api-reference-upload-video | Upload flow requires user action in TikTok to complete posting and uses `video.upload`. | Keep upload-to-draft as `AWAITING_USER_ACTION` until provider completion confirmation. |
| TikTok | Status polling/webhooks | https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status | TikTok supports polling and webhooks; final public post IDs are only available after moderation/public availability. | Poll or process webhook before setting `PUBLISHED` and `publishedAt`. |
| X | Create post | https://docs.x.com/x-api/posts/create-post | X creates posts at `/2/tweets` for authenticated users; media is mutually exclusive with some post options. | Keep X publish gated by approved organic app and tier. |
| X | Media upload | https://docs.x.com/x-api/media/upload-media | X media upload supports media categories and MIME constraints for posts/DMs. | Validate media category/MIME before live X upload. |
| X | Direct Messages | https://docs.x.com/x-api/direct-messages/manage/introduction | X DM manage endpoints require approved developer project/app and user-context access. | Keep DM capabilities gated until tier and scopes are confirmed. |
| LinkedIn | Community Management overview | https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview | Community Management is a vetted product with development/standard tiers and supports organization posts, comments, reactions, and analytics for approved use cases. | Keep LinkedIn live operations blocked pending product approval. |
| LinkedIn | Posts API | https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api | Posts API supports organization posts and requires versioned headers plus relevant organization/member permissions. | Use organization identity and current version headers when runtime is enabled. |
| LinkedIn | Comments API | https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api | Comments API supports reading/writing comments with organization feed permissions and role restrictions. | Keep comments gated until organization role and permissions are confirmed. |
| LinkedIn | Reactions API | https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/reactions-api | Reactions API supports reaction read/write with organization feed permissions and role restrictions. | Keep reactions gated until organization role and permissions are confirmed. |
| LinkedIn | Organization lookup | https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api | Administered organization lookup requires 3-legged OAuth and organization admin role for full fields. | Confirm org admin before identity discovery acceptance. |

## Changed Behavior

No implementation contradiction requiring an immediate code change was identified from the accessible official docs. Live provider behavior, scopes, product approvals, and API versions must be rechecked again immediately before each provider dashboard setup.
