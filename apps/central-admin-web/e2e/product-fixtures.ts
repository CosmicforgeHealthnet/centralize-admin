// Product Admin gateway mocks (GET /api/products, capabilities, resources,
// operations) in the shapes PIC and the Product Admin really send:
//  - GET /api/products: { success, data: { products } };
//  - every other product route: the protocol response envelope.
import { createHash } from "node:crypto";
import type { MockReply } from "./fixtures";

export const CF_SCOPE = { market: ["NG"], organization: ["cfmeet"], zone: ["production"], tenant: ["tenant-alpha"] };

export const cfmeetProduct = {
  product_id: "cfmeet",
  display_name: "CF Meet",
  available: true,
  reason: null,
  lifecycle_status: "ENABLED",
  contract_revision: 3,
  protocol: { major: 1, minor: 1 },
  effective_scope: CF_SCOPE,
  role: "cfmeet.verification.reviewer",
  capability_states: { READ_ONLY: 2, AVAILABLE: 4 },
  datasets: [],
  navigation: { section: "products", key: "cfmeet", label: "CF Meet" },
};

export const productsReply = (products: unknown[]): MockReply => ({ status: 200, body: { success: true, data: { products } } });

let seq = 0;
export function envelope(result: unknown, over: Record<string, unknown> = {}): MockReply {
  seq += 1;
  return {
    status: 200,
    body: {
      contract_version: "1.1",
      product_id: "cfmeet",
      correlation_id: `corr-e2e-${String(seq).padStart(6, "0")}`,
      as_of: "2026-11-21T09:00:00.000Z",
      freshness: "FRESH",
      coverage: "COMPLETE",
      result,
      error: null,
      ...over,
    },
  };
}

export function envelopeError(status: number, code: string, reason: string, operationId?: string): MockReply {
  return {
    status,
    body: {
      contract_version: "1.1",
      product_id: "cfmeet",
      correlation_id: "corr-e2e-refused",
      as_of: null,
      freshness: "UNKNOWN",
      coverage: "UNKNOWN",
      result: null,
      error: { code, reason, retryable: false, ...(operationId ? { operation_id: operationId } : {}) },
    },
  };
}

type Cap = { id: string; kind: "READ" | "COMMAND"; state: string; risk: string; two?: boolean; blockers?: { code: string; detail: string }[] };
const capability = (c: Cap) => ({
  id: c.id, version: "1.0.0", kind: c.kind, state: c.state, risk: c.risk, description: c.id, datasets: [], blockers: c.blockers ?? [],
  requires_recent_mfa: true, requires_independent_approval: !!c.two, request_schema: null,
});

export interface CapabilityOptions {
  verification?: string;
  verificationBlockers?: { code: string; detail: string }[];
  governance?: string;
  commands?: string;
}

/** GET /api/products/cfmeet/capabilities result (capabilities + modules, as cfmeet-admin serves it). */
export function cfmeetCapabilities(o: CapabilityOptions = {}) {
  const cmd = o.commands ?? "AVAILABLE";
  const readOnly = (o.verification ?? "READ_ONLY") === "READ_ONLY" ? "READ_ONLY" : "BLOCKED_DEPENDENCY";
  return {
    capabilities: [
      capability({ id: "cfmeet.verification.read", kind: "READ", state: o.verification ?? "READ_ONLY", risk: "R1", blockers: o.verificationBlockers }),
      capability({ id: "cfmeet.governance.read", kind: "READ", state: o.governance ?? "READ_ONLY", risk: "R1" }),
      capability({ id: "cfmeet.governance.approval.propose", kind: "COMMAND", state: "AVAILABLE", risk: "R2" }),
      capability({ id: "cfmeet.governance.approval.decide", kind: "COMMAND", state: "AVAILABLE", risk: "R2" }),
      capability({ id: "cfmeet.governance.approval.revoke", kind: "COMMAND", state: "AVAILABLE", risk: "R2" }),
      capability({ id: "cfmeet.verification.case.claim", kind: "COMMAND", state: cmd, risk: "R2" }),
      capability({ id: "cfmeet.verification.app-review.approve", kind: "COMMAND", state: cmd, risk: "R4", two: true }),
      capability({ id: "cfmeet.verification.app-review.reject", kind: "COMMAND", state: cmd, risk: "R4", two: true }),
      capability({ id: "cfmeet.verification.app-review.publish", kind: "COMMAND", state: cmd, risk: "R4", two: true }),
      capability({ id: "cfmeet.verification.partner-go-live.approve", kind: "COMMAND", state: cmd, risk: "R4", two: true }),
      capability({ id: "cfmeet.verification.partner-go-live.reject", kind: "COMMAND", state: cmd, risk: "R4", two: true }),
      capability({ id: "cfmeet.verification.partner-go-live.suspend", kind: "COMMAND", state: cmd, risk: "R4", two: true }),
    ],
    modules: [
      {
        module: "verification", title: "Verification Administration", read_capability_id: "cfmeet.verification.read", rules: [], inventory_capabilities: 13,
        collections: ["verification.cases.list", "verification.cases.read", "verification.case-history.list"].map((id) => ({ collection_id: id, detail: id !== "verification.cases.list", exposure_state: readOnly, privacy: "INTERNAL", risk: "R1" })),
        commands: [],
      },
    ],
  };
}

export function operationView(operationId: string, capabilityId: string, status: string, extra: Record<string, unknown> = {}) {
  const known = ["SUCCEEDED", "FAILED", "REJECTED"].includes(status);
  return {
    operation_id: operationId, capability_id: capabilityId, status, reason_code: null, created_at: "2026-11-21T09:01:00.000Z", updated_at: "2026-11-21T09:01:01.000Z",
    executed: status === "SUCCEEDED", outcome_known: known, source_status: null, source_version: null, evidence: null, approval_ref: null, ...extra,
  };
}

/** Escaped, anchored path pattern (paths may hold dots and colons). */
export const path = (p: string) => new RegExp("^" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");

// Reference digest, written independently of the app (same rules as
// packages/admin-contracts canonical.js and cfmeet-admin operations/service.js).
function canonical(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

export function referenceIntentDigest(command: { capability_id: string; target: unknown; params: { body: unknown }; scope: Record<string, string[]> }, staff: string) {
  const one = (d: string) => (Array.isArray(command.scope[d]) && command.scope[d].length === 1 ? command.scope[d][0] : null);
  const intent = { capability: command.capability_id, target: command.target, body: command.params.body, scope: { market: one("market"), organization: one("organization"), zone: one("zone"), tenant: one("tenant") }, staff };
  return "sha256:" + createHash("sha256").update(canonical(intent)).digest("hex");
}
