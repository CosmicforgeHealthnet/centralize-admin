import axios from "axios";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000",
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
});

// Attach access token on every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("accessToken");
  if (token) config.headers.Authorization = `Bearer ${token}`;
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

    // Only attempt refresh on 401s that haven't already been retried
    if (error.response?.status === 401 && !original._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((token) => {
          original.headers.Authorization = `Bearer ${token}`;
          return api(original);
        });
      }

      original._retry = true;
      isRefreshing = true;

      try {
        const res = await api.post("/api/auth/refresh-token");
        const newToken = res.data.data.accessToken;
        localStorage.setItem("accessToken", newToken);
        // Set cookie for middleware
        document.cookie = `accessToken=${newToken}; path=/; max-age=${8 * 60 * 60}; secure; samesite=strict`;
        flushQueue(null, newToken);
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      } catch (err) {
        flushQueue(err);
        localStorage.removeItem("accessToken");
        document.cookie = "accessToken=; path=/; max-age=0";
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