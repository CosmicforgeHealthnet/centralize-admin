# CosmicForge Marketing Intelligence Phase 2 Final Acceptance Checklist

## Engineering and architecture

- [x] Initial Git state recorded and existing work preserved.
- [x] WP0-WP12 mapped to actual source, schema, APIs, tests, and documentation.
- [x] Admin Prisma client and existing Task, Notification, WebSocket, scheduler, settings, audit, and event systems reused.
- [x] Phase 1 campaign synchronization remains independently controlled.
- [x] Five provider connector contracts, normalized grains, pagination, refresh, currency, and stable IDs documented.
- [x] No provider campaign/ad/budget/content mutation introduced.
- [x] No FX conversion, forecasting, multi-touch attribution, mandatory LLM, or Phase 3 model introduced.

## Release controls

- [x] `MARKETING_INTELLIGENCE_PHASE2_ENABLED` exists and defaults false.
- [x] Master false prevents every Phase 2 scheduler and operational service.
- [x] Component flags cannot bypass master false.
- [x] Manual Phase 2 mutations receive a stable disabled error.
- [x] Reads, settings, connection preparation/validation, OAuth, and Phase 1 sync remain available under existing policies.
- [x] Approved bootstrap defaults reconciled in the canonical registry and consumers.
- [x] Controlled live-validation CLI requires opt-in, confirmation, provider, UUID, account, and bounded dates.
- [x] CLI refuses `NODE_ENV=test` and uses read-only adapters.
- [x] Machine-readable status contains no credentials or raw provider bodies.

## Data, security, and quality

- [x] Attribution, adjustments, currency, stable identity, dedupe, lifecycle, and transactional idempotency tested.
- [x] Credentials/raw provider payloads excluded from APIs, logs, summaries, documentation, and live artifacts.
- [x] Migrations remain ordered, additive, manifest-controlled, and replayable.
- [x] Applicable repository-defined quality commands executed successfully.
- [x] Markdown architecture contains the required 30 sections and 14 Mermaid diagrams.
- [x] DOCX architecture generated as valid OOXML with rendered diagram equivalents.
- [x] Release runbook, live matrix, risk register, rollout, troubleshooting, and acceptance artifacts exist.

## External live acceptance

- [ ] META live gate passed and approved.
- [ ] TIKTOK live gate passed and approved.
- [ ] X live gate passed and approved.
- [ ] LINKEDIN live gate passed and approved.
- [ ] GOOGLE_ADS live gate passed and approved.
- [ ] Five-platform Stage 6 release approved.

## Current verdict

`PHASE2_ENGINEERING_COMPLETE_LIVE_VALIDATION_PENDING`

Stage 1 dark launch is the maximum approved posture until deployment ownership repeats release gates in the target environment. Each later stage is connection/platform-specific and requires its documented exit criteria. Full five-platform release must not be claimed until all five live gates are recorded as passed.
