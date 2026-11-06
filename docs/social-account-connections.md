# Social account connection setup

The old username/password endpoint is retired. Both Marketing > Social Media > Link New Account and Social Operations > Accounts > Connect account use provider authorization. Passwords are entered only on the provider website.

## Server configuration

For each supported provider (`META`, `TIKTOK`, `X`, `LINKEDIN`), configure these protected server environment values:

- `SOCIAL_<PROVIDER>_CLIENT_ID`
- `SOCIAL_<PROVIDER>_CLIENT_SECRET`
- `SOCIAL_<PROVIDER>_REDIRECT_URI`
- Optional `SOCIAL_<PROVIDER>_SCOPES`: only scopes approved for the registered organic app. Defaults request account/read access, not publishing.

For Meta, existing `META_APP_ID` and `META_APP_SECRET` are accepted as fallbacks; explicitly configured SOCIAL_META credentials take precedence. `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_ID` are not used for the login flow. The existing Meta app must support the required organic permissions and exact callback.

For TikTok use the Login Kit client key as CLIENT_ID. These are organic apps, not TikTok Business/advertiser credentials. X uses an OAuth 2 confidential web app with PKCE, not the advertising OAuth 1 consumer key.

Register the exact HTTPS callback with each platform, for example `https://<api-host>/api/v1/marketing/social/oauth/META/callback`. Add every exact callback to `SOCIAL_OAUTH_REDIRECT_URIS` (comma-separated). Use uppercase provider names in configured callbacks to match the existing validator.

Keep the existing persistent `SOCIAL_ENCRYPTION_KEYS_JSON` / active key version (or SOCIAL_OPERATIONS equivalents). Never replace a keyring used for stored credentials. Configure `ADMIN_FRONTEND_PUBLIC_URL` to the trusted frontend origin for the post-authorization return to Social Operations > Accounts. Never accept a return origin from request parameters.

No credentials belong in NEXT_PUBLIC variables. The provider-options endpoint exposes readiness booleans only. Missing apps remain unavailable; the server does not invent credentials or simulate success.

## Verification

Run `node --test tests/social-account-provider-oauth.test.js` from services/central-admin-api. Provider HTTP and persistence are isolated doubles; state hashing, expiry, atomic consumption, browser binding, PKCE and AES-GCM are real. These tests are not proof of a deployed provider connection.

After deploying frontend and backend together and configuring the registered app, an authorized staff member selects the platform, approves access at its website, and returns to Accounts. Confirm the actual connection and discovered identity records. Test declined consent, wrong browser and expired state. No tokens are returned to the frontend.

Connecting an account does not certify publishing, messaging, webhook health or refresh workers. Those operations remain governed by the existing provider adapters and capability checks. YouTube is not implemented by the current Social Operations schema/adapters.

Initial staging inspection on 6 November 2026 found no organic provider app credentials configured. The user subsequently supplied Meta credentials in a Git-ignored private file and explicitly authorized verification with Meta. Meta accepted the credentials. They were installed in the existing staging environment file, preserving its root:cf-staging-deploy ownership and 0640 permissions, a root-only backup, the existing keyring, unrelated settings and existing callback allowlist entries. The tested API was subsequently deployed through the approved GitHub Actions workflow. TikTok, X and LinkedIn remain unavailable because their app configuration has not been supplied.

Provider references: [X OAuth 2 PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code), [TikTok Login Kit](https://developers.tiktok.com/docs/en/login-kit-web), [LinkedIn OpenID Connect](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2), [Facebook manual login](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/).
