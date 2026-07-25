# CosmicForge Marketing Intelligence Phase 2 Live-Validation Matrix

Generated 2026-07-19. This document records engineering capability separately from real-provider acceptance. No live validation was performed during automated development or testing.

## Safety boundary

Live execution requires both `MARKETING_LIVE_VALIDATION_ENABLED=true` and `--confirm-live`, one supported platform, one connection UUID, one bounded account, and a maximum seven-day date range. The tool refuses `NODE_ENV=test`. All provider operations are read-only.

## Capability matrix

| Capability | META | TIKTOK | X | LINKEDIN | GOOGLE_ADS |
|---|---|---|---|---|---|
| Connector registration | Yes | Yes | Yes | Yes | Yes |
| Credential mode | OAuth token | Access/refresh token | OAuth 1.0a | OAuth access/refresh | OAuth refresh + developer token |
| Campaign reads | Implemented | Implemented | Implemented | Implemented | Implemented |
| Creative catalog | Ads with creative metadata | Ads/optional creative ID | Promoted entities | Creative URNs | Ads/resource names |
| Creative insights | Daily ad | Daily auction ad | Daily billing/engagement | Creative-pivot daily | GAQL daily ad |
| Pagination | Graph cursor | Page number | Cursor | Start/count | Page token |
| Rate-limit handling | 429 classified/retried | provider code/429 | 429 classified/retried | 429 classified/retried | 429 classified/retried |
| Token refresh | Reauthorization flow | Refresh supported | Rotation/OAuth 1.0a | Refresh supported | Refresh supported |
| Currency | Connection/account currency | Connection/account currency | Connection currency | Local/connection currency | Customer/connection currency |
| Micro-units | Not applicable | Not applicable | Converted once | Not applicable | Converted once |
| Stable account key | ad account ID | advertiser ID | Ads account ID | sponsored-account URN | customer ID |
| Stable campaign key | campaign ID | campaign ID | campaign/line-item identity | campaign URN | campaign ID/resource |
| Stable creative key | creative ID or ad fallback | creative ID or ad fallback | tweet/promoted entity ID | full creative URN | ad resource/ID |
| Raw-storage policy | bounded/sanitized | bounded/sanitized | bounded/sanitized | bounded/sanitized | bounded/sanitized |
| Mock tests | Passing | Passing | Passing | Passing | Passing |
| Live status | CREDENTIALS_REQUIRED | CREDENTIALS_REQUIRED | CREDENTIALS_REQUIRED | CREDENTIALS_REQUIRED | CREDENTIALS_REQUIRED |
| Capability blocker | live credentials | live credentials/account access | credentials and possible Ads API approval | credentials and possible Ad Analytics permission | credentials and possible developer-token approval |

## Gate results

| Check | META | TIKTOK | X | LINKEDIN | GOOGLE_ADS |
|---|---|---|---|---|---|
| Connection test | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |
| Bounded account/date fetch | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |
| Pagination | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |
| Rate-limit evidence | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |
| Phase 1 campaign reconciliation | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |
| Repeat stable creative IDs | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |
| Currency reconciliation | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |
| Micro-unit reconciliation | N/A | N/A | NOT_RUN | N/A | NOT_RUN |
| Sanitized raw-storage review | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |
| Catalog/insight row counts | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |
| Scoring observation | NOT_ENABLED | NOT_ENABLED | NOT_ENABLED | NOT_ENABLED | NOT_ENABLED |
| Operator approval | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |

## Exact command template

```powershell
$env:MARKETING_LIVE_VALIDATION_ENABLED='true'
npm run marketing:live-validate -- --confirm-live --platform=<META|TIKTOK|X|LINKEDIN|GOOGLE_ADS> --connection-id=<uuid> --from=<YYYY-MM-DD> --to=<YYYY-MM-DD> --account=<bounded-account-id>
```

The CLI records safe status, counts, pagination observation, stable-ID comparison, provider category, and blockers in `docs/marketing-intelligence-phase2-live-validation-status.json`. It intentionally leaves campaign reconciliation, rate-limit evidence, score/fatigue review, and final approval for the authorized operator. A partial tool success is `LIVE_VALIDATION_IN_PROGRESS`, not release approval.

## Approval record

For each platform, the release owner must record date, connection ID, bounded account (non-secret), reviewer, provider capability limitation, reconciliation notes, monitoring owner, rollback owner, and final status. Never copy tokens, authorization headers, credential envelopes, or raw provider bodies into this document.
