# Advertising Execution provider baseline

Verified against official provider documentation on 2026-07-22. This is an operational baseline, not permission to enable writes. API versions remain configuration-driven, all write flags remain off, and account-level capability discovery must pass before an operation can be eligible.

## Google Ads

- Version: v24 is the current stable major used by this implementation. Google lists v24 (2026-04-22), v24.1 (2026-05-20), and v24.2 (2026-06-24); v25 was only an upcoming release at verification time. The adapter accepts supported majors v21-v24 and has no implicit default.
- Sunset: follow Google's published sunset table; review the configured major before each published sunset and no later than monthly.
- Authentication/access: OAuth scope `https://www.googleapis.com/auth/adwords`, developer token, OAuth client credentials, refresh token, customer ID, and optional manager `login-customer-id`. Customer IDs are normalized to ten digits.
- Role/write readiness: the normalized baseline accepts ADMIN or STANDARD only after a preflight confirms account edit permission and any manager relationship. A configured version or credential alone is insufficient.
- Hierarchy/scope: Search campaigns only; campaign budget, campaign, campaign criteria, ad group, ad-group criteria, approved Search assets, ad, asset links, and separate status operations.
- Money: average daily budget in micros at the adapter boundary; Decimal major units everywhere else. Shared-budget changes remain disabled by default.
- Validation/correlation: Google mutate validation uses `validate_only=true` and `partial_failure=false`. The response request ID is retained only as a sanitized correlation identifier. BatchJob is deferred.
- Idempotency/read-back: provider idempotency is limited, so the internal deterministic operation key is primary. Unknown outcomes are not retried blindly; known success requires GAQL read-back.
- Regulated advertising: only `DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING` is accepted. Political/regulated advertising is rejected.
- Review state: returned status/policy state is normalized on read-back; it is never inferred as approved from mutate success.
- Official sources: Google Ads API release/sunset, OAuth, REST authentication, call structure, and EU political advertising policy documentation.

## Meta Marketing API

- Version: required in `MARKETING_AD_EXECUTION_META_API_VERSION`; no default was encoded. Meta's official documentation endpoint did not provide a reliably accessible current-version page during verification, so accepting a particular current major would be unsafe. The configured value is syntax-validated and capability remains unavailable when absent.
- Authentication/access: `ads_management`, an ADMIN or ADVERTISER ad-account role, account edit access, Page ownership, and Instagram identity readiness when an Instagram placement is selected.
- Hierarchy/scope: Auction campaign, ad set, creative, and ad, initially PAUSED. Supported objectives and placements are explicitly allowlisted.
- Money: account-currency major units; no FX conversion.
- Batch/rate limits: batch is represented as per-subresponse outcomes; partial success is never collapsed to success. Rate-limit responses are classified as bounded-retry candidates and permission/policy/validation errors are not retryable.
- Idempotency/correlation: internal operation keys are authoritative; provider request IDs are supplementary sanitized correlation values.
- Regulated advertising/review: special-ad categories are rejected in this scope. Page/Instagram ownership and provider review states must be read back.
- Official source checked: Meta Marketing API official documentation. Access limitation above is intentionally fail-closed and must be rechecked before configuring a production version.

## TikTok for Business

- Version: required in `MARKETING_AD_EXECUTION_TIKTOK_API_VERSION`; no default was encoded because the official public documentation checked did not expose a single stable current Marketing API version suitable for hard-coding.
- Authentication/access: approved TikTok for Business developer app, Ad Management permission, advertiser access, and ADMIN or OPERATOR account role in the normalized model.
- Hierarchy/scope: manually configured campaign, ad group, creative, and ad only. Smart+, Reach and Frequency, and unapproved automated campaign families are blocked.
- Money: advertiser-account currency in Decimal major units; no FX conversion.
- Idempotency/correlation: deterministic `providerOperationKey` is independent of TikTok `request_id`; request ID is supplementary only.
- Spark/review: Spark Ads require explicit authorization. Provider review state is normalized and read back; creation success does not imply review approval.
- Rate limits/errors: provider rate limits are retryable only through bounded policy; permission, policy, and validation failures are not.
- Official source checked: TikTok for Business Marketing API documentation and developer application/permission guidance. Version configuration must be reverified before enabling any provider flag.

## LinkedIn Marketing API

- Version: the latest monthly version explicitly published in the official recent-changes page available during verification was `202604`. The implementation does not invent a newer default: a configured `YYYYMM` must be no later than the current month and remain within the rolling twelve-month support window, and write readiness still requires current provider discovery.
- Upgrade calendar: review on the first business day of every month; upgrade before the configured month's one-year support boundary.
- Authentication/access: `rw_ads` and an eligible CAMPAIGN_MANAGER, ACCOUNT_MANAGER, or ACCOUNT_BILLING_ADMIN role. Development versus Standard access and account edit restrictions are capability blockers.
- Transport: `/rest/` resources, `Linkedin-Version: YYYYMM`, and `X-Restli-Protocol-Version: 2.0.0`.
- Hierarchy/scope: campaign group, sponsored campaign, approved sponsored-content creative, and separate status operations.
- Money: provider currency amount in account currency; no FX conversion.
- Idempotency/correlation: internal keys are primary and provider request correlation is sanitized. Provider success requires read-back.
- Regulated advertising/review: protected-characteristic targeting and regulated advertising are blocked. Review state is provider-reported and normalized.
- Official sources: LinkedIn Marketing API recent changes, versioning, account access controls, and Marketing API access tiers.

## X Ads API

- Version: v12 endpoint family (`https://ads-api.x.com/12`) is the only configured version accepted by this baseline.
- Authentication/access: Ads API application access, an application with write permission represented as `ADS_API_WRITE`, and ACCOUNT_ADMIN or AD_MANAGER account access. Restricted/allowlist access is a permission capability blocker, not a generic connection error.
- Hierarchy/scope: funding instrument preflight (read-only), campaign, line item, targeting, and promoted-post association. Organic publishing is not implemented.
- Money: local micro-units, converted exactly once from Decimal major currency units.
- Validation/idempotency/correlation: no validate-only capability is claimed. Internal operation keys are primary; request IDs are supplementary. Known success requires read-back and unknown results are not blindly retried.
- Rate limits/review: official endpoint rate-limit headers are handled as bounded-retry signals. Provider approval/review state is normalized from read-back.
- Official sources: X Ads API v12 campaign-management reference, access documentation, and rate-limit documentation.

## Intentional deviations and deferred capabilities

- Google v25 was not selected because official documentation listed it as upcoming, while v24 was stable.
- Meta and TikTok do not get a hard-coded version claim because an authoritative current version could not be reliably established from their official public documentation during this run. Missing configuration fails closed.
- No provider SDK was added. Existing Axios/network infrastructure and dependency-injected clients are reused behind adapters; automated tests inject zero-network fakes.
- Google BatchJob, Google non-Search campaigns, regulated or political advertising, Meta special categories, TikTok Smart+/Reach and Frequency, LinkedIn regulated targeting, X funding mutations, and organic X publishing are deferred.
- This baseline records structural support only. It does not establish credentials, account permissions, production provider access, or write readiness.
