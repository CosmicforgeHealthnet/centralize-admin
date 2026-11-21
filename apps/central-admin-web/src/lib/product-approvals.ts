// Two-person approvals of governed product commands (design §5 / §10),
// product-neutral. A high-risk command is never sent until a second staff
// member approved its exact intent:
//
//   1. the requester builds the real command ONCE (its command_id is also the
//      source operation id inside the body) and computes its intent digest;
//   2. `<product>.governance.approval.propose` records the digest, the target,
//      the reason and the exact scope (no body is stored);
//   3. a different staff member decides it (`...approval.decide`);
//   4. the requester sends the SAME command with `params.approval_ref`.
//
// The Product Admin recomputes the digest on run, so it must be computed
// exactly as services/cfmeet-admin/src/operations/service.js does:
//   digestOf({ capability, target, body, scope: {market, organization, zone,
//   tenant} (one value each or null), staff: <HQ staff id> })
// with digestOf = "sha256:" + hex(sha256(canonical JSON)) from
// packages/admin-contracts/src/canonical.js (keys sorted, no whitespace,
// undefined dropped, null kept).

import { buildOperationCommand, toProductApiError, type ProductApiError } from "@/lib/products.service";
import type { BridgeCommandParams, CommandScope, OperationCommand, OperationView, RiskLevel } from "@/types/products.types";

// ── Canonical digest (port of admin-contracts canonical.js) ───────

/** Canonical JSON: object keys sorted by code point, no whitespace, undefined values dropped. */
export function canonicalize(value: unknown, depth = 0): string {
  if (depth > 64) throw new TypeError("canonical_depth_exceeded");
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonical_non_finite_number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return "[" + value.map((item) => canonicalize(item, depth + 1)).join(",") + "]";
      const record = value as Record<string, unknown>;
      // Default sort compares UTF-16 code units, exactly like the server's Array.prototype.sort().
      const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
      return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalize(record[key], depth + 1)).join(",") + "}";
    }
    default:
      throw new TypeError("canonical_unsupported_type");
  }
}

/** "sha256:<hex>" of the canonical JSON of `value` (Web Crypto; needs a secure context). */
export async function digestOf(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Secure hashing is not available in this browser");
  const bytes = new TextEncoder().encode(canonicalize(value));
  const hash = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return "sha256:" + Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

const single = (scope: CommandScope, dim: "market" | "organization" | "zone" | "tenant") => {
  const values = scope[dim];
  return Array.isArray(values) && values.length === 1 ? values[0] : null;
};

/**
 * Intent digest of a Bridge-mapped command, as the Product Admin computes it
 * when the command runs. `staffId` is the requester's HQ staff id (the
 * delegation `sub`), so only the requester can later run it.
 */
export function intentDigestOf(command: OperationCommand<BridgeCommandParams>, staffId: string): Promise<string> {
  const scope = command.scope;
  return digestOf({
    capability: command.capability_id,
    target: command.target,
    body: command.params.body,
    scope: { market: single(scope, "market"), organization: single(scope, "organization"), zone: single(scope, "zone"), tenant: single(scope, "tenant") },
    staff: String(staffId),
  });
}

// ── Commands ──────────────────────────────────────────────────────

export const governanceReadCapability = (productId: string) => `${productId}.governance.read`;
export const proposeCapability = (productId: string) => `${productId}.governance.approval.propose`;
export const decideCapability = (productId: string) => `${productId}.governance.approval.decide`;
export const revokeCapability = (productId: string) => `${productId}.governance.approval.revoke`;

/** Owner decision: an approval lives at most 12 hours (the server default). */
export const APPROVAL_TTL_MAX_SECONDS = 43200;

export interface BridgeCommandInput {
  capability_id: string;
  target: { type: string; id: string; expected_version: number | null };
  /** Body fields except operation_id, which is always the command id. */
  body: Record<string, unknown>;
  reason_code: string;
  case_reference?: string | null;
  scope: CommandScope;
}

/**
 * Builds one Bridge-mapped command. The source body's operation_id is bound
 * to the command id (the Product Admin refuses anything else). Build it ONCE
 * per user intent and keep it until it settles.
 */
export function buildBridgeCommand(input: BridgeCommandInput): OperationCommand<BridgeCommandParams> {
  const command = buildOperationCommand<BridgeCommandParams>({
    capability_id: input.capability_id,
    target: input.target,
    params: { body: {} },
    reason_code: input.reason_code,
    case_reference: input.case_reference ?? null,
    scope: input.scope,
  });
  return { ...command, params: { body: { ...input.body, operation_id: command.command_id } } };
}

export interface ProposeParams extends Record<string, unknown> {
  capability_id: string;
  intent_digest: string;
  ttl_seconds?: number;
  expected_version?: number;
}

/**
 * The propose command for a prepared command: same target, reason, case
 * reference and scope (the approval is bound to that exact scope and shown
 * with that target in the approvals inbox).
 */
export function buildProposeCommand(productId: string, run: OperationCommand<BridgeCommandParams>, intentDigest: string, ttlSeconds?: number): OperationCommand<ProposeParams> {
  const params: ProposeParams = { capability_id: run.capability_id, intent_digest: intentDigest };
  if (ttlSeconds !== undefined) params.ttl_seconds = ttlSeconds;
  if (Number.isInteger(run.target.expected_version)) params.expected_version = run.target.expected_version as number;
  return buildOperationCommand<ProposeParams>({
    capability_id: proposeCapability(productId),
    target: run.target,
    params,
    reason_code: run.reason_code,
    case_reference: run.case_reference,
    scope: run.scope,
  });
}

/** Approval record scope (arrays per dimension) as a command scope. */
export function commandScopeOf(scope: Record<string, string[] | undefined>): CommandScope | null {
  const market = scope.market;
  const organization = scope.organization;
  if (!Array.isArray(market) || !market.length || !Array.isArray(organization) || !organization.length) return null;
  const out: CommandScope = { market: [...market], organization: [...organization] };
  for (const dim of ["zone", "tenant"] as const) {
    const values = scope[dim];
    if (Array.isArray(values) && values.length) out[dim] = [...values];
  }
  return out;
}

/** Decide (APPROVE or REJECT) as the second person. Scope: the approval's own scope. */
export function buildDecideCommand(productId: string, approval: ApprovalItem, decision: "APPROVE" | "REJECT", reasonCode: string) {
  const scope = commandScopeOf(approval.intent_summary.scope);
  if (!scope) throw new Error("The approval has no market and organization scope");
  return buildOperationCommand({
    capability_id: decideCapability(productId),
    target: { type: `${productId}.approval`, id: approval.approval_id, expected_version: null },
    params: { approval_id: approval.approval_id, decision },
    reason_code: reasonCode,
    case_reference: approval.intent_summary.case_reference,
    scope,
  });
}

/** Revoke a proposed (or, by someone other than the requester, an approved) approval before it is used. */
export function buildRevokeCommand(productId: string, approval: ApprovalItem, reasonCode: string) {
  const scope = commandScopeOf(approval.intent_summary.scope);
  if (!scope) throw new Error("The approval has no market and organization scope");
  return buildOperationCommand({
    capability_id: revokeCapability(productId),
    target: { type: `${productId}.approval`, id: approval.approval_id, expected_version: null },
    params: { approval_id: approval.approval_id, reason_code: reasonCode },
    reason_code: reasonCode,
    case_reference: approval.intent_summary.case_reference,
    scope,
  });
}

// ── Approvals inbox items (cfmeet.governance.read) ────────────────

export type ApprovalStatus = "PROPOSED" | "APPROVED" | "REJECTED" | "REVOKED" | "CONSUMED";

/** One approval as the inbox serves it (body-free). */
export interface ApprovalItem {
  approval_id: string;
  capability: string;
  status: ApprovalStatus | string;
  risk: RiskLevel | string | null;
  /** PROPOSED/APPROVED past expires_at and never used. */
  expired: boolean;
  requester_ref: string;
  approver_ref: string | null;
  intent_summary: {
    capability: string;
    target: { type: string; id: string } | null;
    expected_version: number | null;
    reason_code: string | null;
    case_reference: string | null;
    scope: Record<string, string[] | undefined>;
  };
  intent_digest: string;
  created_at: string;
  decided_at: string | null;
  expires_at: string;
}

export interface ApprovalListData {
  items: ApprovalItem[];
}

/** Fixed purposes a staff read may declare (the Product Admin refuses others). */
export const READ_PURPOSES = [
  "verification-review",
  "support-review",
  "abuse-review",
  "billing-review",
  "pricing-change",
  "ops-incident",
  "release-request",
  "privacy-request",
  "metrics-read",
] as const;

/** Display state combining status and expiry. */
export function approvalDisplayStatus(item: Pick<ApprovalItem, "status" | "expired">): string {
  if (item.expired) return "EXPIRED";
  return item.status;
}

/** The decide path's own rules, mirrored so the UI never offers what the server refuses. */
export function canDecide(item: ApprovalItem, staffId: string | null | undefined): boolean {
  return item.status === "PROPOSED" && !item.expired && !!staffId && item.requester_ref !== String(staffId);
}

/** Revoke rules: PROPOSED or APPROVED, unexpired; the requester may withdraw only while PROPOSED. */
export function canRevoke(item: ApprovalItem, staffId: string | null | undefined): boolean {
  if (!staffId || item.expired) return false;
  if (item.status === "PROPOSED") return true;
  return item.status === "APPROVED" && item.requester_ref !== String(staffId);
}

/** The approval record an approval command returned (operation.approval or its evidence). */
export function approvalIdOf(operation: OperationView | null | undefined): string | null {
  if (!operation) return null;
  const fromApproval = operation.approval && typeof operation.approval.approval_id === "string" ? operation.approval.approval_id : null;
  const evidence = operation.evidence as Record<string, unknown> | null | undefined;
  const fromEvidence = evidence && typeof evidence.approval_id === "string" ? evidence.approval_id : null;
  return fromApproval ?? fromEvidence;
}

// ── Refusal reasons ───────────────────────────────────────────────

const REASON_TEXT: Record<string, string> = {
  APPROVER_MUST_BE_INDEPENDENT: "You requested this approval, so a different staff member must decide it.",
  APPROVAL_ALREADY_DECIDED: "Someone already decided this approval.",
  APPROVAL_EXPIRED: "This approval has expired. Request a new one.",
  APPROVAL_NOT_FOUND: "This approval was not found, or you are not eligible to see it.",
  APPROVER_SCOPE_INSUFFICIENT: "Your grant does not cover the whole scope of this approval.",
  APPROVER_ROLE_NOT_VERIFIABLE: "Your approver role cannot be verified for this high-risk action right now.",
  REQUESTER_CANNOT_REVOKE_APPROVAL: "An approved request can only be revoked by someone other than its requester.",
  APPROVAL_NOT_REVOCABLE: "Only a proposed or approved, unused approval can be revoked.",
  REVOCATION_REASON_REQUIRED: "A revocation reason is required.",
  APPROVAL_TARGET_INVALID: "This action cannot be put up for approval.",
  APPROVAL_TARGET_NOT_CERTIFIED: "This high-risk action is not certified for this contract yet, so it cannot be approved.",
  APPROVAL_ALREADY_CONSUMED: "This approval was already used by another operation.",
  APPROVAL_REVOKED: "This approval was revoked.",
  APPROVAL_NOT_APPROVED: "This approval has not been approved yet.",
  APPROVAL_BINDING_MISMATCH: "The command no longer matches what was approved. Request a new approval.",
  APPROVAL_REQUESTER_MISMATCH: "Only the staff member who requested this approval can run it.",
  APPROVAL_SOURCE_VERSION_CHANGED: "The case changed after the approval was requested. Refresh and request a new approval.",
  APPROVAL_CERTIFICATION_CHANGED: "The high-risk certification changed since the approval. Request a new approval.",
  APPROVAL_POLICY_CHANGED: "The source policy changed since the approval. Request a new approval.",
  INDEPENDENT_APPROVAL_REQUIRED: "This action needs an approval from a second staff member first.",
  SOURCE_VERSION_CONFLICT: "The case changed since you loaded it. Refresh and try again.",
  VERSION_CONFLICT: "The case changed since you loaded it. Refresh and try again.",
  RECENT_MFA_REQUIRED: "Confirm with your authenticator app, then try again.",
  MFA_STEP_UP_CANCELLED: "Confirmation with the authenticator app was cancelled. Nothing was sent.",
  CAPABILITY_DISABLED: "This action is switched off for this product.",
  OPERATIONS_NOT_ENABLED_FOR_PRODUCT: "Operations are not switched on for this product.",
  HIGH_RISK_CERTIFICATION_REQUIRED: "This high-risk action is not certified for this contract yet.",
};

/** True for reasons that mean "the target changed since you loaded it". */
export function isVersionConflictReason(reason: string | null | undefined): boolean {
  return !!reason && /VERSION_CONFLICT|SOURCE_VERSION_CHANGED/.test(reason);
}

/** Friendly sentence for a server reason code (falls back to the code itself). */
export function reasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (REASON_TEXT[reason]) return REASON_TEXT[reason];
  if (reason.startsWith("APPROVER_")) return "You are not eligible to decide this approval (" + reason + ").";
  return null;
}

/** One line for a refused write, preferring the server's specific reason. */
export function refusalText(error: unknown): string {
  const e: ProductApiError = toProductApiError(error);
  return reasonText(e.reason) ?? reasonText(e.code) ?? e.message;
}
