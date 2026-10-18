import api from "./api";
import type {
  AMIApiEnvelope,
  AMIOverviewResponse,
  AMIProviderValidationRow,
  AMICreativeListItem,
  AMICreativeDetail,
  AMICreativeFilters,
  AMIRecommendationListItem,
  AMIRecommendationDetail,
  AMIRecommendationFilters,
  AMIConvertToTaskPayload,
  AMIConvertToTaskResult,
  AMIEligibleAssignee,
  AMIAlertListItem,
  AMIAlertDetail,
  AMIAlertFilters,
  AMIExperimentListItem,
  AMIExperimentDetail,
  AMIExperimentFilters,
  AMIExperimentFormPayload,
  AMIEvaluationRunListItem,
  AMIEvaluationRunDetail,
  AMIEvaluationRunFilters,
  AMIManualOperationPayload,
  AMIManualOperationResult,
  AMISettingRow,
  AMISettingUpdatePayload,
} from "@/types/ai-marketing-intelligence.types";
import {
  delay,
  mockAMIOverview,
  mockAMIProviderValidation,
  mockAMICreatives,
  mockAMICreativeDetail,
  mockAMIRecommendations,
  mockAMIRecommendationDetail,
  mockAMIEligibleAssignees,
  mockAMIConvertToTaskResult,
  mockAMIAlerts,
  mockAMIAlertDetail,
  mockAMIExperiments,
  mockAMIExperimentDetail,
  mockAMIEvaluationRuns,
  mockAMIEvaluationRunDetail,
  mockAMIManualOperationResult,
  mockAMISettings,
} from "./ai-marketing-intelligence.mock";

// Flip to false once the backend Phase 2 routes are live in this environment.
const USE_MOCK = true;

const BASE = "/api/v1/marketing/intelligence";

// ─── Overview ──────────────────────────────────────────────────────────────

export const fetchAMIOverview = async (): Promise<AMIOverviewResponse> => {
  if (USE_MOCK) {
    await delay();
    return mockAMIOverview;
  }
  const { data } = await api.get<AMIApiEnvelope<AMIOverviewResponse>>(`${BASE}/overview`);
  return data.data;
};

// ─── Provider validation ─────────────────────────────────────────────────────

export const fetchAMIProviderValidation = async (): Promise<AMIProviderValidationRow[]> => {
  if (USE_MOCK) {
    await delay();
    return mockAMIProviderValidation;
  }
  const { data } = await api.get<AMIApiEnvelope<AMIProviderValidationRow[]>>(`${BASE}/provider-validation`);
  return data.data;
};

// ─── Creative Intelligence ──────────────────────────────────────────────────

export const fetchAMICreatives = async (filters: Partial<AMICreativeFilters>): Promise<AMICreativeListItem[]> => {
  if (USE_MOCK) {
    await delay();
    let rows = [...mockAMICreatives];
    if (filters.platform && filters.platform !== "all") rows = rows.filter((c) => c.platform === filters.platform);
    if (filters.dataSufficiency && filters.dataSufficiency !== "all") rows = rows.filter((c) => c.dataSufficiency === filters.dataSufficiency);
    if (filters.fatigueStatus && filters.fatigueStatus !== "all") rows = rows.filter((c) => c.fatigueStatus === filters.fatigueStatus);
    if (filters.creativeType && filters.creativeType !== "all") rows = rows.filter((c) => c.type === filters.creativeType);
    if (filters.search) rows = rows.filter((c) => c.name.toLowerCase().includes(filters.search!.toLowerCase()));
    return rows;
  }
  const { data } = await api.get<AMIApiEnvelope<AMICreativeListItem[]>>(`${BASE}/creatives`, { params: filters });
  return data.data;
};

export const fetchAMICreativeDetail = async (id: string): Promise<AMICreativeDetail> => {
  if (USE_MOCK) {
    await delay();
    return mockAMICreativeDetail(id);
  }
  const { data } = await api.get<AMIApiEnvelope<AMICreativeDetail>>(`${BASE}/creatives/${id}`);
  return data.data;
};

export const fetchAMICreativeScoreHistory = async (id: string) => {
  if (USE_MOCK) {
    await delay();
    return mockAMICreativeDetail(id).scoreHistory;
  }
  const { data } = await api.get<AMIApiEnvelope<AMICreativeDetail["scoreHistory"]>>(`${BASE}/creatives/${id}/scores`);
  return data.data;
};

// ─── Recommendations ────────────────────────────────────────────────────────

export const fetchAMIRecommendations = async (
  filters: Partial<AMIRecommendationFilters>
): Promise<AMIRecommendationListItem[]> => {
  if (USE_MOCK) {
    await delay();
    let rows = [...mockAMIRecommendations];
    if (filters.type && filters.type !== "all") rows = rows.filter((r) => r.type === filters.type);
    if (filters.status && filters.status !== "all") rows = rows.filter((r) => r.status === filters.status);
    if (filters.platform && filters.platform !== "all") rows = rows.filter((r) => r.platform === filters.platform);
    if (filters.onlyActionable) rows = rows.filter((r) => r.status === "PENDING");
    if (filters.onlyAwaitingTaskConversion) rows = rows.filter((r) => r.status === "ACCEPTED");
    return rows;
  }
  const { data } = await api.get<AMIApiEnvelope<AMIRecommendationListItem[]>>(`${BASE}/recommendations`, { params: filters });
  return data.data;
};

export const fetchAMIRecommendationDetail = async (id: string): Promise<AMIRecommendationDetail> => {
  if (USE_MOCK) {
    await delay();
    return mockAMIRecommendationDetail(id);
  }
  const { data } = await api.get<AMIApiEnvelope<AMIRecommendationDetail>>(`${BASE}/recommendations/${id}`);
  return data.data;
};

export const acceptAMIRecommendation = async (id: string): Promise<AMIRecommendationDetail> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockAMIRecommendationDetail(id), status: "ACCEPTED" };
  }
  const { data } = await api.patch<AMIApiEnvelope<AMIRecommendationDetail>>(`${BASE}/recommendations/${id}/accept`);
  return data.data;
};

export const dismissAMIRecommendation = async (id: string, reason?: string): Promise<AMIRecommendationDetail> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockAMIRecommendationDetail(id), status: "DISMISSED" };
  }
  const { data } = await api.patch<AMIApiEnvelope<AMIRecommendationDetail>>(`${BASE}/recommendations/${id}/dismiss`, { reason });
  return data.data;
};

export const fetchAMIEligibleAssignees = async (): Promise<AMIEligibleAssignee[]> => {
  if (USE_MOCK) {
    await delay(200);
    return mockAMIEligibleAssignees;
  }
  const { data } = await api.get<AMIApiEnvelope<AMIEligibleAssignee[]>>(`${BASE}/eligible-assignees`);
  return data.data;
};

export const convertAMIRecommendationToTask = async (
  id: string,
  payload: AMIConvertToTaskPayload
): Promise<AMIConvertToTaskResult> => {
  if (USE_MOCK) {
    await delay(600);
    return mockAMIConvertToTaskResult(payload.assigneeAdminUserId);
  }
  const { data } = await api.post<AMIApiEnvelope<AMIConvertToTaskResult>>(
    `${BASE}/recommendations/${id}/convert-to-task`,
    payload
  );
  return data.data;
};

// ─── Alerts ─────────────────────────────────────────────────────────────────

export const fetchAMIAlerts = async (filters: Partial<AMIAlertFilters>): Promise<AMIAlertListItem[]> => {
  if (USE_MOCK) {
    await delay();
    let rows = [...mockAMIAlerts];
    if (filters.status && filters.status !== "all") rows = rows.filter((a) => a.status === filters.status);
    if (filters.severity && filters.severity !== "all") rows = rows.filter((a) => a.severity === filters.severity);
    if (filters.type && filters.type !== "all") rows = rows.filter((a) => a.type === filters.type);
    if (filters.platform && filters.platform !== "all") rows = rows.filter((a) => a.platform === filters.platform);
    return rows;
  }
  const { data } = await api.get<AMIApiEnvelope<AMIAlertListItem[]>>(`${BASE}/alerts`, { params: filters });
  return data.data;
};

export const fetchAMIAlertDetail = async (id: string): Promise<AMIAlertDetail> => {
  if (USE_MOCK) {
    await delay();
    return mockAMIAlertDetail(id);
  }
  const { data } = await api.get<AMIApiEnvelope<AMIAlertDetail>>(`${BASE}/alerts/${id}`);
  return data.data;
};

export const acknowledgeAMIAlert = async (id: string): Promise<AMIAlertDetail> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockAMIAlertDetail(id), status: "ACKNOWLEDGED" };
  }
  const { data } = await api.patch<AMIApiEnvelope<AMIAlertDetail>>(`${BASE}/alerts/${id}/acknowledge`);
  return data.data;
};

export const resolveAMIAlert = async (id: string, reason?: string): Promise<AMIAlertDetail> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockAMIAlertDetail(id), status: "RESOLVED", resolutionReason: reason ?? null };
  }
  const { data } = await api.patch<AMIApiEnvelope<AMIAlertDetail>>(`${BASE}/alerts/${id}/resolve`, { reason });
  return data.data;
};

// ─── Experiments ────────────────────────────────────────────────────────────

export const fetchAMIExperiments = async (filters: Partial<AMIExperimentFilters>): Promise<AMIExperimentListItem[]> => {
  if (USE_MOCK) {
    await delay();
    let rows = [...mockAMIExperiments];
    if (filters.status && filters.status !== "all") rows = rows.filter((e) => e.status === filters.status);
    if (filters.platform && filters.platform !== "all") rows = rows.filter((e) => e.platform === filters.platform);
    if (filters.metric && filters.metric !== "all") rows = rows.filter((e) => e.metric === filters.metric);
    return rows;
  }
  const { data } = await api.get<AMIApiEnvelope<AMIExperimentListItem[]>>(`${BASE}/experiments`, { params: filters });
  return data.data;
};

export const fetchAMIExperimentDetail = async (id: string): Promise<AMIExperimentDetail> => {
  if (USE_MOCK) {
    await delay();
    return mockAMIExperimentDetail(id);
  }
  const { data } = await api.get<AMIApiEnvelope<AMIExperimentDetail>>(`${BASE}/experiments/${id}`);
  return data.data;
};

export const createAMIExperiment = async (payload: AMIExperimentFormPayload): Promise<AMIExperimentDetail> => {
  if (USE_MOCK) {
    await delay();
    return {
      id: "exp-" + Date.now(),
      ...payload,
      platform: payload.platform ?? null,
      connectionId: payload.connectionId ?? null,
      campaignExternalId: payload.campaignExternalId ?? null,
      status: "DRAFT",
      startedAt: null,
      endedAt: null,
      owner: "You",
      result: null,
      conclusion: null,
      cancelReason: null,
    };
  }
  const { data } = await api.post<AMIApiEnvelope<AMIExperimentDetail>>(`${BASE}/experiments`, payload);
  return data.data;
};

export const updateAMIExperiment = async (id: string, payload: Partial<AMIExperimentFormPayload>): Promise<AMIExperimentDetail> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockAMIExperimentDetail(id), ...payload } as AMIExperimentDetail;
  }
  const { data } = await api.patch<AMIApiEnvelope<AMIExperimentDetail>>(`${BASE}/experiments/${id}`, payload);
  return data.data;
};

export const startAMIExperiment = async (id: string): Promise<AMIExperimentDetail> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockAMIExperimentDetail(id), status: "RUNNING", startedAt: new Date().toISOString() };
  }
  const { data } = await api.post<AMIApiEnvelope<AMIExperimentDetail>>(`${BASE}/experiments/${id}/start`);
  return data.data;
};

export const completeAMIExperiment = async (
  id: string,
  payload: { result: string; conclusion?: string }
): Promise<AMIExperimentDetail> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockAMIExperimentDetail(id), status: "COMPLETED", endedAt: new Date().toISOString(), result: payload.result, conclusion: payload.conclusion ?? null };
  }
  const { data } = await api.post<AMIApiEnvelope<AMIExperimentDetail>>(`${BASE}/experiments/${id}/complete`, payload);
  return data.data;
};

export const cancelAMIExperiment = async (id: string, reason?: string): Promise<AMIExperimentDetail> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockAMIExperimentDetail(id), status: "CANCELLED", cancelReason: reason ?? null };
  }
  const { data } = await api.post<AMIApiEnvelope<AMIExperimentDetail>>(`${BASE}/experiments/${id}/cancel`, { reason });
  return data.data;
};

// ─── Evaluation runs ─────────────────────────────────────────────────────────

export const fetchAMIEvaluationRuns = async (
  filters: Partial<AMIEvaluationRunFilters>
): Promise<AMIEvaluationRunListItem[]> => {
  if (USE_MOCK) {
    await delay();
    let rows = [...mockAMIEvaluationRuns];
    if (filters.runType && filters.runType !== "all") rows = rows.filter((r) => r.runType === filters.runType);
    if (filters.status && filters.status !== "all") rows = rows.filter((r) => r.status === filters.status);
    if (filters.platform && filters.platform !== "all") rows = rows.filter((r) => r.platform === filters.platform);
    return rows;
  }
  const { data } = await api.get<AMIApiEnvelope<AMIEvaluationRunListItem[]>>(`${BASE}/evaluation-runs`, { params: filters });
  return data.data;
};

export const fetchAMIEvaluationRunDetail = async (id: string): Promise<AMIEvaluationRunDetail> => {
  if (USE_MOCK) {
    await delay();
    return mockAMIEvaluationRunDetail(id);
  }
  const { data } = await api.get<AMIApiEnvelope<AMIEvaluationRunDetail>>(`${BASE}/evaluation-runs/${id}`);
  return data.data;
};

// ─── Manual operations (Section 19) ───────────────────────────────────────────

export const runAMIManualOperation = async (payload: AMIManualOperationPayload): Promise<AMIManualOperationResult> => {
  if (USE_MOCK) {
    await delay(1200);
    return mockAMIManualOperationResult();
  }
  const routeMap: Record<AMIManualOperationPayload["operation"], string> = {
    PHASE1_SYNC: `${BASE}/sync`,
    CREATIVE_SYNC: `${BASE}/creatives/sync`,
    CREATIVE_SCORE: `${BASE}/creatives/score`,
    RECOMMENDATION_EVALUATE: `${BASE}/recommendations/evaluate`,
    ALERT_EVALUATE: `${BASE}/alerts/evaluate`,
  };
  const { data } = await api.post<AMIApiEnvelope<AMIManualOperationResult>>(routeMap[payload.operation], payload);
  return data.data;
};

// ─── Settings ───────────────────────────────────────────────────────────────

export const fetchAMISettings = async (): Promise<AMISettingRow[]> => {
  if (USE_MOCK) {
    await delay();
    return mockAMISettings;
  }
  const { data } = await api.get<AMIApiEnvelope<AMISettingRow[]>>(`${BASE}/settings`);
  return data.data;
};

export const updateAMISetting = async (payload: AMISettingUpdatePayload): Promise<AMISettingRow> => {
  if (USE_MOCK) {
    await delay();
    const existing = mockAMISettings.find((s) => s.key === payload.key);
    return {
      key: payload.key,
      scope: payload.scope,
      platform: payload.platform ?? null,
      connectionId: payload.connectionId ?? null,
      currency: payload.currency ?? existing?.currency ?? null,
      configuredValue: payload.value,
      effectiveValue: payload.value,
      effectiveSourceScope: payload.scope,
      version: payload.expectedVersion + 1,
      isMonetary: existing?.isMonetary ?? false,
      isPercentage: existing?.isPercentage ?? false,
    };
  }
  const { data } = await api.patch<AMIApiEnvelope<AMISettingRow>>(`${BASE}/settings`, payload);
  return data.data;
};