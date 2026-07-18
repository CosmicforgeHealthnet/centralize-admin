# Social Operations Testing Matrix

Implementation date: 2026-07-17

| Area | Existing or new coverage | Status | Test type |
|---|---|---|---|
| Schema and relations | `social-operations.section5.schema.test.js`, `social-operations.section5.db.test.js`, `task-assignee-nullability.test.js`, `social-operations-section15-database-constraints.test.js` | Covered | Static/database |
| Connector contract | `connector-contract.test.js`, `connector-capabilities.test.js`, `connector-normalization.test.js` | Covered | Unit/mocked connector |
| Provider content | `social-operations-section9-reconciliation.test.js`, Section 15 acceptance tests | Covered | Unit/mocked connector |
| Comment reply | `social-operations-section10-action-worker.test.js`, `social-operations-section15-provider-acceptance.test.js` | Covered | Unit/mocked connector |
| Database constraints | `social-operations.section5.db.test.js`, `task-assignee-nullability.test.js`, `social-operations-section15-database-constraints.test.js` | Covered | Database |
| Job claim and concurrency | `social-operations-section10-leasing.test.js`, `social-operations-section10-closure-corrections.test.js` | Covered | Unit/database-style |
| Action jobs | `social-operations-section10-action-worker.test.js`, `social-operations-section10-closure-corrections.test.js` | Covered | Unit |
| Privacy and redaction | `social-operations-section12-redaction-retention.test.js`, `social-operations-section12-security.test.js`, `social-operations-section13-restricted-phase-gate.test.js` | Covered | Unit/static |
| API and RBAC | `social-operations-section8-routes.test.js`, `social-operations-section8-rbac.test.js`, `social-operations-section8-sanitization.test.js`, `marketing-legacy-social-freeze.test.js` | Covered | API/unit |
| Workers | `social-operations-section10-publishing-worker.test.js`, `social-operations-section10-worker-startup.test.js`, `social-operations-section10-scheduling.test.js` | Covered | Unit |
| Webhooks | `social-operations-section9-webhooks.test.js`, `social-operations-section9-idempotency.test.js`, `social-operations-section12-webhook-ssrf.test.js` | Covered | Unit/API |
| HealthNet | `social-operations-section13-classification.test.js`, `social-operations-section13-escalation.test.js`, `task-assignee-nullability.test.js` | Covered | Unit/database |
| Legacy write freeze | `marketing-legacy-social-freeze.test.js` | Covered | Database integration |
| Migration backfill | `social-operations-section14-backfill.test.js`, `legacy-social-backfill.js --dry-run`, `--apply-check` | Covered | Unit/local reconciliation |
| Partial webhook indexes | `social-operations-section15-database-constraints.test.js` | Covered | Database |
| Provider-mocked acceptance | `social-operations-section15-provider-acceptance.test.js` | Covered | Mocked connector |
| Live pre-production acceptance | `social-operations-platform-acceptance-checklist.md` | Pending pre-production execution | Manual |
| CI network safety | Connector static tests plus Section 15 mocked acceptance assertions reject provider URLs/token-looking fixtures | Covered | Static/mocked connector |

No equivalent tests were duplicated solely to satisfy naming. Section 15 additions focus on missing legacy migration, partial-index, compatibility, and mocked acceptance coverage.
