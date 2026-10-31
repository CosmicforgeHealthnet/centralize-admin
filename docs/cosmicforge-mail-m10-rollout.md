# CosmicForge Mail M10: production pilot and expansion readiness

Status: original M10 rollout specification. **Core-worker policy revised 2026-10-31:** OUTBOUND, INBOUND and EVENTS use backend enable flags rather than manual ALLOW rules; explicit legacy DENY rules still block a queue, and MARKETING remains opt-in. The statement below describes the original activation baseline. No rule, cohort, stop,
DNS record, provider route, worker or flag was created or changed in any
shared environment. The live canary was never executed.

## 1. Rollout model

Three layers apply, and each can only narrow what the layer above allows:

1. **Configuration flags** (`MAIL_ENABLED`, `MAIL_SENDING_ENABLED`,
   `MAIL_MARKETING_ENABLED`, `MAIL_BROADCAST_DISPATCH_ENABLED`, ...,
   `MAIL_EMERGENCY_STOP_*`). These need a deploy.
2. **Database emergency stops** (`mail_emergency_stops`): `ALL`, `MARKETING` or
   one `ORGANIZATION`.
   - Activation is immediate and needs any mail admin with EDIT; no 2FA, so
     the stop is fast in an incident.
   - Release needs a step-up (`MAIL_EMERGENCY_STOP_RELEASE`).
   - Queued mail is deferred, never failed; new external sends get 503.
   - Receiving and delivery events continue.
3. **Rollout rules** (`mail_rollout_rules`), per deployment environment.
   - A capability is allowed only where an `ALLOW` rule matches and no
     `DENY` rule does.
   - Enforcement is **on by default in production** and off elsewhere
     (`MAIL_ROLLOUT_ENFORCED` overrides; set it to `true` in staging to
     rehearse).

| Capability | Checked at | Scopes |
|---|---|---|
| `STAFF_MAIL`, `SUPPORT` | Compose (external recipients only) and outbound dispatch | ENVIRONMENT, ORGANIZATION, DOMAIN (sender), MAILBOX, COHORT (sender) |
| `MARKETING_BROADCAST`, `MARKETING_AUTOMATION`, `MARKETING_CONFIRMATION` | Worker before each provider call | ENVIRONMENT, ORGANIZATION |
| `PRODUCT_INTEGRATION` | Event ingestion (503, retryable, so products lose nothing) | ENVIRONMENT, ORGANIZATION |
| `WORKER_OUTBOUND`, `WORKER_INBOUND`, `WORKER_EVENTS` (retired as ALLOW controls) | Core processing is backend-managed: it follows the backend Mail flags (`MAIL_SENDING_ENABLED`, `MAIL_RECEIVING_ENABLED` + inbound ownership, `MAIL_ENABLED`). ALLOW rules are refused (`CORE_WORKER_BACKEND_MANAGED`). An explicit DENY rule is an emergency pause, reported in the worker heartbeat and raised as `MAIL_WORKER_QUEUE_UNSERVED`. The worker runs whenever `MAIL_ENABLED=true` unless `MAIL_WORKER_ENABLED=false` (explicit shutdown). See `docs/cosmicforge-mail-inbound-incident-repair.md`. | ENVIRONMENT only (DENY) |
| `WORKER_MARKETING` | Optional marketing queue is still opt-in via rollout | ENVIRONMENT only |

Rules are never edited, only revoked; every change is audited.
- Changes that **widen** exposure (create ALLOW, revoke DENY) need a step-up
  (`MAIL_ROLLOUT_CHANGE`).
- Changes that **narrow** it (create DENY, revoke ALLOW) are immediate.
- Rule state is cached for at most 5 seconds per process; changes made through
  the same API process apply instantly.

UI: `/dashboard/mail/rollout` (stops, readiness, cohorts, **optional feature rules; no worker queue controls**) and
`/dashboard/mail/operations` (M9).

## 2. Pilot staff onboarding and offboarding

Onboarding a pilot member:
1. Confirm HQ MFA enrollment (required for every step-up).
2. Provision the personal mailbox (M2 provisioning).
3. Add the person to the pilot cohort.
4. Check `GET /admin/rollout/pilot/{adminUserId}`. `ready: true` means the
   account is active, MFA is enrolled, a mailbox is active and `STAFF_MAIL`
   is allowed for them.

Offboarding:
1. Remove the person from the cohort. Their next external send is refused.
2. For leavers, also use M2 mailbox offboarding (suspends the mailbox and
   cancels unsent mail at dispatch) and HQ account deactivation (revokes
   sessions).

## 3. Canary

- **Offline** (`npm run mail:canary:simulate`, also run in CI by
  `tests/mail-m10-drills.test.js`). It runs on a disposable replay database
  with the fake provider:
  - enforced default-deny;
  - cohort onboarding plus ALLOW;
  - a canary send reaching the provider;
  - DB emergency stop refusing sends, then release with step-up and resume;
  - ops snapshot and metrics clean;
  - pilot readiness gates pass.

  Result: all steps pass.
- **Live** (`npm run mail:canary:live -- --environment=staging --api=... --mailbox=<canary mailbox> --to=<operator seed address>`).
  - Prints the plan only, unless `--execute --confirm-live=<environment>` is
    given.
  - Refuses production without `--allow-production`.
  - Reads the token from `HQ_API_TOKEN` (never from the command line), sends
    exactly one message with an Idempotency-Key, and polls for delivery
    evidence for up to 10 minutes.
  - **Not executed in this work.** Running it is an operator action that
    needs a change ticket.

## 4. DNS coexistence plan (per brand domain)

The current mail setup of each brand domain (MX host, SPF, DKIM selectors,
DMARC policy) was **not inspected**: no DNS or provider access was used. The
plan is therefore a checklist for the domain owner.

1. **Inventory.** Record the current MX, SPF (`v=spf1 ...`), every DKIM
   selector, DMARC (`_dmarc`), and any existing mail provider routes. Export
   them before any change.
2. **Sending first, receiving later.**
   - Add the sending domain in Resend and publish only the records Resend
     shows for it: DKIM and the return-path/bounce records.
   - Prefer a dedicated subdomain for HQ sending so the root SPF/MX stay as
     they are.
   - If the root domain must send, merge Resend's `include:` into the
     existing SPF record. Never publish a second SPF record, and keep it
     under the 10-DNS-lookup limit.
3. **Do not move the root MX during the pilot.** Existing staff mailboxes keep
   receiving where they do today.
   - HQ Mail receiving for the pilot uses a separate receiving
     (sub)domain/route configured in Resend.
   - Alternatively, use forwarding rules from the current provider, if
     approved.
4. **DMARC.** Keep the existing policy. Verify alignment for the HQ sending
   domain (DKIM `d=` aligned) using the aggregate reports before tightening
   anything. Never relax a stricter policy.
5. **Validation.** Check SPF/DKIM/DMARC results in the received headers of a
   canary sent to an operator seed mailbox. Check the M9 health and webhook
   gates.
6. **Cutover (later stage, separate approval).**
   - Lower the MX TTL a few days ahead.
   - Change MX in a window, keeping the previous provider able to accept
     mail during propagation.
   - Monitor the inbound webhook backlog.
   - Roll back by restoring the recorded MX.
7. **Karryam transactional mail is out of scope.** Its sending domain,
   provider and DNS are not changed by HQ Mail.

## 5. Progressive rollout criteria

`GET /admin/rollout/readiness` evaluates live state. Automated gates report
PASS or FAIL; human sign-offs are MANUAL and are never assumed.

| Stage | Automated gates (summary) | Manual sign-offs |
|---|---|---|
| S0 staging rehearsal | No infra violations; keyring, storage and scanner healthy; provider and webhook secret configured; alerts on; metrics token set | Restore drill, rollback drill, runbook review |
| S1 staff pilot | No critical alerts; enforcement on; a cohort with members; `STAFF_MAIL` allowed for a cohort and **not** environment-wide; worker rules present; no stop | DNS checklist for the pilot domain; pilot briefing |
| S2 brand-wide | No critical alerts; staff bounce rate under the threshold with at least the minimum sample; no unknown outcomes or dead letters in 24h; scan backlog OK | Pilot sign-off by the brand owner |
| S3 marketing | Dispatch flag on; unsubscribe configured; postal addresses set; marketing worker allowed; no marketing stop | Legal sign-off on consent and lists; DMARC alignment |
| S4 product integrations | Ingestion enabled and configured; every ACTIVE integration has an owner approval | Product owner tested the outbox integration |

Thresholds come from the M9 `MAIL_ALERT_*` settings. They are initial values;
no historical stability data exists yet.

## 6. Deployment sequence

Every step needs the approvals listed in the final report. None was performed
here.

1. Review and merge the PR stack in order (integration, M7, M8, M9, M10) into
   `staging`. This needs owner approval.
2. Staging DB: take a verified backup, then apply manual migrations 29–33
   with `db:admin:prepare` (ledger-tracked), under owner approval.
3. Deploy the staging API and web with every Mail flag unchanged and with
   `MAIL_ROLLOUT_ENFORCED=true`.
4. Run the S0 gates on staging. Run `mail:backup:verify` and
   `mail:rollback:drill` against disposable copies.
5. Configure staging-only secrets in the secret manager, then:
   - verify core queues are running under Mail backend flags (no rollout ALLOW rules required);
   - create the staging pilot cohort and ALLOW rule;
   - run the live canary against staging (operator, with a change ticket).
6. Repeat 1–5 for production with production secrets, KMS and S3. Optional staff/marketing/product capabilities still require explicit rollout approval. Core queues run when enabled by backend configuration; validate inbound ownership, domain verification and mailbox routing before release.
7. Progress S1 → S4 only when each stage's automated gates pass **and** its
   manual sign-offs are recorded.

## 7. Rollback

- **Fastest:** activate a DB emergency stop (immediate). Revoking the ALLOW
  rules or the WORKER rules is also immediate.
- **Configuration:** turn off the M7–M10 flags. The code then falls back to
  M6 behavior.
- **Schema:** `docs/sql/cosmicforge-mail-m7-m10-rollback.sql`, newest
  section first. Take a verified backup first, and export run, alert and
  integration history if it must be kept. If M10 tables are dropped while
  M10 code is deployed, set `MAIL_ROLLOUT_ENFORCED=false` first.
- **Drill:** `npm run mail:rollback:drill` (also in CI). It builds a
  disposable replay DB, seeds M7–M10 rows, and runs the rollback SQL.
  - It checks that every M7–M10 table and type is gone and that M1–M6 tables
    and rows are intact.
  - It then re-applies migrations 29–33 and checks for no drift.
  - Result: `ok: true`, 5 migrations re-applied, drift `none`.

## Configuration and schema

- Migration: `20261030_mail_m10_rollout.sql` (number 33).
- Tables: `mail_rollout_cohorts`, `mail_rollout_cohort_members`,
  `mail_rollout_rules`, `mail_emergency_stops`. There are partial unique
  indexes for one active rule per scope, one active membership, and one active
  stop per scope.
- New step-up purpose: `MAIL_ROLLOUT_CHANGE`.
- Env: `MAIL_ROLLOUT_ENFORCED` (see `.env.example`).
