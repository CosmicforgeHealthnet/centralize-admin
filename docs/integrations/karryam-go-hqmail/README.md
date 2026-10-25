# HQ Mail reference client (Go)

Reference code for product teams (first: Karryam Go) that want to report
transactional-mail delivery status, approved marketing triggers or
operational alerts to CosmicForge HQ Mail using **contract v1**
(`docs/integrations/hqmail-contract-v1.schema.json`).

This directory is **documentation**. It is not imported by any product and
nothing in the Karryam Go repository was changed. Adopting it is the product
owner's decision.

## Rules

1. **Outbox, never inline.** Write the event to the product's own outbox table
   in the same transaction as the product change; a worker delivers it. HQ
   being slow or down must never block a booking, login or payment.
2. **Same `eventId` on every retry.** HQ is idempotent on `(integration,
   eventId)`. A different payload under the same id gets `409` and must not be
   retried.
3. **Retry only when `Result.Retryable`** (network errors, `429`, `5xx`), with
   exponential backoff. `401/403/413/422` are permanent: fix and re-emit.
4. **No content.** No subject, body, HTML, attachments, credentials, card data,
   or any clinical/patient data. HQ rejects them fail-closed (`422
   MAIL_INTEGRATION_FORBIDDEN_CONTENT`).
5. **Transactional mail stays with the product.** HQ never sends Karryam's
   transactional email; `mail.delivery_status` only reports what the product
   already sent.

## Signing

Byte-compatible with Karryam's `shared/go/serviceauth`:

```
X-Service-Name:      <service identity registered in HQ>
X-Service-Timestamp: <unix seconds>   (max skew 300s by default)
X-Service-Signature: hex(HMAC-SHA256(secret, METHOD \n REQUEST_URI \n ts \n hex(sha256(body))))
```

so `serviceauth.SignRequest(req, "karryam-notification-service", secret)` can be
used directly. The shared test vector (asserted in `hqmail_test.go`, the HQ
unit tests, and checked against Karryam's real `SignRequest`):

```
POST /api/mail/v1/integrations/v1/events  ts=1761350400
body={"contractVersion":1}  secret=vector-secret-0123456789
=> f2d6ea185346e6460abaf673214319f2b29e6a00f0c1e4593aaa3168c68e7f27
```

## Activation gate

An integration registered in HQ starts `DISABLED`. A mail administrator can
activate it only by recording the product owner's approval reference and
passing an MFA step-up (`MAIL_INTEGRATION_ACTIVATE`). It should not be
activated until the product owner has tested it end-to-end in a
non-production environment with their own outbox. Ingestion is additionally
gated by `MAIL_INTEGRATIONS_ENABLED` (default `false`).

## Test

```
go vet ./... && go test ./...
```
