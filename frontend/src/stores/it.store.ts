import { create } from "zustand";
import type {
  ITStats,
  Consultation,
  RTCSession,
  Delivery,
  Transaction,
  AuditLog,
  UserNotification,
  ITFilters,
} from "@/types/it.types";
import {
  fetchITStats,
  fetchConsultations,
  transitionConsultation,
  fetchRTCSessions,
  transitionRTCSession,
  fetchDeliveries,
  transitionDelivery,
  retryDelivery,
  fetchTransactions,
  transitionPayment,
  flagTransaction,
  fetchAuditLogs,
  fetchUserNotifications,
} from "@/lib/it.service";

interface PaginationState {
  currentPage: number;
  totalPages: number;
  totalItems: number;
}

interface ITState {
  stats: ITStats | null;
  isLoadingStats: boolean;

  consultations: Consultation[];
  consultationPagination: PaginationState | null;
  consultationFilters: ITFilters;
  isLoadingConsultations: boolean;

  rtcSessions: RTCSession[];
  rtcPagination: PaginationState | null;
  rtcFilters: ITFilters;
  isLoadingRTC: boolean;

  deliveries: Delivery[];
  deliveryPagination: PaginationState | null;
  deliveryFilters: ITFilters;
  isLoadingDeliveries: boolean;

  transactions: Transaction[];
  transactionPagination: PaginationState | null;
  transactionFilters: ITFilters;
  isLoadingTransactions: boolean;

  auditLogs: AuditLog[];
  auditPagination: PaginationState | null;
  auditFilters: ITFilters;
  isLoadingAudit: boolean;

  notifications: UserNotification[];
  notificationPagination: PaginationState | null;
  notificationFilters: ITFilters;
  isLoadingNotifications: boolean;

  error: string | null;

  fetchStats: () => Promise<void>;
  fetchConsultations: () => Promise<void>;
  setConsultationFilters: (f: Partial<ITFilters>) => void;
  transitionConsultation: (id: string, status: string) => Promise<void>;

  fetchRTCSessions: () => Promise<void>;
  setRTCFilters: (f: Partial<ITFilters>) => void;
  transitionRTCSession: (id: string, status: string) => Promise<void>;

  fetchDeliveries: () => Promise<void>;
  setDeliveryFilters: (f: Partial<ITFilters>) => void;
  transitionDelivery: (id: string, status: string) => Promise<void>;
  retryDelivery: (id: string) => Promise<void>;

  fetchTransactions: () => Promise<void>;
  setTransactionFilters: (f: Partial<ITFilters>) => void;
  transitionPayment: (id: string, status: string) => Promise<void>;
  flagTransaction: (id: string, reason: string) => Promise<void>;

  fetchAuditLogs: () => Promise<void>;
  setAuditFilters: (f: Partial<ITFilters>) => void;

  fetchUserNotifications: (userId: string) => Promise<void>;
  setNotificationFilters: (f: Partial<ITFilters>) => void;

  clearError: () => void;
}

const defaultFilters: ITFilters = { search: "", status: "", page: 1, limit: 20 };

const buildPagination = (res: { total: number; page: number; limit: number }) => ({
  currentPage: res.page,
  totalPages: Math.ceil(res.total / res.limit),
  totalItems: res.total,
});

export const useITStore = create<ITState>((set, get) => ({
  stats: null,
  isLoadingStats: false,

  consultations: [],
  consultationPagination: null,
  consultationFilters: { ...defaultFilters },
  isLoadingConsultations: false,

  rtcSessions: [],
  rtcPagination: null,
  rtcFilters: { ...defaultFilters },
  isLoadingRTC: false,

  deliveries: [],
  deliveryPagination: null,
  deliveryFilters: { ...defaultFilters },
  isLoadingDeliveries: false,

  transactions: [],
  transactionPagination: null,
  transactionFilters: { ...defaultFilters },
  isLoadingTransactions: false,

  auditLogs: [],
  auditPagination: null,
  auditFilters: { ...defaultFilters },
  isLoadingAudit: false,

  notifications: [],
  notificationPagination: null,
  notificationFilters: { ...defaultFilters },
  isLoadingNotifications: false,

  error: null,

  fetchStats: async () => {
    set({ isLoadingStats: true, error: null });
    try {
      const stats = await fetchITStats();
      set({ stats, isLoadingStats: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch stats", isLoadingStats: false });
    }
  },

  fetchConsultations: async () => {
    const { consultationFilters: f } = get();
    set({ isLoadingConsultations: true, error: null });
    try {
      const res = await fetchConsultations({ status: f.status || undefined, page: f.page, limit: f.limit });
      set({ consultations: res.data, consultationPagination: buildPagination(res), isLoadingConsultations: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch consultations", isLoadingConsultations: false });
    }
  },

  setConsultationFilters: (f) => set((s) => ({ consultationFilters: { ...s.consultationFilters, ...f } })),

  transitionConsultation: async (id, status) => {
    try {
      await transitionConsultation(id, status);
      await get().fetchConsultations();
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to update consultation" });
    }
  },

  fetchRTCSessions: async () => {
    const { rtcFilters: f } = get();
    set({ isLoadingRTC: true, error: null });
    try {
      const res = await fetchRTCSessions({ status: f.status || undefined, page: f.page, limit: f.limit });
      set({ rtcSessions: res.data, rtcPagination: buildPagination(res), isLoadingRTC: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch RTC sessions", isLoadingRTC: false });
    }
  },

  setRTCFilters: (f) => set((s) => ({ rtcFilters: { ...s.rtcFilters, ...f } })),

  transitionRTCSession: async (id, status) => {
    try {
      await transitionRTCSession(id, status);
      await get().fetchRTCSessions();
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to update RTC session" });
    }
  },

  fetchDeliveries: async () => {
    const { deliveryFilters: f } = get();
    set({ isLoadingDeliveries: true, error: null });
    try {
      const res = await fetchDeliveries({ status: f.status || undefined, page: f.page, limit: f.limit });
      set({ deliveries: res.data, deliveryPagination: buildPagination(res), isLoadingDeliveries: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch deliveries", isLoadingDeliveries: false });
    }
  },

  setDeliveryFilters: (f) => set((s) => ({ deliveryFilters: { ...s.deliveryFilters, ...f } })),

  transitionDelivery: async (id, status) => {
    try {
      await transitionDelivery(id, status);
      await get().fetchDeliveries();
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to update delivery" });
    }
  },

  retryDelivery: async (id) => {
    try {
      await retryDelivery(id);
      await get().fetchDeliveries();
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to retry delivery" });
    }
  },

  fetchTransactions: async () => {
    const { transactionFilters: f } = get();
    set({ isLoadingTransactions: true, error: null });
    try {
      const res = await fetchTransactions({ status: f.status || undefined, page: f.page, limit: f.limit });
      set({ transactions: res.data, transactionPagination: buildPagination(res), isLoadingTransactions: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch transactions", isLoadingTransactions: false });
    }
  },

  setTransactionFilters: (f) => set((s) => ({ transactionFilters: { ...s.transactionFilters, ...f } })),

  transitionPayment: async (id, status) => {
    try {
      await transitionPayment(id, status);
      await get().fetchTransactions();
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to update payment" });
    }
  },

  flagTransaction: async (id, reason) => {
    try {
      await flagTransaction(id, reason);
      await get().fetchTransactions();
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to flag transaction" });
    }
  },

  fetchAuditLogs: async () => {
    const { auditFilters: f } = get();
    set({ isLoadingAudit: true, error: null });
    try {
      const res = await fetchAuditLogs({ page: f.page, limit: f.limit });
      set({ auditLogs: res.data, auditPagination: buildPagination(res), isLoadingAudit: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch audit logs", isLoadingAudit: false });
    }
  },

  setAuditFilters: (f) => set((s) => ({ auditFilters: { ...s.auditFilters, ...f } })),

  fetchUserNotifications: async (userId) => {
    const { notificationFilters: f } = get();
    set({ isLoadingNotifications: true, error: null });
    try {
      const res = await fetchUserNotifications(userId, { page: f.page, limit: f.limit });
      set({ notifications: res.data, notificationPagination: buildPagination(res), isLoadingNotifications: false });
    } catch (err: any) {
      set({ error: err.response?.data?.message || "Failed to fetch notifications", isLoadingNotifications: false });
    }
  },

  setNotificationFilters: (f) => set((s) => ({ notificationFilters: { ...s.notificationFilters, ...f } })),

  clearError: () => set({ error: null }),
}));