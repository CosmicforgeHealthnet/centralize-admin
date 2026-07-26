# Advertising Execution backend architecture

Status: Sections 6-28 implemented locally on `staging`; provider writes remain disabled.

The module is mounted once at `/api/v1/marketing/advertising-execution` from `src/app.js`. Requests flow through bearer authentication, Marketing section RBAC, action-specific execution roles, bounded rate limits, strict DTO inspection, a thin controller, the production service/repositories, and the Admin Prisma client. Controllers never resolve credentials, call provider mutation methods, or enqueue in-memory work.

Plan mutations preserve a versioned desired state. Validation runs the ordered transport, domain, capability, business-policy, provider-preflight, approval-integrity and execution-precondition pipeline as applicable. Provider preflight is read-only and outside database transactions. A successful validation creates an immutable packet bound to the plan version and SHA-256 fingerprint. Approval decisions are append-only, scoped to that packet, and cannot be supplied by the sole author. Queueing only creates or returns a durable run, operations and job; the endpoint makes no provider request.

Provider writes are reachable only from the execution worker after the master, provider, connection, dry-run, lease, account lock, policy, approval, capability, idempotency and precondition gates pass. Unknown outcomes enter reconciliation and cannot be blindly retried. Human retry review creates a durable retry job without calling the provider. Compensation always creates a new DRAFT linked to the original plan/run/operation.

Creative publication validates source ownership, normalized copy, MIME/signature/metadata, malware policy, destination HTTPS/domain/SSRF/redirect rules, UTM and accessibility before atomically allocating a revision. The controller does not upload to an advertising provider.

The execution and reconciliation workers are constructed on module composition but start only from `src/server.js` when explicitly enabled. Importing the module never starts a worker. Graceful shutdown stops workers before database disconnect.

Security boundaries: existing connection credential storage is reused; credentials are resolved only inside provider adapter contexts; normalized DTOs and response mappers reject or remove credential-like fields, raw provider bodies, signed URLs, internal paths and lease owners. Historical approvals, validation packets, validation issues, snapshots, reconciliations, drift acknowledgments, retry reviews and policy history use restrictive foreign keys and append-only database triggers.
