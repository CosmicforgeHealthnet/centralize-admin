import { inspectHttpError } from "@/lib/error-messages";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import api from "@/lib/api";
import { applySessionPayload, clearSessionState, getMode, setMemoryFallbackToken, type SessionPayload } from "@/lib/auth-session";
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

interface MfaChallenge {
  challengeToken: string | null; // null when the challenge travels in an httpOnly cookie (Google)
  expiresAt: string | null;
}

interface AuthState {
  user: AdminUser | null;
  // Only populated in legacy mode. In dual/cookie mode credentials are httpOnly cookies.
  accessToken: string | null;
  mfaChallenge: MfaChallenge | null;
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
  completeMfa: (input: { code?: string; recoveryCode?: string }) => Promise<void>;
  startCookieMfaChallenge: () => void;
  cancelMfa: () => void;
  hydrateFromSession: () => Promise<boolean>;
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

interface LoginPayload extends SessionPayload {
  mustChangePassword?: boolean;
  user: AdminUser;
}

// Store credentials for the server-selected mode, then load the profile.
async function finishLogin(data: LoginPayload, set: (partial: Partial<AuthState>) => void) {
  const mode = applySessionPayload(data);
  if (mode === "dual") {
    // If the browser blocked the API cookies, keep the body token in memory only.
    try {
      await api.get("/api/auth/session");
    } catch {
      setMemoryFallbackToken(data.accessToken ?? null);
    }
  }
  set({ user: data.user, accessToken: mode === "legacy" ? data.accessToken ?? null : null, mustChangePassword: Boolean(data.mustChangePassword), isLoading: false });
  const { fetchProfile } = useProfileStore.getState();
  await fetchProfile();
}

function extractErrorMessage(err: unknown, fallback: string): string {
  const detail = inspectHttpError(err);
  if (detail.transportCode === "ERR_NETWORK" || detail.originalMessage === "Network Error") {
    return "Unable to connect to server. Please check your connection and try again.";
  }
  if (detail.transportCode === "ECONNABORTED" || detail.originalMessage?.includes("timeout")) {
    return "Request timed out. Please try again.";
  }
  if (detail.hasResponse) {
    if (detail.fieldErrors.length) return detail.fieldErrors.join(" ");
    return detail.message || fallback;
  }
  if (detail.hasRequest) return "Server is not responding. Please try again later.";
  return fallback;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      mfaChallenge: null,
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
        set({ isLoading: true, error: null, mfaChallenge: null });
        try {
          const res = await api.post("/api/auth/login", { email, password });
          const data = res.data.data;
          if (data.mfaRequired) {
            set({ isLoading: false, mfaChallenge: { challengeToken: data.challengeToken, expiresAt: data.challengeExpiresAt } });
            return;
          }
          await finishLogin(data, set);
        } catch (err: unknown) {
          set({
            error: extractErrorMessage(err, "Invalid email or password"),
            isLoading: false,
          });
        }
      },

      completeMfa: async ({ code, recoveryCode }) => {
        set({ isLoading: true, error: null });
        try {
          const challengeToken = useAuthStore.getState().mfaChallenge?.challengeToken || undefined;
          const res = await api.post("/api/auth/login/mfa", { challengeToken, code: code || undefined, recoveryCode: recoveryCode || undefined });
          set({ mfaChallenge: null });
          await finishLogin(res.data.data, set);
        } catch (err: unknown) {
          set({ error: extractErrorMessage(err, "The code is not valid"), isLoading: false });
        }
      },

      startCookieMfaChallenge: () => set({ mfaChallenge: { challengeToken: null, expiresAt: null }, error: null }),

      cancelMfa: () => set({ mfaChallenge: null, error: null }),

      // Rebuild state from the httpOnly-cookie session (reload, Google callback).
      hydrateFromSession: async () => {
        try {
          const res = await api.get("/api/auth/session");
          const data = res.data.data;
          applySessionPayload({ csrfToken: data.csrfToken, session: { mode: data.mode } });
          set({ user: data.user, accessToken: null, mustChangePassword: Boolean(data.user?.mustChangePassword), isLoading: false, error: null });
          return true;
        } catch {
          return false;
        }
      },

      // ─────────────────────────────────────────────────────────
      // LOGOUT - ✅ FIXED
      // ─────────────────────────────────────────────────────────
      logout: async () => {
        try {
          await api.post("/api/auth/logout");
        } catch (_) {}

        // ✅ Clear everything (legacy token, CSRF, hint cookie, mode)
        clearSessionState();

        // ✅ Clear the persisted Zustand storage
        localStorage.removeItem("auth-storage");

        const { useProfileStore } = await import("@/stores/profile.store");
        useProfileStore.getState().clearProfile();

        // ✅ Reset all state
        set({ 
          user: null, 
          accessToken: null,
          mfaChallenge: null,
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
        } catch (err: unknown) {
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
        } catch (err: unknown) {
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
        } catch (err: unknown) {
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
        } catch (err: unknown) {
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
        } catch (err: unknown) {
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
      // Never persist a token outside legacy mode.
      partialize: (state) => ({
        user: state.user,
        accessToken: getMode() === "legacy" ? state.accessToken : null,
        mustChangePassword: state.mustChangePassword,
      }),
    }
  )
);