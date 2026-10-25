// M10 rollout controls (mail admins).

export type RolloutEffect = "ALLOW" | "DENY";
export type RolloutScopeType = "ENVIRONMENT" | "ORGANIZATION" | "DOMAIN" | "MAILBOX" | "COHORT";

export interface RolloutRule {
  id: string;
  environment: string;
  capability: string;
  scopeType: RolloutScopeType;
  scopeId: string | null;
  effect: RolloutEffect;
  reason: string;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

export interface EmergencyStop {
  id: string;
  environment: string;
  scope: "ALL" | "MARKETING" | "ORGANIZATION";
  organizationId: string | null;
  reason: string;
  activatedBy: string;
  activatedAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
}

export interface RolloutCohort {
  id: string;
  key: string;
  name: string;
  description: string | null;
  members: { adminUserId: string; addedAt: string }[];
}

export interface RolloutOverview {
  environment: string;
  enforced: boolean;
  capabilities: string[];
  scopeTypes: RolloutScopeType[];
  rules: RolloutRule[];
  emergencyStops: EmergencyStop[];
  environmentStops: { all: boolean; marketing: boolean };
  cohorts: RolloutCohort[];
}

export interface ReadinessGate {
  id: string;
  label: string;
  status: "PASS" | "FAIL" | "MANUAL";
  detail: unknown;
}

export interface ReadinessStage {
  id: string;
  label: string;
  gates: ReadinessGate[];
  automatedReady: boolean;
  manualPending: number;
}

export interface Readiness {
  environment: string;
  generatedAt: string;
  stages: ReadinessStage[];
}
