# CosmicForge Mail - Staging Migration Runbook

Migration artifact: `services/central-admin-api/prisma/manual-migrations/20261024_add_cosmicforge_mail_m1_m6.sql`
(manifest order 27, checksum in `manifest.json`).
Rollback artifact: `docs/sql/cosmicforge-mail-m1-m6-rollback.sql` (manual only).

The migration was amended twice before any application: post-review remediation added
`OUTCOME_UNKNOWN` statuses and `mail_message_recipients.provider_message_id`, and pre-merge
hardening replaced plaintext `snippet` / `search_text` / note `body` columns with
`encrypted_snippet`, `metadata_search_text` and `encrypted_body` (GIN index
`IDX_mail_messages_metadata_search_fts`). Amending in place is safe only because no environment
has applied it (see the pre-flight ledger check below); if the ledger row exists anywhere, stop
and ship a follow-up migration instead. Always use the checksum in `manifest.json` from the
reviewed commit.

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
  'UQ_mail_sender_grants_active','UQ_marketing_email_suppressions_active','IDX_mail_messages_metadata_search_fts');  -- 4
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
replay database: staging schema -> migration (36 tables, 5 triggers, 4 indexes, zero drift)
-> rollback (0 Mail tables, 0 Mail types) -> `prisma migrate diff` against the staging schema
reports no difference).

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

## Addendum: migrations 28-33 (Stage A, M7-M10)

Apply in manifest order, after 27, in the same approved change window and only after a verified backup.
`npm run db:admin:prepare` applies pending files in order and records each in `social_manual_migrations`;
it refuses a file whose checksum differs from `manifest.json`. All files are additive. Rollback:
`docs/sql/cosmicforge-mail-m7-m10-rollback.sql` (rehearsed by `npm run mail:rollback:drill`).

| Order | File | sha256 (manifest) |
|---|---|---|
| 27 | `20261024_add_cosmicforge_mail_m1_m6.sql` | `a3b7d61f61fb815affb4f617481d878472d099ed48db43d60f2e52e9022ec9f0` |
| 28 | `20261025_add_admin_sessions_mfa.sql` | `e8d1b5537677367aed24c2a09191bb95568cde2ad14d6b4d62c6fa083adbf883` |
| 29 | `20261026_mail_step_up_session_binding.sql` | `5bfc3b52d1eb6d4dd957d139045f1bddecb00f818c2d856997c30be8cdf56fbf` |
| 30 | `20261027_mail_m7_broadcasts_automation.sql` | `88c17ea2ca3f835f2eeb5ee4213da76a0751ccd373cedc20238f51a36232e65f` |
| 31 | `20261028_mail_m8_product_integration.sql` | `c526d300c48ed6e406b6cd4ea6532e32f738c81ebdd4fa1da68bcddb11abff94` |
| 32 | `20261029_mail_m9_operations.sql` | `a3bf88806a0a74bc2d06ddce972fa56f6cf2c0c6580270e9d4bf91c402686447` |
| 33 | `20261030_mail_m10_rollout.sql` | `1bc07e19b8fe54837c0b2c5ff1199c7dc2841bfa4e5be37fdeb9f305ab7a1753` |
| 34 | `20261031_account_setup_tokens.sql` | `364fa19c3b9bdd6844dcfe068a4f63e6952d8a6d631b354f0416317b9bf9a613` |
| 35 | `20261101_mail_spec_gap_closure.sql` | `efc3c863c21ba0413a9d239ea53de50cf2837c3ba456caa622776ed65818f5b4` |
| 36 | `20261102_mail_user_preferences.sql` | `f99c79176acf7a3f36e154d742ff487943e485413d88472a20731be1848ab3ea` |

Migration 34 (account setup links, P0 security fix) is not Mail-specific: it
replaces emailed temporary passwords for lab approval, HR invitations and
HR-approved resets. Until it is applied, invitations are created without an
email (`inviteDelivery: PENDING_MIGRATION`), lab approvals report
`setupLink: PENDING_MIGRATION`, and HR reset approval answers 503; no password
is ever emailed. Rollback: `docs/sql/account-setup-tokens-rollback.sql`.

Migration 35 (Mail gap closure) adds new tables only: body-search index,
encrypted header/raw-MIME archive pointers, forwarding rules, shared rate-limit
buckets and campaign reply attribution. Code deployed before it keeps core
Mail working: those features answer 503 `MAIL_FEATURE_NOT_READY`, search is
metadata-only, rate limits use the process-local window and nothing is
archived or forwarded (tested by `tests/mail-pre-gap-migration.test.js`).
Rollback: `docs/sql/cosmicforge-mail-gap-closure-rollback.sql` (run it before
the M7-M10 rollback; the rollback drill does this).

Migration 36 (Mail user preferences, spec 15 "Profiles") adds one new table,
`mail_user_preferences` (preferred sender identity, Mail notification opt-out;
FKs to `admin_users` RESTRICT and `mail_addresses` SET NULL). Code deployed
before it keeps all Mail and gap-closure features working: `GET
/me/preferences` answers the defaults (`available: false`, notifications on,
no preferred sender), `PUT /me/preferences` answers 503
`MAIL_FEATURE_NOT_READY`, compose uses the first sender identity and no
notification is suppressed (tested by
`tests/mail-pre-preferences-migration.test.js`). Rollback:
`docs/sql/cosmicforge-mail-user-preferences-rollback.sql` (run it first; the
rollback drill does this).

Pre-checks: `npm run db:replay:verify` (drift none) and `npm run mail:rollback:drill` on a disposable copy.
Post-checks: every file present in the ledger; `npm run db:schema:assert`; Mail flags unchanged (all OFF).
