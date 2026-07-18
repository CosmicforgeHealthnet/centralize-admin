# Social Operations Migration Replay

Authoritative sources:

- Prisma schema: `prisma/schema.prisma`
- Manual SQL directory: `prisma/manual-migrations/`
- Manifest: `prisma/manual-migrations/manifest.json`

Commands:

- `npm run db:manifest:verify`
- `npm run db:replay:verify`
- `npm run db:replay:ci`
- `npm run db:schema:assert`

Replay behavior:

1. Verify manual migration membership and SHA-256 checksums.
2. Create a disposable PostgreSQL database from local or CI `DATABASE_URL`.
3. Push the current Prisma schema into that disposable database.
4. Apply the ordered manual SQL chain. Legacy plain `CREATE TYPE` statements are wrapped at replay time so duplicate enum types do not break verification; source migration files are not rewritten.
5. Assert Social Operations tables, partial indexes, foreign-key type compatibility, and task assignee nullability.
6. Run Prisma drift comparison and report the result.
7. Drop the disposable database unless `--keep` is explicitly passed.

Partial indexes verified:

- `social_webhook_subscription_connection_event_unique`
- `social_webhook_subscription_identity_event_unique`
- `social_posts_legacy_source_id_unique`

The replay command does not mutate the existing local `cosmicforge_admin` database.
