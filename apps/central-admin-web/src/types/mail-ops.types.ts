// M9 Mail operations (admin only). Counts, ages and codes only; never
// message content, subjects or addresses.

export type AlertSeverity = "info" | "warning" | "critical";

export interface OpsAlert {
  id: string;
  code: string;
  severity: AlertSeverity;
  organizationId: string | null;
  detail: Record<string, unknown> | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface OpsSnapshot {
  generatedAt: string;
  runtimeHalt: { staffMail: string | null; marketing: string | null } | null;
  queue: {
    byStatus: { queue: string; status: string; count: number }[];
    oldestDueSeconds: Record<string, number>;
    active: number;
    deadLetters24h: { queue: string; kind: string; count: number }[];
  };
  webhooks: { backlog: number; oldestBacklogSeconds: number; failed24h: number };
  scanning: { backlog: number; oldestBacklogSeconds: number };
  delivery: { staff24h: Record<string, number>; outcomeUnknown24h: number };
  retention: Record<string, number>;
  openAlerts: OpsAlert[];
}

export interface UsageRow {
  organizationId: string;
  organization: { id: string; slug?: string; name?: string };
  purpose: string;
  accepted: number;
  rejected: number;
  received: number;
  providerRequests: number;
  bytes: number;
  estimatedCost: number | null;
}

export interface QuotaLimit {
  id: string;
  organizationId: string;
  purpose: string;
  dailySoftLimit: number | null;
  dailyHardLimit: number | null;
  monthlyHardLimit: number | null;
  updatedAt: string;
}

export interface UsageReport {
  days: number;
  since: string;
  summary: UsageRow[];
  limits: QuotaLimit[];
  cost: { currency: string | null; source: string | null; note?: string };
}

export type RetentionMode = "DRY_RUN" | "EXECUTE";
export type RetentionStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface RetentionRun {
  id: string;
  organizationId: string | null;
  policyId: string | null;
  category: string;
  action: string;
  mode: RetentionMode;
  status: RetentionStatus;
  cutoff: string;
  dryRunId: string | null;
  requestedBy: string;
  counts: Record<string, number | string>;
  errorCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface RetentionCapabilities {
  executionEnabled: boolean;
  dryRunValidHours: number;
  systemCategories: { category: string; action: string; retainDays: number | null }[];
}

export interface RetentionPolicy {
  id: string;
  organizationId: string;
  mailboxId: string | null;
  name: string;
  retainDays: number;
  action: "ARCHIVE" | "DELETE";
  enabled: boolean;
}
