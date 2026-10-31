# Coding Agent Instructions

Read and follow [AGENTS.md](AGENTS.md) before planning, editing, testing, committing, or releasing changes.

**Mandatory owner workflow:** Complete each scoped work package on `staging`, run its required validation, commit task-only changes, push to `origin/staging`, and verify the remote SHA before reporting the task complete. Never change `main` or production without a separate explicit instruction. Respect actual GitHub checks/review gates and report any blocked push instead of pretending the task was delivered.

Preserve unrelated work, existing services and authorization boundaries. Use GitHub Actions—not direct coding-agent VPS access—for deployment. The full rules, including security and end-of-work evidence, are in [AGENTS.md](AGENTS.md).
