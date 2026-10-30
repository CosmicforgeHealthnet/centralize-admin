import api from "./api";
import type {
  AEApiEnvelope,
  AEOverviewResponse,
  AEProviderCapability,
  AEPlanListItem,
  AEPlanDetail,
  AEPlanFilters,
  AEPlanContextPayload,
  AEValidationResult,
  AEApprovalQueueItem,
  AEApprovalPacket,
  AERunListItem,
  AERunDetail,
  AERunFilters,
  AEOperationDetail,
  AERetryReviewPayload,
  AEIncidentListItem,
  AEIncidentDetail,
  AEIncidentFilters,
  AECompensationDraftPayload,
  AECreativePublicationListItem,
  AECreativePublicationDetail,
  AERecommendationConversionContext,
  AEPolicyRow,
  AEPolicyUpdatePayload,
  AEKillSwitch,
  AEOverrideRequestPayload,
  AEOverrideRecord,
  AEHealthResponse,
} from "@/types/advertising-execution.types";
import {
  delay,
  mockAEProviderCapabilities,
  mockAEPlans,
  mockAEPlanDetail,
  mockAEValidationResult,
  mockAEApprovalQueue,
  mockAEApprovalPacket,
  mockAERuns,
  mockAERunDetail,
  mockAEOperationDetail,
  mockAEIncidents,
  mockAEIncidentDetail,
  mockAECreativePublications,
  mockAECreativePublicationDetail,
  mockAEPolicies,
  mockAEKillSwitches,
  mockAEOverrides,
  mockAEHealth,
  mockAEOverview,
} from "./advertising-execution.mock";

// Flip to false once the backend Phase 3 routes are live in this environment.
const USE_MOCK = true;

const BASE = "/api/v1/marketing/advertising-execution";

// ─── Overview ──────────────────────────────────────────────────────────────

export const fetchAEOverview = async (): Promise<AEOverviewResponse> => {
  if (USE_MOCK) {
    await delay();
    return mockAEOverview;
  }
  const { data } = await api.get<AEApiEnvelope<AEOverviewResponse>>(`${BASE}/overview`);
  return data.data;
};

// ─── Provider readiness / capabilities ─────────────────────────────────────────

export const fetchAECapabilities = async (): Promise<AEProviderCapability[]> => {
  if (USE_MOCK) {
    await delay();
    return mockAEProviderCapabilities;
  }
  const { data } = await api.get<AEApiEnvelope<AEProviderCapability[]>>(`${BASE}/capabilities`);
  return data.data;
};

// ─── Plans ──────────────────────────────────────────────────────────────────

export const fetchAEPlans = async (filters: Partial<AEPlanFilters>): Promise<AEPlanListItem[]> => {
  if (USE_MOCK) {
    await delay();
    let rows = [...mockAEPlans];
    if (filters.provider && filters.provider !== "all") rows = rows.filter((p) => p.provider === filters.provider);
    if (filters.status && filters.status !== "all") rows = rows.filter((p) => p.status === filters.status);
    if (filters.source && filters.source !== "all") rows = rows.filter((p) => p.source === filters.source);
    if (filters.search) rows = rows.filter((p) => p.name.toLowerCase().includes(filters.search!.toLowerCase()));
    return rows;
  }
  const { data } = await api.get<AEApiEnvelope<AEPlanListItem[]>>(`${BASE}/plans`, { params: filters });
  return data.data;
};

export const fetchAEPlanDetail = async (id: string): Promise<AEPlanDetail> => {
  if (USE_MOCK) {
    await delay();
    return mockAEPlanDetail(id);
  }
  const { data } = await api.get<AEApiEnvelope<AEPlanDetail>>(`${BASE}/plans/${id}`);
  return data.data;
};

export const createAEPlan = async (payload: AEPlanContextPayload): Promise<AEPlanDetail> => {
  if (USE_MOCK) {
    await delay();
    const id = "plan-" + Date.now();
    return {
      ...mockAEPlanDetail("plan-1"),
      id,
      name: payload.name,
      provider: payload.provider,
      connectionId: payload.connectionId,
      currency: "USD",
      source: payload.source,
      status: "DRAFT",
      version: 1,
      fingerprint: null,
      validationCurrent: false,
      approvalProgress: null,
      description: payload.description ?? null,
      sourceRecommendationId: payload.sourceRecommendationId ?? null,
    };
  }
  const { data } = await api.post<AEApiEnvelope<AEPlanDetail>>(`${BASE}/plans`, payload);
  return data.data;
};

export const updateAEPlan = async (id: string, payload: Partial<AEPlanDetail>): Promise<AEPlanDetail> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockAEPlanDetail(id), ...payload } as AEPlanDetail;
  }
  const { data } = await api.patch<AEApiEnvelope<AEPlanDetail>>(`${BASE}/plans/${id}`, payload);
  return data.data;
};

export const cancelAEPlan = async (id: string, reason?: string): Promise<AEPlanDetail> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockAEPlanDetail(id), status: "CANCELLED" };
  }
  const { data } = await api.delete<AEApiEnvelope<AEPlanDetail>>(`${BASE}/plans/${id}`, { data: { reason } });
  return data.data;
};

// ─── Validation ─────────────────────────────────────────────────────────────

export const validateAEPlan = async (id: string): Promise<AEValidationResult> => {
  if (USE_MOCK) {
    await delay(800);
    const plan = mockAEPlanDetail(id);
    return mockAEValidationResult(id, plan.version, plan.fingerprint ?? "new-fingerprint");
  }
  const { data } = await api.post<AEApiEnvelope<AEValidationResult>>(`${BASE}/plans/${id}/validate`);
  return data.data;
};

// ─── Submit / approvals ─────────────────────────────────────────────────────

export const submitAEPlanForApproval = async (id: string): Promise<AEPlanDetail> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockAEPlanDetail(id), status: "PENDING_APPROVAL" };
  }
  const { data } = await api.post<AEApiEnvelope<AEPlanDetail>>(`${BASE}/plans/${id}/submit`);
  return data.data;
};

export const fetchAEApprovalQueue = async (): Promise<AEApprovalQueueItem[]> => {
  if (USE_MOCK) {
    await delay();
    return mockAEApprovalQueue;
  }
  const { data } = await api.get<AEApiEnvelope<AEApprovalQueueItem[]>>(`${BASE}/plans`, { params: { status: "PENDING_APPROVAL" } });
  return data.data;
};

export const fetchAEApprovalPacket = async (planId: string): Promise<AEApprovalPacket> => {
  if (USE_MOCK) {
    await delay();
    return mockAEApprovalPacket(planId);
  }
  const { data } = await api.get<AEApiEnvelope<AEApprovalPacket>>(`${BASE}/plans/${planId}`);
  return data.data;
};

export const approveAEPlan = async (id: string, acknowledgment: { spend: boolean; activation: boolean }): Promise<AEPlanDetail> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockAEPlanDetail(id), status: "APPROVED" };
  }
  const { data } = await api.post<AEApiEnvelope<AEPlanDetail>>(`${BASE}/plans/${id}/approve`, acknowledgment);
  return data.data;
};

export const rejectAEPlan = async (id: string, reason: string): Promise<AEPlanDetail> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockAEPlanDetail(id), status: "DRAFT" };
  }
  const { data } = await api.post<AEApiEnvelope<AEPlanDetail>>(`${BASE}/plans/${id}/reject`, { reason });
  return data.data;
};

export const revokeAEApproval = async (id: string): Promise<AEPlanDetail> => {
  if (USE_MOCK) {
    await delay();
    return mockAEPlanDetail(id);
  }
  const { data } = await api.post<AEApiEnvelope<AEPlanDetail>>(`${BASE}/plans/${id}/revoke-approval`);
  return data.data;
};

// ─── Queue / cancellation ────────────────────────────────────────────────────

export const queueAEPlan = async (id: string): Promise<{ planId: string; runId: string; jobId: string }> => {
  if (USE_MOCK) {
    await delay(600);
    return { planId: id, runId: "run-" + Date.now(), jobId: "job-" + Date.now() };
  }
  const { data } = await api.post<AEApiEnvelope<{ planId: string; runId: string; jobId: string }>>(`${BASE}/plans/${id}/queue`);
  return data.data;
};

export const cancelAEQueuedPlan = async (id: string, reason?: string): Promise<AEPlanDetail> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockAEPlanDetail(id), status: "CANCELLED" };
  }
  const { data } = await api.post<AEApiEnvelope<AEPlanDetail>>(`${BASE}/plans/${id}/cancel`, { reason });
  return data.data;
};

// ─── Compensation ───────────────────────────────────────────────────────────

export const createAECompensationPlan = async (payload: AECompensationDraftPayload): Promise<AEPlanDetail> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockAEPlanDetail("plan-3"), compensationOriginalPlanId: payload.originalPlanId };
  }
  const { data } = await api.post<AEApiEnvelope<AEPlanDetail>>(`${BASE}/plans/${payload.originalPlanId}/create-compensation`, payload);
  return data.data;
};

// ─── Execution runs ──────────────────────────────────────────────────────────

export const fetchAERuns = async (filters: Partial<AERunFilters>): Promise<AERunListItem[]> => {
  if (USE_MOCK) {
    await delay();
    let rows = [...mockAERuns];
    if (filters.provider && filters.provider !== "all") rows = rows.filter((r) => r.provider === filters.provider);
    if (filters.jobStatus && filters.jobStatus !== "all") rows = rows.filter((r) => r.jobStatus === filters.jobStatus);
    return rows;
  }
  const { data } = await api.get<AEApiEnvelope<AERunListItem[]>>(`${BASE}/runs`, { params: filters });
  return data.data;
};

export const fetchAERunDetail = async (id: string): Promise<AERunDetail> => {
  if (USE_MOCK) {
    await delay();
    return mockAERunDetail(id);
  }
  const { data } = await api.get<AEApiEnvelope<AERunDetail>>(`${BASE}/runs/${id}`);
  return data.data;
};

// ─── Operations / retry ─────────────────────────────────────────────────────

export const fetchAEOperationDetail = async (id: string): Promise<AEOperationDetail> => {
  if (USE_MOCK) {
    await delay();
    return mockAEOperationDetail(id);
  }
  const { data } = await api.get<AEApiEnvelope<AEOperationDetail>>(`${BASE}/operations/${id}`);
  return data.data;
};

export const retryAEOperation = async (payload: AERetryReviewPayload): Promise<AEOperationDetail> => {
  if (USE_MOCK) {
    await delay(600);
    return { ...mockAEOperationDetail(payload.operationId), status: "RETRY_SCHEDULED" };
  }
  const { data } = await api.post<AEApiEnvelope<AEOperationDetail>>(`${BASE}/operations/${payload.operationId}/retry`, payload);
  return data.data;
};

// ─── Drift / incidents ────────────────────────────────────────────────────────

export const fetchAEIncidents = async (filters: Partial<AEIncidentFilters>): Promise<AEIncidentListItem[]> => {
  if (USE_MOCK) {
    await delay();
    let rows = [...mockAEIncidents];
    if (filters.classification && filters.classification !== "all") rows = rows.filter((i) => i.classification === filters.classification);
    if (filters.severity && filters.severity !== "all") rows = rows.filter((i) => i.severity === filters.severity);
    if (filters.provider && filters.provider !== "all") rows = rows.filter((i) => i.provider === filters.provider);
    if (filters.onlyUnresolved) rows = rows.filter((i) => !i.acknowledged);
    return rows;
  }
  const { data } = await api.get<AEApiEnvelope<AEIncidentListItem[]>>(`${BASE}/drift`, { params: filters });
  return data.data;
};

export const fetchAEIncidentDetail = async (id: string): Promise<AEIncidentDetail> => {
  if (USE_MOCK) {
    await delay();
    return mockAEIncidentDetail(id);
  }
  const { data } = await api.get<AEApiEnvelope<AEIncidentDetail>>(`${BASE}/drift/${id}`);
  return data.data;
};

export const acknowledgeAEIncident = async (id: string, reason: string): Promise<AEIncidentDetail> => {
  if (USE_MOCK) {
    await delay();
    return { ...mockAEIncidentDetail(id), acknowledged: true, acknowledgedBy: "You", acknowledgedAt: new Date().toISOString(), acknowledgmentReason: reason };
  }
  const { data } = await api.post<AEApiEnvelope<AEIncidentDetail>>(`${BASE}/drift/${id}/acknowledge`, { reason });
  return data.data;
};

// ─── Creative publications ─────────────────────────────────────────────────────

export const fetchAECreativePublications = async (sourceAssetId?: string): Promise<AECreativePublicationListItem[]> => {
  if (USE_MOCK) {
    await delay();
    return sourceAssetId ? mockAECreativePublications.filter((p) => p.sourceAssetId === sourceAssetId) : mockAECreativePublications;
  }
  const { data } = await api.get<AEApiEnvelope<AECreativePublicationListItem[]>>(`${BASE}/creatives/${sourceAssetId}/publications`);
  return data.data;
};

export const fetchAECreativePublicationDetail = async (id: string): Promise<AECreativePublicationDetail> => {
  if (USE_MOCK) {
    await delay();
    return mockAECreativePublicationDetail(id);
  }
  const { data } = await api.get<AEApiEnvelope<AECreativePublicationDetail>>(`${BASE}/creatives/publications/${id}`);
  return data.data;
};

export const createAECreativePublication = async (
  sourceAssetId: string,
  payload: Record<string, unknown>
): Promise<AECreativePublicationDetail> => {
  if (USE_MOCK) {
    await delay(700);
    return mockAECreativePublicationDetail("pub-2");
  }
  const { data } = await api.post<AEApiEnvelope<AECreativePublicationDetail>>(`${BASE}/creatives/${sourceAssetId}/publications`, payload);
  return data.data;
};

// ─── Recommendation conversion ──────────────────────────────────────────────────

export const fetchAERecommendationConversionContext = async (recommendationId: string): Promise<AERecommendationConversionContext> => {
  if (USE_MOCK) {
    await delay();
    return {
      recommendationId,
      recommendationType: "SCALE",
      evidenceSummary: "CPA has stayed 22% below target for 14 consecutive days.",
      confidence: 0.81,
      suggestedProvider: "META",
      suggestedAccountId: "act_1234567890",
      existingDraftPlanId: null,
    };
  }
  const { data } = await api.get<AEApiEnvelope<AERecommendationConversionContext>>(`${BASE}/recommendations/${recommendationId}`);
  return data.data;
};

export const convertAERecommendationToPlan = async (recommendationId: string): Promise<AEPlanDetail> => {
  if (USE_MOCK) {
    await delay(700);
    return { ...mockAEPlanDetail("plan-1"), source: "RECOMMENDATION", sourceRecommendationId: recommendationId, status: "DRAFT" };
  }
  const { data } = await api.post<AEApiEnvelope<AEPlanDetail>>(`${BASE}/recommendations/${recommendationId}/create-plan`);
  return data.data;
};

// ─── Policies / kill switches / overrides ─────────────────────────────────────

export const fetchAEPolicies = async (): Promise<AEPolicyRow[]> => {
  if (USE_MOCK) {
    await delay();
    return mockAEPolicies;
  }
  const { data } = await api.get<AEApiEnvelope<AEPolicyRow[]>>(`${BASE}/policies`);
  return data.data;
};

export const updateAEPolicy = async (payload: AEPolicyUpdatePayload): Promise<AEPolicyRow> => {
  if (USE_MOCK) {
    await delay();
    const existing = mockAEPolicies.find((p) => p.key === payload.key);
    return {
      key: payload.key,
      scope: payload.scope,
      provider: payload.provider ?? null,
      connectionId: payload.connectionId ?? null,
      currency: payload.currency ?? existing?.currency ?? null,
      configuredValue: payload.value,
      effectiveValue: payload.value,
      effectiveSourceScope: payload.scope,
      version: payload.expectedVersion + 1,
    };
  }
  const { data } = await api.patch<AEApiEnvelope<AEPolicyRow>>(`${BASE}/policies`, payload);
  return data.data;
};

export const fetchAEKillSwitches = async (): Promise<AEKillSwitch[]> => {
  if (USE_MOCK) {
    await delay();
    return mockAEKillSwitches;
  }
  const { data } = await api.get<AEApiEnvelope<AEKillSwitch[]>>(`${BASE}/policies`, { params: { view: "kill-switches" } });
  return data.data;
};

export const requestAEOverride = async (payload: AEOverrideRequestPayload): Promise<AEOverrideRecord> => {
  if (USE_MOCK) {
    await delay(600);
    return {
      id: "override-" + Date.now(),
      scope: payload.scope,
      scopeId: payload.scopeId,
      actorLabel: "You",
      controlsBypassed: payload.controlsRequested,
      nonOverridableControls: ["EXECUTION_SELF_APPROVAL_FORBIDDEN"],
      justification: payload.justification,
      createdAt: new Date().toISOString(),
      expiresAt: payload.expiresAt,
      usedAt: null,
      revokedAt: null,
    };
  }
  const { data } = await api.post<AEApiEnvelope<AEOverrideRecord>>(`${BASE}/overrides`, payload);
  return data.data;
};

export const fetchAEOverrides = async (): Promise<AEOverrideRecord[]> => {
  if (USE_MOCK) {
    await delay();
    return mockAEOverrides;
  }
  const { data } = await api.get<AEApiEnvelope<AEOverrideRecord[]>>(`${BASE}/overrides`);
  return data.data;
};

// ─── Health ─────────────────────────────────────────────────────────────────

export const fetchAEHealth = async (): Promise<AEHealthResponse> => {
  if (USE_MOCK) {
    await delay();
    return mockAEHealth;
  }
  const { data } = await api.get<AEApiEnvelope<AEHealthResponse>>(`${BASE}/health`);
  return data.data;
};