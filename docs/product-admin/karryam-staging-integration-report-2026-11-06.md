# Karryam staging integration ? 6 November 2026

The approved read-only Support and synchronization-health integration is operational. Both synchronization stages have committed and acknowledged real data. Karryam is enabled in HQ, and the existing Help & Support page has a generic, authorized Product activity panel. This is not a claim that all fourteen original acceptance gates or every Karryam service are fully certified.

Open https://centralize-admin-staging.vercel.app/dashboard/help using David Odimayo's normal account. The panel is backed by Central Admin API ? Product Integration Core ? the HQ observations produced from Karryam Admin and Karryam Backoffice Bridge. It does not call the Bridge from the browser.

## Observed results

At 04:38 UTC, HQ registration `c64934c8-0ee2-4f6d-8fdf-0cf89cb00acd` was ENABLED, synchronization HEALTHY, drift NONE. Both subscriptions were ACTIVE with COMPLETE coverage, no gaps and zero quarantined records. Support cursor/head/ACK were 5; synchronization-health cursor/head/ACK were 4. Stage A committed and acknowledged Bridge sequence 2, with two real Support case projections.

| Metric | Observed value |
| --- | ---: |
| Open Support cases | 2 |
| Open emergency cases | 0 |
| Escalated cases | 0 |
| Bridge lag, events | 0 |
| Open entity gaps | 0 |
| Open quarantine | 0 |

Freshness is computed from the original observation timestamp, not from successful polling or deployment time. The observations were recorded at approximately 03:07 UTC and exceed their one-hour freshness target at the final check: the API/dashboard correctly report STALE while keeping COMPLETE coverage and the actual observed values. Stored observation rows' initial `freshness` fields are not a substitute for the API's current freshness calculation. No timestamps or business records were edited to manufacture a fresh observation.

The actual Central Admin API container successfully reached PIC readiness over its configured Unix socket (200). The public products API refused an unauthenticated request (401). The live dashboard JavaScript contains the new Product activity component and uses `https://stagingca.cosmicforge-healthnet.com` as its API origin. Public-shell verification used only the documented non-credential `cf_session` routing hint; no staff session, MFA claim or authenticated user acceptance was fabricated.

## Scope and access

Only `karryam.support_operations` and `karryam.sync_health`, version 1.0.0, are subscribed for Operations.

| Authorization dimension | Exact value |
| --- | --- |
| Product | karryam |
| Market | NG-LAG |
| Organization | karryam-staging |
| Zone | NG-LAG-MAIN |
| Tenant / authorization group | karryam-staging-operations |

This is an administrative authorization allocation, not a rewrite of native business ownership or geography. Finance, marketing and verification datasets remain unsubscribed and uncertified.

David's initial product read grant is `9fd80674-c92e-46da-996f-8eec5b5b8a63`, expiring **8 November 2026 at 04:34:25 UTC / 05:34:25 Lagos time**. Its fixed actions are product navigation, manifest metadata, dataset listing, metric reads and synchronization status. It includes only the two datasets and exact scope above. A registry-policy evaluation allowed both datasets and denied another tenant, live resource reads and business commands. This was a policy evaluation, not a claimed signed-in HTTP test.

The first-read bootstrap verified an enabled staging registration, approved active Operations subscriptions, exact scope, no prior product grant and a maximum 72-hour grant lifetime. It used the separate migration/operator credential and recorded an atomic OPERATOR audit. The target account was independently checked as ACTIVE. Normal staff sessions, MFA and API authorization are unchanged.

## Deployed components

| Component | Deployed source / image |
| --- | --- |
| Central Admin Web | Successful staging build `3382f557bd8b837e453f9125e5443970a889e0a5`; frontend source is identical to separately tested `afcce2ebb16474777aeb753b7e8181a8405e58dc` |
| Central Admin API | Existing `staging-17b9f3f9081e8bf58e0e34b16dc54c7181e9d9f7`; image ID `sha256:8a915f95a3e88145dcde9b14acf6d0c74f906880e3316422d41fa69c47e2d71d` |
| Product Integration Core | Source `fff48b29b23e67133f587ed08d9e36785d1b92d6`; image ID `sha256:0a65142f9149c4a88ab9b74424e0c5431c3c28556c12f0bc0554787fc837b526` |
| Karryam Admin and worker | Source `b34ea957373dd39a68cb3042f7cd9bea2be0355a`; image ID `sha256:3431990283b901f077e0179780ecac3832f29b2ff41e94e56c201f188323e46c` |
| Karryam Admin database | `postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` |
| Karryam Backoffice Bridge | Existing source `77dcf3fcbeaea902d3629514c129b755d85a75fe`; image ID `sha256:4073655050e2939d43439f6e36adebd5504f98fc666918775edfee63b79a530c` |
| Support source service | Source `f8194572bcc83e6dbb0e8e37a7b14224e2f75611`; registry digest `sha256:b2b0433a846eb34978b0ae7b79052d78917fec7695e1fc3a9899395cc6e6b859` |
| Taxi source service | Existing source `4d90bfb6948de8529a452c57f2d7954880b9c746`; image ID `sha256:3c1cb25ab4160b71ed749b5a4ec189ae51fd6e6254e9c1635dbdb36d36fdd219` |
| Initial read-grant operator image | Source `a33b899065aff1e698b39ce8521b425328fa6199`, independently labelled and CI-verified; it was used as an ephemeral operator container, not substituted for the running PIC service |

Vercel later rate-limited new deployments. The previously successful staging deployment already contains the intended dashboard code, verified in its served asset `11c7de5d85522aba.js` (SHA-256 `1c1cc4472db1057bef40e734955c78c7b61866ba0d1fe40b881028d85331f973`). Do not claim the latest repository SHA was rebuilt by Vercel. The frontend binding and private backend are separate work packages; protected-path release checks were retained.

## Security, migrations and recovery

The signed source access policy is version 2. Support and Bridge use it for the approved read-only event path. Taxi was aligned to the same version because native owner requests bind policy ID, version and checksum; its Taxi read rule and policy expiry were compared byte-for-byte and remain unchanged. Taxi's image, networks and published loopback ports were preserved, and it receives only public policy/key files, not Support's HMAC keys.

Support events are authorized against current signed owner allocations before disclosure. The private source relay has a dedicated key; snapshots use a different dedicated key. The Bridge backfills and reconciles the approved source. Workload assertions use the honest `workload` ACR; human MFA is not simulated. Worker credential sessions rotate every two minutes to fit the Bridge's existing five-minute ceiling.

Migration 005 records the explicit signed, scoped, one-hour staging operator certification exception. Ordinary staff certification still requires a separate validator/certifier. A protected HQ metadata backup and clean migration preview preceded application. Product certification and final approval are recorded as OPERATOR actions, not independent human signatures. The separately authorized subscription extension was pinned in both protected trust and signed decision. All temporary authorities were revoked and the active decision file removed after setup.

PIC and Karryam Admin publish no host ports. The worker joins only the Bridge and DB-B private networks. PIC has no direct source/Bridge network access. The original unrelated database/firewall configuration was not changed. All inspected application/database containers were healthy, with API/worker containers running as expected. Restarting the worker and PIC preserved images, committed cursors, ACKs and the absence of gaps/quarantine.

## Validation and handoff

- [Backend CI `a33b899`](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/42162541737): all six jobs passed, including real PostgreSQL, operator/first-read-grant regressions, coverage, image smoke tests and Section 13.3 code gates. External staging gates are not self-certified by CI.
- [Frontend CI `afcce2e`](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/42162090470): lint/build and the full mocked-API browser suite passed. New product tests cover desktop/mobile rendering, source/time/coverage labels, unavailable versus zero, refresh and no panel without product grants.
- Support's source release had all eight required workflows and the restore certification pass before its support-only deployment. Its Linux/PostgreSQL security regression passed 76 tests with no skips.
- Local TypeScript checking and the read-grant validation tests passed. The initial local browser server startup exceeded its timeout; browser acceptance was subsequently completed successfully in CI, not reported as a local pass.

Protected host evidence is under `/srv/cosmicforge/staging/backups/support-feed-release-f8194572-948a1e39/`, including migration previews/application, backups, source snapshot checks, live Bridge/Stage A/Stage B proofs, operator decisions, first read-grant audit, restart recovery and runtime inventory. Backups, environment files and credentials are not repository artifacts.

Still external/unverified: David's genuine signed-in dashboard acceptance; Moses/staff acceptance of live Taxi and case-detail resource reads with real recent MFA and appropriate resource grants; any source domains outside the two approved datasets; and formal closure of the original full staging acceptance gates. Resource reads and domain writes were not granted to complete these steps artificially. Production and `main` were not changed by this work package.
