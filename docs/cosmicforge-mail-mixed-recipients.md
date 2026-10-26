# CosmicForge Mail: mixed internal/external recipients (spec 11.8, GAP 8)

Status: implemented behind `MAIL_MIXED_RECIPIENT_MODE`. The default stays
`external-only`. `full-headers` must NOT be enabled until product/security
have approved it AND the receiving cutover (our domains' MX pointing at
Resend inbound) is complete. The live checks at the end are still open.

## The problem

A message from a CosmicForge mailbox can have internal recipients (active
local mailboxes on our domains) and external recipients in To, Cc and Bcc.

RFC 5322 section 3.6.3 expects every recipient to see the same `To:` and
`Cc:` header fields; `Bcc:` must never reveal blind recipients to the others
(common practice: the Bcc field is removed from every copy, and each blind
recipient sees the original To/Cc). Reply-All in the recipient's client is
built from From + To + Cc, so missing visible recipients means a reply that
silently drops people.

Internal recipients always get exactly one local copy at queue time
(`compose.service.js sendDraft`, recipient status `INTERNAL_DELIVERED`). That
copy lists the full visible To/Cc (never Bcc). This is the single delivery
path for internal recipients in both modes.

## Provider constraint: no envelope/header split

Resend's `POST /emails` takes `to`, `cc`, `bcc`, `reply_to` and custom
`headers`. It builds the visible To/Cc header fields from `to`/`cc` and
delivers to every address in `to`, `cc` and `bcc`. There is no documented way
to send the SMTP envelope to a subset of the header recipients (no
`envelope`/`RCPT TO` override, no way to set `To:`/`Cc:` independently).
So "show internal people in the headers" necessarily means "the provider also
delivers to the internal addresses". Resend also requires `to`.

## Modes

### `external-only` (default)

* Only external (`PENDING`) recipients are given to the provider.
* External recipients see only the external To/Cc. Reply-All from an
  external client misses internal people (known limitation).
* With no external To, external Cc are promoted to `to` (Resend requires it).
* With only external Bcc, each Bcc recipient gets an individual request
  (`to` = that recipient), so Bcc recipients never see each other.
* Why it is the default: in `full-headers` the provider delivers to internal
  addresses through our MX. Before the receiving cutover our MX is the legacy
  mail system, which would store a duplicate copy of every mixed send.

### `full-headers`

* The provider request carries the complete visible To and Cc (internal +
  external, original To/Cc types kept) and external Bcc in `bcc`.
* Internal Bcc recipients are never given to the provider (they already have
  their local copy) and never appear in any header.
* External Bcc recipients are in `bcc` of the same request, so (RFC common
  practice) they see the original To/Cc and no Bcc header, and never each
  other. Only when there is no visible To/Cc at all does each external Bcc get
  an individual request with `to` = that recipient (Resend requires `to`).
* With no visible To but visible Cc, the Cc are promoted to `to` (Resend
  requires `to`); this is the only case where a header type changes.
* Every recipient of the request sees the same To/Cc, so Reply-All from an
  external client includes internal people.
* The plan (recipient lists, mode and origin header value) is persisted on the
  job at the first attempt, so a later mode or key change never alters the
  payload sent under a batch's Idempotency-Key.
* Config validation refuses the mode (logs a warning, stays `external-only`,
  `publicStatus().mixedRecipients.refusedReason`) when no origin key exists.

## Provider echoes (full-headers)

The provider delivers the internal To/Cc addresses back to us via MX. These
echoes must not create a second copy:

1. Signed origin header on every request that addresses an internal
   recipient: `X-CosmicForge-Origin: <messageId>.<hmac>`, where `<messageId>`
   is the sender's OUTBOUND `mail_messages.id` and `<hmac>` is base64url
   HMAC-SHA256 over `cosmicforge-mail-origin:v1:<messageId>`
   (`src/modules/mail/security/origin-header.js`). Key: `MAIL_ORIGIN_HEADER_SECRET`
   (>= 32 chars); otherwise derived from every version of the env encryption
   keyring (signing with the active version, verifying with all, so rotation
   does not resurrect echoes). With `MAIL_KMS_PROVIDER=aws-kms` an explicit
   secret is required.
2. The inbound pipeline (`inbound.processor.js`) verifies the HMAC in constant
   time, loads the referenced OUTBOUND message, requires the inbound From to
   be the original sender and that the message has internally delivered
   recipients, and then, per target mailbox, drops the inbound only where the
   mailbox already holds that message (same rfcMessageId). It records
   `MAIL_INBOUND_PROVIDER_ECHO_DEDUPED` (metadata: via, provider email id).
   Mailboxes without a copy get the mail normally.
3. Message-ID dedup: an inbound whose Message-ID is ours, or the provider's
   alias of ours (below), is handled the same way (`via` = `message-id` /
   `provider-alias`). The pre-existing per-mailbox unique Message-ID index
   still dedups replays.

Security: a forged, malformed or other-key header is "not an echo" (audited
as `MAIL_INBOUND_ORIGIN_HEADER_INVALID`) and the mail is delivered normally,
so an attacker without the key cannot suppress delivery. A valid header
copied from a mail an external recipient received can only suppress copies of
that same message in mailboxes that already hold it, and only with the
original From. The header (message UUID + MAC) is visible to external
recipients; it carries no content.

## Provider delivery events for internal addresses

* Internal recipients stay `INTERNAL_DELIVERED`. They are never shown as
  "Delivered to receiving server" and never become FAILED/BOUNCED.
* An event that names only internal addresses (and is not just the echo of
  the request's To list) is stored for operators only: `mail_delivery_events`
  row with `message_id` NULL and `detail = { internalRecipient: true,
  ignored: true, outboundMessageId }`, audit
  `MAIL_DELIVERY_INTERNAL_RECIPIENT_IGNORED`. No status change, no
  suppression, nothing in the sender's delivery details.
* In full-headers mode internal rows the request addressed carry the batch's
  provider id (status unchanged) so a request with one external and some
  internal recipients is not treated as a single-recipient batch: an
  unnamed or To-echo bounce is recorded as unattributed instead of being
  guessed onto the only external recipient.
* Message status is derived from external recipients only, so a partial
  provider failure (one external delivered, another bounced) is reported
  truthfully regardless of internal recipients.

## Message-ID consistency

Resend may replace our `Message-ID` header (its docs do not say it can be
overridden). Resend returns its own `message_id` in every email webhook and in
`GET /emails/{id}`.

* The webhook controller stores `data.message_id` (email events only).
* The delivery-event processor stores it in `mail_message_provider_ids`
  (migration 37) when it differs from our rfcMessageId. First alias wins; one
  alias per message (for individual-Bcc multi-request sends only the first
  observed alias is kept). If the adapter's send response ever carries an
  `rfcMessageId`, it is stored the same way (Resend's documented response
  only has `id`).
* Threading (`message-store.service.js findThreadForReferences`) matches
  In-Reply-To/References against our rfcMessageId and, when not found,
  against provider aliases (mapped back to our rfcMessageId, so replies also
  join internal copies' threads in other mailboxes).
* Echo dedup uses the alias as well.
* Before migration 37 (`features.finalGap` not ready) aliases are neither
  stored nor looked up; everything else (both modes, origin-header echo dedup,
  threading by our own Message-ID) works unchanged.

## Reply / Reply-All

Built server side (`prefillFromSource`): from an internal copy, To = original
sender (or Reply-To), Cc = all visible To/Cc minus the replier's mailbox
addresses and sender identities; from the sender's own message, To = original
To, Cc = original Cc minus own. Bcc rows are never copied.

## Enabling full-headers (checklist)

1. Product + security approval of this design.
2. Receiving cutover done: our domains' MX -> Resend inbound; legacy system no
   longer receives for these domains.
3. Set `MAIL_ORIGIN_HEADER_SECRET` (>= 32 random chars; required with KMS).
4. Set `MAIL_MIXED_RECIPIENT_MODE=full-headers`; confirm
   `publicStatus().mixedRecipients.mode` and no "refused" warning in logs.

## Live checks still required (staging, real Resend)

* Custom header preservation: `X-CosmicForge-Origin` arrives unchanged on the
  inbound copy and is returned in `GET /emails/receiving/{id}` headers.
* Message-ID: does Resend keep our `Message-ID`? If not, confirm the webhook
  `message_id` equals the Message-ID seen by recipients and on the echo.
* Echo dedup end to end: internal To + external Cc send -> exactly one copy
  per internal mailbox, `MAIL_INBOUND_PROVIDER_ECHO_DEDUPED` audited.
* Bcc: external Bcc copies carry no Bcc header and the original To/Cc;
  webhook events for Bcc recipients (does Resend include `bcc`?).
* Event payloads for multi-recipient requests (which addresses `to`/`cc`
  list) to confirm attribution.
* Quota impact: provider usage now counts internal addresses in the request.
