# Karryam staging integration checkpoint ? 8 November 2026

The full 14-service integration is not yet complete. This checkpoint distinguishes actual Headquarters observations from preparation evidence.

## Completed Headquarters activation

The native onboarding workflow activated contract revision 8, certified the Verification and campaign metric declarations, and created two read-only subscriptions. Both subscriptions are ACTIVE with COMPLETE coverage and successful synchronization. Observed Verification counts are 10 pending review and 4 verified. Campaign records are zero; no sample business records were created.

The temporary root setup authorities were revoked after completion. No staff grants, MFA settings, business-write permissions or production services were changed. A real signed-in Central Admin Web user session has not been verified for these additional datasets.

## Remaining work

- Complete source runtime compatibility and approved staging upgrade paths for the remaining services; database restore and migration previews alone do not certify a running connection.
- Preserve the Dispatch/Fleet receipt and consumer transition requirements. Do not restart incompatible consumers or bypass the release hold.
- Resolve Payment/Wallet and Referral native staff authorization through their supported enrollment rules. Bridge role mappings do not replace those native checks.
- Complete source-specific Media, Pricing and Analytics enrollment and coverage requirements.
- Verify the authorized Central Admin Web paths across the entire inventory.

## Evidence already available

Existing evidence includes source backup/restores, isolated pending-migration previews, Notification and Verification staging deployment, native snapshot ingestion, and the Headquarters activation results. Reuse those results rather than rerunning them without a relevant change.

The Headquarters code includes a regression fix: dataset approval must use readiness declared by the current contract, even when the dataset row retains its original contract pointer. A separately pinned, signed, staging-only operator decision can activate only the exact declared readiness changes; it cannot grant staff access or enable business commands. The four focused catalogue tests passed in isolated PostgreSQL. Existing operator tests passed with one conditional environment skip.

## Continuation preparation results

Seven candidate service binaries compile: Karryam Backoffice Bridge, Fleet Partner, Vendor, Media/File, Pricing, Analytics and Dispatch/Delivery. The Fleet worker and Vendor migration tool also compile. The scan of these candidates reports zero HIGH/CRITICAL vulnerabilities and zero secret findings.

Resolved missing dependency checksums in Fleet, Vendor and Analytics; normalized the Media module checksum file. These dependency fixes are still local and have not been pushed or deployed.

Pricing passed startup and restart against a restored staging database with no existing-container changes. Vendor also passed startup and restart after its pending migrations were applied in the isolated restored database. Vendor's broad inventory comparison observed one concurrent container disappearing; its identity was not retained, so that guard is not reported as a clean pass. A follow-up found no unhealthy persistent service and no persistent service started during the preview. The original evidence remains preserved.

Dispatch's current relay-operation table contains no rows. Fleet's new immutable receipt table is not yet installed in the running database. A stopped legacy Dispatch container still has an automatic restart policy, so the coordinated transition must include it. This inventory does not certify that every possible external consumer or supervisor has been discovered.

Fleet subsequently passed candidate startup and restart on a restored staging database after applying the five already-previewed migrations there. The completed backup validation was reused. Existing persistent containers were unchanged. No live Fleet migration or cutover was performed.
