# CosmicForge Mail - Staging Migration Runbook

Migration artifact: `services/central-admin-api/prisma/manual-migrations/20261024_add_cosmicforge_mail_m1_m6.sql`
(manifest order 27, checksum in `manifest.json`).
Rollback artifact: `docs/sql/cosmicforge-mail-m1-m6-rollback.sql` (manual only).

The migration was amended once before any application (post-review remediation added
`OUTCOME_UNKNOWN` statuses and `mail_message_recipients.provider_message_id`); always use the
checksum in `manifest.json` from the reviewed commit.

The migration is **additive**: 33 new enums, 36 new tables, indexes, CHECK
constraints, 3 partial unique indexes, a GIN full-text index, and 2 trigger
functions (append-only evidence, legal-hold delete guard). It does not alter,
drop or rewrite any existing table, column or type. It was verified with
`npm run db:replay:verify` (committed baseline + all 27 manual migrations ->
`prisma migrate diff` reports **no drift** against `prisma/schema.prisma`).

Nothing in CI, the staging deploy job or the application applies this
migration automatically. CI's `prisma db push` runs only against its own
disposable PostgreSQL service container.

## 1. Prerequisites

- [ ] PR reviewed and merged to `staging`; staging image deployed with all Mail flags **off**
      (`MAIL_ENABLED=false` is the default - an unmigrated database is harmless while off).
- [ ] Change window agreed with the Admin DB owner. HealthNet / Karryam product databases are not touched.
- [ ] Operator has `psql` access to the staging Admin database as the schema owner role.
- [ ] `npm run db:manifest:verify` passes on the deployed commit.
- [ ] `npm run db:admin:guard` confirms the intended staging Admin target (never a product DB).

## 2. Backup

```bash
export ADMIN_DB_URL='postgresql://...staging admin...'   # never commit
pg_dump --format=custom --no-owner --file "admin-staging-pre-mail-$(date +%Y%m%d%H%M).dump" "$ADMIN_DB_URL"
pg_restore --list admin-staging-pre-mail-*.dump | head   # confirm the archive is readable
```

Store the dump in the approved backup location; do not copy it to laptops.

## 3. Pre-flight checks

```sql
-- Must return 0 rows (no name collisions).
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public' AND (table_name LIKE 'mail\_%' OR table_name LIKE 'marketing\_email\_%')
   AND table_name <> 'marketing_email_templates';
-- Must return 0 rows.
SELECT 1 FROM social_manual_migrations WHERE file = '20261024_add_cosmicforge_mail_m1_m6.sql';
```

## 4. Apply (single transaction)

```bash
cd services/central-admin-api
sha256sum prisma/manual-migrations/20261024_add_cosmicforge_mail_m1_m6.sql   # compare with manifest.json (LF-normalised)
psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
  -f prisma/manual-migrations/20261024_add_cosmicforge_mail_m1_m6.sql
psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 -c \
  "INSERT INTO social_manual_migrations (file, sha256) VALUES ('20261024_add_cosmicforge_mail_m1_m6.sql', '<sha256 from manifest.json>');"
```

## 5. Verification

```bash
DATABASE_URL="$ADMIN_DB_URL" npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
# exit 0 = no drift
```

```sql
SELECT count(*) FROM information_schema.tables WHERE table_schema='public'
  AND (table_name LIKE 'mail\_%' OR table_name IN ('marketing_email_contacts','marketing_email_consents',
  'marketing_email_suppressions','marketing_email_audiences','marketing_email_audience_contacts',
  'marketing_email_segments','marketing_email_studio_templates','marketing_email_template_versions',
  'marketing_email_campaigns','marketing_email_campaign_snapshots','marketing_email_campaign_approvals'));   -- 36
SELECT tgname FROM pg_trigger WHERE tgname LIKE 'TRG_mail%' OR tgname LIKE 'TRG_marketing_%';               -- 5 triggers
SELECT indexname FROM pg_indexes WHERE indexname IN ('UQ_mail_memberships_active_member',
  'UQ_mail_sender_grants_active','UQ_marketing_email_suppressions_active','IDX_mail_messages_search_fts');  -- 4
```

Then restart the staging API (flags still off) and confirm existing login, HR,
Support, Marketing and Social Operations smoke checks still pass.

## 6. Rollback

Preferred (no Mail data worth keeping yet): run the reviewed rollback script.

```bash
psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 -f docs/sql/cosmicforge-mail-m1-m6-rollback.sql
```

It drops only the Mail objects created by this migration and removes the
ledger row. Existing tables are untouched (verified against a disposable
replay database).

If Mail data must be preserved, do **not** run the rollback: set
`MAIL_ENABLED=false` (the API returns 503 for every Mail route and the worker
exits) and keep the tables. Full restore from the section 2 dump is the last
resort and loses every Admin write made after the backup.

## 7. Enabling Mail on staging (separate approvals)

Enable in this order, one flag per change, each with its own approval:

1. `MAIL_ENABLED=true` with `MAIL_STORAGE_PROVIDER=filesystem` + `MAIL_STORAGE_LOCAL_DIR` on an
   encrypted private volume, `MAIL_ENCRYPTION_KEYS` from the secret store, and a scanner
   (`MAIL_SCANNER_PROVIDER=clamd`). Without storage/keys/scanner Mail fails closed.
2. Create organizations, register an allowlisted **test** domain (`MAIL_DOMAIN_ALLOWLIST`),
   enter its Resend domain id and run "verify" (read-only; no DNS changes are made by the app).
3. `MAIL_WORKER_ENABLED=true` on exactly one worker container (`npm run mail:worker`).
4. `MAIL_SENDING_ENABLED=true` with `RESEND_API_KEY` for the test domain only.
5. `MAIL_RECEIVING_ENABLED=true` with `RESEND_WEBHOOK_SECRET`, after the Resend receiving route
   for the **test** domain is configured by the domain owner.
6. `MAIL_MARKETING_ENABLED=true` (authoring + approvals only; no dispatch exists in M6).

Production MX/DNS, `marketing@karryam.com`, existing SMTP/Gmail/cPanel senders and
HealthNet clinical email are explicitly out of scope.
