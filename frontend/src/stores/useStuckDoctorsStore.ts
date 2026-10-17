import { create } from "zustand";
import { fetchStuckDoctors } from "@/lib/verification.service";
import type { StuckDoctor, StuckDoctorStats, VerificationPagination } from "@/types/verification.types";

interface StuckDoctorsState {
  doctors: StuckDoctor[];
  stats: StuckDoctorStats | null;
  pagination: VerificationPagination | null;
  isLoading: boolean;
  error: string | null;
  page: number;
  limit: number;

  fetch: () => Promise<void>;
  setPage: (page: number) => void;
  setLimit: (limit: number) => void;
  clearError: () => void;
  reset: () => void;
}

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

export const useStuckDoctorsStore = create<StuckDoctorsState>((set, get) => ({
  doctors: [],
  stats: null,
  pagination: null,
  isLoading: false,
  error: null,
  page: DEFAULT_PAGE,
  limit: DEFAULT_LIMIT,

  fetch: async () => {
    const { page, limit } = get();
    set({ isLoading: true, error: null });

    try {
      const result = await fetchStuckDoctors({ page, limit });
      set({
        doctors: result.doctors,
        stats: result.stats,
        pagination: result.pagination,
        isLoading: false,
      });
    } catch (err: any) {
      set({
        error: err.response?.data?.message || "Failed to fetch stuck doctors",
        isLoading: false,
      });
    }
  },

  setPage: (page: number) => {
    set({ page });
    get().fetch();
  },

  setLimit: (limit: number) => {
    set({ limit, page: DEFAULT_PAGE });
    get().fetch();
  },

  clearError: () => set({ error: null }),
  reset: () => {
    set({
      doctors: [],
      stats: null,
      pagination: null,
      isLoading: false,
      error: null,
      page: DEFAULT_PAGE,
      limit: DEFAULT_LIMIT,
    });
  },
}));