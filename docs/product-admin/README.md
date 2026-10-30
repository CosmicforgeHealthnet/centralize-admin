# Product Admin platform (Karryam Admin and Centralized Admin HQ integration)

Implementation of Sections 1–5 of *Karryam Admin and Centralized Admin
Headquarters — Complete Backend Implementation Specification v1.0*.

| Document | Covers |
|---|---|
| [section-1-baseline-audit.md](section-1-baseline-audit.md) | Verified repository, KarryGo bridge and PR #36 baseline |
| [architecture.md](architecture.md) | Sections 2–3: topology, authority boundaries, data access rule, monorepo services, disabled-by-default switches |
| [protocol-v1.md](protocol-v1.md) | Section 4: Universal Product Admin Protocol v1, manifest, datasets, events, compatibility, envelopes, Karryam status |
| [registry-and-onboarding.md](registry-and-onboarding.md) | Section 5: registry database, onboarding, HQ API, navigation contract, synchronization, monitoring, runbook |
| [sections-1-5-implementation-report.md](sections-1-5-implementation-report.md) | Evidence report: completion matrix, test results, external dependencies, verdict |

Code:

- `packages/admin-contracts`, `packages/event-contracts`,
  `packages/identity-and-permissions`, `packages/service-clients`
- `services/karryam-admin` — first real Product Admin
- `services/product-integration-core` — HQ registry, onboarding and sync
- `services/central-admin-api/src/modules/product-gateway` — staff-facing routes
- `infrastructure/product-admin` — operator templates
- `.github/workflows/product-admin-platform-ci.yml` — CI (build/test only)

Everything new is disabled by default. Nothing here certifies a live
staging or production integration.
