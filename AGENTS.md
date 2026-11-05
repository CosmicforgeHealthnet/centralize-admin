# Coding Agent Instructions — Centralized Admin

These instructions apply to the entire repository and all coding agents working on it.

## Branch and delivery policy (owner instruction, 31 October 2026)

**STAGING-FIRST.** All new coding, fixes, documentation, migrations, tests, and integrations must target `staging`. Do not push to, merge into, deploy from, or modify `main` or production unless the owner separately and explicitly authorizes that change.

**PUSH AT THE END OF EVERY WORK PACKAGE.** A task is not delivered just because the files have changed locally. After finishing the requested work:
1. Review the current working tree and preserve unrelated/uncommitted changes, including work from other agents.
2. Fetch the latest `origin/staging`; reconcile concurrent upstream commits safely. Never force-push, reset, or overwrite others' work.
3. Run the relevant tests, lint, schema validation, security checks, and build gates. Fix regressions before publishing. Record external/unavailable checks as blockers, not passes.
4. Commit only task-scoped changes and **push the completed work to `origin/staging`**. Use a normal fast-forward push whenever repository permissions allow.
5. If repository rules require a pull request, use the permitted workflow and merge the approved, green work into `staging` before calling the task delivered. Do not bypass checks or independent review requirements.
6. Verify the actual remote `staging` commit SHA and applicable GitHub Actions results; report the final SHA, push/merge status, test evidence, and any remaining blockers.

Do not silently leave finished work only in a local branch, unpushed worktree, draft PR, or feature branch. If a push/merge is genuinely blocked by permissions, conflicting changes, mandatory reviews, or failing checks, complete all safely possible work and **report the exact blocker**; never claim delivery or fabricate success.

## Architecture and safety constraints

- Centralized Admin is the Headquarters control plane. Product Admins are independent services. Headquarters communicates with product-admin services, never directly with their source bridges, source databases, or operational microservices.
- `karryam-admin` is the independent admin for the product **Karryam**. The legacy `KarryGo` name may appear only in existing repository names and technical paths. Karryam Admin is the only Centralized Admin component allowed to communicate with the private Karryam Backoffice Bridge.
- Preserve the existing UI, dashboard, sidebar, Logistics, HealthNet, Mail, Marketing, authentication, and working routes unless the current task explicitly requires a scoped change.
- Preserve the existing private network and trust boundaries, real staff/scope authorization, audit, source-of-truth decisions, and fail-closed policy. No unapproved domain writes, source database access, fake records, or public Bridge endpoints.
- Use approved GitHub Actions for staging deployment. Coding agents must not use direct VPS SSH or unapproved production credentials. Staging code push does **not** imply permission to activate services, perform destructive migrations, enable write capabilities, or bypass release gates.
- Never commit secrets, live keys, certificates with private keys, passwords, tokens, or protected environment files.

## End-of-task report

For every completed work package, report: what changed; files/services affected; tests and CI results (including skips); current `staging` SHA; whether staging was actually deployed; whether production was untouched; and any operator-only or external acceptance gates still pending.
