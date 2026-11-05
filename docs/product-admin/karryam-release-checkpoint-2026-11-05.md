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

## Remaining integration work

Fresh post-release inspection confirms the Backoffice, Karryam Admin, PIC and dedicated Karryam Admin database are healthy. Backoffice ADMIN_REMOTE_ENABLED is false; ADMIN_ACCESS_POLICY_FILE and ADMIN_ACCESS_POLICY_KEYS_FILE remain unconfigured. Karryam Bridge access/feed and PIC synchronization remain false. No Stage A worker was activated.

Complete the real source access policy and actual administrative organization/tenant allocation, Bridge trust/enrollment, existing audited HQ onboarding/staff grants and dataset certification. The existing code requires distinct real actors for onboarding review/certification/approval; the delegated Support deployment waiver does not fabricate those business approvals. Do not invent scope identifiers, reuse fixture grants, bypass MFA or directly edit lifecycle rows.

Then verify real Taxi and Support reads, Stage A and Stage B, replay/restart/duplicate handling and authorized Central Admin Web reporting. Keep source business writes and the explicit Dispatch deployment hold unchanged. This checkpoint does not claim those remaining acceptance checks passed.
