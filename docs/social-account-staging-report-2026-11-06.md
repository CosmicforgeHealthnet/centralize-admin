# Social account staging release ? 6 November 2026

The API connection fix is deployed on staging. The complete browser-to-Meta flow is not yet accepted: Vercel is rate-limiting the frontend deployment, and the Meta app dashboard callback/organic permissions have not been confirmed. No authenticated staff consent or publishing test is claimed.

## Released code and checks

- Runtime source: `97d35dae6460dda3ec97fac1d737779b55c9a1b0`.
- Runtime image: `ghcr.io/cosmicforgehealthnet/admin-backend:staging-97d35dae6460dda3ec97fac1d737779b55c9a1b0`.
- Image ID: `sha256:d0f01395fb263d2a6c0eaf4d45b2bc2c27be8fa4a893bb38f48824fa06862068`.
- [Approved staging release](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/42187197793): full backend verification, SSH identity, image publication and deployment succeeded. This includes Social Operations, Mail compatibility, full tests and security gates.
- [Frontend CI](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/42185988271): lint/build and mocked-API browser suite passed. Its frontend tree is identical to the deployed API commit's frontend tree. This is not a successful Vercel deployment or a live provider-consent test.
- Eleven isolated OAuth regressions passed, using real single-use state, expiry, browser binding, encryption and PKCE with mocked provider HTTP/persistence. Frontend TypeScript checking passed. Secret scan reported zero findings; static safety and test-network checks passed.

## Observed runtime

- API process running; `/health` returned 200. No Docker healthcheck is configured, so this is an HTTP health observation, not a claimed Docker healthy status.
- Meta provider readiness reports available; TikTok, X and LinkedIn report setup required.
- Public provider readiness endpoint returns 401 without authentication, verified with Windows native TLS and from the VPS.
- Server certificate verified from the VPS: valid through 31 December 2026. Windows native TLS succeeded. Python on this Windows machine separately reported an expiry-validation problem; verification was not disabled to work around it.
- Existing unrelated Mail/Marketing design edits were excluded. No production/main deployment, schema migration, publishing-worker activation or domain write capability was introduced.

## Remaining acceptance

1. Vercel must permit the frontend build; GitHub statuses currently report a deployment rate limit and retry in 24 hours. No paid plan or alternative hosting was enabled.
2. A person with Meta app dashboard access must confirm the exact callback `https://stagingca.cosmicforge-healthnet.com/api/v1/marketing/social/oauth/META/callback`, supported login configuration, app mode and approved organic scopes. Possession of the app secret does not establish dashboard access or these approvals.
3. An authorized staff member must complete genuine Meta consent and verify the resulting connection and identities. Tokens/passwords must not be pasted into chat. Connecting an account does not certify the existing provider publishing/messaging adapters.
