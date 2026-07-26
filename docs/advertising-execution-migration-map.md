# Advertising Execution migration map

The conceptual Section 28 order maps to the repository without renaming or editing applied migrations:

| Conceptual responsibility | Actual migration |
|---|---|
| execution foundation | `20260728_advertising_execution_sections9_10.sql` |
| approvals, runs, jobs and initial policies/creatives | `20260729_advertising_execution_sections18_24.sql` |
| operations/reconciliation, creative evidence, targeting, leases, dead-letter and compensation remediation | `20260730_advertising_execution_sections18_24_remediation.sql` |
| Section 25 API evidence, policy history, validation packets, drift acknowledgments, retry review, cancellation enums, append-only triggers and list indexes | `20260731_advertising_execution_sections25_28.sql` |
| Sections 25–28 production-integrity remediation: retry-job FK, durable cancellation, complete policy history, emergency overrides, central audit immutability and new indexes | `20260801_advertising_execution_sections25_28_remediation.sql` |

Both Sections 25–28 migrations are additive and store no credentials or raw provider payloads. The canonical manifest contains 26 migrations. The remediation migration has no DROP/TRUNCATE/destructive rename/unsafe CASCADE and does not edit prior migrations. Empty-database replay and drift verification are required; local application occurs only through the guarded Admin preparation command. Staging and production were not migrated.
