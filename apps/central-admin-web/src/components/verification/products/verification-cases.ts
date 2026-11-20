// Product verification cases (the shared case shape served by a product's
// `<product>.verification.read` capability; CF Meet Admin Bridge contract
// 1.12.0: VerificationCase, VerificationCaseDetail, VerificationCaseHistory)
// and the case commands HQ can run through POST /operations.

import type { ProductCapabilities, ProductCapability } from "@/types/products.types";

export const CASE_STATES = ["OPEN", "CLAIMED", "APPROVED", "REJECTED", "PUBLISHED", "SUSPENDED", "CANCELLED"] as const;
export type CaseState = (typeof CASE_STATES)[number];
export const CASE_KINDS = ["PARTNER_GO_LIVE", "APP_REVIEW"] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

export interface CaseEvidence {
  kind: string;
  ref: string;
  /** Hash only; the evidence itself never leaves the product. */
  sha256: string;
}

export interface VerificationCase {
  case_id: string;
  product: string;
  kind: CaseKind | string;
  subject_ref: string;
  state: CaseState | string;
  /** Increases on every transition; the commands' expected_version. */
  version: number;
  assignee_ref: string | null;
  submitted_at: string;
  updated_at: string;
  evidence: CaseEvidence[];
  approvals_required: number;
  partner_tenant_id: string;
}

export type CaseDetails =
  | { requested_capabilities: string[]; approved_capabilities: string[] }
  | { app_version: number; published_version: number | null };

export interface VerificationCaseDetail extends VerificationCase {
  details: CaseDetails;
}

export interface CaseHistoryItem {
  sequence: number;
  from_state: string | null;
  to_state: string | null;
  actor_kind: "STAFF" | "PARTNER" | "SYSTEM" | string;
  actor_ref: string | null;
  reason_code: string | null;
  occurred_at: string;
}

export interface CaseListData {
  items: VerificationCase[];
}

export interface CaseHistoryData {
  case_id: string;
  items: CaseHistoryItem[];
}

/** The fixed read purpose for verification (the Bridge accepts only this one). */
export const VERIFICATION_PURPOSE = "verification-review";
export const COLLECTIONS = {
  list: "verification.cases.list",
  detail: "verification.cases.read",
  history: "verification.case-history.list",
} as const;

export const verificationReadCapability = (productId: string) => `${productId}.verification.read`;
export const caseTargetType = (productId: string) => `${productId}.verification_case`;

export const STATE_LABEL: Record<string, string> = {
  OPEN: "Open",
  CLAIMED: "Claimed",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  PUBLISHED: "Published",
  SUSPENDED: "Suspended",
  CANCELLED: "Withdrawn",
};
export const KIND_LABEL: Record<string, string> = { PARTNER_GO_LIVE: "Partner go-live", APP_REVIEW: "App review" };

export interface CaseAction {
  id: string;
  /** Command id without the product prefix; HQ capability = `<product>.<command>`. */
  command: string;
  label: string;
  kinds: readonly string[];
  states: readonly string[];
  reasons: readonly string[];
  reasonRequired: boolean;
  /** PARTNER_GO_LIVE approve: approved_capabilities subset (1-16). */
  approvedCapabilities?: boolean;
  destructive?: boolean;
}

const REJECT_REASONS = ["EVIDENCE_INSUFFICIENT", "USE_CASE_NOT_PERMITTED", "POLICY_VIOLATION", "DUPLICATE_SUBMISSION"] as const;

/** Case commands (Bridge 1.12.0). The server decides; states only hide actions that cannot apply. */
export const CASE_ACTIONS: readonly CaseAction[] = [
  { id: "claim", command: "verification.case.claim", label: "Claim case", kinds: CASE_KINDS, states: ["OPEN"], reasons: ["REVIEW_STARTED"], reasonRequired: false },
  { id: "go-live-approve", command: "verification.partner-go-live.approve", label: "Approve go-live", kinds: ["PARTNER_GO_LIVE"], states: ["OPEN", "CLAIMED"], reasons: ["REVIEW_PASSED"], reasonRequired: false, approvedCapabilities: true },
  { id: "go-live-reject", command: "verification.partner-go-live.reject", label: "Reject go-live", kinds: ["PARTNER_GO_LIVE"], states: ["OPEN", "CLAIMED"], reasons: REJECT_REASONS, reasonRequired: true, destructive: true },
  { id: "go-live-suspend", command: "verification.partner-go-live.suspend", label: "Suspend partner", kinds: ["PARTNER_GO_LIVE"], states: ["APPROVED"], reasons: ["POLICY_VIOLATION", "SECURITY_CONCERN", "PARTNER_REQUEST"], reasonRequired: false, destructive: true },
  { id: "app-approve", command: "verification.app-review.approve", label: "Approve app", kinds: ["APP_REVIEW"], states: ["OPEN", "CLAIMED"], reasons: ["REVIEW_PASSED"], reasonRequired: false },
  { id: "app-reject", command: "verification.app-review.reject", label: "Reject app", kinds: ["APP_REVIEW"], states: ["OPEN", "CLAIMED"], reasons: REJECT_REASONS, reasonRequired: true, destructive: true },
  { id: "app-publish", command: "verification.app-review.publish", label: "Publish app", kinds: ["APP_REVIEW"], states: ["APPROVED"], reasons: ["REVIEW_PASSED"], reasonRequired: false },
];

export function actionsFor(c: Pick<VerificationCase, "kind" | "state">): CaseAction[] {
  if (c.state === "CANCELLED") return [];
  return CASE_ACTIONS.filter((a) => a.kinds.includes(c.kind) && a.states.includes(c.state));
}

export function commandCapability(caps: ProductCapabilities | undefined, productId: string, action: CaseAction): ProductCapability | null {
  return caps?.capabilities.find((c) => c.id === `${productId}.${action.command}`) ?? null;
}

interface ModuleSummary {
  read_capability_id?: string;
  collections?: { collection_id: string; exposure_state: string }[];
}

/** Exposure of one collection from the product's module summary, or null when the product does not publish one. */
export function collectionExposure(caps: ProductCapabilities | undefined, readCapability: string, collectionId: string): string | null {
  const modules = Array.isArray(caps?.modules) ? (caps?.modules as ModuleSummary[]) : [];
  const summary = modules.find((m) => m.read_capability_id === readCapability);
  return summary?.collections?.find((c) => c.collection_id === collectionId)?.exposure_state ?? null;
}

/** Display of an `hq:<staff id>` / `operator:<name>` actor reference. */
export function actorLabel(ref: string | null, staffId: string | null | undefined): string {
  if (!ref) return "—";
  if (staffId && ref === `hq:${staffId}`) return "You";
  return ref;
}
