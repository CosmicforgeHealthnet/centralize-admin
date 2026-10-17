import { create } from "zustand";
import {
  fetchAllVerifications,
  fetchDoctorVerifications,
  fetchDoctorVerificationById,
  approveDoctorVerification,
  rejectDoctorVerification,
  fetchPharmacyVerifications,
  fetchPharmacyVerificationById,
  approvePharmacyVerification,
  rejectPharmacyVerification,
  fetchLabVerifications,
  fetchLabVerificationById,
  approveLabVerification,
  rejectLabVerification,
  fetchDispatchVerifications,
  fetchDispatchVerificationById,
  approveDispatchStep,
  rejectDispatchStep,
  suspendDispatchProvider,
  unsuspendDispatchProvider,
} from "@/lib/verification.service";
import type {
  VerificationListItem,
  VerificationStats,
  VerificationPagination,
  VerificationDetail,
  PharmacyVerificationDetail,
  LabVerificationDetail,
  DispatchVerificationDetail,
  VerificationFilters,
  VerificationRole,
} from "@/types/verification.types";

interface VerificationState {
  // ── List data ─────────────────────────────────────────
  requests: VerificationListItem[];
  stats: VerificationStats | null;
  pagination: VerificationPagination | null;

  // ── Detail data ───────────────────────────────────────
  currentDetail:
    | VerificationDetail
    | PharmacyVerificationDetail
    | LabVerificationDetail
    | DispatchVerificationDetail
    | null;

  // ── UI state ──────────────────────────────────────────
  activeRole: VerificationRole;
  filters: VerificationFilters;
  isLoadingList: boolean;
  isLoadingDetail: boolean;
  isActioning: boolean;
  error: string | null;

  // ── Actions ───────────────────────────────────────────
  setActiveRole: (role: VerificationRole) => void;
  setFilters: (filters: Partial<VerificationFilters>) => void;
  resetFilters: () => void;

  fetchList: () => Promise<void>;
  fetchDetail: (id: string) => Promise<void>;
  clearDetail: () => void;

  approve: (id: string, reviewNotes?: string) => Promise<void>;
  reject: (id: string, rejectionReason: string, reviewNotes?: string) => Promise<void>;

  // Dispatch-specific
  approveStep: (id: string, step: string, notes?: string) => Promise<void>;
  rejectStep: (id: string, step: string, reason: string) => Promise<void>;
  suspend: (id: string, reason: string) => Promise<void>;
  unsuspend: (id: string) => Promise<void>;

  clearError: () => void;
}

const DEFAULT_FILTERS: VerificationFilters = {
  status: "All",
  startDate: "",
  endDate: "",
  search: "",
  page: 1,
  limit: 10,
};

export const useVerificationStore = create<VerificationState>((set, get) => ({
  // ── Initial state ─────────────────────────────────────
  requests: [],
  stats: null,
  pagination: null,
  currentDetail: null,
  activeRole: "All",
  filters: DEFAULT_FILTERS,
  isLoadingList: false,
  isLoadingDetail: false,
  isActioning: false,
  error: null,

  // ── Role / filter actions ─────────────────────────────

  setActiveRole: (role) => {
    set({ activeRole: role, filters: DEFAULT_FILTERS, requests: [], pagination: null });
  },

  setFilters: (incoming) => {
    set((state) => ({
      filters: {
        ...state.filters,
        ...incoming,
        page: incoming.page ?? 1,
      },
    }));
  },

  resetFilters: () => {
    set({ filters: DEFAULT_FILTERS });
  },

  // ── List fetch ────────────────────────────────────────

  fetchList: async () => {
    const { activeRole, filters } = get();
    set({ isLoadingList: true, error: null });

    try {
      let result;

      if (activeRole === "All") {
        result = await fetchAllVerifications(filters);
      } else if (activeRole === "Doctors") {
        result = await fetchDoctorVerifications(filters);
      } else if (activeRole === "Pharmacies") {
        result = await fetchPharmacyVerifications(filters);
      } else if (activeRole === "Dispatch") {
        result = await fetchDispatchVerifications(filters);
      } else {
        // Labs
        result = await fetchLabVerifications(filters);
      }

      set({
        requests: result.requests,
        pagination: result.pagination,
        stats: "stats" in result ? (result as { stats: VerificationStats }).stats : get().stats,
        isLoadingList: false,
      });
    } catch (err: any) {
      set({
        error: err.response?.data?.message || "Failed to fetch verification requests",
        isLoadingList: false,
      });
    }
  },

  // ── Detail fetch ──────────────────────────────────────

  fetchDetail: async (id: string) => {
    const { activeRole } = get();
    set({ isLoadingDetail: true, error: null, currentDetail: null });

    try {
      let detail;

      if (activeRole === "Pharmacies") {
        detail = await fetchPharmacyVerificationById(id);
      } else if (activeRole === "Labs") {
        detail = await fetchLabVerificationById(id);
      } else if (activeRole === "Dispatch") {
        detail = await fetchDispatchVerificationById(id);
      } else {
        detail = await fetchDoctorVerificationById(id);
      }

      set({ currentDetail: detail, isLoadingDetail: false });
    } catch (err: any) {
      set({
        error: err.response?.data?.message || "Failed to fetch verification detail",
        isLoadingDetail: false,
      });
    }
  },

  clearDetail: () => set({ currentDetail: null }),

  // ── Approve ───────────────────────────────────────────

  approve: async (id: string, reviewNotes?: string) => {
    const { activeRole } = get();
    set({ isActioning: true, error: null });

    try {
      if (activeRole === "Pharmacies") {
        await approvePharmacyVerification(id, reviewNotes);
      } else if (activeRole === "Labs") {
        await approveLabVerification(id);
      } else {
        await approveDoctorVerification(id, reviewNotes);
      }

      set((state) => ({
        requests: state.requests.map((r) =>
          r.id === id ? { ...r, status: "Approved" as const } : r
        ),
        currentDetail:
          state.currentDetail?.id === id
            ? { ...state.currentDetail, status: "Approved" as const }
            : state.currentDetail,
        isActioning: false,
      }));
    } catch (err: any) {
      set({
        error: err.response?.data?.message || "Failed to approve verification",
        isActioning: false,
      });
      throw err;
    }
  },

  // ── Reject ────────────────────────────────────────────

  reject: async (id: string, rejectionReason: string, reviewNotes?: string) => {
    const { activeRole } = get();
    set({ isActioning: true, error: null });

    try {
      if (activeRole === "Pharmacies") {
        await rejectPharmacyVerification(id, rejectionReason, reviewNotes);
      } else if (activeRole === "Labs") {
        await rejectLabVerification(id, rejectionReason);
      } else {
        await rejectDoctorVerification(id, rejectionReason, reviewNotes);
      }

      set((state) => ({
        requests: state.requests.map((r) =>
          r.id === id ? { ...r, status: "Failed" as const } : r
        ),
        currentDetail:
          state.currentDetail?.id === id
            ? { ...state.currentDetail, status: "Failed" as const }
            : state.currentDetail,
        isActioning: false,
      }));
    } catch (err: any) {
      set({
        error: err.response?.data?.message || "Failed to reject verification",
        isActioning: false,
      });
      throw err;
    }
  },

  // ── Dispatch-specific actions ─────────────────────────

  approveStep: async (id: string, step: string, notes?: string) => {
    set({ isActioning: true, error: null });
    try {
      await approveDispatchStep(id, step, notes);
      // Refresh detail to get updated step statuses
      await get().fetchDetail(id);
      set({ isActioning: false });
    } catch (err: any) {
      set({
        error: err.response?.data?.message || "Failed to approve step",
        isActioning: false,
      });
      throw err;
    }
  },

  rejectStep: async (id: string, step: string, reason: string) => {
    set({ isActioning: true, error: null });
    try {
      await rejectDispatchStep(id, step, reason);
      await get().fetchDetail(id);
      set({ isActioning: false });
    } catch (err: any) {
      set({
        error: err.response?.data?.message || "Failed to reject step",
        isActioning: false,
      });
      throw err;
    }
  },

  suspend: async (id: string, reason: string) => {
    set({ isActioning: true, error: null });
    try {
      await suspendDispatchProvider(id, reason);
      set((state) => ({
        requests: state.requests.map((r) =>
          r.id === id ? { ...r, status: "Failed" as const } : r
        ),
        currentDetail:
          state.currentDetail?.id === id
            ? { ...state.currentDetail, status: "Failed" as const }
            : state.currentDetail,
        isActioning: false,
      }));
    } catch (err: any) {
      set({
        error: err.response?.data?.message || "Failed to suspend provider",
        isActioning: false,
      });
      throw err;
    }
  },

  unsuspend: async (id: string) => {
    set({ isActioning: true, error: null });
    try {
      await unsuspendDispatchProvider(id);
      set((state) => ({
        requests: state.requests.map((r) =>
          r.id === id ? { ...r, status: "Approved" as const } : r
        ),
        currentDetail:
          state.currentDetail?.id === id
            ? { ...state.currentDetail, status: "Approved" as const }
            : state.currentDetail,
        isActioning: false,
      }));
    } catch (err: any) {
      set({
        error: err.response?.data?.message || "Failed to unsuspend provider",
        isActioning: false,
      });
      throw err;
    }
  },

  clearError: () => set({ error: null }),
}));