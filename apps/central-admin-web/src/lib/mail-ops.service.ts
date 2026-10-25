import api from "./api";
import type { OpsAlert, OpsSnapshot, QuotaLimit, RetentionCapabilities, RetentionPolicy, RetentionRun, UsageReport } from "@/types/mail-ops.types";

const BASE = "/api/mail/v1/admin";
const unwrap = <T>(response: { data: { data: T } }) => response.data.data;

export const opsSnapshot = async () => unwrap<OpsSnapshot>(await api.get(`${BASE}/ops/snapshot`));
export const opsAlerts = async (includeResolved = false) => unwrap<OpsAlert[]>(await api.get(`${BASE}/ops/alerts`, { params: includeResolved ? { includeResolved: true } : {} }));
export const acknowledgeAlert = async (id: string) => unwrap<OpsAlert>(await api.post(`${BASE}/ops/alerts/${id}/acknowledge`, {}));
export const usageReport = async (days = 30) => unwrap<UsageReport>(await api.get(`${BASE}/usage`, { params: { days } }));
export const setQuota = async (input: { organizationId: string; purpose: string; dailySoftLimit: number | null; dailyHardLimit: number | null; monthlyHardLimit: number | null }) =>
  unwrap<QuotaLimit>(await api.put(`${BASE}/quotas`, input));
export const retentionCapabilities = async () => unwrap<RetentionCapabilities>(await api.get(`${BASE}/retention/capabilities`));
export const retentionPolicies = async () => unwrap<RetentionPolicy[]>(await api.get(`${BASE}/retention-policies`));
export const retentionRuns = async () => unwrap<RetentionRun[]>(await api.get(`${BASE}/retention/runs`));
export const startRetentionDryRun = async (target: { policyId: string } | { category: string }) => unwrap<RetentionRun>(await api.post(`${BASE}/retention/runs`, target));
export const executeRetention = async (dryRunId: string, stepUpId: string) => unwrap<RetentionRun>(await api.post(`${BASE}/retention/runs/${dryRunId}/execute`, { stepUpId }));
export const cancelRetention = async (runId: string) => unwrap<RetentionRun>(await api.post(`${BASE}/retention/runs/${runId}/cancel`, {}));
