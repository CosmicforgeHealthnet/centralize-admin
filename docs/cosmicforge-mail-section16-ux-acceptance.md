# CosmicForge Mail — Section 16 UX Acceptance

**Review date:** 2026-10-26
**Specification:** `CosmicForge_Mail_Implementation_Specification.pdf`, Section 16
**Repository / branch:** `CosmicforgeHealthnet/centralize-admin`, `staging`
**Base:** `05d23695cfa6ea52376c77c03806d1e7549f0a57` (matched `origin/staging` at last fetch)
**Published / tested UI code head:** `4debf946099514aa807159a14637863af05cbc75` (the later acceptance-report update is documentation-only).

## Result

**SECTION 16 CODE COMPLETE — MANUAL ACCEPTANCE PENDING** for the frontend changes in this review. The app builds, the full offline browser suite passes, responsive screenshots were inspected, and modified files pass focused lint. The staging frontend is published to its separate Vercel staging project. The VPS API was not deployed or restarted by this push. This is not end-to-end production-data certification; manual screen-reader review remains outstanding.

### Deployment safety and Vercel behavior

The previous workflow ran its SSH/image/recreate jobs on every staging push. `.github/workflows/staging.yml` now classifies the exact base-to-head commit range with `infrastructure/scripts/staging-api-change-scope.sh`. Only `services/central-admin-api/**`, `Dockerfile` or `.dockerignore` source/build inputs can set `api_changed=true`; docs, test paths/names, frontend paths and workflow edits are ignored. Renames are disabled for diff classification so a moved/deleted backend source file is not hidden. Invalid/missing SHAs and non-ancestor ranges fail classification closed. The workflow modification plus Section 16 frontend changes therefore classifies false. All three privileged jobs (`verify-staging-ssh`, `build-staging-image`, `deploy-staging-api`) explicitly require a successful classifier result, successful backend verification and staging ref. Manual backend dispatch remains available only with the staging ref and a required full `api_release_base_sha` input; a separately approved backend-source push follows the existing verification/deployment path.

The classifier test suite passes frontend-only, docs-only, API tests-only, workflow-only, workflow-plus-frontend, backend-source, migration, Dockerfile, `.dockerignore`, mixed-change, and malformed-SHA cases. `actionlint` v1.7.12 passes. On the actual Section 16 push and the final guarded head, GitHub logged `api_changed=false` and marked all three staging API jobs skipped. GitHub's actual `Staging` environment still has `protection_rules=[]` and `can_admins_bypass=true`; the frontend-only gate is the job condition, which skips SSH before the job can access the environment or secret. Backend-source staging pushes remain governed by the existing verified CI deployment path.

Vercel's authenticated project inventory shows a separate `centralize-admin-staging` project and staging-domain alias, distinct from the main `centralize-admin` project and its production domain. The staging project automatically deployed commit `4debf946099514aa807159a14637863af05cbc75` and reports it `READY`. The separate main project has no deployment for this SHA. This is the requested staging frontend publication; it did not deploy the staging API or touch the main Vercel project.

## 1. Design changes and visual review

| Screen / area | Previous issue | Change and evidence | Responsive / interaction result |
|---|---|---|---|
| Mail shell and navigation | Weak page hierarchy; narrow-screen folder navigation did not behave as a focused drawer. | Added a clearer Mail identity/header, empty-reader guidance and shortcuts, semantic folder dialog, focus entry/trap, Escape dismissal and focus restoration. Reused the existing sidebar and entitlements. [Desktop inbox](./cosmicforge-mail-section16/evidence/mail-inbox-desktop-chromium.png) · [Mobile inbox](./cosmicforge-mail-section16/evidence/mail-inbox-mobile-chromium.png) · [Mobile folder drawer](./cosmicforge-mail-section16/evidence/mail-folder-drawer-mobile-mobile-chromium.png) | Single-pane mobile flow; drawer keyboard behavior is covered by Playwright. |
| Conversation list | Small targets and compressed text/action hierarchy. | Improved row spacing, unread/selected emphasis, focus styles and toolbar targets while retaining selection, bulk actions and pagination. [Desktop inbox](./cosmicforge-mail-section16/evidence/mail-inbox-desktop-chromium.png) | 390px mobile view and 320–1440px compose reflow checks; the inbox/list itself was browser-checked at 390px. |
| Conversation reader | Dense header/actions and weak separation between thread messages. | Improved subject/action hierarchy, message headers, metadata and readable body spacing. Existing safe HTML rendering and remote-image blocking remain in place. [Desktop thread](./cosmicforge-mail-section16/evidence/mail-thread-desktop-chromium.png) · [Mobile thread](./cosmicforge-mail-section16/evidence/mail-thread-mobile-chromium.png) | Reader occupies the active mobile pane and preserves long-message scrolling. |
| Compose | Sender/recipient controls crowded at phone width; unclear save/send affordances. | Refined quick/full compose hierarchy, recipient wrapping, sender rows, focus on reply recipient, save status, busy state and safe-area-aware wrapping footer. Autosave/conflict behavior and honest queued messaging remain connected to existing APIs. [Desktop full compose](./cosmicforge-mail-section16/evidence/mail-full-compose-desktop-chromium.png) · [Mobile full compose](./cosmicforge-mail-section16/evidence/mail-full-compose-mobile-chromium.png) · [Mobile quick compose](./cosmicforge-mail-section16/evidence/mail-quick-compose-mobile-chromium.png) · [320px compose](./cosmicforge-mail-section16/evidence/mail-compose-320px-mobile-chromium.png) | No horizontal overflow at 320, 375, 390, 768, 1024, 1280 and 1440 CSS px in the compose viewport sweep. |
| Search and preferences | Filter inputs and preference sections were visually dense. | Improved input/filter layout, clearable applied-filter context and settings section spacing. [Mobile search](./cosmicforge-mail-section16/evidence/mail-search-mobile-chromium.png) · [Mobile settings](./cosmicforge-mail-section16/evidence/mail-settings-mobile-chromium.png) | Existing mailbox-scoped search and preference APIs retained; desktop/mobile screenshots captured. |
| Shared Support queue | Shared-work context was not prominent enough in the mail view. | Captured the existing team queue with assignment/status context and retained permission-denied coverage. [Mobile queue](./cosmicforge-mail-section16/evidence/mail-support-queue-mobile-chromium.png) | Works as a distinct shared queue; no Help ticketing replacement was introduced. |
| Email Marketing | Mobile section links clipped after part of “Contacts & consent”, obscuring later destinations. | Changed the section strip to wrap instead of requiring an undisclosed horizontal swipe; added a no-overflow assertion. Existing brand scope and disabled execution state remain explicit. [Desktop overview](./cosmicforge-mail-section16/evidence/marketing-overview-desktop-chromium.png) · [Mobile overview](./cosmicforge-mail-section16/evidence/marketing-overview-mobile-chromium.png) | All seven destinations are visible on mobile without horizontal overflow. Campaign, template and automation flows retain existing workflow-oriented UI. [Campaign preflight](./cosmicforge-mail-section16/evidence/marketing-campaign-preflight-mobile-chromium.png) · [Template QA](./cosmicforge-mail-section16/evidence/marketing-template-qa-mobile-mobile-chromium.png) · [Automation test mode](./cosmicforge-mail-section16/evidence/marketing-automation-test-mode-mobile-chromium.png) |
| IT Mail administration | Dense administrative data and multi-section controls. | Existing administration experience was preserved and covered with responsive screenshots and permission checks; credentials remain server-side. [Mobile domains](./cosmicforge-mail-section16/evidence/it-mail-administration-domains-mobile-chromium.png) · [Mobile audit](./cosmicforge-mail-section16/evidence/it-mail-administration-audit-mobile-chromium.png) | Table content remains within its local scroll region; full administrative usability with an assistive technology remains unreviewed. |
| Loading, empty and service error | Needed stronger distinction between an empty mailbox and an unavailable service. | Kept explicit permission/error boundaries and verified empty and 503 states separately. [Empty](./cosmicforge-mail-section16/evidence/mail-empty-mobile-chromium.png) · [Service error](./cosmicforge-mail-section16/evidence/mail-service-error-mobile-chromium.png) | Retry/error messages are rendered as states rather than false empty results. Offline draft persistence was not certified. |

All 22 screenshots under [`docs/cosmicforge-mail-section16/evidence`](./cosmicforge-mail-section16/evidence) use deterministic synthetic API fixtures, not customer inbox data. They are viewport captures from Playwright Chromium at 1440×900 desktop and 390×844 mobile (device scale factor 2); the compose no-overflow test additionally resizes across the listed widths. The browser was used to inspect layout, clipped content, spacing, focus and responsive behavior. The campaign and IT screenshots show the actual viewport at the test's current scroll position, not stitched full-page composites.

## 2. Section 16.1 placement audit

| Workspace integration | Existing placement retained / verified |
|---|---|
| Dashboard shell and navigation | Existing dashboard header, theme, authentication, role grants and dashboard route layout remain authoritative. The breadcrumb now identifies Mail and Email Marketing context. |
| Employee Mail | Existing routes under `/dashboard/mail`, `MailShell`, mailbox switcher, `InboxList`, `ThreadDetail` and `ComposeEditor` reused. No duplicate mailbox application was introduced. |
| Personal preferences | Existing `/dashboard/mail/settings` and `MailPreferences` retained and refined. |
| HR mailbox provisioning | Existing HR mailbox request card and provisioning approval flow retained; existing desktop Playwright scenarios pass. |
| IT administration | Existing `/dashboard/it` Mail Administration tabs and source-backed operations retained; existing authorization/2FA tests pass. |
| Help email | `/dashboard/help/email` remains a valid route. Shared Support mailbox queue remains separate from the existing Help ticketing/chat workflows. |
| Marketing | Existing `/dashboard/marketing/email-marketing` routes, shell, templates, campaign approvals, preflight, analytics and automation reused. No marketing execution engine or second marketing application was introduced. |

## 3. Section 16.2 acceptance matrix

| Requirement | Implementation / evidence | Desktop | Mobile | Accessibility | Result |
|---|---|---|---|---|---|
| Three-pane desktop | Mail shell keeps navigation, thread list and reader as independent panes; desktop inbox/thread captures. | Browser screenshot and interaction pass | — | Semantic navigation/landmarks; axe pass | PASS |
| Single-pane mobile | Mail shell changes active pane and opens folders as a dialog. | — | 390px captures; no horizontal scroll for the inbox journey | Drawer focus trap, Escape and focus restoration tested | PASS |
| Quick/full compose | Existing quick and full editor modes retained, visually tuned. | Both rendered | Both rendered; 320px reflow | Controls use labels/focus styling | PASS |
| Draft autosave | Existing revisioned autosave and conflict handling retained. | E2E save and conflict scenario | Same browser suite on mobile | Live status remains available | PASS (mock API) |
| Loading/error/offline | Loading, forbidden, missing migration, empty and service-error states remain explicit; service failure is not mapped to empty results. | Existing tests | Mobile error/empty captures | axe coverage | PARTIAL — offline draft persistence and recovery were not tested/certified |
| Keyboard / screen reader | Keyboard reply path, attachment and queued send tested; drawer focus lifecycle tested. axe/WCAG automated suite passes on Mail, settings, operations/integrations and IT Mail Admin. | Automated keyboard/axe | Automated keyboard/axe | No manual screen-reader audit or full keyboard-only critical journey was performed. | PARTIAL — manual acceptance pending |
| Attachments | Existing upload path exercised with a synthetic file; attachment appears before sending. | Existing and new E2E | Mobile keyboard flow | Labels/focus checked in axe-covered screens | PASS (mock API) |
| Shared sender identity | Existing server-authorized sender selection and denied sender cases retained. | Existing E2E pass | Existing E2E pass | Permission boundaries tested | PASS (mock API) |
| Read / star / archive / bulk state | Existing individual thread state and bulk action controls retained. | Rendered and API wiring inspected | Touch-sized bulk controls | Labels and focus styles present | PARTIAL — this review did not add end-to-end coverage for each bulk action |
| Honest delivery states | Existing test verifies 202 is “queued” and is not “delivered”; unknown outcome tests remain. | Existing E2E pass | Existing E2E pass | Status is announced in page | PASS (mock API) |
| Privacy and search | Existing mailbox-scoped search, denied mailbox/thread boundaries and safe HTML with remote images blocked retained. New screenshot covers filter UI. | Existing tests pass | Search screenshot and responsive browser pass | axe and auth-denial assertions pass | PASS (mock API) |
| Shared Support | Existing assignment, queue and revoked-member views remain. | Existing E2E pass | Screenshot captured | axe covers operational/product integration region | PASS (mock API) |
| Settings / HR / IT | Existing personal preference, HR provisioning, IT domains, audit and sensitive-operation flows remain. | Existing E2E pass | Settings/IT captures and admin scenarios | axe passes on Mail settings and IT Mail Admin | PASS (mock API) |
| Marketing integration | Existing campaign approval, test/replay and QA flows retained; seven section tabs wrap on mobile. | E2E and screenshot | E2E, screenshot and no-overflow assertion | axe coverage for integrations; manual workflow audit pending | PASS for UI integration (mock API) |
| 320/375/390/768/1024/1280/1440 reflow | Explicit viewport sweep on compose; inbox/mobile coverage at 390; Marketing nav at 390. | 1024/1280/1440 compose | 320/375/390/768 compose | Zoom/reflow manual review pending | PARTIAL — sweep is not every page at every width |
| Performance | No new heavy UI library; panels retain current queries/pagination. | — | — | — | NOT MEASURED — no performance budget comparison was run |

## 4. Test and integration evidence

| Check | Result |
|---|---|
| `NEXT_PUBLIC_API_URL=http://localhost:4999 npm run build` | PASS; Next.js 16.1.6 production build, TypeScript and route generation completed. |
| `npx tsc --noEmit` | PASS. A subsequent production build also ran TypeScript after the final source adjustment. |
| Full `npm run lint` | PASS, 0 errors; 199 repository-wide warnings reported. |
| Focused ESLint on all changed source and E2E files | PASS, 0 errors and 0 warnings after the focus-restoration cleanup. |
| Full `npm run test:e2e` | PASS on rebuilt candidate: 161 passed, 17 project-conditional skips; 178 total, 1.6 minutes. Offline deterministic API fixtures. |
| Final focused `npx playwright test e2e/section16-visual.spec.ts` | PASS: 13 passed, 1 intentional desktop width-sweep skip. |
| Accessibility automation | PASS in the full suite: axe rules covering WCAG 2.0/2.1 A/AA on inbox, preferences, operations/integrations and IT Mail Admin. |
| Staging API path classifier | PASS: all 10 path/SHA scenarios in `infrastructure/scripts/test-staging-api-change-scope.sh`; actual candidate range also reports `api_changed=false`. |
| Workflow syntax / expressions | PASS: `actionlint` v1.7.12 on `.github/workflows/staging.yml`. |
| Manual keyboard / screen-reader review | NOT PERFORMED. Keyboard journey coverage is automated but partial; a human assistive-technology run remains required. |
| Backend/API compatibility | No API contracts, backend files, migrations or endpoints changed. UI/API tests used deterministic mocks; no live staging backend was exercised. |
| Staging API deployment guard | PASS on the original Section 16 push `04f0ef61...` and final code head `4debf946...`: scope classifier succeeded with `api_changed=false`; `verify-staging-ssh`, `build-staging-image` and `deploy-staging-api` were all skipped. No Actions SSH, image publication or container recreation ran. This confirms this push did not restart or replace the API container; separate out-of-band VPS activity is not observable through the repository workflow. |
| Frontend CI | PASS on exact UI code head `4debf946099514aa807159a14637863af05cbc75`: [lint/typecheck/build and Mail E2E run](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40351828963). E2E uses mocked APIs. |
| Staging API / backend CI | PASS: [staging workflow run](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40351749983) completed verification and skipped its three privileged jobs; [Social Operations CI](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40351749980) passed. |
| Monorepo / container compatibility CI | PASS: [layout and local compatibility image build](https://github.com/CosmicforgeHealthnet/centralize-admin/actions/runs/40351750076). The image was not pushed or deployed. The first attempt at `04f0ef61...` failed the layout rule because new files occupied the reserved root `scripts/` path; moving them into `infrastructure/scripts/` fixed it, and the final-head run passed. |
| Vercel / staging frontend | PASS: deployment [`dpl_FXVRbwxsGSfdNmX9v6iCeAHkEQ8M`](https://vercel.com/cosmicforgedevteamgmailcoms-projects/centralize-admin-staging/FXVRbwxsGSfdNmX9v6iCeAHkEQ8M) for `4debf946...` is `READY` in the separate `centralize-admin-staging` project. No main-project deployment for this SHA. |
| Current branch state | `origin/staging` matched `4debf946099514aa807159a14637863af05cbc75` at verification; the report evidence update is a documentation-only follow-up. |

### Changed contracts and migrations

- API routes, OpenAPI, schemas and capability registry: **no changes**.
- Database/backend migrations: **none**.
- Modified frontend files are Mail shell/list/reader/compose/search/preferences, dashboard breadcrumb, Email Marketing navigation, and E2E screenshot/accessibility evidence helpers/specs.

### Outstanding acceptance items

1. Complete a human keyboard-only critical journey and a manual screen-reader review with an appropriate assistive-technology setup.
2. Verify offline draft persistence/recovery and end-to-end individual/bulk read, star, archive and trash actions against an authorized staging test mailbox.
3. Perform real-user usability review and page-wide viewport checks beyond the explicit compose width sweep.

No Admin capability, Mail sending, DNS, shared database migration, production service or production data was enabled or modified.
