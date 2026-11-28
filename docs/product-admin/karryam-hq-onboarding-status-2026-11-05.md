# Karryam HQ onboarding status - 5 November 2026

## Completed and verified

The signed live Karryam Admin manifest was verified through PIC's existing service-authenticated client against the enrolled signer, product, environment, instance and workload identity. Endpoint: `karryam-staging`; instance: `karryam-admin-staging-1`; workload: `cf://staging/product-admin/karryam`; signer: `karryam-staging-manifest-2026-11`; manifest revision: 1; running build: `df0805b7b4524a5f97db93a0832bddc3d5344488`.

Following explicit authorization for the exact permissions, the existing operator bootstrap created three PLATFORM grants, expiring **8 November 2026 at 18:36 UTC (19:36 Lagos)**:

| Account | Setup actions |
| --- | --- |
| David Odimayo | integration.read, integration.request, integration.verify |
| Adejugbe Enoch Adebola | integration.read, integration.review, integration.certify |
| CosmicForge Admin | integration.read, integration.approve, integration.grants.manage, integration.subscriptions.manage |

All three grants have matching OPERATOR audit records. No product data grants, human approvals or MFA sessions were created. Grant bootstrap did not change the product lifecycle or enable synchronization.

## Remaining prerequisites confirmed live

- Registry, contracts, datasets and subscriptions still have no registrations. The historical pre-bootstrap zero-grant snapshot predates the three grants above.
- David and Enoch had no MFA enrollment at the inspection time; CosmicForge Admin was enrolled. None had a recent MFA-backed session. Credentials, session tokens, MFA secrets and recovery codes were not read or exported.
- All four signed-manifest reporting datasets are `NOT_CERTIFIED`. Source data has not been synchronized into HQ.
- Both existing Support cases produce events with incomplete scope: **2 cases, 0 complete event scopes**. `support_admin_case_event` deliberately emits empty unknown market/zone/tenant dimensions. The separately approved resource-read contexts do not automatically allocate source events. Do not fill those dimensions by guessing or rewrite business ownership.
- Support relay/snapshot and Bridge event ingress/backfill/feed switches remain disabled. The installed source policy permits Taxi and Support resource reads; it does not permit `hq.events.feed`, `hq.events.ack` or `hq.projections.status`.

The next source-side work must establish a supported, authoritative scoped event feed before Stage A, certification or Stage B activation. Do not certify an empty pilot as successful real source ingestion.

## Owner-requested operator setup proposal

The user requested completing setup under delegated operator authority instead of logging in as multiple staff. A local-only signed operator exception is being prepared in an isolated detached worktree. **It is not deployed or activated.** Automatic approval review requires explicit authorization for the precise MFA/independent-actor exception and signing authority. Existing staff security and production remain unchanged while that decision is pending.

## CI limits

Ordinary build, security, PIC, Karryam Admin and synchronization software tests passed for `7b22b9313958f686dacc6723e1990b29d60563fa`. Its Section 13.3 closure job failed: peer-workflow results were missing when collected and real staging evidence remained incomplete. Do not label closure green or replace real staging evidence with disposable tests.

[Actual closure job](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/42027716056/job/127246512021).

Sanitized live evidence: `evidence/karryam-hq-onboarding-readiness-2026-11-05.json`. Protected operator artifacts remain only on the VPS under `/etc/cosmicforge/staging/karryam-source-access/20261105T112448Z-3169bf92`.
