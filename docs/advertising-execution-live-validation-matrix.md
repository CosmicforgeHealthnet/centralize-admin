# Advertising Execution live-validation matrix

Checked 2026-07-23. No live provider request was made during implementation. Every row is therefore `NOT_LIVE_VALIDATED`; account-specific capability must be discovered at runtime and fails closed when stale or missing.

| Provider | Version source | Required access | Structural implementation | Known blocker status |
|---|---|---|---|---|
| Google Ads | `MARKETING_AD_EXECUTION_GOOGLE_ADS_API_VERSION`; official releases list v24.2 as released June 2026 | OAuth, developer token, accessible customer, edit role | Search campaign hierarchy, creative/targeting/bidding validation, read-back | credentials/access tier/test account unverified |
| Meta | `MARKETING_AD_EXECUTION_META_API_VERSION`; no hard-coded default | OAuth scopes, ad-account role, Page/identity ownership | campaign/ad set/creative/ad hierarchy, review sync | app review, account and identity permissions unverified |
| TikTok | `MARKETING_AD_EXECUTION_TIKTOK_API_VERSION`; no hard-coded default | approved Business API app, advertiser role, Spark authorization where used | campaign/ad group/ad hierarchy, review sync | API access and sandbox advertiser unverified |
| LinkedIn | `MARKETING_AD_EXECUTION_LINKEDIN_API_VERSION` (`YYYYMM`); version header required | `rw_ads`, eligible ad-account role, product access | campaign group/campaign/creative hierarchy, monthly version header | product tier/account role unverified |
| X | `MARKETING_AD_EXECUTION_X_API_VERSION`; implementation accepts `12` | Ads API access, OAuth account permissions, funding instrument | campaign/line item/promoted content hierarchy and read-back | Ads API access/funding instrument unverified |

Official references: [Google Ads release/sunset schedule](https://developers.google.com/google-ads/api/docs/sunset-dates), [LinkedIn Marketing versioning](https://learn.microsoft.com/en-us/linkedin/marketing/versioning), [TikTok API for Business portal](https://business-api.tiktok.com/portal), [X Ads API introduction](https://docs.x.com/x-ads-api/introduction), and [Meta official Marketing API collection](https://www.postman.com/meta/facebook-marketing-api/overview).

Before changing any row to validated, record sandbox/test-account availability, exact scopes/roles, capability response, supported campaign/creative/targeting/bidding combinations, review behavior, rate-limit response, sanitized provider request IDs and test date. Confidence or successful recommendation scoring never changes approval requirements.

Section 29.2 status (checked 2026-07-23): every provider remains `NOT_LIVE_VALIDATED`. A fail-closed live harness now exists (`npm run live:read:<provider>` / `npm run live:validate:<provider>`, `scripts/advertising-execution/live-validate.js`) but has never been executed; it requires explicit double confirmation, a sandbox connection, account/currency/destination allowlists, a Decimal budget cap, forced-paused resources, a sanitized created-resource ledger in `artifacts/advertising-execution-live-validation/` and verified cleanup. A row changes to `LIVE_VALIDATED` only after such a run completes with verified read-back and verified cleanup, with the ledger reference recorded here. See `docs/advertising-execution-operations-runbook.md` for the full procedure.
