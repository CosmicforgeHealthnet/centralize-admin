import { create } from "zustand";
import {
  fetchDashboardOverview,
  fetchRevenueChart,
  fetchPlatformUsage,
} from "@/lib/dashboard.service";
import type {
  DashboardOverview,
  RevenueChartItem,
  PlatformUsageItem,
} from "@/types/dashboard.types";
import { inspectHttpError } from "@/lib/error-messages";

type DataStatus = "idle" | "loading" | "success" | "error";

function dashboardError(error: unknown): string {
  const details = inspectHttpError(error);
  if (details.responseCode === "DEPENDENCY_UNAVAILABLE" || details.status === 503) {
    return "HealthNet data is temporarily unavailable. Other Admin services remain operational.";
  }
  if (details.status === 502 || details.status === 504 || (!details.hasResponse && details.hasRequest)) {
    return "The data service is not responding. Check its availability and retry.";
  }
  if (details.status === 401 || details.status === 403) {
    return "You do not have access to this data. Please check your session and permissions.";
  }
  return "This dashboard section could not be loaded. Please retry or contact support.";
}

interface DashboardState {
  overview: DashboardOverview | null;
  revenueChart: RevenueChartItem[];
  platformUsage: PlatformUsageItem[];

  isLoadingOverview: boolean;
  isLoadingRevenue: boolean;
  isLoadingPlatform: boolean;
  overviewStatus: DataStatus;
  revenueStatus: DataStatus;
  platformStatus: DataStatus;
  overviewError: string | null;
  revenueError: string | null;
  platformError: string | null;
  // Maintained for consumers still reading the historical aggregate error.
  error: string | null;

  fetchOverview: () => Promise<void>;
  fetchRevenueChart: () => Promise<void>;
  fetchPlatformUsage: () => Promise<void>;
  fetchAll: () => Promise<void>;
  clearError: () => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  overview: null,
  revenueChart: [],
  platformUsage: [],
  isLoadingOverview: false,
  isLoadingRevenue: false,
  isLoadingPlatform: false,
  overviewStatus: "idle",
  revenueStatus: "idle",
  platformStatus: "idle",
  overviewError: null,
  revenueError: null,
  platformError: null,
  error: null,

  fetchOverview: async () => {
    if (get().isLoadingOverview) return;
    set({ isLoadingOverview: true, overviewStatus: "loading", overviewError: null });
    try {
      const overview = await fetchDashboardOverview();
      set({ overview, isLoadingOverview: false, overviewStatus: "success", overviewError: null });
    } catch (err: unknown) {
      const message = dashboardError(err);
      // Never present cached financial/user figures as live after a failed refresh.
      set({ overview: null, overviewError: message, error: message, overviewStatus: "error", isLoadingOverview: false });
    }
  },

  fetchRevenueChart: async () => {
    if (get().isLoadingRevenue) return;
    set({ isLoadingRevenue: true, revenueStatus: "loading", revenueError: null });
    try {
      const revenueChart = await fetchRevenueChart();
      set({ revenueChart, isLoadingRevenue: false, revenueStatus: "success", revenueError: null });
    } catch (err: unknown) {
      const message = dashboardError(err);
      set({ revenueChart: [], revenueError: message, error: message, revenueStatus: "error", isLoadingRevenue: false });
    }
  },

  fetchPlatformUsage: async () => {
    if (get().isLoadingPlatform) return;
    set({ isLoadingPlatform: true, platformStatus: "loading", platformError: null });
    try {
      const platformUsage = await fetchPlatformUsage();
      set({ platformUsage, isLoadingPlatform: false, platformStatus: "success", platformError: null });
    } catch (err: unknown) {
      const message = dashboardError(err);
      set({ platformUsage: [], platformError: message, error: message, platformStatus: "error", isLoadingPlatform: false });
    }
  },

  // Independent settlement: one failed product request does not discard
  // healthy dashboard responses. Individual actions handle their own errors.
  fetchAll: async () => {
    await Promise.all([
      get().fetchOverview(),
      get().fetchRevenueChart(),
      get().fetchPlatformUsage(),
    ]);
  },

  clearError: () => set({ error: null, overviewError: null, revenueError: null, platformError: null }),
}));
