# HQ Secure Sessions and MFA (P0 Workstreams A and B)

Scope: the Centralized Admin (HQ) login used by every module (Admin, HR, Support,
Marketing, Social Operations and, once PR #13 merges, Mail). This branch is based
on `staging` and does **not** contain the Mail module; see "Mail integration" below.

Nothing here changes behaviour until the migration is applied **and** an
operator opts in (`AUTH_MFA_ENCRYPTION_KEYS`, `AUTH_SESSION_MODE`). The code is
**deploy-safe before the migration**: see section 0.

## 0. Deployment order (code first, migration later)

Merging to `staging` auto-deploys the API, and manual migrations are applied
separately, later. This release is built for that order.

- **The migration only adds new tables** (`admin_sessions`,
  `admin_session_refresh_tokens`, `admin_mfa_enrollments`,
  `admin_mfa_recovery_codes`, `admin_mfa_challenges`, `admin_auth_events`).
- **No existing table, column or enum changes.** The `AdminUser` and
  `RefreshToken` models gain relation fields only, which add no columns, so
  default-select reads such as login's `adminUser.findUnique({ where: { email } })`
  keep working against an unmigrated database.
- **No `AuditAction` values are added.** Session and MFA events go to
  `admin_auth_events`. Existing audit actions (`LOGIN`, `LOGOUT`,
  `TOKEN_REFRESHED`, `PASSWORD_CHANGED`) are written exactly as before.
- **A schema-readiness probe** (`src/shared/auth/schema-readiness.js`) checks all
  six tables with `to_regclass` on first use.
  - `true` is cached for the process.
  - `false` is re-checked every 30 s, so applying the migration takes effect
    without a restart.
- **While the schema is not ready, behaviour is exactly the pre-release one:**
  - login issues an 8 h JWT without a session id and a UUID refresh token in
    `admin_refresh_tokens`;
  - refresh, logout, change-password and the HR password reset run the original
    code paths;
  - there is no MFA challenge, even for users with the legacy `twoFactorEnabled`
    flag;
  - session and MFA endpoints answer `503 AUTH_SCHEMA_NOT_READY`;
  - `AUTH_SESSION_MODE=dual|cookie` is downgraded to `legacy` with a loud log
    warning (no crash);
  - emergency overrides fail closed with `VERIFIED_MFA_UNAVAILABLE`.
- **After the migration:**
  - sessions start being tracked (still the `legacy` contract unless the mode is
    changed);
  - the first refresh of a pre-migration refresh token upgrades it into a session;
  - pre-migration Bearer tokens keep working until they expire in
    `legacy`/`dual` mode.

Proof:

- `tests/auth-premigration-compat.test.js` runs the real app with the **new**
  generated client against a database without the new tables. The same 8 subtests
  pass against a database pushed straight from the `origin/staging` schema.
  It covers:
  - the login response shape;
  - the legacy cookies with no session cookies, although `AUTH_SESSION_MODE=cookie`
    is set;
  - the 8 h token without `sid`;
  - `/me`, `/api/profile/me`, `/api/hrm/attendance` and `/api/marketing/campaigns`;
  - legacy refresh rotation;
  - the 503s;
  - the emergency override failing closed;
  - logout and change-password;
  - that no new tables are touched.
- It then applies the migration in place and shows a pre-migration refresh token
  upgrading into a tracked session.

## 1. What changed

| Area | Before | After |
| --- | --- | --- |
| Access credential | 8 h JWT in the response body, stored by the frontend in `localStorage` and a JS-set `accessToken` cookie | `legacy`: unchanged. `dual`/`cookie`: 15 min JWT in an **httpOnly** cookie; nothing is persisted in browser storage |
| Session state | None server-side (JWT valid until expiry) | `admin_sessions` row per login (after migration); every request checks it is live, so logout, revocation, password change and deactivation take effect **immediately** |
| Refresh | UUID rotated in `admin_refresh_tokens`, no reuse detection | 256-bit random token in `admin_session_refresh_tokens`, SHA-256 stored, rotated per use, linked to its session. Reusing a rotated token outside a 10 s race window **revokes the whole session**. Pre-migration tokens are upgraded on first refresh |
| CSRF | n/a (Bearer only) | Cookie-authenticated unsafe requests need `X-CSRF-Token` (HMAC of session id + nonce) **and** a trusted `Origin`/`Referer` |
| Session lifetime | 7 d refresh, no idle limit | Idle 12 h, absolute 7 d (configurable), max 10 concurrent sessions per user (oldest revoked) |
| Google sign-in | Token in the redirect URL `?token=` | `legacy`: unchanged. `dual`/`cookie`: cookies + `?session=1`, no token in the URL |
| MFA | `twoFactorEnabled` flag, plaintext `twoFactorSecret`, no enrollment | Full lifecycle in `admin_mfa_enrollments`: password re-auth, encrypted secret, verify-before-activate, login challenge, replay guard, lockout, recovery codes, step-up, disable, admin reset, events in `admin_auth_events` |
| Privileged actions | Advertising-execution emergency overrides trusted `twoFactorEnabled === true` | Require verified enrollment **and** a step-up on the current session within 5 min |

## 2. Session modes and rollout

`AUTH_SESSION_MODE`:

| Mode | Response body | Cookies | Bearer accepted | CSRF |
| --- | --- | --- | --- | --- |
| `legacy` (default) | `accessToken` (8 h) | legacy `refreshToken` + `isLoggedIn` | yes | n/a |
| `dual` | `accessToken` (15 min) + `csrfToken` | `__Host-cf_at`, `__Secure-cf_rt` (httpOnly) | yes | cookie requests |
| `cookie` | `csrfToken` only | same as dual | **no** | cookie requests |

Server-side sessions, refresh reuse detection and immediate revocation apply in
**all** modes, including `legacy`. Access tokens minted before this release (no
`sid`) keep working as Bearer tokens until they expire (at most 8 h) in
`legacy`/`dual`; `cookie` mode refuses them.

The frontend follows the mode the API reports in each login/refresh response:

- `legacy`: stores the token exactly as before.
- `dual`/`cookie`: stores no token. It keeps the CSRF token in memory, re-fetches it from
  `GET /api/auth/session` after a reload, and sets a non-credential `cf_session=1` hint
  cookie for the Next.js middleware.
- In `dual` mode, if the browser refuses the API cookies, the body token is kept **in
  memory only** for that tab.

Rollout, one step per approved change:

1. Deploy the code (any order relative to the migration; section 0). Apply the
   migration (section 7) under the Admin DB owner's approval. Behaviour stays the
   `legacy` contract; sessions start being tracked.
2. Set `AUTH_MFA_ENCRYPTION_KEYS` from the secret manager. MFA enrollment becomes
   available under **Settings > Account security**.
3. Set `AUTH_SESSION_MODE=dual` plus the cookie settings in section 3. Check
   in the browser that `cf_at`/`cf_rt` are httpOnly, there is no `accessToken`
   in `localStorage`, and sign-in, reload, refresh and logout all work. Watch
   `CSRF_REJECTED` audit rows and 401 `AUTH_*` codes.
4. When no client relies on Bearer (old tabs expire within 15 min), set
   `AUTH_SESSION_MODE=cookie`.

Rollback: set the mode back (`cookie` → `dual` → `legacy`).

- Users signed in with cookies get a 401. The frontend then refreshes, receives a body
  token again and stores it the legacy way, or the user signs in again.
- No data migration is needed.
- The database rollback (section 7) is only for removing the feature entirely.

## 3. Cookies, domains and browsers

Cookie attributes come from:

- `AUTH_COOKIE_SAMESITE`: `none` in production by default, else `lax`.
- `AUTH_COOKIE_SECURE`: forced on with `SameSite=None`.
- `AUTH_COOKIE_DOMAIN`: optional.

The names follow from these settings:

- access cookie: `__Host-cf_at` (Secure, no Domain, `Path=/`);
- refresh cookie: `__Secure-cf_rt`, scoped to `Path=/api/auth` so it only travels to the
  auth endpoints;
- plain `cf_at` / `cf_rt` on http localhost.

| Deployment | Same-site? | Required settings | Works in Safari / strict 3P-cookie browsers |
| --- | --- | --- | --- |
| Staging today: `centralize-admin-staging.vercel.app` → `stagingca.cosmicforge-healthnet.com` | **No** (different registrable domains) | `SameSite=None; Secure` | **No**: Safari ITP and any browser blocking third-party cookies drop the API cookies. `dual` degrades to the in-memory Bearer token; `cookie` mode fails |
| Production frontend `centralize-admin.cosmiforgegroup.cloud` → API on `api.cosmiforgegroup.cloud` | **Yes** | `AUTH_COOKIE_SAMESITE=lax` (or `strict`) | Yes |
| Local dev `localhost:3000` → `localhost:4000` | Yes | defaults | Yes |

**Recommendation (infrastructure prerequisite for `cookie` mode):** serve the
API from a subdomain of the frontend's registrable domain, for example
`api.cosmiforgegroup.cloud` for `centralize-admin.cosmiforgegroup.cloud`, and use
`SameSite=Lax`. Until then use `dual`.

Vercel preview domains (`*.vercel.app`) are always cross-site to the API, so
previews stay on the Bearer fallback.

CSRF defence works in layers:

- CORS already rejects foreign origins for credentialed requests.
- `authenticate()` additionally refuses cookie-authenticated unsafe requests that have no
  trusted `Origin`/`Referer`, and those whose `X-CSRF-Token` doesn't match the session.
- Refresh and logout also require a trusted Origin when cookies are in use.
- Bearer requests are exempt: a browser cannot attach the header cross-site.

## 4. MFA lifecycle

- **Verified MFA** means an `admin_mfa_enrollments` row with `enrolled_at` set
  **and** an encrypted secret (a CHECK constraint enforces the pair).
  `admin_users.twoFactorEnabled` is kept in sync for compatibility only and is
  never accepted as evidence on its own. Users with the legacy flag and a
  plaintext secret are treated as not enrolled.
- **Enroll** (`POST /api/auth/mfa/enroll {password}`):
  - requires the current password;
  - generates a 160-bit secret, encrypted with AES-256-GCM (purpose and user bound) using
    the `AUTH_MFA_ENCRYPTION_KEYS` keyring;
  - returns the base32 secret and an `otpauth://` URI once (`Cache-Control: no-store`);
  - the pending secret expires after 15 min;
  - without a key the request fails closed with 503.
- **Activate** (`POST /mfa/activate {code}`):
  - activates only after a valid TOTP;
  - clears any legacy plaintext `twoFactorSecret` and issues 10 recovery codes, shown
    once and stored as salted SHA-256 hashes;
  - marks the current session MFA-verified.
- **Login:** a verified user gets
  `{ mfaRequired, challengeToken, challengeExpiresAt }` and **no session**.
  `POST /api/auth/login/mfa {challengeToken, code | recoveryCode}` mints a new session.
  The challenge is:
  - single use;
  - valid for 5 minutes;
  - limited to 5 attempts;
  - stored only as a hash.

  For Google sign-in the challenge travels in an httpOnly cookie, not the URL.
- **Replay guard:** each TOTP time-step is accepted at most once per user. This is
  enforced atomically with `admin_mfa_enrollments.last_used_step`.
- **Lockout:** after 5 consecutive failures MFA is locked for 15 minutes. The routes are
  also behind the existing `authLimiter`.
- **Step-up:** `POST /api/auth/mfa/step-up {code | recoveryCode}` stamps
  `admin_sessions.mfa_verified_at`. `requireRecentMfa(maxAgeMs)` (middleware) and
  `hasFreshVerifiedMfa(actor)` (services) require that stamp, on the same session, within
  5 minutes.
- **Recovery codes:** consumed atomically, and the user is notified on each use.
  Regenerating them (`POST /mfa/recovery-codes/regenerate`) requires a fresh step-up and
  invalidates the old codes.
- **Disable:** `POST /mfa/disable {password, code | recoveryCode}` ends every other
  session. Changing devices means disabling, then enrolling again.
- **Admin-assisted reset:** `POST /mfa/admin-reset {targetUserId, reason}`.
  - Allowed for SUPER, or for the HR rule already used for password resets (MANAGEMENT
    team-lead ADMIN).
  - The actor must have a fresh step-up.
  - Self-reset is refused, and only SUPER can reset a SUPER account.
  - The reset clears the enrollment and revokes all of the target's sessions.
  - It is audited (with the reason) and the target is notified.
- **Auth events** (table `admin_auth_events`, not `AuditAction`):
  - sessions: `SESSION_CREATED`, `SESSION_REVOKED`, `SESSIONS_REVOKED_ALL`,
    `REFRESH_TOKEN_REUSE_DETECTED`, `CSRF_REJECTED`;
  - MFA: `MFA_ENROLLMENT_STARTED`, `MFA_ENROLLED`, `MFA_CHALLENGE_ISSUED`, `MFA_VERIFIED`,
    `MFA_FAILED`, `MFA_LOCKED`, `MFA_RECOVERY_CODE_USED`,
    `MFA_RECOVERY_CODES_REGENERATED`, `MFA_DISABLED`, `MFA_ADMIN_RESET`, `MFA_STEP_UP`.
- **Key rotation:**
  - Add `k2` to `AUTH_MFA_ENCRYPTION_KEYS` and set `AUTH_MFA_ENCRYPTION_ACTIVE_KEY=k2`.
    New enrollments use k2, and old ones still decrypt with k1 (`needsRewrap()` reports
    them).
  - Remove k1 only after every k1 enrollment has been re-enrolled or rewrapped. A rewrap
    job is a follow-up.
  - Losing every key means all users must re-enroll through admin reset.

Frontend: **Settings > Account security** covers:

- two-factor setup (manual key plus the `otpauth` link; no QR library was added, to avoid
  a new dependency);
- recovery codes: show, download, copy, regenerate with step-up;
- turning MFA off;
- the session list, with end session and sign out everywhere.

The login page and the Google callback show the second-factor step.

## 5. API summary

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | none | may return `mfaRequired` |
| POST | `/api/auth/login/mfa` | challenge | `{challengeToken?, code \| recoveryCode}` |
| POST | `/api/auth/refresh-token` | refresh cookie | trusted Origin in dual/cookie |
| POST | `/api/auth/logout` | cookies | revokes the session |
| POST | `/api/auth/logout-all` | session | |
| GET | `/api/auth/session` | session | user, mode, MFA summary, `csrfToken` |
| GET / DELETE | `/api/auth/sessions[/:id]` | session | own sessions only |
| GET | `/api/auth/mfa/status` | session | |
| POST | `/api/auth/mfa/enroll`, `/activate`, `/step-up`, `/disable` | session | |
| POST | `/api/auth/mfa/recovery-codes/regenerate`, `/admin-reset` | session + fresh step-up | |

Errors use the standard envelope with a `code`:

- sessions: `AUTH_SESSION_REVOKED`, `AUTH_SESSION_EXPIRED`, `AUTH_SESSION_INVALID`;
- refresh: `AUTH_REFRESH_RACE`, `AUTH_REFRESH_REUSED`, `AUTH_REFRESH_INVALID`;
- requests: `AUTH_CSRF_INVALID`, `AUTH_ORIGIN_REJECTED`, `AUTH_BEARER_DISABLED`;
- MFA: `MFA_STEP_UP_REQUIRED`, `MFA_CODE_INVALID`, `MFA_LOCKED`, `MFA_UNAVAILABLE`
  (503), `MFA_CHALLENGE_INVALID`, `MFA_NOT_ENROLLED`.

## 6. Compatibility assessment

- **`req.adminUser` is unchanged** (same fields; verified by test). Session and
  MFA facts are on the new `req.authSession`. Every existing module using
  `authenticate()` (Admin, HR, Support, Marketing, Social Operations, and Mail
  after PR #13) keeps working in all modes.
- Existing users without MFA log in exactly as today. Existing refresh
  cookies (pre-release rows) upgrade into a tracked session on first refresh.
- `admin_users` and `admin_refresh_tokens` are not altered; the new client reads
  them identically before and after the migration (section 0).
- Changes that affect existing behaviour:
  - Password change now ends every session immediately. Before, other devices kept their
    8 h tokens.
  - An HR-approved password reset also ends the user's sessions.
  - Replaying a refresh token that has already been rotated logs that session out. This
    is a security improvement, softened by the 10 s race window for multi-tab refreshes.
  - Advertising-execution emergency overrides and emergency policy changes now need a
    verified enrollment plus a fresh step-up. Operators must enroll before using them.
- **Mail (PR #13) integration point.**
  - PR #13's `authz/step-up.service.js` still reads `twoFactorEnabled` + plaintext
    `twoFactorSecret`. A user who enrolls through this flow has an encrypted secret in
    `admin_mfa_enrollments` and `twoFactorSecret = null`, so Mail step-up keeps
    returning `MAIL_MFA_NOT_ENROLLED` until it adopts the shared core.
  - Whichever PR merges second should switch Mail step-up to load the enrollment row,
    then use `resolveTotpSecret({ enrollment })` and `matchTotp()` from
    `src/shared/auth/mfa-core.js`. It should keep its own single-use
    `MailStepUpVerification` table, use `isMfaEnrolled(enrollment)`, and treat a
    missing table as "not enrolled" (fail closed).
  - This is a small, mechanical change inside the Mail module, which imports only
    `shared/*`.
- **Migration numbering:** this migration is manifest order 27, and PR #13's Mail migration
  is also order 27. Whichever merges second must be renumbered to 28 (regenerate the
  manifest, bump the count in `tests/social-operations-section16-migration-ci.test.js`,
  and re-run `db:replay:verify`).

## 7. Database

Migration `prisma/manual-migrations/20261025_add_admin_sessions_mfa.sql` (manifest
order 27) is **new tables only**:

- `admin_sessions`, `admin_session_refresh_tokens`, `admin_mfa_enrollments`,
  `admin_mfa_recovery_codes`, `admin_mfa_challenges`, `admin_auth_events`;
- foreign keys from the new tables to `admin_users`;
- CHECK constraints on the session mode, the expiry order, the challenge attempts and
  verified-enrollment consistency.

No existing table, column, index or enum is altered.

Verification:

- `db:replay:verify` passes with drift none.
- Apply on a staging-schema database, then `migrate diff`: exit 0.

Rollback: `docs/sql/hq-auth-sessions-mfa-rollback.sql`.

- It drops the six tables and removes the ledger row.
- Verified round trip: staging schema, then migration, then rollback. `migrate diff`
  against the staging schema says "No difference detected": **no residue**.
- Order: set `AUTH_SESSION_MODE=legacy`, roll back, then **restart** the API (readiness
  is cached as ready per process).
- It deletes all sessions and MFA enrollments, so users sign in and re-enroll.
- Take a `pg_dump` first, and apply only under the Admin DB owner's approval.

## 8. Threat model (summary)

| Threat | Mitigation |
| --- | --- |
| XSS steals the token | `cookie` mode: no JS-readable credential. The CSRF token is not a credential. `dual` keeps a memory-only token only when cookies are blocked |
| CSRF | SameSite, CORS allowlist, Origin/Referer check, per-session HMAC CSRF token |
| Refresh token theft | Rotation, family reuse detection (session revoked), hashed at rest, `Path=/api/auth` |
| Session fixation | Session ids are created only server-side after authentication; login always mints a new session; forged or cross-user `sid` is refused |
| Stolen access token after logout | Server-side session check on every request (15 min TTL as a backstop) |
| Password-only compromise | MFA challenge before any session; TOTP replay guard; lockout; rate limits |
| MFA secret disclosure from the DB | AES-256-GCM with a keyring outside the DB, AAD bound to the user id |
| Recovery-code theft from the DB | Salted hashes, single use, user notified |
| Insider resets someone's MFA | Authorized roles only, actor step-up, reason, audit, target notified, SUPER protected |

## 9. Remaining gaps and blockers

- **Infrastructure:** `cookie` mode needs a same-site API hostname (section 3).
  Staging today is cross-site, so it can only run `legacy`/`dual`.
- **Secrets:**
  - `AUTH_MFA_ENCRYPTION_KEYS` must come from the secret manager; KMS wrapping is part of
    Workstream C.
  - A rewrap job for MFA key rotation is not built.
- **Frontend automated E2E:** `staging` has no Playwright setup. PR #13 adds one, and
  login/MFA specs should land there after both merge, to avoid conflicting infra
  files.
  - Evidence for this PR is a real-browser run against the real API and a production
    build. Cookie mode had 15 checks covering login, httpOnly cookies, no stored
    token, enrollment, recovery codes, reload, sign out everywhere, the MFA challenge,
    a wrong code, the correct code and the 390 px layout. Legacy mode had 3 checks.
- **Not covered:**
  - WebAuthn/passkeys;
  - mandatory-MFA policies per tier, since MFA is optional per user today (enforcing it
    for SUPER/ADMIN is a product decision);
  - admin-reset UI (the API is complete; HR screens are a follow-up);
  - Mail step-up adoption (section 6).
- Rate limiting reuses the in-memory `express-rate-limit`. That is per instance, so a
  multi-instance deployment needs a shared store.
