# Centralize Admin: database isolation cutover (staging, then production)

Moves each CA app from its legacy-named database (`rtc_db_staging`, `rtc_db`) to `cosmicforge_admin` **inside
the same CA-owned PostgreSQL container** (`admin-server-staging-db-1`, `admin-server-db-1`). RTC's
`cosmicforge-db` and every other project are never addressed. Nothing is deleted.

Script: `.github/scripts/ca-db-isolation-cutover.sh` (v3). One root run on the VPS; it pauses for you.

## What you run

One command in your existing root SSH session (the exact, checksum-pinned command for the reviewed commit is
recorded in issue #28). It downloads the script from a fixed commit, verifies its SHA-256, and runs it:

```bash
curl -fsSL -o /root/ca-db-isolation-cutover.sh https://raw.githubusercontent.com/CosmicforgeHealthnet/centralize-admin/<COMMIT>/.github/scripts/ca-db-isolation-cutover.sh \
  && echo '<SHA256>  /root/ca-db-isolation-cutover.sh' | sha256sum -c - \
  && bash /root/ca-db-isolation-cutover.sh --apply-both
```

Run it in a terminal (not piped into `bash`): it asks three questions.

| Prompt | Type | Effect |
|---|---|---|
| before staging changes | `CUTOVER_STAGING` | anything else: nothing is changed |
| after staging is live | `STAGING_LOGIN_OK` | only after you logged in to the real staging Admin site; anything else stops with production untouched |
| before production changes | `CUTOVER_PRODUCTION` | anything else stops with production untouched |

Do not merge to `staging` or deploy while it runs (a deploy would recreate the staging app mid-change).
Read-only check first, any time: `bash /root/ca-db-isolation-cutover.sh --preflight`. Staging only:
`--staging-only`.

## Expected impact

- **Staging:** `admin-server-staging-app-1` is stopped for the backup and copy (about a minute for a 15 MB
  database), then recreated with the same image. Production keeps running.
- **Production:** the same for `admin-server-app-1`, only after the two production confirmations.
- PostgreSQL containers are **not** restarted. No other container is touched; the script snapshots all of
  them and reports any change.

## What it does, per environment (each step is a gate)

1. Identity: exact container names, Compose project, service, the single storage volume, the image tag still
   pointing at the running image, the source database present.
2. State: already on `cosmicforge_admin` and healthy → skipped (safe rerun). On the legacy database →
   continue. Anything else → stop, nothing changed.
3. Settings: Compose must recreate the app with **exactly** the running settings. Keys whose `.env` value
   contains `$` are the only allowed difference (the cause of the `admN` / `K` warnings: Compose silently
   turns `$admN`/`$K` into empty text). Any other difference (for example `.env` edited since the last
   deploy) stops the run before anything changes.
4. The app is verified on its current database (runtime database name, Prisma AdminUser query, HTTP health).
5. A previous `cosmicforge_admin` is **renamed and kept** (staging: `cosmicforge_admin_previous_copy_<time>`;
   production: only this script's own failed attempt, `..._failed_attempt_<time>`). Production refuses any
   other existing `cosmicforge_admin`.
6. Free disk space for the backup and the copy.
7. Stop **only** the app; wait until no session uses the source (write-free).
8. Fresh `pg_dump` backup, checksummed, restored into a scratch database and its row counts compared (that
   scratch database, created by this run, is the only thing ever dropped).
9. `createdb -T <source>`: a physical copy in the same PostgreSQL instance. Database owner, privileges and
   database-level settings are copied (PostgreSQL does not copy them itself) and compared.
10. Copy verified: every schema object (normalized `pg_dump`), every ownership/ACL/extension/sequence
    catalog entry and every table's row count.
11. `.env`: `DATABASE_URL` points at `cosmicforge_admin`, and every `$` key is written with the exact value
    the running container already has. Values are written without quotes when they are plain, so every
    Compose version reads them the same way. The file keeps its owner and mode. Before it is used, the script
    proves Compose would start the app with the previous settings plus the new database.
12. Recreate **only** the app (`--no-deps --no-build --pull never`), same image. Verify the runtime database,
    Prisma AdminUser, HTTP health, the image and every other setting (per-key fingerprints, no values stored).

## Failure and recovery

- Any failure after the app stopped restores it automatically and **verifies** it is healthy on the legacy
  database again. If the app was only stopped, the untouched original container is simply started. Otherwise
  the original `.env` is put back and the app recreated.
- A staging failure never continues to production.
- Kept: the legacy databases and volumes, the earlier staging copy, the new copy, every backup, and the original
  `.env` in `/var/backups/centralize-admin/cutover-<run>/` (root-only). A summary prints PASS/FAIL per step.
- Manual fallback, if the automatic recovery itself reports it did not verify: copy
  `/var/backups/centralize-admin/cutover-<run>/<env>/original.env` back to the deployment's `.env` and run
  `docker compose up -d --no-deps app` in that directory. The legacy database is untouched.

## Tested

`.github/scripts/tests/ca-db-cutover-replica.sh` runs the unmodified script against a disposable replica with
the same names, real Docker, Compose and PostgreSQL 16, `$admN`/`$K` secrets, a separate app role, restricted
database ACL and settings, a stale earlier staging copy, live writes, and decoy RTC and KarryGo databases.
It covers success, decline, a lingering session, a failed new database (full rollback), rerun, an unknown
production database, an edited `.env`, and a container created with literal `$` values. CI runs it on every
change to the script (`.github/workflows/ca-db-cutover-test.yml`).

The read-only staging preflight (`.github/workflows/ca-db-cutover-preflight.yml`) runs over the existing
staging deploy connection on every change to the script and reports, without values, whether staging is
ready for this run.
