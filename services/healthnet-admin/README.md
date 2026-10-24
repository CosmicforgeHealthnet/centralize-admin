# HealthNet Admin — First Product Admin Microservice

**Current state: reserved boundary, not yet an executable service.**

The existing HealthNet administrative API is implemented within `services/central-admin-api/src/modules/healthnet/`. Do not deploy this directory as a product Admin until its isolated runtime, authoritative data contracts and security boundaries are certified.

The staged extraction and cutover gates (H0–H4), inventory, ownership decisions, acceptance tests and rollback conditions are described in [HealthNet Admin microservice extraction plan](../../docs/healthnet-admin-microservice-extraction-plan.md).

**First task:** perform H0 endpoint + dependency inventory and approve HealthNet owner contracts. Do not merely move files and silently reuse Central Admin database credentials, access tokens or RBAC authority. Keep current HQ routes operational during migration. Production/main remain unchanged until explicit release approval.
