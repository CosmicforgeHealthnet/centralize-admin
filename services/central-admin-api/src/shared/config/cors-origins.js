"use strict";

// Explicitly trusted frontend hostnames for this one Admin platform.
// Any additional approved environment-specific origins belong in CORS_ORIGINS.
// Do not use *.vercel.app: credentialed requests require a narrow allowlist.
const CANONICAL_ADMIN_ORIGINS = Object.freeze([
  "https://centralize-admin.vercel.app",
  "https://centralize-admin.cosmiforgegroup.cloud",
  "https://centralize-admin-staging.vercel.app",
  "https://centralize-admin-staging-cosmicforgedevteamgmailcoms-projects.vercel.app",
]);

// Existing project-scoped Vercel preview domain pattern, not any Vercel tenant.
const VERCEL_PREVIEW_PATTERN =
  /^https:\/\/centralize-admin-[a-z0-9]+-cosmicforgedevteamgmailcoms-projects\.vercel\.app$/;

function createOriginPolicy(env = {}) {
  const configured = String(env.CORS_ORIGINS || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const exactOrigins = new Set([...CANONICAL_ADMIN_ORIGINS, ...configured]);

  return (origin) =>
    !origin ||
    exactOrigins.has(origin) ||
    VERCEL_PREVIEW_PATTERN.test(origin);
}

module.exports = { createOriginPolicy };
