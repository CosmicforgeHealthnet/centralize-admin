import { create } from "zustand";
import { persist } from "zustand/middleware";
import api from "@/lib/api";
import { useProfileStore } from "@/stores/profile.store";

interface AdminUser {
  id: string;
  name: string;
  email: string;
  tier: string;
  department: string;
  isTeamLead: boolean;
}

interface PendingResetRequest {
  id: string;
  name: string;
  email: string;
  position: string | null;
  department: string | null;
  tier: string;
  passwordResetExpires: string;
}

interface AuthState {
  user: AdminUser | null;
  accessToken: string | null;
  mustChangePassword: boolean;
  isLoading: boolean;
  error: string | null;

  // Password reset state
  resetRequestLoading: boolean;
  resetRequestError: string | null;
  resetRequestSuccess: string | null;
  pendingResetRequests: PendingResetRequest[];
  pendingResetLoading: boolean;

  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string, confirmPassword: string) => Promise<void>;
  clearError: () => void;

  // Password reset actions
  requestPasswordReset: (name: string, email: string, position?: string) => Promise<void>;
  getPendingResetRequests: () => Promise<void>;
  approvePasswordReset: (targetUserId: string) => Promise<void>;
  rejectPasswordReset: (targetUserId: string, reason?: string) => Promise<void>;
  clearResetState: () => void;
}

const TOKEN_COOKIE = "accessToken";
const COOKIE_MAX_AGE = 8 * 60 * 60;

function setTokenCookie(token: string) {
  document.cookie = `${TOKEN_COOKIE}=${token}; path=/; max-age=${COOKIE_MAX_AGE}; secure; samesite=strict`;
}

function clearTokenCookie() {
  document.cookie = `${TOKEN_COOKIE}=; path=/; max-age=0`;
}

function extractErrorMessage(err: any, fallback: string): string {
  if (err.code === "ERR_NETWORK" || err.message === "Network Error") {
    return "Unable to connect to server. Please check your connection and try again.";
  }
  if (err.code === "ECONNABORTED" || err.message?.includes("timeout")) {
    return "Request timed out. Please try again.";
  }
  if (err.response) {
    const fieldErrors = err.response?.data?.errors;
    if (Array.isArray(fieldErrors) && fieldErrors.length > 0) {
      return fieldErrors
        .map((e: { field: string; message: string }) => e.message)
        .join(" ");
    }
    return err.response?.data?.message || fallback;
  }
  if (err.request) {
    return "Server is not responding. Please try again later.";
  }
  return fallback;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      mustChangePassword: false,
      isLoading: false,
      error: null,

      resetRequestLoading: false,
      resetRequestError: null,
      resetRequestSuccess: null,
      pendingResetRequests: [],
      pendingResetLoading: false,

      // ─────────────────────────────────────────────────────────
      // LOGIN
      // ─────────────────────────────────────────────────────────
      login: async (email, password) => {
        set({ isLoading: true, error: null });
        try {
          const res = await api.post("/api/auth/login", { email, password });
          const { accessToken, mustChangePassword, user } = res.data.data;

          localStorage.setItem("accessToken", accessToken);
          setTokenCookie(accessToken);

          set({ user, accessToken, mustChangePassword, isLoading: false });

          const { fetchProfile } = useProfileStore.getState();
          await fetchProfile();
        } catch (err: any) {
          set({
            error: extractErrorMessage(err, "Invalid email or password"),
            isLoading: false,
          });
        }
      },

      // ─────────────────────────────────────────────────────────
      // LOGOUT - ✅ FIXED
      // ─────────────────────────────────────────────────────────
      logout: async () => {
        try {
          await api.post("/api/auth/logout");
        } catch (_) {}

        // ✅ Clear everything
        localStorage.removeItem("accessToken");
        clearTokenCookie();

        // ✅ Clear the persisted Zustand storage
        localStorage.removeItem("auth-storage");

        const { useProfileStore } = await import("@/stores/profile.store");
        useProfileStore.getState().clearProfile();

        // ✅ Reset all state
        set({ 
          user: null, 
          accessToken: null,
          mustChangePassword: false,
          isLoading: false,
          error: null,
          resetRequestLoading: false,
          resetRequestError: null,
          resetRequestSuccess: null,
          pendingResetRequests: [],
          pendingResetLoading: false,
        });
      },

      // ─────────────────────────────────────────────────────────
      // CHANGE PASSWORD
      // ─────────────────────────────────────────────────────────
      changePassword: async (currentPassword, newPassword, confirmPassword) => {
        set({ isLoading: true, error: null });
        try {
          await api.post("/api/auth/change-password", {
            currentPassword,
            newPassword,
            confirmPassword,
          });
          set({ isLoading: false, mustChangePassword: false });
        } catch (err: any) {
          set({
            error: extractErrorMessage(err, "Failed to change password"),
            isLoading: false,
          });
          throw err;
        }
      },

      // ─────────────────────────────────────────────────────────
      // REQUEST PASSWORD RESET (employee submits form)
      // ─────────────────────────────────────────────────────────
      requestPasswordReset: async (name, email, position) => {
        set({ resetRequestLoading: true, resetRequestError: null, resetRequestSuccess: null });
        try {
          const res = await api.post("/api/auth/request-password-reset", {
            name,
            email,
            position,
          });
          set({
            resetRequestLoading: false,
            resetRequestSuccess: res.data.message,
          });
        } catch (err: any) {
          set({
            resetRequestError: extractErrorMessage(err, "Failed to submit reset request"),
            resetRequestLoading: false,
          });
          throw err;
        }
      },

      // ─────────────────────────────────────────────────────────
      // GET PENDING RESET REQUESTS (HR Admin)
      // ─────────────────────────────────────────────────────────
      getPendingResetRequests: async () => {
        set({ pendingResetLoading: true });
        try {
          const res = await api.get("/api/auth/pending-reset-requests");
          set({
            pendingResetRequests: res.data.data,
            pendingResetLoading: false,
          });
        } catch (err: any) {
          set({ pendingResetLoading: false });
        }
      },

      // ─────────────────────────────────────────────────────────
      // APPROVE PASSWORD RESET (HR Admin)
      // ─────────────────────────────────────────────────────────
      approvePasswordReset: async (targetUserId) => {
        set({ isLoading: true, error: null });
        try {
          await api.post("/api/auth/approve-password-reset", { targetUserId });
          set((state) => ({
            pendingResetRequests: state.pendingResetRequests.filter(
              (r) => r.id !== targetUserId
            ),
            isLoading: false,
          }));
        } catch (err: any) {
          set({
            error: extractErrorMessage(err, "Failed to approve password reset"),
            isLoading: false,
          });
          throw err;
        }
      },

      // ─────────────────────────────────────────────────────────
      // REJECT PASSWORD RESET (HR Admin)
      // ─────────────────────────────────────────────────────────
      rejectPasswordReset: async (targetUserId, reason) => {
        set({ isLoading: true, error: null });
        try {
          await api.post("/api/auth/reject-password-reset", { targetUserId, reason });
          set((state) => ({
            pendingResetRequests: state.pendingResetRequests.filter(
              (r) => r.id !== targetUserId
            ),
            isLoading: false,
          }));
        } catch (err: any) {
          set({
            error: extractErrorMessage(err, "Failed to reject password reset"),
            isLoading: false,
          });
          throw err;
        }
      },

      clearError: () => set({ error: null }),

      clearResetState: () =>
        set({
          resetRequestLoading: false,
          resetRequestError: null,
          resetRequestSuccess: null,
        }),
    }),
    {
      name: "auth-storage",
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        mustChangePassword: state.mustChangePassword,
      }),
    }
  )
);