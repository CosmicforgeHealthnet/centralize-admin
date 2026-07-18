# Social Operations Environment Validation

Central validator:

`src/modules/marketing/social-operations/config/social-operations-env.validator.js`

Commands:

- `npm run config:validate`
- `npm run config:validate:staging`
- `npm run config:validate:production`

Validated modes:

- `development`
- `test`
- `staging`
- `production`

The validator reports variable names and reason codes only. It does not print secret values.

Staging and production fail closed for:

- missing or malformed `DATABASE_URL`;
- non-PostgreSQL URLs;
- localhost database hosts;
- production test database names;
- missing Social encryption keyring;
- missing active key version;
- active key version absent from keyring;
- invalid encryption key length;
- missing `SOCIAL_CONTENT_HASH_KEY`;
- local media storage;
- incomplete Cloudinary configuration;
- HTTP, wildcard, fragmented, malformed, or localhost callback URLs.

Provider flags:

- `META_SOCIAL_ENABLED`
- `TIKTOK_SOCIAL_ENABLED`
- `X_SOCIAL_ENABLED`
- `LINKEDIN_SOCIAL_ENABLED`

Disabled providers do not require credentials. Enabled staging/production providers require only their organic Social credentials and exact redirect URI. X Ads credentials do not satisfy X organic Social settings.

Worker constraints:

- heartbeat interval must be less than lease duration;
- retry min must not exceed retry max;
- concurrency, batch, lease, heartbeat, recovery, shutdown, and retry values are bounded;
- workers require a database;
- live inbox requires Phase D;
- Phase D and destructive redaction require the compliance gate.

Phase D and live inbox remain disabled by default.
