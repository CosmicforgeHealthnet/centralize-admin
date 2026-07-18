# Social Operations CI

Workflow:

`.github/workflows/social-operations-ci.yml`

The validation workflow uses PostgreSQL 16 as an ephemeral CI service and disables workers, Phase D, live inbox, and all live provider flags.

CI checks:

- `npm ci`
- Prisma format, validate, generate
- `npm run config:validate`
- `npm run config:validate:staging`
- `npm run config:validate:production`
- `npm run db:manifest:verify`
- `npm run db:replay:ci`
- `npm run db:schema:assert`
- `npm run migrations:safety`
- `npm run security:secret-scan`
- `npm run security:audit-policy`
- `npm run security:audit-policy:production`
- `npm run security:static-social`
- `npm run security:network-guard-static`
- `npm run security:sbom`
- `npm run test:network-guard`
- `npm run test:social-operations`
- `npm test`

Runtime network protection:

- CI sets `TEST_NETWORK_GUARD_ENABLED=true`.
- Ordinary `npm test` and focused Social Operations tests load `tests/helpers/network-guard.js` before test modules import app or provider code.
- The guard blocks unexpected outbound `fetch`, HTTP, HTTPS, socket, DNS, axios, provider SDK, Cloudinary SDK, and remote-media transports.
- Only registered local test servers and the configured local/ephemeral PostgreSQL destination are allowed.
- `tests/network-guard.test.js` deliberately attempts external requests and passes only when the guard blocks them with sanitized errors.

No validation workflow deploys staging or production. Provider calls are not made; provider acceptance remains mocked.
