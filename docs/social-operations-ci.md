# Social Operations CI

Workflow:

`.github/workflows/social-operations-ci.yml`

The validation workflow uses one PostgreSQL 16 service as the CI instance of the project Admin database. The service database is named `cosmicforge_admin`, uses the `public` schema, and disables workers, Phase D, live inbox, and all live provider flags.

CI checks:

- `npm ci`
- Prisma format, validate, generate
- `npm run config:validate`
- `npm run config:validate:staging`
- `npm run config:validate:production`
- `npm run db:manifest:verify`
- `npm run db:admin:guard`
- `npx prisma db push --schema prisma/schema.prisma`
- `npm run db:admin:prepare`
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

Migration manifest policy:

- CI runs `npm run db:manifest:verify`.
- CI does not run `npm run db:manifest:generate`.
- Manifest checksums are canonicalized as UTF-8 text with no BOM, LF line endings, and exactly one final newline.
- This prevents Windows CRLF checkouts and Linux LF checkouts from producing different checksums while still detecting meaningful SQL text changes.

Admin database preparation:

- Prisma `db push` creates the Prisma-representable schema but does not create PostgreSQL partial indexes.
- CI therefore runs `npm run db:admin:prepare` after `prisma db push` and before `npm run db:schema:assert`.
- The preparation command validates that `DATABASE_URL` targets `cosmicforge_admin` on an approved local CI host and confirms `current_database()` and `current_schema()` without printing credentials.
- It verifies the migration manifest, takes a PostgreSQL advisory lock, checks for duplicate rows covered by the required partial unique indexes, applies the approved PostgreSQL-only corrective artifact, and records it in `public.social_manual_migrations`.
- Re-running the command is idempotent: an already recorded artifact must have the same canonical checksum and the required indexes must still match the strict catalog assertions.
- CI does not create `cosmicforge_social_replay_*` or any other second database.

Runtime network protection:

- CI sets `TEST_NETWORK_GUARD_ENABLED=true`.
- Ordinary `npm test` and focused Social Operations tests load `tests/helpers/network-guard.js` before test modules import app or provider code.
- The guard blocks unexpected outbound `fetch`, HTTP, HTTPS, socket, DNS, axios, provider SDK, Cloudinary SDK, and remote-media transports.
- Only registered local test servers and the configured local/ephemeral PostgreSQL destination are allowed.
- `tests/network-guard.test.js` deliberately attempts external requests and passes only when the guard blocks them with sanitized errors.

No validation workflow deploys staging or production. Provider calls are not made; provider acceptance remains mocked.
