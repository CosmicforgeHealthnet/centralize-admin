# HR department-based access

Employees get their normal department access from their department and role, without any Module Permission grants. Module Permissions (HR → Accounts → Module Permissions) give additional, cross-department or sensitive access.

## How it works

- One resolver: `services/central-admin-api/src/shared/auth/effective-access.js`.
  Effective access = department defaults + explicit grants (`admin_section_grants`).
- Department defaults are computed on every request, never stored. They exist only while the account is `ACTIVE` with a department. Changing department, removing Team Lead status or deactivating the account removes them immediately.
- Role (HR form "Designation / Role"; Job Title and Account Tier are separate and never imply a role):
  - **Staff**: default.
  - **Team Lead**: `isTeamLead = true`.
  - **Department Manager**: a role grant `department` / `manage:<DEPARTMENT>` in `admin_section_grants`, written and revoked only through Designation / Role (never through Module Permissions). It applies only while the account is in that department; a department change revokes it.
- **Account Tier is separate.** Admin = Platform Admin (the existing platform-wide privileges, unchanged). A Department Manager on the Employee tier gets no Admin-tier routes. Super is unchanged.
- No database migration.

## Department ownership and leadership access

One registry, `DEPARTMENT_OWNERSHIP` in `effective-access.js`, lists the module sections each department owns and what Staff get. **Team Leads and Department Managers automatically receive full operational access (view, create, edit, delete, manage) to every section their department owns**, with no Module Permission. Backend guards (`requireSection`, `requireTierOrDepartment`, `requireTierOrSection`) and the frontend navigation (`/api/hrm/accounts/me/grants`) both read the resolver, so they cannot disagree. New departmental functionality inherits leadership access by adding its sections with `registerDepartmentOwnership()`.

| Department | Staff | Team Lead / Manager (full) |
|---|---|---|
| Every department | `department:directory` VIEW | + `roster` (Team Lead); + `leaves` VIEW (Manager) |
| Marketing | workspace EDIT, social content/submit EDIT, social analytics/inbox VIEW | workspace-manage, Intelligence (incl. settings), advertising-execution section, all social operations except emergency override and restricted moderation, Email Marketing for authorised brands |
| Social Media | workspace VIEW, social as Marketing staff | all social operations (same exclusions) |
| Customer Care | support tickets/chats VIEW | tickets and chats EDIT |
| Finance | payments VIEW | payments EDIT, payment status changes (recent MFA required below Admin tier) |
| Operations | logistics VIEW | logistics EDIT |
| RTC / Telemedicine | sessions / consultations VIEW | EDIT (Telemedicine also cancels appointments) |
| Verification | providers VIEW | doctor/lab approve, reject, stuck-doctor fixes (reviewer must differ from prior reviewer) |
| HR | attendance, hiring, leaves VIEW | attendance, hiring, leaves, performance EDIT |
| Development, Executive, Management | none implemented yet | none (register when modules exist) |

Never inherited by any department (explicit Module Permission, Platform Admin or Super only): payroll, HR account/permission/tier and leadership-role management, Mail admin, admin-ops/admin settings, advertising execution roles (author/approver/admin/emergency), emergency override and restricted social moderation, customer search and sending settings. Platform-wide Admin-only routes (users, analytics, dashboard, HealthNet, audit, notifications) have no owning department and stay Admin-only. Department Manager, Platform Admin and Super remain separate: a department leader never gets Admin-tier routes, and the Admin tier never implies a department role.

Safeguards that stay where the action happens: mandatory MFA/step-up, campaign and import approval by a reviewer other than the author, social approval governance, verification reviewer separation, advertising approvals, Mail broadcast dispatch gates and Resend settings (untouched; no live bulk sending is activated).

## Email Marketing

- Brands are authorised per department with `MAIL_MARKETING_DEPARTMENT_BRANDS` (default `MARKETING:karryam`; format `DEPT:brand,brand;DEPT2:brand`; empty disables). No migration. Members of an authorised department see and author that brand's campaigns with no `mail-marketing:<brand>` grant; Team Leads and Department Managers also approve for it. Staff cannot approve.
- Brand isolation: a brand not authorised for the department (or granted explicitly) is invisible (404).
- Approval still requires a reviewer other than the author/submitter, a step-up, an unexpired preflight and the dispatch allowlist. Broadcast dispatch activation and Resend settings are unchanged.
- Module Permissions (`mail-marketing` → `<brand>`, `approve:<brand>`) remain for additional or cross-department brands; wildcards are Super-only. Brand sections are stored and matched in lower case.

## Module Permissions safety

- Non-Super accounts cannot change their own permissions.
- Syncing permissions keeps unchanged grants as they are (grantor, reason, expiry).
- The account page shows "Effective Access": inherited defaults, additional grants and Email Marketing brands (`GET /api/hrm/accounts/:id/effective-access`).

## Colleague directory

`GET /api/hrm/departments/mine/employees` (or `/:dept/employees` with the caller's own department). HR with `hrm:departments` VIEW keeps the cross-department view. Department Managers also get `GET /api/hrm/departments/mine/leaves`. The UI is under Profile → My Department.

## Reconciling existing accounts

Existing employees get their defaults as soon as the release runs. The report flags what HR should review: no department, Team Lead without a department, a job title that suggests leadership (never applied automatically), Admin-tier accounts in an operational department (`ADMIN_TIER_IN_DEPARTMENT_REVIEW`: confirm Platform Admin or Department Manager), a Marketing employee without a brand, unknown brand grants, stale manager roles, and inactive accounts that still hold grants. Output is redacted by default; `--match=<name>` shows matching accounts in full.

```sh
node scripts/hr/reconcile-department-access.js           # dry run report
node scripts/hr/reconcile-department-access.js --apply   # revoke only fully redundant grants
```

`--apply` revokes only explicit grants that the account's current department defaults already fully cover. It can be re-run safely.

On staging, the read-only workflow `.github/workflows/hr-access-reconcile-staging.yml` runs the dry run inside the staging API container. It runs on staging pushes that change the script or the workflow (dispatch becomes available once the file exists on the default branch). It prints aggregate counts and, for the `match` input (default `enoch`), access facts only: no names, emails or artifacts.

For Enoch (Marketing Team Lead), HR must verify Department = Marketing and Designation / Role = Team Lead; Karryam then follows from the department brand mapping. His Executive tier and role are never changed automatically.
