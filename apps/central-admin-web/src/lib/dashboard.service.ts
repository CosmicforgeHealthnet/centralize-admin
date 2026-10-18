import api from "./api";
import type {
  DashboardOverview,
  RevenueChartItem,
  PlatformUsageItem,
} from "@/types/dashboard.types";

export const fetchDashboardOverview = async (): Promise<DashboardOverview> => {
  const { data } = await api.get("/api/dashboard/overview");
  return data.data;
};

export const fetchRevenueChart = async (): Promise<RevenueChartItem[]> => {
  const { data } = await api.get("/api/dashboard/revenue-chart");
  return data.data;
};

export const fetchPlatformUsage = async (): Promise<PlatformUsageItem[]> => {
  const { data } = await api.get("/api/dashboard/platform-usage");
  return data.data;
};