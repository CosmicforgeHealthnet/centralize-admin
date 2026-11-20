// Onboarding lifecycle rules as PIC enforces them
// (services/product-integration-core/src/onboarding/state-machine.js and
// service.js). Used only to decide which controls to offer and to explain
// the server's two-person and evidence rules; PIC re-checks everything.

import { PATTERNS, type IntegrationContract, type IntegrationDetail, type LifecycleStatus, type LifecycleTransition } from "@/lib/product-integrations.service";
import type { ConfirmField } from "./admin-ui";

/** Platform permissions (PLATFORM grants held in PIC). */
export type PlatformPermission =
  | "integration.read"
  | "integration.request"
  | "integration.verify"
  | "integration.review"
  | "integration.certify"
  | "integration.approve"
  | "integration.suspend"
  | "integration.revoke"
  | "integration.grants.manage"
  | "integration.subscriptions.manage";

export const REASON_FIELD: ConfirmField = {
  name: "reason_code",
  label: "Reason code",
  required: true,
  pattern: PATTERNS.reasonCode,
  placeholder: "POLICY_VIOLATION",
  hint: "Upper case letters, digits and _, e.g. SECURITY_INCIDENT",
  upper: true,
};

export const evidenceField = (required: boolean): ConfirmField => ({
  name: "evidence_ref",
  label: required ? "Evidence reference" : "Evidence reference (optional)",
  required,
  pattern: PATTERNS.evidenceRef,
  placeholder: "docs/product-admin/evidence/review-2026-11.json",
  hint: "A path, ticket or document reference (3-256 characters: letters, digits, . _ : / # -)",
});

export interface TransitionSpec {
  to: LifecycleStatus;
  permission: PlatformPermission;
  label: string;
  danger?: boolean;
  fields: ConfirmField[];
  requirements: string[];
}

export const TRANSITIONS: Record<LifecycleTransition, TransitionSpec> = {
  "verify-identity": {
    to: "IDENTITY_VERIFIED",
    permission: "integration.verify",
    label: "Verify identity",
    fields: [],
    requirements: ["Permission integration.verify and a recent MFA.", "PIC fetches the signed manifest from the registry-pinned endpoint and checks the signer, workload identity and fingerprint."],
  },
  "validate-contract": {
    to: "CONTRACT_VALIDATED",
    permission: "integration.verify",
    label: "Validate contract",
    fields: [],
    requirements: ["Permission integration.verify.", "A breaking catalog change is recorded as rejected and refused (CONTRACT_BREAKING)."],
  },
  "review-policy": {
    to: "POLICY_REVIEWED",
    permission: "integration.review",
    label: "Review policy",
    fields: [evidenceField(false)],
    requirements: ["Permission integration.review.", "Two-person rule: must be someone other than the requester."],
  },
  "certify-staging": {
    to: "CERTIFIED_STAGING",
    permission: "integration.certify",
    label: "Certify staging",
    fields: [evidenceField(true)],
    requirements: ["Permission integration.certify and an evidence reference.", "Two-person rule: someone other than the requester and other than whoever validated the contract.", "At least one approved dataset."],
  },
  approve: {
    to: "ENABLED",
    permission: "integration.approve",
    label: "Approve (enable)",
    fields: [],
    requirements: ["Permission integration.approve.", "Two-person rule: someone other than the requester and other than the certifier.", "Certified contract, verified identity, unexpired manifest and an approved dataset."],
  },
  reject: {
    to: "REJECTED",
    permission: "integration.review",
    label: "Reject",
    danger: true,
    fields: [REASON_FIELD],
    requirements: ["Permission integration.review and a reason code.", "Rejected registrations are closed for good."],
  },
  suspend: {
    to: "SUSPENDED",
    permission: "integration.suspend",
    label: "Suspend",
    danger: true,
    fields: [REASON_FIELD],
    requirements: ["Permission integration.suspend and a reason code.", "Synchronization stops; the product returns only through resume-review and every gate again."],
  },
  revoke: {
    to: "REVOKED",
    permission: "integration.revoke",
    label: "Revoke",
    danger: true,
    fields: [REASON_FIELD],
    requirements: ["Permission integration.revoke and a reason code.", "Permanent: subscriptions are suspended and the registration never returns."],
  },
  "resume-review": {
    to: "REQUESTED",
    permission: "integration.approve",
    label: "Resume review",
    fields: [REASON_FIELD],
    requirements: ["Permission integration.approve and a reason code.", "Returns to REQUESTED; identity must be verified again."],
  },
};

/** Transitions the state machine allows from each status. */
export const AVAILABLE: Record<LifecycleStatus, LifecycleTransition[]> = {
  DRAFT: [],
  REQUESTED: ["verify-identity", "reject", "suspend", "revoke"],
  IDENTITY_VERIFIED: ["validate-contract", "reject", "suspend", "revoke"],
  CONTRACT_VALIDATED: ["review-policy", "reject", "suspend", "revoke"],
  POLICY_REVIEWED: ["certify-staging", "reject", "suspend", "revoke"],
  CERTIFIED_STAGING: ["approve", "reject", "suspend", "revoke"],
  ENABLED: ["suspend", "revoke"],
  SUSPENDED: ["resume-review", "revoke"],
  REJECTED: [],
  REVOKED: [],
};

/** The onboarding candidate contract: the one named by the latest CONTRACT_VALIDATED decision (as PIC picks it). */
export function candidateContract(detail: IntegrationDetail): IntegrationContract | null {
  const last = [...detail.history].reverse().find((h) => h.decision === "CONTRACT_VALIDATED" && h.contract_id);
  return (last && detail.contracts.find((c) => c.id === last.contract_id)) || null;
}

const SELF_REQUESTER = "Two-person rule: you requested this registration, so someone else must do this.";

/** Why the signed-in staff member cannot run a transition under the two-person rule, or null. */
export function independenceBlock(transition: LifecycleTransition, detail: IntegrationDetail, me: string | null): string | null {
  if (!me) return null;
  const reg = detail.registration;
  const candidate = candidateContract(detail);
  if (transition === "review-policy" && reg.requested_by === me) return SELF_REQUESTER;
  if (transition === "certify-staging") {
    if (reg.requested_by === me) return SELF_REQUESTER;
    if (candidate?.status === "VALIDATED" && candidate.validated_by === me) return "Two-person rule: you validated the contract, so someone else must certify it.";
  }
  if (transition === "approve") {
    if (reg.requested_by === me) return SELF_REQUESTER;
    if (candidate?.certified_by === me) return "Two-person rule: you certified the contract, so someone else must approve.";
  }
  return null;
}

export const ENVIRONMENTS = ["test", "development", "staging", "production"] as const;
