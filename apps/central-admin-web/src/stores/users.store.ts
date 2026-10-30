import { create } from "zustand";
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
  UsersFilters,
  UsersPagination,
  BulkUpdateResult,
  AnalyticsStats,
  VisitorSession,
  WaitlistEntry,
} from "@/types/users.types";
import {
  fetchUserStats,
  fetchGrowthChart,
  fetchSignUpTrends,
  fetchUsers,
  fetchUser,
  fetchUserActivity,
  fetchUserTransactions,
  fetchUserAppointments,
  fetchUserSubscriptions,
  updateUserStatus,
  bulkUpdateUserStatus,
  deleteUser,
  forcePasswordReset,
  fetchAnalyticsStats,
  fetchAnalyticsVisitors,
  fetchAnalyticsWaitlist,
} from "@/lib/users.service";
import { readHttpErrorMessage } from "@/lib/error-messages";


interface UserDetailPagination {
  currentPage: number;
  totalPages: number;
  totalItems: number;
}

interface AnalyticsPagination {
  total: number;
  page: number;
  limit: number;
}

interface UsersState {
  // ── List ────────────────────────────────────────────────────────────────
  stats: UserStats | null;
  growthChart: GrowthChartItem[];
  signUpTrends: SignUpTrendItem[];
  users: User[];
  pagination: UsersPagination | null;
  filters: UsersFilters;

  // ── Single user ─────────────────────────────────────────────────────────
  selectedUser: UserDetail | null;
  userActivity: UserActivity | null;
  userTransactions: UserTransaction[];
  userTransactionsPagination: UserDetailPagination | null;
  userAppointments: UserAppointment[];
  userAppointmentsPagination: UserDetailPagination | null;
  userSubscriptions: Subscription[];

  // ── Analytics ────────────────────────────────────────────────────────────
  analyticsStats: AnalyticsStats | null;
  analyticsVisitors: VisitorSession[];
  analyticsVisitorsPagination: AnalyticsPagination | null;
  analyticsWaitlist: WaitlistEntry[];
  analyticsWaitlistPagination: AnalyticsPagination | null;

  // ── Loading flags ───────────────────────────────────────────────────────
  isLoadingStats: boolean;
  isLoadingCharts: boolean;
  isLoadingUsers: boolean;
  isLoadingUser: boolean;
  isLoadingActivity: boolean;
  isLoadingTransactions: boolean;
  isLoadingAppointments: boolean;
  isLoadingSubscriptions: boolean;
  isUpdatingStatus: boolean;
  isBulkUpdating: boolean;
  isDeleting: boolean;
  isLoadingAnalyticsStats: boolean;
  isLoadingAnalyticsVisitors: boolean;
  isLoadingAnalyticsWaitlist: boolean;

  error: string | null;

  // ── Actions ─────────────────────────────────────────────────────────────
  fetchStats: () => Promise<void>;
  fetchCharts: () => Promise<void>;
  fetchUsers: () => Promise<void>;
  fetchUser: (id: string) => Promise<void>;
  fetchUserActivity: (id: string) => Promise<void>;
  fetchUserTransactions: (id: string, page?: number) => Promise<void>;
  fetchUserAppointments: (id: string, page?: number) => Promise<void>;
  fetchUserSubscriptions: (id: string) => Promise<void>;
  updateUserStatus: (id: string, status: string) => Promise<void>;
  bulkUpdateStatus: (ids: string[], status: string) => Promise<BulkUpdateResult>;
  deleteUser: (id: string) => Promise<void>;
  forcePasswordReset: (id: string) => Promise<void>;
  setFilters: (f: Partial<UsersFilters>) => void;
  resetFilters: () => void;
  clearSelectedUser: () => void;
  clearError: () => void;
  fetchAnalyticsStats: (params?: { from?: string; to?: string }) => Promise<void>;
  fetchAnalyticsVisitors: (params?: { page?: number; limit?: number; country?: string; user_type_intent?: string; converted?: boolean }) => Promise<void>;
  fetchAnalyticsWaitlist: (params?: { page?: number; limit?: number; role?: string; country?: string }) => Promise<void>;
}

const defaultFilters: UsersFilters = {
  search: "",
  role: "",
  status: "",
  tier: "",
  dateFrom: "",
  dateTo: "",
  sortBy: "createdAt",
  sortOrder: "desc",
  page: 1,
  limit: 20,
};

export const useUsersStore = create<UsersState>((set, get) => ({
  stats: null,
  growthChart: [],
  signUpTrends: [],
  users: [],
  pagination: null,
  filters: { ...defaultFilters },

  selectedUser: null,
  userActivity: null,
  userTransactions: [],
  userTransactionsPagination: null,
  userAppointments: [],
  userAppointmentsPagination: null,
  userSubscriptions: [],

  analyticsStats: null,
  analyticsVisitors: [],
  analyticsVisitorsPagination: null,
  analyticsWaitlist: [],
  analyticsWaitlistPagination: null,

  isLoadingStats: false,
  isLoadingCharts: false,
  isLoadingUsers: false,
  isLoadingUser: false,
  isLoadingActivity: false,
  isLoadingTransactions: false,
  isLoadingAppointments: false,
  isLoadingSubscriptions: false,
  isUpdatingStatus: false,
  isBulkUpdating: false,
  isDeleting: false,
  isLoadingAnalyticsStats: false,
  isLoadingAnalyticsVisitors: false,
  isLoadingAnalyticsWaitlist: false,

  error: null,

  // ── Stats ────────────────────────────────────────────────────────────────
  fetchStats: async () => {
    set({ isLoadingStats: true, error: null });
    try {
      const stats = await fetchUserStats();
      set({ stats, isLoadingStats: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) ?? "Failed to fetch stats", isLoadingStats: false });
    }
  },

  // ── Charts ───────────────────────────────────────────────────────────────
  fetchCharts: async () => {
    set({ isLoadingCharts: true, error: null });
    try {
      const [growthChart, signUpTrends] = await Promise.all([
        fetchGrowthChart(),
        fetchSignUpTrends(),
      ]);
      set({ growthChart, signUpTrends, isLoadingCharts: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) ?? "Failed to fetch charts", isLoadingCharts: false });
    }
  },

  // ── List users ───────────────────────────────────────────────────────────
  fetchUsers: async () => {
    const { filters: f } = get();
    set({ isLoadingUsers: true, error: null });
    try {
      const res = await fetchUsers({
        role: f.role || undefined,
        status: f.status || undefined,
        search: f.search || undefined,
        tier: f.tier || undefined,
        dateFrom: f.dateFrom || undefined,
        dateTo: f.dateTo || undefined,
        sortBy: f.sortBy || undefined,
        sortOrder: f.sortOrder,
        page: f.page,
        limit: f.limit,
      });
      set({
        users: res.data,
        pagination: {
          currentPage: res.page,
          totalPages: res.totalPages,
          totalItems: res.total,
        },
        isLoadingUsers: false,
      });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) ?? "Failed to fetch users", isLoadingUsers: false });
    }
  },

  // ── Single user ──────────────────────────────────────────────────────────
  fetchUser: async (id) => {
    set({ isLoadingUser: true, error: null });
    try {
      const user = await fetchUser(id);
      set({ selectedUser: user, isLoadingUser: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) ?? "Failed to fetch user", isLoadingUser: false });
    }
  },

  fetchUserActivity: async (id) => {
    set({ isLoadingActivity: true, error: null });
    try {
      const userActivity = await fetchUserActivity(id);
      set({ userActivity, isLoadingActivity: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) ?? "Failed to fetch activity", isLoadingActivity: false });
    }
  },

  fetchUserTransactions: async (id, page = 1) => {
    set({ isLoadingTransactions: true, error: null });
    try {
      const res = await fetchUserTransactions(id, { page, limit: 20 });
      set({
        userTransactions: res.data,
        userTransactionsPagination: {
          currentPage: res.page,
          totalPages: res.totalPages,
          totalItems: res.total,
        },
        isLoadingTransactions: false,
      });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) ?? "Failed to fetch transactions", isLoadingTransactions: false });
    }
  },

  fetchUserAppointments: async (id, page = 1) => {
    set({ isLoadingAppointments: true, error: null });
    try {
      const res = await fetchUserAppointments(id, { page, limit: 20 });
      set({
        userAppointments: res.data,
        userAppointmentsPagination: {
          currentPage: res.page,
          totalPages: res.totalPages,
          totalItems: res.total,
        },
        isLoadingAppointments: false,
      });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) ?? "Failed to fetch appointments", isLoadingAppointments: false });
    }
  },

  fetchUserSubscriptions: async (id) => {
    set({ isLoadingSubscriptions: true, error: null });
    try {
      const userSubscriptions = await fetchUserSubscriptions(id);
      set({ userSubscriptions, isLoadingSubscriptions: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) ?? "Failed to fetch subscriptions", isLoadingSubscriptions: false });
    }
  },

  // ── Mutations ────────────────────────────────────────────────────────────
  updateUserStatus: async (id, status) => {
    set({ isUpdatingStatus: true, error: null });
    try {
      await updateUserStatus(id, status);
      await get().fetchUsers();
      if (get().selectedUser?.id === id) await get().fetchUser(id);
      set({ isUpdatingStatus: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) ?? "Failed to update status", isUpdatingStatus: false });
    }
  },

  bulkUpdateStatus: async (ids, status) => {
    set({ isBulkUpdating: true, error: null });
    try {
      const result = await bulkUpdateUserStatus(ids, status);
      await get().fetchUsers();
      set({ isBulkUpdating: false });
      return result;
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) ?? "Failed to bulk update", isBulkUpdating: false });
      throw err;
    }
  },

  deleteUser: async (id) => {
    set({ isDeleting: true, error: null });
    try {
      await deleteUser(id);
      set((s) => ({ users: s.users.filter((u) => u.id !== id) }));
      await get().fetchUsers();
      if (get().selectedUser?.id === id) get().clearSelectedUser();
      set({ isDeleting: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) ?? "Failed to delete user", isDeleting: false });
      throw err;
    }
  },

  forcePasswordReset: async (id) => {
    try {
      await forcePasswordReset(id);
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) ?? "Failed to force password reset" });
      throw err;
    }
  },

  // ── Filters / helpers ────────────────────────────────────────────────────
  setFilters: (f) =>
    set((s) => ({
      filters: {
        ...s.filters,
        ...f,
        page: f.page !== undefined ? f.page : 1,
      },
    })),
  resetFilters: () => set({ filters: { ...defaultFilters } }),
  clearSelectedUser: () =>
    set({
      selectedUser: null,
      userActivity: null,
      userTransactions: [],
      userTransactionsPagination: null,
      userAppointments: [],
      userAppointmentsPagination: null,
      userSubscriptions: [],
    }),
  clearError: () => set({ error: null }),

  // ── Analytics ────────────────────────────────────────────────────────────
  fetchAnalyticsStats: async (params) => {
    set({ isLoadingAnalyticsStats: true, error: null });
    try {
      const analyticsStats = await fetchAnalyticsStats(params);
      set({ analyticsStats, isLoadingAnalyticsStats: false });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) ?? "Failed to fetch analytics stats", isLoadingAnalyticsStats: false });
    }
  },

  fetchAnalyticsVisitors: async (params) => {
    set({ isLoadingAnalyticsVisitors: true, error: null });
    try {
      const res = await fetchAnalyticsVisitors(params);
      set({
        analyticsVisitors: res.sessions,
        analyticsVisitorsPagination: { total: res.total, page: res.page, limit: res.limit },
        isLoadingAnalyticsVisitors: false,
      });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) ?? "Failed to fetch visitors", isLoadingAnalyticsVisitors: false });
    }
  },

  fetchAnalyticsWaitlist: async (params) => {
    set({ isLoadingAnalyticsWaitlist: true, error: null });
    try {
      const res = await fetchAnalyticsWaitlist(params);
      set({
        analyticsWaitlist: res.entries,
        analyticsWaitlistPagination: { total: res.total, page: res.page, limit: res.limit },
        isLoadingAnalyticsWaitlist: false,
      });
    } catch (err: unknown) {
      set({ error: readHttpErrorMessage(err) ?? "Failed to fetch waitlist", isLoadingAnalyticsWaitlist: false });
    }
  },
}));