# CosmicForge Mail M8: product integration

Status: code complete behind flags. **Not activated anywhere.** No product
repository was modified; no Karryam transactional mail path changed.

## Scope and boundaries

| Concern | Owner | HQ Mail role |
|---|---|---|
| Karryam transactional email (OTP, receipts, booking mail) | Karryam Go (`notification-service`) | None. HQ never sends it. It may receive delivery *metadata* (`mail.delivery_status@1`). |
| Marketing automation triggers | HQ Mail | Accepts approved product events (`marketing.trigger@1`) that match `event-registry.js`. Never treated as consent. |
| Operational alerts | Product | HQ accepts low-sensitivity alerts (`ops.alert@1`) and notifies mail admins (de-duplicated per code per hour). |
| HealthNet | HealthNet | `RESTRICTED_HEALTH`: `ops.alert@1` only, no triggers, no delivery metadata, no personal data. Enforced by service code **and** a DB CHECK. |

Legacy HQ transactional senders (`src/shared/config/mailer.js`,
`src/shared/utils/email.util.js`) are unchanged; `tests/mail-m8-unit.test.js`
pins their hashes and fails if Mail imports them or nodemailer.

## Contract v1

Endpoint: `POST /api/mail/v1/integrations/v1/events` (raw body, service HMAC).
Schema: `docs/integrations/hqmail-contract-v1.schema.json`. Reference Go client:
`docs/integrations/karryam-go-hqmail/` (signing verified against Karryam's real
`serviceauth.SignRequest`).

Versioning: the URL carries the transport version (`/v1/`), the envelope
carries `contractVersion`, and every event type carries `eventVersion`.
Additive changes ship as a new `eventVersion`; HQ supports old and new side by
side until the product confirms migration. Unknown fields are rejected (strict),
so producers cannot silently send data HQ has not reviewed.

### Responses

| Status | Code | Retry? | Meaning |
|---|---|---|---|
| 202 | — (`accepted`, `duplicate`) | no | Stored (or already stored with identical payload). |
| 401 | `MAIL_INTEGRATION_UNAUTHORIZED` | no | Bad/missing signature, skew, unknown service (indistinguishable on purpose). |
| 403 | `MAIL_INTEGRATION_NOT_ACTIVE` | no | Integration is DISABLED or SUSPENDED. |
| 403 | `MAIL_INTEGRATION_SCOPE_MISMATCH` | no | Envelope `product`/`organization` is not the integration's own. |
| 403 | `MAIL_INTEGRATION_FORBIDDEN_CONTENT` (`EVENT_TYPE_NOT_ALLOWED`) | no | Event type not allowed for this integration/classification. |
| 409 | `MAIL_INTEGRATION_EVENT_CONFLICT` | no | Same `eventId`, different payload. |
| 409 | `MAIL_INTEGRATION_IDEMPOTENCY_CONFLICT` | no | Same `idempotencyKey` (per integration), different payload. A retry with the same key and payload under a new `eventId` answers 202 `duplicate:true` with the original `eventId`. |
| 422 | `MAIL_INTEGRATION_LEGACY_SHAPE_NOT_ENABLED` | no | Native Karryam `notifications.Request` shape sent while the compat allowlist (`MAIL_INTEGRATION_KARRYAM_COMPAT_SERVICES`) does not include the service, or the integration is not Karryam. See `docs/cosmicforge-mail-karryam-handoff.md`. |
| 413 | `MAIL_INTEGRATION_BODY_TOO_LARGE` | no | Over `MAIL_INTEGRATION_MAX_BODY_BYTES`. |
| 422 | `MAIL_INTEGRATION_FORBIDDEN_CONTENT` / `UNKNOWN_FIELDS` / `UNSUPPORTED_*` / `MAIL_VALIDATION_FAILED` | no | Contract violation. Recorded as a rejection (no payload stored, only its SHA-256). |
| 429 | `MAIL_RATE_LIMITED` | yes | Per-integration limit (`MAIL_INTEGRATION_RATE_PER_MINUTE`). |
| 503 | `MAIL_INTEGRATIONS_DISABLED` / `_NOT_CONFIGURED` / `MAIL_STORAGE_UNAVAILABLE` | yes | Feature off, hash secret missing, or storage failure. |

## Privacy

- Recipient addresses in delivery metadata are stored only as
  `HMAC-SHA256(MAIL_INTEGRATION_HASH_SECRET, organizationId:email)` plus the
  domain. Bounce/complaint suppression is applied only when the address is
  already an HQ marketing contact of the same brand (no new personal data is
  created from product events).
- Prohibited keys (content, credentials, clinical terms) are rejected at any
  depth. Ops-alert summaries may not contain emails or phone numbers.
- Integration event and delivery tables are append-only (DB trigger
  `mail_guard_append_only`): UPDATE is blocked; DELETE is allowed only inside a
  retention purge transaction (`SET LOCAL cosmicforge.mail_retention_purge='on'`, M9).

## Administration (HQ)

UI: `/dashboard/mail/integrations` (linked from Mail settings). API under
`/api/mail/v1/admin/integrations` (see OpenAPI). Mail admins see all;
a `mail / integration:<product>` VIEW grant sees only that product's health
and events (product-isolated).

Lifecycle: register (always `DISABLED`) → authorize brand system/shared/alias
senders on verified domains → **owner approval gate** → activate (owner
approval reference + approver + MFA step-up `MAIL_INTEGRATION_ACTIVATE`; DB
CHECK requires approval fields when ACTIVE) → suspend at any time.

## Owner-approval gate (not yet passed)

Before any integration is activated in any environment:

1. Product owner reviews contract v1 and the reference client.
2. Product owner implements outbox delivery in their own repository and
   tests it against a disposable HQ environment.
3. HQ operator provisions `MAIL_INTEGRATION_SERVICE_SECRETS` and
   `MAIL_INTEGRATION_HASH_SECRET` through the secret manager (never in git).
4. Owner records written approval; HQ mail admin activates with step-up.

None of these steps has been performed.

## Database

Migration `20261028_mail_m8_product_integration.sql` (M8, number 31):
`mail_product_integrations`, `mail_product_sender_authorizations`,
`mail_product_integration_events`, `mail_product_delivery_events`. No
cross-service foreign keys; products are referenced by slug and service name.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `MAIL_INTEGRATIONS_ENABLED` | `false` | Also requires `MAIL_ENABLED`. |
| `MAIL_INTEGRATION_SERVICE_SECRETS` | empty | `name=secret,...` |
| `MAIL_INTEGRATION_HASH_SECRET` | empty | >= 32 chars, else 503. |
| `MAIL_INTEGRATION_MAX_SKEW_SECONDS` | 300 | 30–900 |
| `MAIL_INTEGRATION_RATE_PER_MINUTE` | 600 | per integration, per process |
| `MAIL_INTEGRATION_MAX_BODY_BYTES` | 16384 | |

## Tests

- `tests/mail-m8-unit.test.js`: signature vector, auth failure modes, strict
  contract, prohibited content, flags default off, legacy-sender tripwire.
- `tests/mail-m8-postgres.test.js`: ingestion end to end against Postgres
  (mock Karryam/HealthNet consumers), isolation, spoofing, idempotency,
  append-only trigger, activation gate.
- `docs/integrations/karryam-go-hqmail/hqmail_test.go`: Go client vector and
  retry classification.
- `apps/central-admin-web/e2e/mail-integrations.spec.ts`: admin UI.
