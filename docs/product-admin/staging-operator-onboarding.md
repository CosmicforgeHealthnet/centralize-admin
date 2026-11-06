# Delegated staging onboarding operator

Status: implemented candidate; not activated. This is a local operator tool, not an HTTP endpoint or a staff login.

The owner delegated Karryam staging setup to David. The explicit exception allows one operator to perform setup without staff sessions or separate staff approvers for one hour. Record the original delegation and the explicit exception authorization in the protected operator change record. Do not describe an operator-generated signature as an independent owner signature or staff approval.

## Boundaries

The generic verifier accepts only Linux root, the actual `root@<hostname>` identity, staging, and the product and exact scope independently pinned in the root-owned public authority entry. The Karryam CLI additionally restricts execution to Karryam and exactly these scope values: market `NG-LAG`, organization `karryam-staging`, zone `NG-LAG-MAIN`, tenant `karryam-staging-operations`. The latter values are an administrative authorization group, not inferred business ownership or native geography.

A signed decision must explicitly set both `allow_setup_without_staff_sessions` and `allow_single_operator_onboarding` to true. Its validity cannot exceed one hour. The fixed public-key trust file is `/etc/cosmicforge/staging/secrets/pic-operator-authority/public-keys.json`. The decision must be a private root-owned regular file under `/etc/cosmicforge/staging/`. Every ancestor must be root-owned, without symlinks or group/world write access. The verifier rechecks signature, file hashes, scope and expiry on every operation. Changing or removing the decision or trust file revokes the active permit.

Use a dedicated delegated-operator Ed25519 authority; never reuse source policy, manifest, staff or Bridge keys. Keep the private key outside application mounts. Pin its public trust entry with purpose `OWNER_DELEGATION`, environment `staging`, product `karryam`, the exact `allowed_scope` above, `revoked:false`, and `not_after` equal to the decision expiry. Generate the one-hour decision only when the operation is ready. No authority or decision is included in this repository.

Permitted methods: inspect, request, verify identity, validate contract, review policy, approve an eligible dataset, certify staging, approve integration. The CLI restricts dataset review to `karryam.support_operations` and `karryam.sync_health` version `1.0.0`. Registration endpoint, workload, instance and manifest signer are pinned in the CLI.

Normal HTTP authorization and staff MFA remain unchanged. This capability cannot administer grants or subscriptions, enable commands, change production, or certify a `NOT_CERTIFIED` dataset. Existing schema/privacy, manifest, current-contract, state and optimistic-revision checks remain in force. Audit actors are explicitly `OPERATOR`, with the decision and delegation references; no staff approval or MFA proof is invented.

## Execution and recovery

Before any apply, review the exact staging commit and successful applicable CI, verify runtime configuration and endpoint pins, and take a protected recoverable backup of the HQ integration metadata. Run the CLI in an approved root-operated staging environment using the real hostname, reviewed code and the existing staging configuration. Use a read-only root filesystem, no public ports, only required private connectivity and read-only authority/configuration mounts. Do not expose secrets in arguments, logs or repository files.

Run `node scripts/staging-operator-onboarding.js --decision <protected-decision-path> --step request` first. Without `--apply` every step is a plan only and does not access the database. Apply each step separately; inspect the resulting registration revision before the next transition. Mutating lifecycle transitions require `--id` and `--expected-revision`. Review and certification also require a real `--evidence-ref`. Stop on any failed gate; do not change the database directly to move lifecycle state.

After the authorized setup, remove the signed decision and revoke or remove the dedicated public trust entry. Preserve protected audit and backup records. If a step fails, revoke first and inspect existing state; do not repeat registration blindly or reset approvals. Revert candidate code through the normal staging release process if required. Restore metadata only through the existing tested recovery process, with a scoped change review; do not overwrite unrelated HQ state.

## Verification and outstanding work

Isolated Linux/PostgreSQL regression: 43 passed, one non-root-guard skip (the root guard runs in ordinary non-root checks), zero failed. A separate isolated operator/state-machine coverage run passed 19 tests, one skip: operator verifier 100% line / 94.9% branch, state machine 100% / 96.55%. Existing state-machine thresholds are unchanged. Ten certification/coverage evidence tool tests passed locally. Windows cannot exercise the protected Linux root path; the isolated Linux run covers it.

These checks used no live data and changed no pre-existing containers. They do not constitute deployment, source-feed certification, independent human review, or end-to-end acceptance. CI must bind supplemental coverage to the exact tested commit and LCOV hash. The source Support event scope/feed work and real dataset certification remain separate prerequisites. Do not claim Central Admin Web displays real Karryam data until that full path is verified.

Follow-up architecture correction: the shared verifier reads its product and exact scope pins from the separately protected authority entry; the Karryam CLI independently pins the approved pilot scope. The corrected Linux sandbox run passed 20 tests with one non-root-guard skip, with 100% line / 94.34% branch coverage for the verifier and 100% / 96.55% for the state machine. Existing live containers were unchanged. The original CI architecture failure is not a passing certification; the corrected commit requires a fresh CI run.

## Database certification correction (6 November 2026)

The first live operator attempt reached policy review and approved the two certified datasets, then correctly stopped at the database's unconditional independent-certifier constraint. No certification was recorded. Migration 005 adds an explicit immutable operator decision reference and a staging-only database guard tied to a recent, successful signed-delegation authorization audit, its exact product/scope, one-hour validity and protected-file digests. Ordinary staff certification still requires a separate validator and certifier. The service records the real operator identity for both actions; it never invents a second reviewer.

The regression exercises the actual certification UPDATE and rejects missing, expired, null, wrong-scope and missing-waiver evidence. It also exercises activation, refuses delegated production certification, and checks ordinary independent production certification remains valid. Apply the forward-only migration only after applicable CI passes, with a protected HQ metadata backup and a migration preview. Previously revoked decisions remain revoked; a new short-lived decision is required for a subsequent operator attempt.

## Explicit read-only subscription setup delegation

Separately authorized by the user on 6 November 2026: the root-only CLI may create exactly the Operations subscriptions `karryam.support_operations` and `karryam.sync_health`, version `1.0.0`, in the already approved scope. This optional authority is absent from onboarding-only permits. Both the protected trust entry and signed decision must explicitly include `allow_scoped_readonly_subscriptions:true`, the exact `readonly_subscription_datasets` list and `readonly_subscription_department:"operations"`. The existing one-hour expiry, file protection, revocation and exact product/scope checks still apply.

The generic service wrapper permits only those pinned dataset IDs, department, scope and version with enabled read-only subscriptions; the native dataset approval, current-contract, privacy, department and scope checks remain in force. The Karryam CLI step `subscribe` independently restricts the two dataset IDs. It cannot grant staff access, edit arbitrary subscriptions, enable business commands or operate in production. Revoke the temporary decision and authority immediately after setup. Normal HTTP staff authorization is unchanged.
