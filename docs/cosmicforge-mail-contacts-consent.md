# Email Marketing: Contacts & Consent

Centralized Admin → Marketing → Email Marketing → Contacts & Consent.

## Rules

- Saving a contact and giving marketing permission are separate steps. A contact can be
  saved with no permission. It is then never eligible for marketing.
- The consent **source** records the channel Mail itself received the permission through,
  and it is **set by the server**. Staff actions are always `MANUAL`. CSV imports are
  always `IMPORT`. The admin API refuses `WEB_FORM`, `API`, `EVENT` and `IMPORT` with 422
  (`CONSENT_SOURCE_SET_BY_SERVER`).
- Mail has **no** web-form, API or event consent-collection channel today: the product
  integration endpoint enforces withdrawals and triggers only. Existing rows labelled
  `WEB_FORM` / `API` / `EVENT` were entered by staff before this change and are kept
  unchanged. A future genuine channel must set its own source on the server.
- A staff-typed evidence reference never grants permission by itself.

## Staff workflow

| Choice in the form | API (`consent.mode`) | Result |
|---|---|---|
| Save contact only | no `consent` | `marketingPermission: NOT_REQUESTED`; no consent row |
| Ask them to confirm by email | `REQUEST_CONFIRMATION` | Consent `PENDING_CONFIRMATION` (`MANUAL`, double opt-in). A confirmation email job is queued when confirmation emails are enabled; the response says whether one was queued (`confirmationEmail.queued`). The contact's own confirmation grants it (welcome automations may start). |
| They already agreed (I have proof) | `DOCUMENTED` + `evidence.reference` (+ optional `note`, `consentedAt`) | **Approval request**: nothing reaches the consent table. A *different* brand approver approves it under Approvals within 7 days. Approval re-checks the current state, then writes `GRANTED` / `MANUAL` / `doubleOptIn=false` with `sourceEvidence.verification` (`INDEPENDENT_APPROVAL`, requester, approver, times). This never triggers welcome automations. |

Legacy request bodies without `mode` stay accepted: `doubleOptIn: true` means
`REQUEST_CONFIRMATION` and `doubleOptIn: false` means `DOCUMENTED`. A body without either
means `REQUEST_CONFIRMATION`. `doubleOptIn: false` therefore no longer grants immediately.

Refusals:

- `CONSENT_ALREADY_GRANTED` (409): staff cannot downgrade an existing grant.
- `WITHDRAWN_CONSENT_REQUIRES_DOUBLE_OPT_IN`: a withdrawal comes back only through the
  contact's own confirmation.
- Approvals are refused when the request is:
  - already decided (single use, even with concurrent approvers);
  - expired;
  - self-approved by the requester;
  - from another brand;
  - for a consent withdrawn since the request was made;
  - for a consent already granted.

Unsubscribe, withdrawal, suppression, complaint and bounce handling, eligibility checks and
provider safeguards are unchanged.

## Topics and privacy-policy versions

They are chosen from `GET /marketing/{orgId}/consent-options`, which combines:

- `MAIL_MARKETING_CONSENT_TOPICS`: comma-separated; defaults to `newsletter`. Topics of the
  brand's campaigns and existing consents are always allowed too.
- `MAIL_MARKETING_CONSENT_POLICY_VERSIONS`: comma-separated; the **first is the current
  version**. Versions already used by the brand stay valid, so history is never broken.

Any other value is refused with 422. A brand with no configured and no in-use policy version
cannot record permission (`CONSENT_POLICY_VERSION_NOT_CONFIGURED`), but contacts can still be
saved.

**Deployment requirement:** set `MAIL_MARKETING_CONSENT_POLICY_VERSIONS` (and
`MAIL_MARKETING_CONSENT_TOPICS` if more than `newsletter` is used) before deploying.

## CSV import

- `originalChannel`: `WEB_FORM`, `EVENT` or `OTHER`, meaning where people originally opted
  in. It is stored in `sourceEvidence.originalChannel`; the consent source is `IMPORT`. The
  legacy `source` field maps `WEB_FORM`, `EVENT` and `IMPORT` (= `OTHER`); `API` and `MANUAL`
  are refused.
- Columns: `email` (required), and optionally `first_name`, `last_name`, `consented_at`
  (ISO date) and `timezone` (IANA).
- The evidence reference, opt-in attestation and two-person preview/commit approval within
  24 h are unchanged. Imports never re-grant withdrawn or pending consent.

## API changes

| Method and path | Change |
|---|---|
| `POST /marketing/{orgId}/contacts` | Contact source is always `manual`. `consent.mode` is accepted; consent sources other than `MANUAL` are refused. The response adds `marketingPermission`, `consentApproval` and `confirmationEmail` |
| `POST /marketing/{orgId}/contacts/{contactId}/consents` | Same modes and rules; returns `status`, `consentApproval` and `confirmationEmail` |
| `POST /marketing/{orgId}/contacts/import` | `originalChannel`; stored source `IMPORT`; topic and policy version must be allowed choices |
| `GET /marketing/{orgId}/consent-options` | New (view) |
| `GET /marketing/{orgId}/consent-approvals` | New (view): pending, unexpired requests |
| `POST /marketing/{orgId}/consent-approvals/{requestId}/decision` | New (approve): `{ decision: "APPROVE" \| "REJECT", note? }` |

No database migration: approval requests and decisions are append-only `mail_audit_events`
(`MARKETING_CONSENT_APPROVAL_REQUESTED` / `MARKETING_CONSENT_APPROVAL_DECIDED`). Existing
contacts and consents are not modified.

## Tests

- `services/central-admin-api/tests/mail-contacts-consent-postgres.test.js`: real
  PostgreSQL and the real router, including direct HTTP bypass attempts.
- `apps/central-admin-web/e2e/marketing-contacts-consent.spec.ts`: desktop and mobile. The
  request bodies the UI sends are validated against the backend's OpenAPI request schemas.
- Existing Mail suites now obtain eligible contacts through the genuine paths:
  confirmation by the contact (`tests/helpers/marketing-consent.js`) or approval.
