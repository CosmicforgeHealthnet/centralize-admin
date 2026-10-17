import { create } from "zustand";
import type {
  AMIOverviewResponse,
  AMIProviderValidationRow,
  AMICreativeListItem,
  AMICreativeDetail,
  AMICreativeFilters,
  AMIRecommendationListItem,
  AMIRecommendationDetail,
  AMIRecommendationFilters,
  AMIConvertToTaskPayload,
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
  AMISettingVersionConflict,
} from "@/types/ai-marketing-intelligence.types";
import {
  fetchAMIOverview,
  fetchAMIProviderValidation,
  fetchAMICreatives,
  fetchAMICreativeDetail,
  fetchAMIRecommendations,
  fetchAMIRecommendationDetail,
  acceptAMIRecommendation,
  dismissAMIRecommendation,
  fetchAMIEligibleAssignees,
  convertAMIRecommendationToTask,
  fetchAMIAlerts,
  fetchAMIAlertDetail,
  acknowledgeAMIAlert,
  resolveAMIAlert,
  fetchAMIExperiments,
  fetchAMIExperimentDetail,
  createAMIExperiment,
  updateAMIExperiment,
  startAMIExperiment,
  completeAMIExperiment,
  cancelAMIExperiment,
  fetchAMIEvaluationRuns,
  fetchAMIEvaluationRunDetail,
  runAMIManualOperation,
  fetchAMISettings,
  updateAMISetting,
} from "@/lib/ai-marketing-intelligence.service";

// Maps HTTP status/code to actionable message — same pattern as Phase 1 MI store.
function resolveErrorMessage(err: any, fallback: string): string {
  const status = err?.response?.status;
  const code = err?.response?.data?.code;
  if (status === 401) return "Your session has expired. Please sign in again.";
  if (status === 403) return "You don't have permission for this action (requires marketing/intelligence access).";
  if (code === "MARKETING_INTELLIGENCE_PHASE2_DISABLED") return "Phase 2 is installed in this environment but operational evaluation is disabled.";
  if (code === "MARKETING_ASSIGNEE_UNAVAILABLE") return "No eligible Marketing administrator is available for assignment.";
  if (code === "LOCK_CONFLICT") return "This operation is already running. View the active run for status.";
  return err?.response?.data?.message || fallback;
}

const today = new Date().toISOString().slice(0, 10);
const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);

const defaultCreativeFilters: AMICreativeFilters = {
  platform: "all",
  connectionId: "all",
  campaignExternalId: "",
  creativeType: "all",
  providerStatus: "",
  dataSufficiency: "all",
  fatigueStatus: "all",
  minScore: null,
  maxScore: null,
  currency: "all",
  from: fourteenDaysAgo,
  to: today,
  search: "",
};

const defaultRecommendationFilters: AMIRecommendationFilters = {
  type: "all",
  status: "all",
  platform: "all",
  connectionId: "all",
  campaignExternalId: "",
  currency: "all",
  minConfidence: null,
  maxConfidence: null,
  generatedFrom: "",
  generatedTo: "",
  onlyActionable: false,
  onlyAwaitingTaskConversion: false,
};

const defaultAlertFilters: AMIAlertFilters = {
  status: "all",
  severity: "all",
  type: "all",
  platform: "all",
  connectionId: "all",
  campaignExternalId: "",
  from: "",
  to: "",
  tab: "all",
};

const defaultExperimentFilters: AMIExperimentFilters = {
  status: "all",
  platform: "all",
  metric: "all",
  createdFrom: "",
  createdTo: "",
};

const defaultRunFilters: AMIEvaluationRunFilters = {
  runType: "all",
  status: "all",
  platform: "all",
  from: "",
  to: "",
};

interface AIMarketingIntelligenceState {
  // ── Overview ──────────────────────────────────────────────────────────────
  overview: AMIOverviewResponse | null;
  isLoadingOverview: boolean;

  // ── Provider validation ───────────────────────────────────────────────────
  providerValidation: AMIProviderValidationRow[];
  isLoadingProviderValidation: boolean;

  // ── Creatives ─────────────────────────────────────────────────────────────
  creatives: AMICreativeListItem[];
  creativeFilters: AMICreativeFilters;
  isLoadingCreatives: boolean;
  creativeDetail: AMICreativeDetail | null;
  isLoadingCreativeDetail: boolean;

  // ── Recommendations ───────────────────────────────────────────────────────
  recommendations: AMIRecommendationListItem[];
  recommendationFilters: AMIRecommendationFilters;
  isLoadingRecommendations: boolean;
  recommendationDetail: AMIRecommendationDetail | null;
  isLoadingRecommendationDetail: boolean;
  eligibleAssignees: AMIEligibleAssignee[];
  isConvertingToTask: boolean;

  // ── Alerts ────────────────────────────────────────────────────────────────
  alerts: AMIAlertListItem[];
  alertFilters: AMIAlertFilters;
  isLoadingAlerts: boolean;
  alertDetail: AMIAlertDetail | null;
  isLoadingAlertDetail: boolean;

  // ── Experiments ───────────────────────────────────────────────────────────
  experiments: AMIExperimentListItem[];
  experimentFilters: AMIExperimentFilters;
  isLoadingExperiments: boolean;
  experimentDetail: AMIExperimentDetail | null;
  isLoadingExperimentDetail: boolean;

  // ── Evaluation runs ───────────────────────────────────────────────────────
  evaluationRuns: AMIEvaluationRunListItem[];
  runFilters: AMIEvaluationRunFilters;
  isLoadingRuns: boolean;
  runDetail: AMIEvaluationRunDetail | null;
  isLoadingRunDetail: boolean;

  // ── Manual operations ─────────────────────────────────────────────────────
  isRunningOperation: boolean;
  lastOperationResult: AMIManualOperationResult | null;

  // ── Settings ──────────────────────────────────────────────────────────────
  settings: AMISettingRow[];
  isLoadingSettings: boolean;
  settingConflict: AMISettingVersionConflict | null;

  actionLoading: string | null;
  error: string | null;

  // ── Actions ───────────────────────────────────────────────────────────────
  fetchOverview: () => Promise<void>;
  fetchProviderValidation: () => Promise<void>;

  fetchCreatives: () => Promise<void>;
  setCreativeFilters: (f: Partial<AMICreativeFilters>) => void;
  fetchCreativeDetail: (id: string) => Promise<void>;

  fetchRecommendations: () => Promise<void>;
  setRecommendationFilters: (f: Partial<AMIRecommendationFilters>) => void;
  fetchRecommendationDetail: (id: string) => Promise<void>;
  acceptRecommendation: (id: string) => Promise<void>;
  dismissRecommendation: (id: string, reason?: string) => Promise<void>;
  loadEligibleAssignees: () => Promise<void>;
  convertRecommendation: (id: string, payload: AMIConvertToTaskPayload) => Promise<{ success: boolean; needsAssignee?: boolean }>;

  fetchAlerts: () => Promise<void>;
  setAlertFilters: (f: Partial<AMIAlertFilters>) => void;
  fetchAlertDetail: (id: string) => Promise<void>;
  acknowledgeAlert: (id: string) => Promise<void>;
  resolveAlert: (id: string, reason?: string) => Promise<void>;

  fetchExperiments: () => Promise<void>;
  setExperimentFilters: (f: Partial<AMIExperimentFilters>) => void;
  fetchExperimentDetail: (id: string) => Promise<void>;
  createExperiment: (payload: AMIExperimentFormPayload) => Promise<AMIExperimentDetail | null>;
  updateExperiment: (id: string, payload: Partial<AMIExperimentFormPayload>) => Promise<void>;
  startExperiment: (id: string) => Promise<void>;
  completeExperiment: (id: string, payload: { result: string; conclusion?: string }) => Promise<void>;
  cancelExperiment: (id: string, reason?: string) => Promise<void>;

  fetchEvaluationRuns: () => Promise<void>;
  setRunFilters: (f: Partial<AMIEvaluationRunFilters>) => void;
  fetchRunDetail: (id: string) => Promise<void>;

  runManualOperation: (payload: AMIManualOperationPayload) => Promise<void>;

  fetchSettings: () => Promise<void>;
  updateSetting: (payload: AMISettingUpdatePayload) => Promise<{ success: boolean }>;
  clearSettingConflict: () => void;

  clearError: () => void;
}

export const useAIMarketingIntelligenceStore = create<AIMarketingIntelligenceState>((set, get) => ({
  overview: null,
  isLoadingOverview: false,

  providerValidation: [],
  isLoadingProviderValidation: false,

  creatives: [],
  creativeFilters: { ...defaultCreativeFilters },
  isLoadingCreatives: false,
  creativeDetail: null,
  isLoadingCreativeDetail: false,

  recommendations: [],
  recommendationFilters: { ...defaultRecommendationFilters },
  isLoadingRecommendations: false,
  recommendationDetail: null,
  isLoadingRecommendationDetail: false,
  eligibleAssignees: [],
  isConvertingToTask: false,

  alerts: [],
  alertFilters: { ...defaultAlertFilters },
  isLoadingAlerts: false,
  alertDetail: null,
  isLoadingAlertDetail: false,

  experiments: [],
  experimentFilters: { ...defaultExperimentFilters },
  isLoadingExperiments: false,
  experimentDetail: null,
  isLoadingExperimentDetail: false,

  evaluationRuns: [],
  runFilters: { ...defaultRunFilters },
  isLoadingRuns: false,
  runDetail: null,
  isLoadingRunDetail: false,

  isRunningOperation: false,
  lastOperationResult: null,

  settings: [],
  isLoadingSettings: false,
  settingConflict: null,

  actionLoading: null,
  error: null,

  // ── Overview ────────────────────────────────────────────────────────────
  fetchOverview: async () => {
    set({ isLoadingOverview: true, error: null });
    try {
      const overview = await fetchAMIOverview();
      set({ overview, isLoadingOverview: false });
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to fetch overview"), isLoadingOverview: false });
    }
  },

  // ── Provider validation ─────────────────────────────────────────────────
  fetchProviderValidation: async () => {
    set({ isLoadingProviderValidation: true, error: null });
    try {
      const providerValidation = await fetchAMIProviderValidation();
      set({ providerValidation, isLoadingProviderValidation: false });
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to fetch provider validation"), isLoadingProviderValidation: false });
    }
  },

  // ── Creatives ─────────────────────────────────────────────────────────────
  fetchCreatives: async () => {
    set({ isLoadingCreatives: true, error: null });
    try {
      const { creativeFilters } = get();
      const creatives = await fetchAMICreatives(creativeFilters);
      set({ creatives, isLoadingCreatives: false });
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to fetch creatives"), isLoadingCreatives: false });
    }
  },
  setCreativeFilters: (f) => {
    set((s) => ({ creativeFilters: { ...s.creativeFilters, ...f } }));
    get().fetchCreatives();
  },
  fetchCreativeDetail: async (id) => {
    set({ isLoadingCreativeDetail: true, error: null });
    try {
      const creativeDetail = await fetchAMICreativeDetail(id);
      set({ creativeDetail, isLoadingCreativeDetail: false });
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to fetch creative detail"), isLoadingCreativeDetail: false });
    }
  },

  // ── Recommendations ───────────────────────────────────────────────────────
  fetchRecommendations: async () => {
    set({ isLoadingRecommendations: true, error: null });
    try {
      const { recommendationFilters } = get();
      const recommendations = await fetchAMIRecommendations(recommendationFilters);
      set({ recommendations, isLoadingRecommendations: false });
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to fetch recommendations"), isLoadingRecommendations: false });
    }
  },
  setRecommendationFilters: (f) => {
    set((s) => ({ recommendationFilters: { ...s.recommendationFilters, ...f } }));
    get().fetchRecommendations();
  },
  fetchRecommendationDetail: async (id) => {
    set({ isLoadingRecommendationDetail: true, error: null });
    try {
      const recommendationDetail = await fetchAMIRecommendationDetail(id);
      set({ recommendationDetail, isLoadingRecommendationDetail: false });
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to fetch recommendation detail"), isLoadingRecommendationDetail: false });
    }
  },
  acceptRecommendation: async (id) => {
    set({ actionLoading: `accept-${id}`, error: null });
    try {
      const updated = await acceptAMIRecommendation(id);
      set((s) => ({
        recommendationDetail: s.recommendationDetail?.id === id ? updated : s.recommendationDetail,
        recommendations: s.recommendations.map((r) => (r.id === id ? { ...r, status: "ACCEPTED" } : r)),
        actionLoading: null,
      }));
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to accept recommendation"), actionLoading: null });
    }
  },
  dismissRecommendation: async (id, reason) => {
    set({ actionLoading: `dismiss-${id}`, error: null });
    try {
      const updated = await dismissAMIRecommendation(id, reason);
      set((s) => ({
        recommendationDetail: s.recommendationDetail?.id === id ? updated : s.recommendationDetail,
        recommendations: s.recommendations.map((r) => (r.id === id ? { ...r, status: "DISMISSED" } : r)),
        actionLoading: null,
      }));
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to dismiss recommendation"), actionLoading: null });
    }
  },
  loadEligibleAssignees: async () => {
    try {
      const eligibleAssignees = await fetchAMIEligibleAssignees();
      set({ eligibleAssignees });
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to load eligible assignees") });
    }
  },
  convertRecommendation: async (id, payload) => {
    set({ isConvertingToTask: true, error: null });
    try {
      const result = await convertAMIRecommendationToTask(id, payload);
      set((s) => ({
        recommendationDetail:
          s.recommendationDetail?.id === id
            ? { ...s.recommendationDetail, status: "CONVERTED_TO_TASK", convertedTaskId: result.taskId }
            : s.recommendationDetail,
        recommendations: s.recommendations.map((r) => (r.id === id ? { ...r, status: "CONVERTED_TO_TASK" } : r)),
        isConvertingToTask: false,
      }));
      return { success: true };
    } catch (err: any) {
      const code = err?.response?.data?.code;
      if (code === "MARKETING_ASSIGNEE_UNAVAILABLE") {
        set({ isConvertingToTask: false, error: resolveErrorMessage(err, "No eligible assignee available") });
        return { success: false, needsAssignee: true };
      }
      set({ error: resolveErrorMessage(err, "Failed to convert recommendation to task"), isConvertingToTask: false });
      return { success: false };
    }
  },

  // ── Alerts ────────────────────────────────────────────────────────────────
  fetchAlerts: async () => {
    set({ isLoadingAlerts: true, error: null });
    try {
      const { alertFilters } = get();
      const alerts = await fetchAMIAlerts(alertFilters);
      set({ alerts, isLoadingAlerts: false });
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to fetch alerts"), isLoadingAlerts: false });
    }
  },
  setAlertFilters: (f) => {
    set((s) => ({ alertFilters: { ...s.alertFilters, ...f } }));
    get().fetchAlerts();
  },
  fetchAlertDetail: async (id) => {
    set({ isLoadingAlertDetail: true, error: null });
    try {
      const alertDetail = await fetchAMIAlertDetail(id);
      set({ alertDetail, isLoadingAlertDetail: false });
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to fetch alert detail"), isLoadingAlertDetail: false });
    }
  },
  acknowledgeAlert: async (id) => {
    set({ actionLoading: `ack-${id}`, error: null });
    try {
      const updated = await acknowledgeAMIAlert(id);
      set((s) => ({
        alertDetail: s.alertDetail?.id === id ? updated : s.alertDetail,
        alerts: s.alerts.map((a) => (a.id === id ? { ...a, status: "ACKNOWLEDGED" } : a)),
        actionLoading: null,
      }));
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to acknowledge alert"), actionLoading: null });
    }
  },
  resolveAlert: async (id, reason) => {
    set({ actionLoading: `resolve-${id}`, error: null });
    try {
      const updated = await resolveAMIAlert(id, reason);
      set((s) => ({
        alertDetail: s.alertDetail?.id === id ? updated : s.alertDetail,
        alerts: s.alerts.map((a) => (a.id === id ? { ...a, status: "RESOLVED" } : a)),
        actionLoading: null,
      }));
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to resolve alert"), actionLoading: null });
    }
  },

  // ── Experiments ───────────────────────────────────────────────────────────
  fetchExperiments: async () => {
    set({ isLoadingExperiments: true, error: null });
    try {
      const { experimentFilters } = get();
      const experiments = await fetchAMIExperiments(experimentFilters);
      set({ experiments, isLoadingExperiments: false });
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to fetch experiments"), isLoadingExperiments: false });
    }
  },
  setExperimentFilters: (f) => {
    set((s) => ({ experimentFilters: { ...s.experimentFilters, ...f } }));
    get().fetchExperiments();
  },
  fetchExperimentDetail: async (id) => {
    set({ isLoadingExperimentDetail: true, error: null });
    try {
      const experimentDetail = await fetchAMIExperimentDetail(id);
      set({ experimentDetail, isLoadingExperimentDetail: false });
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to fetch experiment detail"), isLoadingExperimentDetail: false });
    }
  },
  createExperiment: async (payload) => {
    set({ actionLoading: "create-experiment", error: null });
    try {
      const created = await createAMIExperiment(payload);
      await get().fetchExperiments();
      set({ actionLoading: null });
      return created;
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to create experiment"), actionLoading: null });
      return null;
    }
  },
  updateExperiment: async (id, payload) => {
    set({ actionLoading: `update-${id}`, error: null });
    try {
      const updated = await updateAMIExperiment(id, payload);
      set((s) => ({ experimentDetail: s.experimentDetail?.id === id ? updated : s.experimentDetail, actionLoading: null }));
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to update experiment"), actionLoading: null });
    }
  },
  startExperiment: async (id) => {
    set({ actionLoading: `start-${id}`, error: null });
    try {
      const updated = await startAMIExperiment(id);
      set((s) => ({
        experimentDetail: s.experimentDetail?.id === id ? updated : s.experimentDetail,
        experiments: s.experiments.map((e) => (e.id === id ? { ...e, status: "RUNNING" } : e)),
        actionLoading: null,
      }));
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to start experiment"), actionLoading: null });
    }
  },
  completeExperiment: async (id, payload) => {
    set({ actionLoading: `complete-${id}`, error: null });
    try {
      const updated = await completeAMIExperiment(id, payload);
      set((s) => ({
        experimentDetail: s.experimentDetail?.id === id ? updated : s.experimentDetail,
        experiments: s.experiments.map((e) => (e.id === id ? { ...e, status: "COMPLETED" } : e)),
        actionLoading: null,
      }));
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to complete experiment"), actionLoading: null });
    }
  },
  cancelExperiment: async (id, reason) => {
    set({ actionLoading: `cancel-${id}`, error: null });
    try {
      const updated = await cancelAMIExperiment(id, reason);
      set((s) => ({
        experimentDetail: s.experimentDetail?.id === id ? updated : s.experimentDetail,
        experiments: s.experiments.map((e) => (e.id === id ? { ...e, status: "CANCELLED" } : e)),
        actionLoading: null,
      }));
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to cancel experiment"), actionLoading: null });
    }
  },

  // ── Evaluation runs ───────────────────────────────────────────────────────
  fetchEvaluationRuns: async () => {
    set({ isLoadingRuns: true, error: null });
    try {
      const { runFilters } = get();
      const evaluationRuns = await fetchAMIEvaluationRuns(runFilters);
      set({ evaluationRuns, isLoadingRuns: false });
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to fetch evaluation runs"), isLoadingRuns: false });
    }
  },
  setRunFilters: (f) => {
    set((s) => ({ runFilters: { ...s.runFilters, ...f } }));
    get().fetchEvaluationRuns();
  },
  fetchRunDetail: async (id) => {
    set({ isLoadingRunDetail: true, error: null });
    try {
      const runDetail = await fetchAMIEvaluationRunDetail(id);
      set({ runDetail, isLoadingRunDetail: false });
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to fetch run detail"), isLoadingRunDetail: false });
    }
  },

  // ── Manual operations ─────────────────────────────────────────────────────
  runManualOperation: async (payload) => {
    set({ isRunningOperation: true, error: null });
    try {
      const result = await runAMIManualOperation(payload);
      set({ lastOperationResult: result, isRunningOperation: false });
      await get().fetchEvaluationRuns();
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Manual operation failed"), isRunningOperation: false });
    }
  },

  // ── Settings ──────────────────────────────────────────────────────────────
  fetchSettings: async () => {
    set({ isLoadingSettings: true, error: null });
    try {
      const settings = await fetchAMISettings();
      set({ settings, isLoadingSettings: false });
    } catch (err: unknown) {
      set({ error: resolveErrorMessage(err, "Failed to fetch settings"), isLoadingSettings: false });
    }
  },
  updateSetting: async (payload) => {
    set({ actionLoading: `setting-${payload.key}`, error: null });
    try {
      const updated = await updateAMISetting(payload);
      set((s) => ({
        settings: s.settings.map((row) =>
          row.key === payload.key && row.scope === payload.scope && row.connectionId === (payload.connectionId ?? null)
            ? updated
            : row
        ),
        actionLoading: null,
      }));
      return { success: true };
    } catch (err: any) {
      const code = err?.response?.data?.code;
      if (code === "STALE_VERSION" || code === "SETTING_VERSION_CONFLICT") {
        set({
          actionLoading: null,
          settingConflict: {
            key: payload.key,
            serverValue: err?.response?.data?.serverValue ?? null,
            serverVersion: err?.response?.data?.serverVersion ?? payload.expectedVersion + 1,
            draftValue: payload.value,
          },
        });
        return { success: false };
      }
      set({ error: resolveErrorMessage(err, "Failed to update setting"), actionLoading: null });
      return { success: false };
    }
  },
  clearSettingConflict: () => set({ settingConflict: null }),

  clearError: () => set({ error: null }),
}));