import { create } from "zustand";
import type {
  AdminOpsPagination,
  AdminOpsFilters,
  ServiceRegistry,
  RegisterServicePayload,
  JobExecution,
  TrackJobPayload,
  DeadLetterJob,
  WebhookEndpoint,
  WebhookPayload,
  WebhookDeliveryLog,
  Incident,
  IncidentPayload,
  SystemAlert,
  AlertPayload,
  FeatureFlag,
  FeatureFlagPayload,
  HealthCheckRecord,
  EnvConfig,
  EnvConfigPayload,
} from "@/types/admin-ops.types";
import {
  fetchServices, fetchService, registerService, updateService, deregisterService, pingService,
  fetchJobs, trackJob,
  fetchDeadLetters, resolveDeadLetter,
  fetchWebhooks, createWebhook, updateWebhook, deleteWebhook,
  fetchWebhookLogs,
  fetchIncidents, createIncident, updateIncident, resolveIncident,
  fetchAlerts, createAlert, markAlertRead, resolveAlert,
  fetchFlags, createFlag, updateFlag, deleteFlag,
  fetchHealthHistory, fetchLatestHealthCheck,
  fetchEnvConfigs, createEnvConfig, updateEnvConfig, deleteEnvConfig,
} from "@/lib/admin-ops.service";

const defaultFilters: AdminOpsFilters = { search: "", status: "", page: 1, limit: 20 };

const buildPagination = (res: { total: number; page: number; limit: number }): AdminOpsPagination => ({
  currentPage: res.page,
  totalPages: Math.ceil(res.total / res.limit),
  totalItems: res.total,
});

interface AdminOpsState {
  // Services
  services: ServiceRegistry[];
  servicePagination: AdminOpsPagination | null;
  serviceFilters: AdminOpsFilters;
  isLoadingServices: boolean;

  // Jobs
  jobs: JobExecution[];
  jobPagination: AdminOpsPagination | null;
  jobFilters: AdminOpsFilters;
  isLoadingJobs: boolean;

  // Dead Letters
  deadLetters: DeadLetterJob[];
  deadLetterPagination: AdminOpsPagination | null;
  deadLetterFilters: AdminOpsFilters;
  isLoadingDeadLetters: boolean;

  // Webhooks
  webhooks: WebhookEndpoint[];
  webhookPagination: AdminOpsPagination | null;
  webhookFilters: AdminOpsFilters;
  isLoadingWebhooks: boolean;

  // Webhook Logs
  webhookLogs: WebhookDeliveryLog[];
  webhookLogPagination: AdminOpsPagination | null;
  webhookLogFilters: AdminOpsFilters;
  isLoadingWebhookLogs: boolean;

  // Incidents
  incidents: Incident[];
  incidentPagination: AdminOpsPagination | null;
  incidentFilters: AdminOpsFilters;
  isLoadingIncidents: boolean;

  // Alerts
  alerts: SystemAlert[];
  alertPagination: AdminOpsPagination | null;
  alertFilters: AdminOpsFilters;
  isLoadingAlerts: boolean;
  unreadAlertCount: number;

  // Feature Flags
  flags: FeatureFlag[];
  flagPagination: AdminOpsPagination | null;
  flagFilters: AdminOpsFilters;
  isLoadingFlags: boolean;

  // Health History
  healthHistory: HealthCheckRecord[];
  healthPagination: AdminOpsPagination | null;
  healthFilters: AdminOpsFilters;
  latestHealth: HealthCheckRecord | null;
  isLoadingHealth: boolean;

  // Env Configs
  envConfigs: EnvConfig[];
  envConfigPagination: AdminOpsPagination | null;
  envConfigFilters: AdminOpsFilters;
  isLoadingEnvConfigs: boolean;

  actionLoading: string | null;
  error: string | null;

  // Service actions
  fetchServices: () => Promise<void>;
  setServiceFilters: (f: Partial<AdminOpsFilters>) => void;
  pingService: (id: string) => Promise<void>;
  registerService: (payload: RegisterServicePayload) => Promise<void>;
  updateService: (id: string, payload: Partial<RegisterServicePayload>) => Promise<void>;
  deregisterService: (id: string) => Promise<void>;

  // Job actions
  fetchJobs: () => Promise<void>;
  setJobFilters: (f: Partial<AdminOpsFilters>) => void;
  trackJob: (payload: TrackJobPayload) => Promise<void>;

  // Dead letter actions
  fetchDeadLetters: () => Promise<void>;
  setDeadLetterFilters: (f: Partial<AdminOpsFilters>) => void;
  resolveDeadLetter: (id: string) => Promise<void>;

  // Webhook actions
  fetchWebhooks: () => Promise<void>;
  setWebhookFilters: (f: Partial<AdminOpsFilters>) => void;
  createWebhook: (payload: WebhookPayload) => Promise<void>;
  updateWebhook: (id: string, payload: Partial<WebhookPayload>) => Promise<void>;
  deleteWebhook: (id: string) => Promise<void>;

  // Webhook log actions
  fetchWebhookLogs: () => Promise<void>;
  setWebhookLogFilters: (f: Partial<AdminOpsFilters>) => void;

  // Incident actions
  fetchIncidents: () => Promise<void>;
  setIncidentFilters: (f: Partial<AdminOpsFilters>) => void;
  createIncident: (payload: IncidentPayload) => Promise<void>;
  updateIncident: (id: string, payload: Partial<IncidentPayload & { status: string }>) => Promise<void>;
  resolveIncident: (id: string) => Promise<void>;

  // Alert actions
  fetchAlerts: () => Promise<void>;
  setAlertFilters: (f: Partial<AdminOpsFilters>) => void;
  createAlert: (payload: AlertPayload) => Promise<void>;
  markAlertRead: (id: string) => Promise<void>;
  resolveAlert: (id: string) => Promise<void>;

  // Flag actions
  fetchFlags: () => Promise<void>;
  setFlagFilters: (f: Partial<AdminOpsFilters>) => void;
  createFlag: (payload: FeatureFlagPayload) => Promise<void>;
  updateFlag: (key: string, payload: Partial<FeatureFlagPayload>) => Promise<void>;
  deleteFlag: (key: string) => Promise<void>;
  toggleFlag: (key: string, isEnabled: boolean) => Promise<void>;

  // Health actions
  fetchHealthHistory: () => Promise<void>;
  setHealthFilters: (f: Partial<AdminOpsFilters>) => void;
  fetchLatestHealth: () => Promise<void>;

  // Env config actions
  fetchEnvConfigs: () => Promise<void>;
  setEnvConfigFilters: (f: Partial<AdminOpsFilters>) => void;
  createEnvConfig: (payload: EnvConfigPayload) => Promise<void>;
  updateEnvConfig: (id: string, payload: Partial<EnvConfigPayload>) => Promise<void>;
  deleteEnvConfig: (id: string) => Promise<void>;

  clearError: () => void;
}

export const useAdminOpsStore = create<AdminOpsState>((set, get) => ({
  services: [], servicePagination: null, serviceFilters: { ...defaultFilters }, isLoadingServices: false,
  jobs: [], jobPagination: null, jobFilters: { ...defaultFilters }, isLoadingJobs: false,
  deadLetters: [], deadLetterPagination: null, deadLetterFilters: { ...defaultFilters }, isLoadingDeadLetters: false,
  webhooks: [], webhookPagination: null, webhookFilters: { ...defaultFilters }, isLoadingWebhooks: false,
  webhookLogs: [], webhookLogPagination: null, webhookLogFilters: { ...defaultFilters }, isLoadingWebhookLogs: false,
  incidents: [], incidentPagination: null, incidentFilters: { ...defaultFilters }, isLoadingIncidents: false,
  alerts: [], alertPagination: null, alertFilters: { ...defaultFilters }, isLoadingAlerts: false, unreadAlertCount: 0,
  flags: [], flagPagination: null, flagFilters: { ...defaultFilters }, isLoadingFlags: false,
  healthHistory: [], healthPagination: null, healthFilters: { ...defaultFilters }, latestHealth: null, isLoadingHealth: false,
  envConfigs: [], envConfigPagination: null, envConfigFilters: { ...defaultFilters }, isLoadingEnvConfigs: false,
  actionLoading: null,
  error: null,

  // ── Services ──────────────────────────────────────────────────────────────
  fetchServices: async () => {
    const { serviceFilters: f } = get();
    set({ isLoadingServices: true, error: null });
    try {
      const res = await fetchServices({ status: f.status || undefined, page: f.page, limit: f.limit });
      set({ services: res.data, servicePagination: buildPagination(res), isLoadingServices: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch services", isLoadingServices: false });
    }
  },
  setServiceFilters: (f) => set((s) => ({ serviceFilters: { ...s.serviceFilters, ...f } })),
  pingService: async (id) => {
    set({ actionLoading: id });
    try {
      const updated = await pingService(id);
      set((s) => ({ services: s.services.map((sv) => sv.id === id ? { ...sv, ...updated } : sv), actionLoading: null }));
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Ping failed", actionLoading: null });
    }
  },
  registerService: async (payload) => {
    set({ actionLoading: "create" });
    try {
      await registerService(payload);
      await get().fetchServices();
      set({ actionLoading: null });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to register service", actionLoading: null });
    }
  },
  updateService: async (id, payload) => {
    set({ actionLoading: id });
    try {
      await updateService(id, payload);
      await get().fetchServices();
      set({ actionLoading: null });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to update service", actionLoading: null });
    }
  },
  deregisterService: async (id) => {
    set({ actionLoading: id });
    try {
      await deregisterService(id);
      set((s) => ({ services: s.services.filter((sv) => sv.id !== id), actionLoading: null }));
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to deregister service", actionLoading: null });
    }
  },

  // ── Jobs ──────────────────────────────────────────────────────────────────
  fetchJobs: async () => {
    const { jobFilters: f } = get();
    set({ isLoadingJobs: true, error: null });
    try {
      const res = await fetchJobs({ status: f.status || undefined, page: f.page, limit: f.limit });
      set({ jobs: res.data, jobPagination: buildPagination(res), isLoadingJobs: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch jobs", isLoadingJobs: false });
    }
  },
  setJobFilters: (f) => set((s) => ({ jobFilters: { ...s.jobFilters, ...f } })),
  trackJob: async (payload) => {
    set({ actionLoading: "track" });
    try {
      await trackJob(payload);
      await get().fetchJobs();
      set({ actionLoading: null });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to track job", actionLoading: null });
    }
  },

  // ── Dead Letters ──────────────────────────────────────────────────────────
  fetchDeadLetters: async () => {
    const { deadLetterFilters: f } = get();
    set({ isLoadingDeadLetters: true, error: null });
    try {
      const res = await fetchDeadLetters({ status: f.status || undefined, page: f.page, limit: f.limit });
      set({ deadLetters: res.data, deadLetterPagination: buildPagination(res), isLoadingDeadLetters: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch dead letters", isLoadingDeadLetters: false });
    }
  },
  setDeadLetterFilters: (f) => set((s) => ({ deadLetterFilters: { ...s.deadLetterFilters, ...f } })),
  resolveDeadLetter: async (id) => {
    set({ actionLoading: id });
    try {
      const updated = await resolveDeadLetter(id);
      set((s) => ({ deadLetters: s.deadLetters.map((d) => d.id === id ? updated : d), actionLoading: null }));
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to resolve dead letter", actionLoading: null });
    }
  },

  // ── Webhooks ──────────────────────────────────────────────────────────────
  fetchWebhooks: async () => {
    const { webhookFilters: f } = get();
    set({ isLoadingWebhooks: true, error: null });
    try {
      const res = await fetchWebhooks({ page: f.page, limit: f.limit });
      set({ webhooks: res.data, webhookPagination: buildPagination(res), isLoadingWebhooks: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch webhooks", isLoadingWebhooks: false });
    }
  },
  setWebhookFilters: (f) => set((s) => ({ webhookFilters: { ...s.webhookFilters, ...f } })),
  createWebhook: async (payload) => {
    set({ actionLoading: "create" });
    try {
      await createWebhook(payload);
      await get().fetchWebhooks();
      set({ actionLoading: null });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to create webhook", actionLoading: null });
    }
  },
  updateWebhook: async (id, payload) => {
    set({ actionLoading: id });
    try {
      await updateWebhook(id, payload);
      await get().fetchWebhooks();
      set({ actionLoading: null });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to update webhook", actionLoading: null });
    }
  },
  deleteWebhook: async (id) => {
    set({ actionLoading: id });
    try {
      await deleteWebhook(id);
      set((s) => ({ webhooks: s.webhooks.filter((w) => w.id !== id), actionLoading: null }));
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to delete webhook", actionLoading: null });
    }
  },

  // ── Webhook Logs ──────────────────────────────────────────────────────────
  fetchWebhookLogs: async () => {
    const { webhookLogFilters: f } = get();
    set({ isLoadingWebhookLogs: true, error: null });
    try {
      const res = await fetchWebhookLogs({ status: f.status || undefined, page: f.page, limit: f.limit });
      set({ webhookLogs: res.data, webhookLogPagination: buildPagination(res), isLoadingWebhookLogs: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch webhook logs", isLoadingWebhookLogs: false });
    }
  },
  setWebhookLogFilters: (f) => set((s) => ({ webhookLogFilters: { ...s.webhookLogFilters, ...f } })),

  // ── Incidents ─────────────────────────────────────────────────────────────
  fetchIncidents: async () => {
    const { incidentFilters: f } = get();
    set({ isLoadingIncidents: true, error: null });
    try {
      const res = await fetchIncidents({ status: f.status || undefined, page: f.page, limit: f.limit });
      set({ incidents: res.data, incidentPagination: buildPagination(res), isLoadingIncidents: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch incidents", isLoadingIncidents: false });
    }
  },
  setIncidentFilters: (f) => set((s) => ({ incidentFilters: { ...s.incidentFilters, ...f } })),
  createIncident: async (payload) => {
    set({ actionLoading: "create" });
    try {
      await createIncident(payload);
      await get().fetchIncidents();
      set({ actionLoading: null });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to create incident", actionLoading: null });
    }
  },
  updateIncident: async (id, payload) => {
    set({ actionLoading: id });
    try {
      await updateIncident(id, payload);
      await get().fetchIncidents();
      set({ actionLoading: null });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to update incident", actionLoading: null });
    }
  },
  resolveIncident: async (id) => {
    set({ actionLoading: id });
    try {
      const updated = await resolveIncident(id);
      set((s) => ({ incidents: s.incidents.map((i) => i.id === id ? updated : i), actionLoading: null }));
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to resolve incident", actionLoading: null });
    }
  },

  // ── Alerts ────────────────────────────────────────────────────────────────
  fetchAlerts: async () => {
    const { alertFilters: f } = get();
    set({ isLoadingAlerts: true, error: null });
    try {
      const res = await fetchAlerts({ isResolved: f.status === "resolved" ? true : f.status === "active" ? false : undefined, page: f.page, limit: f.limit });
      const unread = res.data.filter((a) => !a.isRead).length;
      set({ alerts: res.data, alertPagination: buildPagination(res), unreadAlertCount: unread, isLoadingAlerts: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch alerts", isLoadingAlerts: false });
    }
  },
  setAlertFilters: (f) => set((s) => ({ alertFilters: { ...s.alertFilters, ...f } })),
  createAlert: async (payload) => {
    set({ actionLoading: "create" });
    try {
      await createAlert(payload);
      await get().fetchAlerts();
      set({ actionLoading: null });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to create alert", actionLoading: null });
    }
  },
  markAlertRead: async (id) => {
    set({ actionLoading: id });
    try {
      const updated = await markAlertRead(id);
      set((s) => ({ alerts: s.alerts.map((a) => a.id === id ? updated : a), actionLoading: null }));
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to mark alert as read", actionLoading: null });
    }
  },
  resolveAlert: async (id) => {
    set({ actionLoading: id });
    try {
      const updated = await resolveAlert(id);
      set((s) => ({ alerts: s.alerts.map((a) => a.id === id ? updated : a), actionLoading: null }));
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to resolve alert", actionLoading: null });
    }
  },

  // ── Flags ─────────────────────────────────────────────────────────────────
  fetchFlags: async () => {
    const { flagFilters: f } = get();
    set({ isLoadingFlags: true, error: null });
    try {
      const res = await fetchFlags({ page: f.page, limit: f.limit });
      set({ flags: res.data, flagPagination: buildPagination(res), isLoadingFlags: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch flags", isLoadingFlags: false });
    }
  },
  setFlagFilters: (f) => set((s) => ({ flagFilters: { ...s.flagFilters, ...f } })),
  createFlag: async (payload) => {
    set({ actionLoading: "create" });
    try {
      await createFlag(payload);
      await get().fetchFlags();
      set({ actionLoading: null });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to create flag", actionLoading: null });
    }
  },
  updateFlag: async (key, payload) => {
    set({ actionLoading: key });
    try {
      await updateFlag(key, payload);
      await get().fetchFlags();
      set({ actionLoading: null });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to update flag", actionLoading: null });
    }
  },
  deleteFlag: async (key) => {
    set({ actionLoading: key });
    try {
      await deleteFlag(key);
      set((s) => ({ flags: s.flags.filter((fl) => fl.key !== key), actionLoading: null }));
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to delete flag", actionLoading: null });
    }
  },
  toggleFlag: async (key, isEnabled) => {
    set({ actionLoading: key });
    try {
      const updated = await updateFlag(key, { isEnabled });
      set((s) => ({ flags: s.flags.map((fl) => fl.key === key ? updated : fl), actionLoading: null }));
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to toggle flag", actionLoading: null });
    }
  },

  // ── Health ────────────────────────────────────────────────────────────────
  fetchHealthHistory: async () => {
    const { healthFilters: f } = get();
    set({ isLoadingHealth: true, error: null });
    try {
      const res = await fetchHealthHistory({ page: f.page, limit: f.limit });
      set({ healthHistory: res.data, healthPagination: buildPagination(res), isLoadingHealth: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch health history", isLoadingHealth: false });
    }
  },
  setHealthFilters: (f) => set((s) => ({ healthFilters: { ...s.healthFilters, ...f } })),
  fetchLatestHealth: async () => {
    set({ isLoadingHealth: true, error: null });
    try {
      const latest = await fetchLatestHealthCheck();
      set({ latestHealth: latest, isLoadingHealth: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch latest health", isLoadingHealth: false });
    }
  },

  // ── Env Configs ───────────────────────────────────────────────────────────
  fetchEnvConfigs: async () => {
    const { envConfigFilters: f } = get();
    set({ isLoadingEnvConfigs: true, error: null });
    try {
      const res = await fetchEnvConfigs({ page: f.page, limit: f.limit });
      set({ envConfigs: res.data, envConfigPagination: buildPagination(res), isLoadingEnvConfigs: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch env configs", isLoadingEnvConfigs: false });
    }
  },
  setEnvConfigFilters: (f) => set((s) => ({ envConfigFilters: { ...s.envConfigFilters, ...f } })),
  createEnvConfig: async (payload) => {
    set({ actionLoading: "create" });
    try {
      await createEnvConfig(payload);
      await get().fetchEnvConfigs();
      set({ actionLoading: null });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to create config", actionLoading: null });
    }
  },
  updateEnvConfig: async (id, payload) => {
    set({ actionLoading: id });
    try {
      await updateEnvConfig(id, payload);
      await get().fetchEnvConfigs();
      set({ actionLoading: null });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to update config", actionLoading: null });
    }
  },
  deleteEnvConfig: async (id) => {
    set({ actionLoading: id });
    try {
      await deleteEnvConfig(id);
      set((s) => ({ envConfigs: s.envConfigs.filter((c) => c.id !== id), actionLoading: null }));
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to delete config", actionLoading: null });
    }
  },

  clearError: () => set({ error: null }),
}));