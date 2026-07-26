# Advertising Execution API handoff

Base path: `/api/v1/marketing/advertising-execution`. Authentication is the existing `Authorization: Bearer` flow. All responses use `{ success, message, data }`; lists put `{ items, pagination: { page, limit, total, pages } }` inside `data`. Maximum page size is 100. Mutation bodies are JSON except creative publication, which is multipart with one `media` file and a JSON `payload` field.

| Method and path | Access | Required normalized input |
|---|---|---|
| `GET /capabilities` | VIEW | optional provider; connectionId and accountExternalId must appear together |
| `GET /policies` | VIEW | provider, connectionId, effective, page, limit; account/currency filters are rejected as unsupported |
| `PATCH /policies` | EDIT + EXECUTION_ADMIN | id, expectedVersion, valueType, value, enabled, reason |
| `POST /overrides` | EDIT + EMERGENCY_OPERATOR | exact planId, CONNECTION_WRITE_GATE, reason and expiry (maximum two hours); current SUPER/ACTIVE/2FA status is reloaded server-side |
| `POST /plans` | EDIT + AUTHOR | provider, connectionId, accountExternalId, currency, optional name/description/desiredState/items |
| `GET /plans` | VIEW | bounded status/provider/scope/source/date/search/sort filters |
| `GET /plans/:id` | VIEW | UUID path |
| `PATCH /plans/:id` | EDIT + AUTHOR | expectedVersion plus allowlisted material fields |
| `DELETE /plans/:id` | EDIT + AUTHOR | expectedVersion, reason; domain cancellation only |
| `POST /plans/:id/validate` | EDIT + AUTHOR | expectedVersion |
| `POST /plans/:id/submit` | EDIT + AUTHOR | expectedVersion, fingerprint |
| `POST /plans/:id/approve` | EDIT + APPROVER | expectedVersion, fingerprint, optional comment/acknowledgements |
| `POST /plans/:id/reject` | EDIT + APPROVER | expectedVersion, fingerprint, reason |
| `POST /plans/:id/revoke-approval` | EDIT + APPROVER | expectedVersion, fingerprint, reason |
| `POST /plans/:id/queue` | EDIT + AUTHOR | expectedVersion, fingerprint, optional MANUAL/SCHEDULED trigger; overrideId additionally requires EMERGENCY_OPERATOR |
| `POST /plans/:id/cancel` | EDIT + AUTHOR | expectedVersion, reason |
| `POST /plans/:id/create-compensation` | EDIT + AUTHOR | originalRunId, originalOperationId, optional reconciliationId, safeAction, optional proposedValues, reason and irreversibleWarning; authoritative before/current/spend/lineage evidence is server-loaded |
| `GET /runs` | VIEW | bounded plan/provider/scope/status/date/sort filters |
| `GET /runs/:id` | VIEW | UUID path |
| `GET /operations/:id` | VIEW | UUID path; attempts bounded to 25, snapshots to 20, and reconciliation/retry evidence to 25 |
| `POST /operations/:id/retry` | EDIT + EXECUTION_ADMIN | reason; durable review only |
| `GET /drift` | VIEW | bounded provider/scope/classification/acknowledgment filters |
| `POST /drift/:id/acknowledge` | EDIT + EXECUTION_ADMIN | reason; acknowledgment does not resolve drift |
| `POST /recommendations/:id/create-plan` | EDIT + AUTHOR | accepted recommendation identifier; creates DRAFT only |
| `POST /creatives/:id/publications` | EDIT + AUTHOR | multipart media + strict normalized publication payload |
| `GET /creatives/:id/publications` | VIEW | bounded provider/scope/format/review/reuse filters |
| `GET /health` | VIEW | optional provider and connectionId for sanitized account-specific readiness |

All UUIDs, dates, versions, fingerprints, enums, Decimal strings, sort fields and ranges are validated. Unknown, prototype, credential-like and provider-native fields are rejected recursively. Accepted plan/run/publication filters are translated into Prisma predicates; contextual capability filters must be supplied as a complete account scope, and unsupported policy filters are rejected. Queueing and retry review are idempotent through durable SHA-256 identities, database uniqueness and serializable transactions. Validation may perform a read-only provider preflight; queue, retry, recommendation conversion, compensation and creative-publication controllers perform no provider mutation.

Synthetic queue request:

```json
{"expectedVersion":3,"fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","trigger":"MANUAL"}
```

No response contains tokens, credential envelopes, signed URLs, authorization headers, raw provider request/response bodies, internal paths, stack traces or lease-owner values.

Testing note (Section 29): the runtime route inventory above is asserted by `src/modules/marketing/advertising-execution/__tests__/section29.docs-migrations.test.js`, and the recursive no-secret response guarantee by `section29.security.test.js`. The full requirement-to-test map is `docs/advertising-execution-section29-test-traceability.md`; run `npm run test:advertising-execution:section29` for the aggregate offline suite. No automated test calls a live provider.
