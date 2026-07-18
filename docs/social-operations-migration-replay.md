# Social Operations Migration Replay

Authoritative sources:

- Prisma schema: `prisma/schema.prisma`
- Manual SQL directory: `prisma/manual-migrations/`
- Manifest: `prisma/manual-migrations/manifest.json`

Commands:

- `npm run db:manifest:generate`
- `npm run db:manifest:verify`
- `npm run db:admin:guard`
- `npm run db:admin:prepare`
- `npm run db:replay:verify`
- `npm run db:schema:assert`

Manifest checksum rules:

- Manual migration checksums are calculated from canonical UTF-8 text.
- One leading UTF-8 BOM is removed before hashing.
- CRLF and lone CR line endings are converted to LF.
- The canonical hash input always has exactly one final newline.
- Internal SQL whitespace, identifiers, values, and comments remain meaningful and detectable.
- Manifest filenames are stored as migration basenames and sorted with deterministic bytewise ordering.

The manifest previously used raw file bytes, which made Windows CRLF working-tree files hash differently from Linux/GitHub Actions LF checkout files. CI now verifies the committed manifest using canonical checksums; it must not regenerate the manifest during validation.

Developer workflow after adding or intentionally editing a manual migration:

1. Run `npm run db:manifest:generate`.
2. Review `prisma/manual-migrations/manifest.json`.
3. Run `npm run db:manifest:verify`.
4. Run migration replay and schema assertions before committing.

Same Admin database preparation:

1. Confirm `DATABASE_URL` targets `cosmicforge_admin` and `public` with `npm run db:admin:guard`.
2. Push the Prisma schema to that same Admin database.
3. Run `npm run db:admin:prepare`.
4. Run `npm run db:schema:assert`.

`npm run db:admin:prepare` does not create another database. It verifies the manifest, acquires an advisory lock, checks for duplicate rows covered by required partial unique indexes, applies approved PostgreSQL-only artifacts to `public` in `cosmicforge_admin`, and records successful application in `public.social_manual_migrations` with the canonical checksum. A changed checksum for an applied artifact is fatal.

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

The replay command remains an optional local developer verification tool. Social Operations CI does not call it and does not create `cosmicforge_social_replay_*`; CI uses the same-database Admin preparation flow instead.
