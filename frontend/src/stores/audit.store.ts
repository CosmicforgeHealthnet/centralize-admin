import { inspectHttpError } from "@/lib/error-messages";
import { create } from "zustand";
import auditService from "@/lib/audit.service";
import type { ActivityLog, LogGroup, PaginationInfo } from "@/types/audit.types";

interface AuditState {
  logs: ActivityLog[];
  groupedLogs: LogGroup[];
  pagination: PaginationInfo | null;
  isLoading: boolean;
  error: string | null;

  fetchMyLogs: (page?: number, limit?: number) => Promise<void>;
  fetchAllLogs: (page?: number, limit?: number) => Promise<void>;
  clearError: () => void;
  reset: () => void;
}

const groupLogsByDate = (logs: ActivityLog[]): LogGroup[] => {
  const groups: Record<string, ActivityLog[]> = {};

  logs.forEach((log) => {
    const date = log.time;
    if (!groups[date]) {
      groups[date] = [];
    }
    groups[date].push(log);
  });

  const orderMap: Record<string, number> = {
    "Just now": 0,
    "Today": 1,
    "Yesterday": 2,
  };

  return Object.entries(groups)
    .map(([date, items]) => ({ date, logs: items }))
    .sort((a, b) => {
      const orderA = orderMap[a.date] ?? 3;
      const orderB = orderMap[b.date] ?? 3;
      if (orderA !== orderB) return orderA - orderB;
      return b.date.localeCompare(a.date);
    });
};

export const useAuditStore = create<AuditState>((set, get) => ({
  logs: [],
  groupedLogs: [],
  pagination: null,
  isLoading: false,
  error: null,

  fetchMyLogs: async (page = 1, limit = 50) => {
    set({ isLoading: true, error: null });
    try {
      const result = await auditService.getMyActivityLogs(page, limit);
      const groupedLogs = groupLogsByDate(result.logs);
      set({
        logs: result.logs,
        groupedLogs,
        pagination: result.pagination,
        isLoading: false,
      });
    } catch (error: unknown) {
      set({
        error: inspectHttpError(error).message || "Failed to fetch activity logs",
        isLoading: false,
      });
    }
  },

  fetchAllLogs: async (page = 1, limit = 50) => {
    set({ isLoading: true, error: null });
    try {
      const result = await auditService.getAllActivityLogs(page, limit);
      const groupedLogs = groupLogsByDate(result.logs);
      set({
        logs: result.logs,
        groupedLogs,
        pagination: result.pagination,
        isLoading: false,
      });
    } catch (error: unknown) {
      set({
        error: inspectHttpError(error).message || "Failed to fetch all activity logs",
        isLoading: false,
      });
    }
  },

  clearError: () => set({ error: null }),
  
  reset: () => {
    set({
      logs: [],
      groupedLogs: [],
      pagination: null,
      isLoading: false,
      error: null,
    });
  },
}));