# Karryam staging checkpoint ? 5 November 2026

Support/Dispute is deployed and verified. Whole-product integration is not complete.

## Delivered source release

- KarryGo staging: 00800825db714c50da5edd1c9bac0c5fa39c5aac. PR24 merged the delegated Support release authorization; the subsequent two-file fix corrects the repository-root metadata URL and adds a regression test. All 22 focused tests and all eight required exact-SHA CI workflows passed.
- User-approved main change: 1c229cbe2212e2542f29d29c43e058bc2e9f67eb adds only the existing manual, staging-restricted certification workflow. No application files changed on main.
- User-approved legacy repository secrets VPS_HOST, VPS_USER and VPS_SSH_KEY retired. The five staging environment secrets remain present; RELEASE_AUDIT_TOKEN is not stored as a variable. The actual certification and deployment authorization checks passed using it.
- [Restore certification 41997807447](https://github.com/CosmicforgeHealthnet/KarryGo/actions/runs/41997807447): success.
- [Support-only deployment 41998635339](https://github.com/CosmicforgeHealthnet/KarryGo/actions/runs/41998635339): success.

## Actual verification

A fresh PostgreSQL 16 Support backup restored into an isolated temporary database passed 17 assertions. The exact staging Dockerfile image passed two starts, correct commit reporting, migration replay, original-data preservation and unauthorized/disabled-access checks. The previous live image also started successfully after those migrations, preserving the same schema and original data. Temporary verification containers were removed.

Live Support reports commit 00800825db714c50da5edd1c9bac0c5fa39c5aac and is healthy and ready. Image ID: sha256:e86a5d7a6deb830c27e141bdc4be209b13dda0cf19ddcc4fac39ae6570e92f20. Owner authorization tables are present. Disabled owner reads return 503; unauthenticated customer and legacy admin reads return 401.

Of 183 pre-deployment containers, only /karrygo-support-dispute-service changed. Its database and every other pre-existing container retained the same ID, image ID and start time. No new containers remained after deployment. Dispatch, production application code, Mail, firewall settings and business-data access were not changed by this work.

Sanitized evidence:

- evidence/karryam-support-release-proof-2026-11-05.json
- evidence/karryam-support-image-runtime-2026-11-05.json
- evidence/karryam-support-deployment-2026-11-05.json

Protected backup, detailed verification logs and pre/post container snapshots remain only on the VPS under /srv/cosmicforge/staging/backups/support-readiness-20261105T070638Z-6d422840. No raw backup, private key, token or protected environment value is included here.

## Approved read-only connection completed at 12:20 UTC

The user explicitly approved protected key generation/policy installation and then the specific 12 Taxi + 2 Support allocations, certificate enrollment and scoped read-only activation. The signed policy is installed for `karryam-staging-operations-readonly`, revision 1, expiring 5 December 2026. The staging administrative scope is product `karryam`, market `NG-LAG`, zone `NG-LAG-MAIN`, organization `karryam-staging`, tenant `karryam-staging-operations`. This new authorization grouping does not rewrite source business ownership or assert native geography for Support cases.

Source endpoints accepted all 14 separately signed owner contexts. Karryam Admin's verified workload certificate is enrolled until policy expiry. Bridge remote access, generic Taxi/Support read adapters and Karryam Admin's Bridge client are enabled. The only product role mapping is `karryam.customer-care.viewer` to the same Bridge role; the policy permits only `taxi.independent_rides.read` and `support.cases.read` for `support-review`. No staff grants were created. Recent actual MFA and HQ authorization remain required.

An isolated internal network connects only the Bridge and these two sources; the Bridge receives only their reader HMAC files. Private signing keys and publisher credentials are not mounted in the Bridge or HQ. Only the three planned source/Bridge containers changed during that activation; their images stayed unchanged and no unrelated container changed. Karryam Admin was then recreated with its same image. All six relevant services passed health checks. Actual Karryam Admin-to-Bridge TLS 1.3 mutual authentication passed with the pinned server certificate; unsigned requests returned 401. Source requests without credentials also returned 401. Fresh backup/restore checks before policy installation passed 24 Support, 77 Taxi and 36 Bridge assertions.

Support subject previews are bounded and credential-redacted free text; this is not a guarantee that all personal information is removed. Dedicated contact, GPS, financial, messages/evidence and write capabilities were not enabled. Stage A feed, Stage A worker and synchronization remain off. Dispatch and production were untouched by this connection package.

Sanitized evidence: `evidence/karryam-readonly-connection-2026-11-05.json`. Its `current_state` is authoritative; historical step summaries retain their earlier flags. Detailed backups, signatures, contexts and rollback artifacts remain only under `/etc/cosmicforge/staging/karryam-source-access/20261105T112448Z-3169bf92` on the VPS.

## HQ setup progress at 18:42 UTC

Three explicitly approved, 72-hour platform setup grants are installed and have matching operator audit records. These are onboarding permissions, not product data grants or staff approvals. The signed live manifest passed pinned identity/signature verification; all reporting datasets remain NOT_CERTIFIED. Both Support cases have incomplete event scope, so the source feed and synchronization remain disabled. See `karryam-hq-onboarding-status-2026-11-05.md` and its sanitized evidence for the exact permissions, expiry and remaining gates. A proposed signed operator setup exception is not deployed or activated.

## Remaining integration work

The signed policy, record allocations, certificate enrollment and read-only transport setup above are complete. Real staff capability discovery and authorized source reads have not yet passed. Existing audited HQ onboarding, staff grants and dataset certification remain required; do not fabricate MFA, actor identities or lifecycle approvals.

Then verify real Taxi and Support reads, Stage A and Stage B, replay/restart/duplicate handling and authorized Central Admin Web reporting. Keep business writes and the explicit Dispatch deployment hold unchanged. Full integration is not complete, and these remaining acceptance checks are not recorded as passes.
