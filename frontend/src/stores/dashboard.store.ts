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

interface DashboardState {
  // ── Data ─────────────────────────────────────────────
  overview: DashboardOverview | null;
  revenueChart: RevenueChartItem[];
  platformUsage: PlatformUsageItem[];

  // ── UI State ──────────────────────────────────────────
  isLoadingOverview: boolean;
  isLoadingRevenue: boolean;
  isLoadingPlatform: boolean;
  error: string | null;

  // ── Actions ───────────────────────────────────────────
  fetchOverview: () => Promise<void>;
  fetchRevenueChart: () => Promise<void>;
  fetchPlatformUsage: () => Promise<void>;
  fetchAll: () => Promise<void>;
  clearError: () => void;
}

export const useDashboardStore = create<DashboardState>((set) => ({
  // ── Initial State ─────────────────────────────────────
  overview: null,
  revenueChart: [],
  platformUsage: [],
  isLoadingOverview: false,
  isLoadingRevenue: false,
  isLoadingPlatform: false,
  error: null,

  // ── Actions ───────────────────────────────────────────
  fetchOverview: async () => {
    set({ isLoadingOverview: true, error: null });
    try {
      const overview = await fetchDashboardOverview();
      set({ overview, isLoadingOverview: false });
    } catch (err: any) {
      set({
        error: err.response?.data?.message || "Failed to fetch dashboard overview",
        isLoadingOverview: false,
      });
    }
  },

  fetchRevenueChart: async () => {
    set({ isLoadingRevenue: true, error: null });
    try {
      const revenueChart = await fetchRevenueChart();
      set({ revenueChart, isLoadingRevenue: false });
    } catch (err: any) {
      set({
        error: err.response?.data?.message || "Failed to fetch revenue data",
        isLoadingRevenue: false,
      });
    }
  },

  fetchPlatformUsage: async () => {
    set({ isLoadingPlatform: true, error: null });
    try {
      const platformUsage = await fetchPlatformUsage();
      set({ platformUsage, isLoadingPlatform: false });
    } catch (err: any) {
      set({
        error: err.response?.data?.message || "Failed to fetch platform usage",
        isLoadingPlatform: false,
      });
    }
  },

  // Fires all three in parallel — use this on dashboard page mount
  fetchAll: async () => {
    set({
      isLoadingOverview: true,
      isLoadingRevenue: true,
      isLoadingPlatform: true,
      error: null,
    });
    try {
      const [overview, revenueChart, platformUsage] = await Promise.all([
        fetchDashboardOverview(),
        fetchRevenueChart(),
        fetchPlatformUsage(),
      ]);
      set({
        overview,
        revenueChart,
        platformUsage,
        isLoadingOverview: false,
        isLoadingRevenue: false,
        isLoadingPlatform: false,
      });
    } catch (err: any) {
      set({
        error: err.response?.data?.message || "Failed to fetch dashboard data",
        isLoadingOverview: false,
        isLoadingRevenue: false,
        isLoadingPlatform: false,
      });
    }
  },

  clearError: () => set({ error: null }),
}));