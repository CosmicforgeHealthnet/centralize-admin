# Product Admin databases — migration, backup and rollback runbook

Applies to both product-admin databases (Section 9.5):

| Service | Database / schema | Ledger | Runner |
|---|---|---|---|
| Karryam Admin | dedicated database, schema `karryam_admin` | `karryam_admin.schema_migrations` | `services/karryam-admin/scripts/migrate.js` |
| Product Integration Core (HQ) | Central Admin database, schema `hq_integration` | `hq_integration.hq_product_admin_schema_migrations` | `services/product-integration-core/scripts/migrate.js` |

Operators run these steps through the approved release workflow. Coding
agents never connect to staging or production databases.

## 1. Rules

- Forward-only, numbered files (`NNN_name.sql`). A file is never edited
  after it has been applied anywhere: the runner refuses a changed checksum
  (`APPLIED_MIGRATION_CHANGED` / `migration_checksum_mismatch`) and a missing
  applied file. Corrections are new files.
- Each file runs in its own transaction under a per-schema advisory lock;
  concurrent runs serialize; a failing file rolls back completely and is not
  recorded (tested).
- The ledger is append-only (triggers since `003`).
- Migrations run only with the migration credential; the runtime credential
  must differ (both runners and both services refuse otherwise).
- Runtime roles are never superusers and never own schema objects. The runner
  refuses a runtime role that is a superuser, can create roles or databases,
  bypasses RLS, has replication, owns schema objects, inherits a privileged
  role, or is the migration role; it then revokes and re-grants the exact
  documented privilege set in one transaction.
- No down-migrations. Recovery is forward-fix or restore (section 5).

## 2. Preflight (read-only)

```
KARRYAM_ADMIN_MIGRATION_DATABASE_URL=… KARRYAM_ADMIN_RUNTIME_ROLE=karryam_admin_runtime npm --prefix services/karryam-admin run migrate -- --preview
PIC_MIGRATION_DATABASE_URL=… PIC_RUNTIME_ROLE=pic_runtime npm --prefix services/product-integration-core run migrate -- --preview
```

The preview runs in a `READ ONLY` transaction that is rolled back and prints
JSON (connection strings redacted): applied versions with checksums, pending
versions with a statement-level risk summary (`TABLE_REWRITE`,
`VALIDATING_CONSTRAINT`, `WRITE_BLOCKING_INDEX`, `BACKFILL`, blocking kinds
`DESTRUCTIVE` / `DATA_REMOVAL` / `EXTENSION_REQUIRED`), row estimates for
every locked table, runtime-role problems, the runtime role's current and
post-run privileges, and `backup_required`. Exit code 2 when not `ok`.

Do not continue when `ok` is false, when a pending file shows a blocking
kind, or when `row_estimates` show that a rewrite or validation would hold a
lock longer than the agreed maintenance window.

Expected preview for the Section 9 release (`003`):

- Karryam Admin `003_section_9_data_governance`: one `TABLE_REWRITE`
  (`hq_outbox` stored generated columns), new tables (`capability_snapshots`,
  `legal_holds`, `retention_policies`), metadata-only column additions,
  guards and indexes. No blocking statement, no extension.
- HQ `003_section_9_data_governance`: no rewrite; new table
  `hq_product_admin_legal_holds`; constraints on populated tables are
  `NOT VALID` (enforced for new rows, history untouched); indexes on
  registry tables.

## 3. Backup (before every migration with pending files)

1. Take a logical backup of the schema with the migration identity:
   `pg_dump --format=custom --schema=<schema> --no-owner --no-privileges --file pre-<version>.dump <url>`.
2. Prove it is restorable, not just that pg_dump exited: `pg_restore --list`
   must show the table-of-contents entries, and the file checksum is
   recorded with the release evidence.
3. The disposable drill (`infrastructure/product-admin/db/restore-drill.js`,
   run in CI by `tests/restore-drill-postgres.test.js` in both services)
   certifies the procedure on every commit: old release + data → backup →
   new migrations → restore into a fresh database → schema fingerprint, row
   counts and ledger equal → re-apply migrations → schema equals the
   migrated source → re-run applies nothing. Reports are uploaded as CI
   artifacts. It never touches staging or production.
4. A staging restore drill on real infrastructure is an operator task (see
   section 7).

## 4. Apply and verify

1. Deploy order: **migrate first, then roll the application image**. Every
   Section 9 migration is backward compatible with the previous image (it
   only adds nullable/defaulted columns, new tables, guards and indexes; the
   old image never writes anything the guards refuse).
2. `npm run migrate` with the runtime role set; check the log lists the
   expected versions and checksums.
3. Re-run the preview: `pending` empty, `ok: true`, runtime privileges equal
   `privileges_after_run`.
4. Start the new image; `/health/ready` must report the database `OK`.

## 5. Rollback and recovery

| Situation | Action |
|---|---|
| Migration failed | Nothing was recorded and the transaction rolled back. Fix forward with a corrected *new* file; never edit an applied one. |
| New image misbehaves, schema fine | Redeploy the previous image tag. It is compatible with the migrated schema (section 4.1); committed data, cursors and history are kept. |
| Migration applied but wrong (no data loss) | Forward-fix migration (next number) reviewed like any other. |
| Data corrupted or lost by a migration | Stop writers (`*_ENABLED=false`, worker stopped), restore the pre-migration backup into a **new** database, verify ledger/row counts/fingerprint as in the drill, re-point the service, then re-apply a corrected forward migration. |

Durable worker state after a restore: Bridge feed cursors and HQ sync cursors
come back at their pre-backup values. That is safe by design: the Bridge
redelivers from the cursor, events are deduplicated by event ID and digest,
projections are version-fenced, and ACKs never exceed the committed cursor;
the HQ outbox re-derives from projections. Expect replays, never gaps.

Conditions that **prevent** a restore-based rollback (forward-fix only):
events acknowledged to the Bridge after the backup would be re-read but any
HQ-side ACK newer than the restored outbox head must be reconciled first
(the HQ consumer cursor would be ahead of the restored outbox: hold Stage B
until the outbox head passes it again); approvals consumed and operations
dispatched after the backup are recorded only in the newer database —
restoring would lose their audit trail, so the newer audit and operation
rows must be exported and preserved before any restore. Audit, approval and
operation history is never discarded to make a rollback easier.

## 6. Isolation

Section 9 migrations touch only `karryam_admin` (Karryam Admin database) and
`hq_integration` (HQ). They do not change Mail, HealthNet, Marketing, Central
Admin authentication or Logistics objects.

## 7. Operator-only items

Provision roles (`infrastructure/product-admin/postgres-roles.example.sql`),
store credentials in the host secret manager, take and verify the staging
backup, run the migrations through the approved workflow, perform a staging
restore drill when permitted, and confirm encryption at rest for the
database volumes and backups (section 9.4.9 in the Section 9 report).
