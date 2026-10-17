import { create } from "zustand";
import type {
  MIConnection,
  MIConnectionFilters,
  MICreateConnectionPayload,
  MIUpdateConnectionPayload,
  MIDashboardFilters,
  MIPerformanceResponse,
  MIProviderValidationRow,
  MISyncRequest,
  MISyncResult,
} from "@/types/marketing-intelligence.types";
import {
  fetchMIConnections,
  createMIConnection,
  updateMIConnection,
  testMIConnection,
  disableMIConnection,
  enableMIConnection,
  deleteMIConnection,
  bootstrapMIConnections,
  fetchMIPerformance,
  runMISync,
  fetchMIProviderValidation,
} from "@/lib/marketing-intelligence.service";

const today = new Date().toISOString().slice(0, 10);
const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

const defaultDashboardFilters: MIDashboardFilters = {
  from: thirtyDaysAgo,
  to: today,
  platform: "all",
  search: "",
  currency: "all",
};

// Maps HTTP status to a distinct, actionable message — 401/403 need different
// recovery paths than a generic server error (§9 error-category handling).
function resolveErrorMessage(err: any, fallback: string): string {
  const status = err?.response?.status;
  if (status === 401) return "Your session has expired. Please sign in again.";
  if (status === 403) return "You don't have permission for this action (requires marketing/intelligence access).";
  return err?.response?.data?.message || fallback;
}

const defaultConnectionFilters: MIConnectionFilters = { platform: "all", status: "" };

interface MarketingIntelligenceState {
  // ── Connections ──────────────────────────────────────────────────────────
  connections: MIConnection[];
  connectionFilters: MIConnectionFilters;
  isLoadingConnections: boolean;
  connectionTestResult: Record<string, "SUCCESS" | "FAILED" | null>;

  // ── Performance dashboard ────────────────────────────────────────────────
  dashboardFilters: MIDashboardFilters;
  performance: MIPerformanceResponse | null;
  isLoadingPerformance: boolean;

  // ── Manual sync ───────────────────────────────────────────────────────────
  lastSyncResult: MISyncResult | null;
  isSyncing: boolean;

  // ── Provider validation ───────────────────────────────────────────────────
  providerValidation: MIProviderValidationRow[];
  isLoadingProviderValidation: boolean;

  actionLoading: string | null;
  error: string | null;

  // ── Actions ───────────────────────────────────────────────────────────────
  fetchConnections: () => Promise<void>;
  setConnectionFilters: (f: Partial<MIConnectionFilters>) => void;
  createConnection: (payload: MICreateConnectionPayload) => Promise<void>;
  updateConnection: (id: string, payload: MIUpdateConnectionPayload) => Promise<void>;
  testConnection: (id: string) => Promise<void>;
  disableConnection: (id: string) => Promise<void>;
  enableConnection: (id: string) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;
  bootstrapConnections: () => Promise<void>;

  setDashboardFilters: (f: Partial<MIDashboardFilters>) => void;
  fetchPerformance: () => Promise<void>;

  runSync: (payload: MISyncRequest) => Promise<void>;

  fetchProviderValidation: () => Promise<void>;

  clearError: () => void;
}

export const useMarketingIntelligenceStore = create<MarketingIntelligenceState>((set, get) => ({
  connections: [],
  connectionFilters: { ...defaultConnectionFilters },
  isLoadingConnections: false,
  connectionTestResult: {},

  dashboardFilters: { ...defaultDashboardFilters },
  performance: null,
  isLoadingPerformance: false,

  lastSyncResult: null,
  isSyncing: false,

  providerValidation: [],
  isLoadingProviderValidation: false,

  actionLoading: null,
  error: null,

  // ── Connections ────────────────────────────────────────────────────────────
  fetchConnections: async () => {
    set({ isLoadingConnections: true, error: null });
    try {
      const connections = await fetchMIConnections();
      const { connectionFilters: f } = get();
      const filtered = connections.filter((c) => {
        if (f.platform !== "all" && c.platform !== f.platform) return false;
        if (f.status && c.status !== f.status) return false;
        return true;
      });
      set({ connections: filtered, isLoadingConnections: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch connections", isLoadingConnections: false });
    }
  },
  setConnectionFilters: (f) => {
    set((s) => ({ connectionFilters: { ...s.connectionFilters, ...f } }));
    get().fetchConnections();
  },
  createConnection: async (payload) => {
    set({ actionLoading: "create" });
    try {
      await createMIConnection(payload);
      await get().fetchConnections();
      set({ actionLoading: null });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to create connection", actionLoading: null });
    }
  },
  updateConnection: async (id, payload) => {
    set({ actionLoading: id });
    try {
      await updateMIConnection(id, payload);
      await get().fetchConnections();
      set({ actionLoading: null });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to update connection", actionLoading: null });
    }
  },
testConnection: async (id) => {
  set({ actionLoading: `test-${id}` });
  try {
    const result = await testMIConnection(id);
    const mappedStatus = result.status === "SUCCESS" ? "SUCCESS" : "FAILED";
    set((s) => ({
      connectionTestResult: { ...s.connectionTestResult, [id]: mappedStatus },
      actionLoading: null,
    }));
  } catch (err: any) {
    set({ error: err.response?.data?.message || "Connection test failed", actionLoading: null });
  }
},
  disableConnection: async (id) => {
    set({ actionLoading: id });
    try {
      await disableMIConnection(id);
      await get().fetchConnections();
      set({ actionLoading: null });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to disable connection", actionLoading: null });
    }
  },
  enableConnection: async (id) => {
    set({ actionLoading: id });
    try {
      await enableMIConnection(id);
      await get().fetchConnections();
      set({ actionLoading: null });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to enable connection", actionLoading: null });
    }
  },
  deleteConnection: async (id) => {
    set({ actionLoading: id });
    try {
      await deleteMIConnection(id);
      set((s) => ({ connections: s.connections.filter((c) => c.id !== id), actionLoading: null }));
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to delete connection", actionLoading: null });
    }
  },
  bootstrapConnections: async () => {
    set({ actionLoading: "bootstrap" });
    try {
      await bootstrapMIConnections();
      await get().fetchConnections();
      set({ actionLoading: null });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to bootstrap connections", actionLoading: null });
    }
  },

  // ── Performance dashboard ────────────────────────────────────────────────
  setDashboardFilters: (f) => {
    set((s) => ({ dashboardFilters: { ...s.dashboardFilters, ...f } }));
    get().fetchPerformance();
  },
  fetchPerformance: async () => {
    const { dashboardFilters: f } = get();
    set({ isLoadingPerformance: true, error: null });
    try {
      const performance = await fetchMIPerformance({ from: f.from, to: f.to, platform: f.platform });
      set({ performance, isLoadingPerformance: false });
    } catch (err: any) {
      set({ error: resolveErrorMessage(err, "Failed to fetch performance"), isLoadingPerformance: false });
    }
  },

  // ── Manual sync ───────────────────────────────────────────────────────────
  runSync: async (payload) => {
    set({ isSyncing: true, error: null });
    try {
      const result = await runMISync(payload);
      set({ lastSyncResult: result, isSyncing: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Sync failed", isSyncing: false });
    }
  },

  // ── Provider validation ───────────────────────────────────────────────────
  fetchProviderValidation: async () => {
    set({ isLoadingProviderValidation: true, error: null });
    try {
      const rows = await fetchMIProviderValidation();
      set({ providerValidation: rows, isLoadingProviderValidation: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch provider validation", isLoadingProviderValidation: false });
    }
  },

  clearError: () => set({ error: null }),
}));