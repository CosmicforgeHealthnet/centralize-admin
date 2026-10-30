"use strict";

const OPERATIONS = Object.freeze({
  "/v1/dashboard/metrics": "HEALTHNET_PLATFORM_ADMIN_METRICS_PATH",
  "/v1/dashboard/charts/activity": "HEALTHNET_PLATFORM_ADMIN_ACTIVITY_PATH",
  "/v1/dashboard/charts/patients": "HEALTHNET_PLATFORM_ADMIN_PATIENTS_PATH",
  "/v1/dashboard/charts/revenue": "HEALTHNET_PLATFORM_ADMIN_REVENUE_PATH",
});

function normalizePath(value) {
  if (!value) return null;
  if (typeof value !== "string" || !value.startsWith("/") ||
      value.startsWith("//") || value.includes("\\") ||
      value.includes("..") || value.includes("?") || value.includes("#") ||
      /[\x00-\x1f]/.test(value)) {
    throw new Error("Invalid upstream route mapping");
  }
  return value;
}

function loadConfig(env = process.env) {
  const port = Number(env.PORT || 4100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");

  // This signing secret is distinct from HQ session tokens and upstream tokens.
  const secret = env.HEALTHNET_INTERNAL_JWT_SECRET || "";
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("HEALTHNET_INTERNAL_JWT_SECRET must be at least 32 bytes");
  }
  let upstream = null;
  if (env.HEALTHNET_PLATFORM_ADMIN_BASE_URL) {
    upstream = new URL(env.HEALTHNET_PLATFORM_ADMIN_BASE_URL);
    const insecureAllowed = env.NODE_ENV !== "production" && env.HEALTHNET_ALLOW_INSECURE_UPSTREAM === "true";
    if ((!insecureAllowed && upstream.protocol !== "https:") ||
        (insecureAllowed && !["https:", "http:"].includes(upstream.protocol)) ||
        upstream.username || upstream.password || upstream.hash || upstream.search) {
      throw new Error("Invalid HEALTHNET_PLATFORM_ADMIN_BASE_URL");
    }
  }

  const upstreamToken = env.HEALTHNET_PLATFORM_ADMIN_TOKEN || "";
  const routes = Object.fromEntries(Object.entries(OPERATIONS)
    .map(([endpoint, name]) => [endpoint, normalizePath(env[name])]));
  const timeoutMs = Number(env.HEALTHNET_UPSTREAM_TIMEOUT_MS || 4000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 200 || timeoutMs > 10000) {
    throw new Error("Invalid HEALTHNET_UPSTREAM_TIMEOUT_MS");
  }

  return Object.freeze({
    port, secret, upstream, upstreamToken, routes, timeoutMs,
    ready: Boolean(upstream && upstreamToken && Object.values(routes).some(Boolean)),
  });
}

module.exports = { loadConfig, OPERATIONS };
