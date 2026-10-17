import api from "./api";
import type {
  UserStats,
  GrowthChartItem,
  SignUpTrendItem,
  User,
  UserDetail,
  UserActivity,
  UserTransaction,
  UserAppointment,
  Subscription,
  BulkUpdateResult,
   AnalyticsStats, VisitorSession, WaitlistEntry, AnalyticsPagination,
} from "@/types/users.types";


interface ListResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}



interface AnalyticsVisitorsResponse {
  sessions: VisitorSession[];
  total: number;
  page: number;
  limit: number;
}

interface AnalyticsWaitlistResponse {
  entries: WaitlistEntry[];
  total: number;
  page: number;
  limit: number;
}

export const fetchAnalyticsStats = async (params?: {
  from?: string;
  to?: string;
}): Promise<AnalyticsStats> => {
  const { data } = await api.get("/api/analytics/stats", { params });
  return data.data;
};

export const fetchAnalyticsVisitors = async (params?: {
  page?: number;
  limit?: number;
  country?: string;
  user_type_intent?: string;
  converted?: boolean;
}): Promise<AnalyticsVisitorsResponse> => {
  const { data } = await api.get("/api/analytics/visitors", { params });
  return data.data;
};

export const fetchAnalyticsWaitlist = async (params?: {
  page?: number;
  limit?: number;
  role?: string;
  country?: string;
}): Promise<AnalyticsWaitlistResponse> => {
  const { data } = await api.get("/api/analytics/waitlist", { params });
  return data.data;
};
export const fetchUserStats = async (): Promise<UserStats> => {
  const { data } = await api.get("/api/users/stats");
  return data.data;
};

export const fetchGrowthChart = async (): Promise<GrowthChartItem[]> => {
  const { data } = await api.get("/api/users/growth-chart");
  return data.data;
};

export const fetchSignUpTrends = async (): Promise<SignUpTrendItem[]> => {
  const { data } = await api.get("/api/users/signup-trends");
  return data.data;
};

export const fetchUsers = async (params: {
  role?: string;
  status?: string;
  search?: string;
  tier?: string;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  page: number;
  limit: number;
}): Promise<ListResponse<User>> => {
  const { data } = await api.get("/api/users", { params });
  return data.data;
};

export const fetchUser = async (id: string): Promise<UserDetail> => {
  const { data } = await api.get(`/api/users/${id}`);
  return data.data;
};

export const fetchUserActivity = async (id: string): Promise<UserActivity> => {
  const { data } = await api.get(`/api/users/${id}/activity`);
  return data.data;
};

export const fetchUserTransactions = async (
  id: string,
  params: { page: number; limit: number }
): Promise<ListResponse<UserTransaction>> => {
  const { data } = await api.get(`/api/users/${id}/transactions`, { params });
  return data.data;
};

export const fetchUserAppointments = async (
  id: string,
  params: { page: number; limit: number }
): Promise<ListResponse<UserAppointment>> => {
  const { data } = await api.get(`/api/users/${id}/appointments`, { params });
  return data.data;
};

export const fetchUserSubscriptions = async (id: string): Promise<Subscription[]> => {
  const { data } = await api.get(`/api/users/${id}/subscriptions`);
  return data.data;
};

export const updateUserStatus = async (id: string, status: string): Promise<void> => {
  await api.patch(`/api/users/${id}/status`, { status });
};

export const bulkUpdateUserStatus = async (
  ids: string[],
  status: string
): Promise<BulkUpdateResult> => {
  const { data } = await api.patch("/api/users/bulk/status", { ids, status });
  return data.data;
};

export const deleteUser = async (id: string): Promise<void> => {
  await api.delete(`/api/users/${id}`);
};

export const forcePasswordReset = async (id: string): Promise<void> => {
  await api.patch(`/api/users/${id}/force-password-reset`);
};