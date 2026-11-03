# HR department-based access

Employees get their normal department access from their department and role, without any Module Permission grants. Module Permissions (HR → Accounts → Module Permissions) give additional, cross-department or sensitive access.

## How it works

- One resolver: `services/central-admin-api/src/shared/auth/effective-access.js`.
  Effective access = department defaults + explicit grants (`admin_section_grants`).
- Department defaults are computed on every request, never stored. They exist only while the account is `ACTIVE` with a department. Changing department, removing Team Lead status or deactivating the account removes them immediately.
- Role (HR form "Designation / Role"; Job Title is separate and never used for access):
  - **Staff**: `isTeamLead = false`, Employee tier.
  - **Team Lead**: `isTeamLead = true`, Employee tier.
  - **Manager**: Admin tier (or higher) within the department.
- No database migration. Admin-tier and Super behaviour is unchanged.

## Department defaults

| Department | Staff | + Team Lead | + Manager |
|---|---|---|---|
| Every department | `department:directory` VIEW (own department, active colleagues, basic work info) | `department:roster` VIEW (all members and their status) | same as Team Lead |
| Marketing | `marketing:workspace` EDIT | `marketing:workspace-manage` EDIT (delete, status changes, social accounts) | `marketing:intelligence` VIEW |
| Customer Care | `support:tickets` VIEW, `support:chats` VIEW | `support:chats` EDIT | — |
| Finance | `finance:payments` VIEW | — | — |
| Operations | `operations:logistics` VIEW | — | — |
| RTC | `rtc:sessions` VIEW | — | — |
| Telemedicine | `telemedicine:consultations` VIEW | — | — |

These always need an explicit grant: payroll, HR account management, security/admin settings (Mail admin, admin-ops), payment status changes, Email Marketing brands, campaign approval and sending settings.

## Email Marketing

- A brand is always assigned explicitly: Module Permissions → `mail-marketing` → `<brand>` (for example `karryam`). VIEW = view; EDIT = author.
- Marketing Team Leads and Managers can author for the brands assigned to them, even with a VIEW assignment.
- Approval needs its own `approve:<brand>` grant. Campaign approval still requires a reviewer other than the author, plus step-up. Broadcast dispatch and Resend settings are unchanged.
- Wildcard brand grants (`*`, `approve:*`) can only be issued by Super accounts. Brand sections are stored and matched in lower case.

## Module Permissions safety

- Non-Super accounts cannot change their own permissions.
- Syncing permissions keeps unchanged grants as they are (grantor, reason, expiry).
- The account page shows "Effective Access": inherited defaults, additional grants and Email Marketing brands (`GET /api/hrm/accounts/:id/effective-access`).

## Colleague directory

`GET /api/hrm/departments/mine/employees` (or `/:dept/employees` with the caller's own department). HR with `hrm:departments` VIEW keeps the cross-department view. The UI is under Profile → My Department.

## Reconciling existing accounts

Existing employees get their defaults as soon as the release runs. The report flags what HR should review: no department, Team Lead without a department, a job title that suggests leadership (never applied automatically), a Marketing employee without a brand, unknown brand grants, and inactive accounts that still hold grants.

```sh
node scripts/hr/reconcile-department-access.js           # dry run report
node scripts/hr/reconcile-department-access.js --apply   # revoke only fully redundant grants
```

`--apply` revokes only explicit grants that the account's current department defaults already fully cover. It can be re-run safely.

For Enoch (Marketing Team Lead), HR must set Department = Marketing and Designation / Role = Team Lead, then assign the `mail-marketing:karryam` brand.
