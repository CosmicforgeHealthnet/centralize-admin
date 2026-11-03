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

## Department defaults

| Department | Staff | + Team Lead | + Manager |
|---|---|---|---|
| Every department | `department:directory` VIEW (own department, active colleagues, basic work info) | `department:roster` VIEW (all members and their status) | `department:leaves` VIEW (own department's leave requests, read-only; approval stays with HR) |
| Marketing | `marketing:workspace` EDIT | `marketing:workspace-manage` EDIT (delete, status changes, social accounts) | `marketing:intelligence` VIEW |
| Customer Care | `support:tickets` VIEW, `support:chats` VIEW | `support:chats` EDIT | — |
| Finance | `finance:payments` VIEW | — | — |
| Operations | `operations:logistics` VIEW | — | — |
| RTC | `rtc:sessions` VIEW | — | — |
| Telemedicine | `telemedicine:consultations` VIEW | — | — |

These always need an explicit grant: payroll, HR account management, security/admin settings (Mail admin, admin-ops), payment status changes, Email Marketing brands, campaign approval and sending settings.

## Email Marketing

- A brand is always assigned explicitly: Module Permissions → `mail-marketing` → `<brand>` (for example `karryam`). VIEW = view; EDIT = author.
- Marketing Team Leads and Department Managers can author for the brands assigned to them, even with a VIEW assignment.
- Approval needs its own `approve:<brand>` grant. Campaign approval still requires a reviewer other than the author, plus step-up. Broadcast dispatch and Resend settings are unchanged.
- Wildcard brand grants (`*`, `approve:*`) can only be issued by Super accounts. Brand sections are stored and matched in lower case.

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

For Enoch (Marketing Team Lead), HR must set Department = Marketing and Designation / Role = Team Lead, then assign the `mail-marketing:karryam` brand.
