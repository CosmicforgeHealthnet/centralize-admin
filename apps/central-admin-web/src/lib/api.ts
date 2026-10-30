import axios from "axios";
import {
  applySessionPayload,
  clearSessionState,
  getBearerToken,
  getCsrfToken,
  getMode,
  setCsrfToken,
} from "./auth-session";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000",
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
});

const UNSAFE_METHODS = new Set(["post", "put", "patch", "delete"]);
let csrfFetch: Promise<void> | null = null;

// After a reload the CSRF token is gone from memory; fetch it once.
async function ensureCsrfToken() {
  if (getCsrfToken() || getMode() === "legacy") return;
  csrfFetch ??= api
    .get("/api/auth/session")
    .then((res) => setCsrfToken(res.data?.data?.csrfToken))
    .catch(() => undefined)
    .finally(() => {
      csrfFetch = null;
    });
  await csrfFetch;
}

// Attach credentials on every request
api.interceptors.request.use(async (config) => {
  const token = getBearerToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  const method = (config.method || "get").toLowerCase();
  if (getMode() !== "legacy" && UNSAFE_METHODS.has(method)) {
    if (!config.url?.includes("/api/auth/session")) await ensureCsrfToken();
    const csrf = getCsrfToken();
    if (csrf) config.headers["X-CSRF-Token"] = csrf;
  }
  return config;
});

// On 401, try to silently refresh, then retry the original request once
let isRefreshing = false;
let failedQueue: Array<{ resolve: (v: string | null) => void; reject: (e: unknown) => void }> = [];

const flushQueue = (error: unknown, token: string | null = null) => {
  failedQueue.forEach((p) => (error ? p.reject(error) : p.resolve(token)));
  failedQueue = [];
};

// Auth endpoints that should NEVER trigger a token refresh
const AUTH_ENDPOINTS = [
  "/api/auth/login",
  "/api/auth/login/mfa",
  "/api/auth/refresh-token",
  "/api/auth/google",
];

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;

    // Don't intercept auth endpoints — let errors pass through directly
    const isAuthEndpoint = AUTH_ENDPOINTS.some((endpoint) =>
      original.url?.includes(endpoint)
    );

    if (isAuthEndpoint) {
      return Promise.reject(error);
    }

    // Another tab refreshed at the same moment; the browser already has the new cookie.
    if (error.response?.data?.code === "AUTH_REFRESH_RACE" && !original._raceRetry) {
      original._raceRetry = true;
      return api(original);
    }

    // Only attempt refresh on 401s that haven't already been retried
    if (error.response?.status === 401 && !original._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((token) => {
          if (token) original.headers.Authorization = `Bearer ${token}`;
          return api(original);
        });
      }

      original._retry = true;
      isRefreshing = true;

      try {
        const res = await api.post("/api/auth/refresh-token");
        const data = res.data.data;
        // Keep the current tab's cookie/bearer choice across refreshes.
        const mode = applySessionPayload(data, { cookieWorks: !getBearerToken() || getMode() === "legacy" });
        const newToken = mode === "legacy" ? data.accessToken : getBearerToken();
        flushQueue(null, newToken);
        if (newToken) original.headers.Authorization = `Bearer ${newToken}`;
        else delete original.headers.Authorization;
        return api(original);
      } catch (err) {
        flushQueue(err);
        clearSessionState();
        window.location.href = "/";
        return Promise.reject(err);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default api;