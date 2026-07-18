# Social Operations Dependency Risk Register

Current residual advisories:

| Advisory ID | Severity | Packages | Runtime classification | Current action |
| --- | --- | --- | --- | --- |
| `GHSA-92pp-h63x-v22m` | Moderate | `@hono/node-server`, `@prisma/dev`, `prisma` | Prisma CLI/toolchain transitive path; Social Operations runtime does not use Hono `serveStatic` | Baseline and monitor; do not force downgrade Prisma |

Policy files:

- `scripts/security/npm-audit-risk-baseline.json`
- `scripts/security/check-npm-audit-policy.js`

Commands:

- `npm run security:audit-policy`
- `npm run security:audit-policy:production`

The available `npm audit fix --force` path would install `prisma@6.19.3`, which is an incompatible downgrade for this repository. That fix is intentionally not applied.

Review deadline: 2026-08-18.
