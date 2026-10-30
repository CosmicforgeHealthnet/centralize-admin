# CosmicForge Mail <-> Karryam Go: integration handoff (spec section 15)

> **Status: HQ side ready behind flags. The Karryam-side consumer/publisher
> does NOT exist yet, and the end-to-end integration is NOT complete.**
> Nothing in the Karryam Go repository was modified (no owner authorization).
> No Karryam service calls HQ today, and HQ never calls Karryam. Activation
> still requires the owner-approval gate in
> `docs/cosmicforge-mail-m8-product-integration.md` (none of its steps has
> been performed).

Audience: Karryam Go engineering (owners of `services/notification-service`
and the `driver-*` services) and the HQ mail operators.

Karryam references below are to the KarryGo working tree at commit
`160444bdf8b1d7abe29baa6fed3943ba905da32c` (read-only inspection).

---

## 1. What Karryam sends today (evidence)

Karryam has one notification shape, used for every channel, defined in
`shared/go/notifications/notifications.go`:

| Item | Location | Notes |
|---|---|---|
| `Recipient` struct | `notifications.go:90-95` | `type`, `id`, `email,omitempty`, `phone,omitempty` |
| `Request` struct | `notifications.go:97-110` | snake_case JSON; `idempotency_key`, `source_service`, `event_type`, `recipient`, then `channels`, `template_key`, `locale`, `title`, `body`, `data`, `template_data`, `priority` (all `omitempty`) |
| Idempotency key format | `notifications.go:84-86` | `"<source_service>:<event_type>:<entity_id>"` (deterministic, no timestamp) |
| Event type constants | `notifications.go:47-77` | e.g. `booking.completed`, `booking.accepted`, `customer.auth.otp`, `payment.success` |
| Send (sync HTTP) | `notifications.go:181-227` | `POST /api/v1/notifications/send`, HMAC-signed, `http.DefaultClient` (no timeout, `:200-203`) |
| Redis publisher | `notifications.go:229-254` | stream `notification:requests`, field `payload` = the Request JSON |
| HMAC signing | `shared/go/serviceauth/serviceauth.go:73-87`, `:138-150` | canonical `METHOD\nREQUEST_URI\nunix_ts\nhex(sha256(body))`, hex HMAC-SHA256 |
| HMAC verify / skew | `serviceauth.go:89-123`, default 5 min `:61-71` | |
| Secrets format | `serviceauth.go:29-53` | `name=secret,name2:secret2` |

There is **no timestamp field** in `Request`; Go's `encoding/json` emits
struct fields in declaration order, drops empty `omitempty` fields, and sorts
map keys. Example, exactly as `driver-hauling-service` builds a completion
today (`services/driver-hauling-service/internal/features/booking/clients/notification_client.go:103-122`,
called from `booking/usecases/booking_service.go:591` and `:662`):

```json
{"idempotency_key":"driver-hauling-service:booking.completed:6f1c2d3e-4b5a-4c6d-8e7f-901234567890","source_service":"driver-hauling-service","event_type":"booking.completed","recipient":{"type":"customer","id":"c0ffee00-1111-4222-8333-444455556666"},"template_key":"booking.completed","data":{"booking_id":"6f1c2d3e-4b5a-4c6d-8e7f-901234567890"},"template_data":{"booking_id":"6f1c2d3e-4b5a-4c6d-8e7f-901234567890"}}
```

Note: booking notifications carry **no recipient email**; only the customer
id. The only email-channel producer today is customer-service's OTP sender
(`services/customer-service/internal/features/auth/clients/notification_email_otp_sender.go:33-46`),
whose `title`/`body` contain the OTP. HQ refuses it by name.

How `notification-service` delivers email:

| Step | Location |
|---|---|
| Routes (HMAC-protected) | `internal/features/messages/http/routes.go:27-40` |
| `Send` -> message + deliveries (dedupe on `idempotency_key`) | `usecases/notification_service.go:66-101`, `repositories/postgres_notification_repository.go:52` (`ON CONFLICT (idempotency_key) DO NOTHING` at `:107`) |
| Stream consumer | `notification_service.go:103-125` |
| Per-delivery processing | `notification_service.go:127-162` |
| Email delivery | `notification_service.go:337-348` -> `EmailSender.SendEmail` |
| SMTP sender | `clients/smtp_email_sender.go:22-62` (`ProviderMessageID` is the literal `"smtp"`, `:61`) |
| Logging fallback | `clients/logging_senders.go:26` (when SMTP config missing; `cmd/main.go:120-123`) |
| Attempts / final status | `notification_service.go:366-410` (`RecordAttempt`, `MarkDelivery`) |
| Backoff | `internal/config/config.go:164-172` |
| Tables | `migrations/001_notifications.sql`: `notification_messages` (1-21), `notification_deliveries` (26-38), `notification_delivery_attempts` (44-52) |

There is **no outbox and no bounce/complaint webhook** in Karryam: the
best signal available is "handed to SMTP" (`sent`) vs `failed`/`dead_lettered`.

## 2. Isolation evidence (HQ never calls Karryam; booking is independent)

- HQ -> Karryam: `grep -rniE "karryam[^\"' ]*(url|database|_db|host)|KarryGo|8101|8104|8106|customer_service|hauling_service|notification_service" services/central-admin-api/src apps/central-admin-web/src`
  matches only two source comments in `integrations/event-registry.js` and
  `integrations/karryam-compat.js`. No HQ code holds a Karryam URL,
  credential or database connection string. `tests/mail-karryam-contract.test.js`
  ("isolation: ...") asserts the integrations module contains no `fetch`,
  HTTP client, `pg`/Prisma client or Karryam database name.
- Karryam -> HQ: `grep -rliE "central.?admin|hq.?mail|cosmicforge.?mail|/api/mail|integrations/v1"`
  over `*.go *.dart *.ts *.tsx *.json *.yml *.yaml *.sql *.sh *.md *.example`
  in KarryGo returns nothing. (Raw greps also hit two committed Mach-O
  binaries, `services/notification-service/devtoken` and
  `services/driver-hauling-service/seed`, on random byte sequences like `hQ`;
  not references.)
- Booking/checkout independence: Karryam booking notifications are
  fire-and-forget (`notification_client.go:12-15`, errors logged at `:119-121`),
  and nothing in the booking path references HQ. HQ is reachable only from a
  future asynchronous publisher (section 6). **Karryam-internal caveat (not
  HQ-related):** `notifications.Client` uses `http.DefaultClient` without a
  timeout and is invoked inline from booking usecases, so a hung
  notification-service can stall a booking request. The HQ publisher must not
  copy that pattern.

## 3. Endpoint and authentication

```
POST {HQ_BASE}/api/mail/v1/integrations/v1/events
Content-Type: application/json
X-Service-Name:      karryam-notification-service      (registered in HQ)
X-Service-Timestamp: <unix seconds>                    (|skew| <= 300s by default)
X-Service-Signature: hex(HMAC-SHA256(secret, "POST\n/api/mail/v1/integrations/v1/events\n<ts>\n" + hex(sha256(body))))
```

This is byte-for-byte Karryam's `serviceauth.SignRequest`, so the publisher
uses it directly:
`serviceauth.SignRequest(req, "karryam-notification-service", secret, body, time.Now())`.
The signed request URI is `req.URL.RequestURI()` (path + query), exactly as
HQ verifies `req.originalUrl`. The secret is provisioned out of band into
HQ's `MAIL_INTEGRATION_SERVICE_SECRETS` and Karryam's own secret store.
Unknown services, bad signatures, skew and unregistered services all return
`401 MAIL_INTEGRATION_UNAUTHORIZED` (indistinguishable on purpose).

## 4. Canonical contract v1 (the supported interface)

Schema: `docs/integrations/hqmail-contract-v1.schema.json`. Strict: unknown
keys are rejected at every level.

```json
{
  "contractVersion": 1,
  "product": "karryam",
  "organization": "karryam",
  "eventId": "kg-evt-0001",
  "eventType": "marketing.trigger",
  "eventVersion": 1,
  "correlationId": "6f1c2d3e-4b5a-4c6d-8e7f-901234567890",
  "idempotencyKey": "driver-hauling-service:booking.completed:6f1c2d3e-4b5a-4c6d-8e7f-901234567890",
  "occurredAt": "2025-10-24T23:59:58.123456789Z",
  "data": {
    "triggerType": "karryam.booking.completed",
    "triggerVersion": 1,
    "contactEmail": "rider@example.com",
    "attributes": { "city": "Lagos", "service": "hauling" }
  }
}
```

| Field | Rule |
|---|---|
| `product`, `organization` | Must equal the authenticated integration's product and brand slug (else 403 `MAIL_INTEGRATION_SCOPE_MISMATCH`). |
| `eventId` | `^[A-Za-z0-9_.:-]{1,160}$`; prefixes `idem:` and `rejected:` are reserved (422 `RESERVED_EVENT_ID_PREFIX`). Reuse it on every retry. |
| `idempotencyKey` | Optional, same pattern. Use `notifications.IdempotencyKey(...)`. See section 5. |
| `occurredAt` | RFC 3339; Go `time.Time` JSON (RFC3339Nano) is accepted (HQ keeps millisecond precision). |
| `data` | Per event type below. Never subject/body/html/text/attachments, credentials, OTPs, card or clinical data (422 `MAIL_INTEGRATION_FORBIDDEN_CONTENT`, scanned at any depth). |

Event type registry (HQ `contracts.js` + `marketing/automation/event-registry.js`):

| eventType@version | data | Karryam use |
|---|---|---|
| `mail.delivery_status@1` | `productMessageId`, `provider` (`smtp`/`resend`/`ses`/`sendgrid`/`mailgun`/`other`), `providerMessageId?`, `sender`, `recipient`, `status` (`ACCEPTED`/`DELIVERED`/`DELAYED`/`BOUNCED`/`COMPLAINED`/`FAILED`/`SUPPRESSED`), `category` | Metadata about mail Karryam already sent. `sender` must be a brand system/shared address authorised for the integration in HQ; staff/personal addresses are always refused (403 `MAIL_SENDER_NOT_AUTHORIZED`, audited as `MAIL_INTEGRATION_SENDER_REJECTED`). Recipient is stored only as `HMAC(hashSecret, orgId:email)` + domain. |
| `marketing.trigger@1` | `triggerType`, `triggerVersion`, `contactEmail`, `attributes?` | Approved triggers only: `karryam.account.registered@1` (`plan`,`city`,`channel`), `karryam.booking.completed@1` (`service`,`city`,`bookingCount`), `karryam.booking.first_completed@1` (`service`,`city`), `karryam.subscription.renewed@1` (`plan`); each must also be enabled on the integration. Never consent. The email is used only to find an existing marketing contact; it is not stored. Other attributes are dropped. |
| `ops.alert@1` | `severity`, `code`, `summary`, `component` | Low-sensitivity operational alerts (no emails/phones in `summary`). |

Recommended Karryam status mapping for `mail.delivery_status`:
`sent` -> `ACCEPTED` (SMTP accepted; Karryam has no delivery receipts),
`failed`/`dead_lettered` -> `FAILED`, `suppressed` -> `SUPPRESSED`;
do not publish `skipped` or `logging_email` (dev) deliveries.
`productMessageId` = `notification_deliveries.id`; `category` = `event_type`.

Responses (`{success, code, retryable, errors[]}` on failure,
`{success:true, data:{accepted, duplicate, eventId, outcome:{kind}}}` on 202):

| Status | Code | Retry? |
|---|---|---|
| 202 | - (`duplicate` true/false) | no (done) |
| 401 | `MAIL_INTEGRATION_UNAUTHORIZED` | no |
| 403 | `MAIL_INTEGRATION_NOT_ACTIVE`, `MAIL_INTEGRATION_SCOPE_MISMATCH`, `MAIL_INTEGRATION_FORBIDDEN_CONTENT`, `MAIL_SENDER_NOT_AUTHORIZED` | no |
| 409 | `MAIL_INTEGRATION_EVENT_CONFLICT` (same eventId, different payload), `MAIL_INTEGRATION_IDEMPOTENCY_CONFLICT` (same idempotencyKey, different payload) | no |
| 413 | `MAIL_INTEGRATION_BODY_TOO_LARGE` | no |
| 422 | `MAIL_VALIDATION_FAILED`, `MAIL_INTEGRATION_UNKNOWN_FIELDS`, `MAIL_INTEGRATION_UNSUPPORTED_EVENT`, `MAIL_INTEGRATION_UNSUPPORTED_VERSION`, `MAIL_INTEGRATION_FORBIDDEN_CONTENT`, `MAIL_INTEGRATION_LEGACY_SHAPE_NOT_ENABLED` | no |
| 429 | `MAIL_RATE_LIMITED` | yes |
| 503 | `MAIL_SCHEMA_NOT_READY`, `MAIL_INTEGRATIONS_DISABLED`, `MAIL_INTEGRATIONS_NOT_CONFIGURED`, `MAIL_ROLLOUT_NOT_ENABLED`, `MAIL_STORAGE_UNAVAILABLE` | yes |

## 5. Idempotency rules

1. HQ dedupes on `(integration, eventId)`: same id + identical raw body ->
   `202 duplicate:true`; same id + different body -> `409 MAIL_INTEGRATION_EVENT_CONFLICT`.
2. HQ also dedupes on `(integration, idempotencyKey)` when the key is present
   (new in this change; previously parsed but unused). The logical event is
   fingerprinted over `product, organization, eventType, eventVersion,
   correlationId, data` (key order irrelevant; **eventId and occurredAt are
   excluded**). Same key + same fingerprint under a fresh eventId ->
   `202 duplicate:true` with the original `eventId`; same key + different
   fingerprint -> `409 MAIL_INTEGRATION_IDEMPOTENCY_CONFLICT`. Concurrent
   first deliveries are serialised by the database unique index (exactly one
   wins). Internally a marker row (`eventId = "idem:<uuidv5>"`,
   `eventType = "integration.idempotency_key"`) is stored in
   `mail_product_integration_events`; it is hidden from health and event
   listings.
3. Marketing triggers sent with an idempotencyKey are stored for automation
   under the key-derived id, so two different eventIds for one key never
   trigger twice.
4. 409s are permanent: do not retry; fix the producer.

## 6. Plan: outbox publisher in `services/notification-service` (Karryam-owned)

Proposed files (Karryam's standard layout; owner decides):

| File | Purpose |
|---|---|
| `migrations/002_hq_mail_outbox.sql` | `hq_mail_outbox(id uuid pk, event_id text unique, idempotency_key text, envelope jsonb, status text check in ('pending','sent','failed_permanent'), attempts int, next_attempt_at timestamptz, last_status int, last_code text, created_at, updated_at)` + index on `(status, next_attempt_at)`. Service-local, no cross-service FKs. |
| `internal/features/hq_mail/models/envelope.go` | Envelope + data structs (copy of `docs/integrations/karryam-go-hqmail/hqmail.go` types; `IdempotencyKey`, `Timestamp()`). |
| `internal/features/hq_mail/repositories/postgres_outbox_repository.go` | `Enqueue(tx, envelope)`, `ClaimDue(limit)` (`FOR UPDATE SKIP LOCKED`), `MarkSent`, `MarkRetry(next)`, `MarkPermanent(code)`. |
| `internal/features/hq_mail/clients/hq_mail_client.go` | `http.Client{Timeout: 10s}`; body via `json.Marshal`; `serviceauth.SignRequest(req, cfg.ServiceName, cfg.Secret, body, time.Now())`; classify per section 4. |
| `internal/features/hq_mail/usecases/publisher.go` | Ticker worker (like `retryDueDeliveries`, `notification_service.go:238-255`): claim, send, mark. Backoff: `hqmail.Backoff(attempt)` (exponential from 30s, cap 30m, full jitter); honour `Retry-After` on 429. Give up after N attempts -> `failed_permanent` + log/metric (never block anything). |
| `internal/features/messages/repositories/postgres_notification_repository.go` | In the transaction that finalises an **email** delivery (`MarkDelivery`, `:247`, called from `finishDelivery` `notification_service.go:404-410` and `handleProviderResult` `:366-402`), also `Enqueue` a `mail.delivery_status@1` envelope: `eventId = "kg-dlv-" + delivery.id + "-" + status`, `idempotencyKey = notifications.IdempotencyKey("notification-service", "mail.delivery_status", delivery.id+":"+status)`, `sender = cfg.SMTP.From`, `recipient = message.RecipientEmail`, `provider = "smtp"`. Skip logging senders. (Today `RecordAttempt` + `MarkDelivery` are separate statements; the enqueue must join the `MarkDelivery` statement's transaction.) |
| `internal/config/config.go` + `cmd/main.go` | `NOTIFICATION_HQ_MAIL_URL`, `NOTIFICATION_HQ_MAIL_SERVICE_NAME` (default `karryam-notification-service`), `NOTIFICATION_HQ_MAIL_SECRET`; publisher starts only when all are set (default OFF), same pattern as the logging-sender fallback (`cmd/main.go:120-123`). |

Marketing triggers (`booking.completed`): the booking notification carries no
customer email. Options for the Karryam owner: (a) the producing service
fills `Recipient.Email` from customer-service's own API before notifying, or
(b) notification-service publishes `marketing.trigger` only when
`recipient_email` is present. Either way the trigger is written to the
outbox, never sent inline from a booking request.

Rules: never call HQ from a request path; HQ outage only delays the outbox;
HQ never blocks booking, payment, login or notification delivery.

## 7. Compatibility option: native `notifications.Request` shape (temporary)

For a short bridge period HQ can accept the native Karryam Request JSON at
the same endpoint, signed the same way. It is **off by default** and accepted
only when the authenticated integration is the Karryam integration
(`product = "karryam"`) **and** its service name is in
`MAIL_INTEGRATION_KARRYAM_COMPAT_SERVICES` (comma list, empty by default; the
integration row has no per-integration config column, so the flag is env).
Otherwise: `422 MAIL_INTEGRATION_LEGACY_SHAPE_NOT_ENABLED` with
`reason` `COMPAT_FLAG_OFF` or `NOT_KARRYAM_INTEGRATION`, `flag`, `shape`.

Normalisation (`services/central-admin-api/src/modules/mail/integrations/karryam-compat.js`,
mapping table in `integrations/event-registry.js`):

| Native | HQ |
|---|---|
| `event_type: "booking.completed"` from `driver-hauling-service` / `driver-taxi-service` / `driver-dispatch-delivery-service` | `marketing.trigger@1`, `karryam.booking.completed@1`, `attributes.service` = `hauling` / `taxi` / `dispatch` (+ `city`, `bookingCount` if present in `data`) |
| `customer.auth.otp` | refused, 422 `MAIL_INTEGRATION_FORBIDDEN_CONTENT` `OTP_NEVER_SENT_TO_HQ` |
| any other `event_type` | 422 `MAIL_INTEGRATION_UNSUPPORTED_EVENT` (`supported: ["booking.completed"]`) |
| `idempotency_key` | `eventId = uuidv5(idempotency_key, uuidv5("integration:<id>", fixed namespace))` - Karryam retries are byte-identical, so they dedupe |
| `product` / `organization` | from the authenticated integration (any such key in the payload is an unknown field) |
| `occurredAt` | HQ receive time (Request has no timestamp) |
| `recipient.email` | required (422 `KARRYAM_RECIPIENT_EMAIL_REQUIRED`); used only for contact lookup, not stored |
| `recipient.phone`, `to`/`cc`/`bcc`/`recipients` | refused (`RAW_CONTACT_DATA_NOT_ALLOWED`, `RECIPIENT_LIST_NOT_ALLOWED`) |
| `title`, `body` | refused (`MESSAGE_CONTENT_NOT_ALLOWED`) |
| `from`/`sender`/`reply_to`/... anywhere | 403 `MAIL_SENDER_NOT_AUTHORIZED` (`PRODUCT_NOTIFICATION_CANNOT_SET_SENDER`), audited |
| `channels`, `template_key`, `locale`, `priority` | validated, ignored |
| `data`, `template_data` | flat primitives only; prohibited keys (credentials, OTP/code/pin, clinical) refused; unapproved keys (e.g. `booking_id`) dropped |
| unknown keys | 422 `MAIL_INTEGRATION_UNKNOWN_FIELDS` |

Successful compat responses include `data.normalizedFrom = "karryam.notifications.Request"`.

**Sunset:** the shim exists only until the contract-v1 outbox publisher
(section 6) is live. Proposed: enable only in a non-production environment,
remove the service from `MAIL_INTEGRATION_KARRYAM_COMPAT_SERVICES` as soon as
canonical events flow, and delete `karryam-compat.js` no later than 90 days
after first enablement. Turning the env value empty disables it instantly.

## 8. Test vectors

`services/central-admin-api/tests/fixtures/karryam/karryam-signed-vectors.json`
(14 vectors, body bytes in `bodyBase64`, headers, test-only secrets). It was
generated with **go1.26.3** by a throwaway program outside both repositories
that imports KarryGo's real `shared/go/notifications` and
`shared/go/serviceauth` (via a `replace` to the unmodified working tree),
marshals values with `encoding/json`, and signs with
`serviceauth.SignRequest` at `ts=1761350400`. HQ reproduces every signature
byte-for-byte (`tests/mail-karryam-contract.test.js`). Key vectors:

| Vector | Signature |
|---|---|
| `cross_language_vector` (`{"contractVersion":1}`, secret `vector-secret-0123456789`) | `f2d6ea185346e6460abaf673214319f2b29e6a00f0c1e4593aaa3168c68e7f27` |
| `compat_booking_completed` | `a505953d769e01d32b610093e9e2f4e3b6fc9cd9b58b9baf1b7d75905646e2a1` |
| `canonical_trigger` | `e2ea9d9c585a1a6a82109d102ddacc77aae250d0010634c42750a31137a299b3` |
| `canonical_delivery` | `36a46352f13f700c4bc27ef58fbaf6f6c7d6f6023675f30f4d6029431d0be995` |

To regenerate: a Go module with
`replace cosmicforge/logistics/shared/go => <KarryGo>/shared/go`, build the
`notifications.Request` / envelope values shown in the fixture descriptions,
`json.Marshal` them, call `serviceauth.SignRequest(httptestReq, name, secret, body, time.Unix(1761350400, 0))`,
and write the headers + base64 body. Run with `GOWORK=off GOFLAGS=-mod=mod`.

## 9. Acceptance steps (none performed yet)

1. Karryam owner reviews this document, contract v1 and the reference client
   (`docs/integrations/karryam-go-hqmail/`).
2. Karryam implements section 6 in `notification-service` (default off) and
   adds a contract test that signs `cross_language_vector` and
   `compat_booking_completed` with `serviceauth.SignRequest` and asserts the
   signatures above.
3. HQ operator, in a non-production HQ: sets `MAIL_ENABLED`,
   `MAIL_INTEGRATIONS_ENABLED=true`, `MAIL_INTEGRATION_HASH_SECRET`,
   `MAIL_INTEGRATION_SERVICE_SECRETS=karryam-notification-service=<secret>`
   via the secret manager; registers the integration (product `karryam`,
   brand `karryam`, event types, trigger `karryam.booking.completed@1`);
   authorises the brand system sender (e.g. `noreply@<karryam domain>`).
4. Owner approval recorded; mail admin activates with MFA step-up.
5. End-to-end in non-production: a hauling booking completes; Karryam's
   outbox publishes; HQ answers 202; replaying the outbox row answers
   `duplicate:true`; HQ health page shows the events; stopping HQ leaves
   bookings unaffected and the outbox drains after HQ returns.
6. Only then consider production, with the compat shim disabled.

## 10. HQ-side verification

`tests/mail-karryam-contract.test.js` (signatures vs Go, Go marshal shape,
skew, wrong service, compat off/on, Karryam-only scoping, normalisation and
idempotent replay, unknown/refused events, content/PHI/phone rejection,
staff-sender spoof rejection + audit, canonical idempotencyKey dedupe and
409), `tests/mail-m8-unit.test.js` (normaliser, UUIDv5, reserved prefixes,
fingerprint) and `tests/mail-m8-postgres.test.js` (idempotencyKey incl.
concurrent race, staff-sender audit).
