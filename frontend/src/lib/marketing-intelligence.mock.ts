import type {
  MIConnection,
  MIConnectionTestResult,
  MIPerformanceResponse,
  MIProviderValidationRow,
  MISyncResult,
} from "@/types/marketing-intelligence.types";

export const delay = (ms = 400) => new Promise((r) => setTimeout(r, ms));

// ─── Connections ─────────────────────────────────────────────────────────────

export const mockMIConnections: MIConnection[] = [
  {
    id: "mi-conn-meta-1",
    platform: "META",
    accountId: "act_1029384756",
    accountLabel: "CosmicForge Healthnet — Meta Ads",
    currency: "NGN",
    status: "ACTIVE",
    hasAccessToken: true,
    hasRefreshToken: false,
    hasRequiredCredentials: true,
    requiresReauthorization: false,
    lastSyncAt: "2026-07-25T06:00:00.000Z",
    lastSyncError: null,
    createdAt: "2026-06-01T09:00:00.000Z",
    updatedAt: "2026-07-25T06:00:00.000Z",
  },
  {
    id: "mi-conn-tiktok-1",
    platform: "TIKTOK",
    accountId: "tt-adv-88213",
    accountLabel: "CosmicForge — TikTok Ads",
    currency: "NGN",
    status: "ERROR",
    hasAccessToken: true,
    hasRefreshToken: true,
    hasRequiredCredentials: true,
    requiresReauthorization: true,
    lastSyncAt: "2026-07-24T06:00:00.000Z",
    lastSyncError: "REAUTHORIZATION_REQUIRED",
    createdAt: "2026-06-03T09:00:00.000Z",
    updatedAt: "2026-07-24T06:05:00.000Z",
  },
  {
    id: "mi-conn-x-1",
    platform: "X",
    accountId: null,
    accountLabel: null,
    currency: null,
    status: "DISABLED",
    hasAccessToken: false,
    hasRefreshToken: false,
    hasRequiredCredentials: false,
    requiresReauthorization: false,
    lastSyncAt: null,
    lastSyncError: null,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: "mi-conn-linkedin-1",
    platform: "LINKEDIN",
    accountId: "urn:li:sponsoredAccount:509821",
    accountLabel: "CosmicForge — LinkedIn Ads",
    currency: "USD",
    status: "ACTIVE",
    hasAccessToken: true,
    hasRefreshToken: false,
    hasRequiredCredentials: true,
    requiresReauthorization: false,
    lastSyncAt: "2026-07-25T06:00:00.000Z",
    lastSyncError: null,
    createdAt: "2026-06-10T09:00:00.000Z",
    updatedAt: "2026-07-25T06:00:00.000Z",
  },
  {
    id: "mi-conn-googleads-1",
    platform: "GOOGLE_ADS",
    accountId: "1234567890",
    accountLabel: "CosmicForge — Google Ads",
    currency: "NGN",
    status: "ACTIVE",
    hasAccessToken: true,
    hasRefreshToken: true,
    hasRequiredCredentials: true,
    requiresReauthorization: false,
    lastSyncAt: "2026-07-25T06:00:00.000Z",
    lastSyncError: null,
    createdAt: "2026-06-15T09:00:00.000Z",
    updatedAt: "2026-07-25T06:00:00.000Z",
  },
];

export const mockMIConnectionTest = (connectionId: string): MIConnectionTestResult => {
  const conn = mockMIConnections.find((c) => c.id === connectionId);
  if (conn?.requiresReauthorization) {
    return { status: "FAILED", errorCategory: "REAUTHORIZATION_REQUIRED", testedAt: new Date().toISOString() };
  }
  if (!conn?.hasRequiredCredentials) {
    return { status: "FAILED", errorCategory: "INVALID_CONFIGURATION", testedAt: new Date().toISOString() };
  }
  return { status: "SUCCESS", testedAt: new Date().toISOString() };
};

// ─── Performance dashboard ─────────────────────────────────────────────────────

export const mockMIPerformanceSingleCurrency: MIPerformanceResponse = {
  asOf: "2026-07-25T06:00:00.000Z",
  partial: true,
  platformErrors: [{ platform: "TIKTOK", code: "REAUTHORIZATION_REQUIRED", retryable: true }],
  summary: {
    currency: "NGN",
    spend: 125000,
    impressions: 420000,
    clicks: 9600,
    signups: 460,
    activeUsers: 310,
    payments: 95,
    revenue: 480000,
    cpa: 271.74,
    conversionRate: 0.99,
    mixedCurrencies: false,
    currencyCompatibility: true,
  },
  summaryByCurrency: null,
  campaigns: [
    {
      platform: "META", accountId: "act_1029384756", campaignExternalId: "campaign-123",
      campaignName: "Doctor Awareness", currency: "NGN", spend: 50000, impressions: 180000,
      clicks: 4200, signups: 210, activeUsers: 140, payments: 45, revenue: 220000,
      cpa: 238.1, conversionRate: 1.07,
    },
    {
      platform: "GOOGLE_ADS", accountId: "1234567890", campaignExternalId: "campaign-556",
      campaignName: "Telemedicine Signups", currency: "NGN", spend: 40000, impressions: 150000,
      clicks: 3600, signups: 180, activeUsers: 120, payments: 38, revenue: 180000,
      cpa: 222.2, conversionRate: 1.06,
    },
    {
      platform: "LINKEDIN", accountId: "urn:li:sponsoredAccount:509821", campaignExternalId: "campaign-901",
      campaignName: "B2B Clinic Partnerships", currency: "NGN", spend: 35000, impressions: 90000,
      clicks: 1800, signups: 70, activeUsers: 50, payments: 12, revenue: 80000,
      cpa: 500.0, conversionRate: 0.67,
    },
  ],
};

export const mockMIPerformanceMixedCurrency: MIPerformanceResponse = {
  asOf: "2026-07-25T06:00:00.000Z",
  partial: false,
  platformErrors: [],
  summary: {
    currency: null, spend: null, impressions: 640000, clicks: 14000, signups: 690,
    activeUsers: 460, payments: 133, revenue: null, cpa: null, conversionRate: null,
    mixedCurrencies: true, currencyCompatibility: false,
  },
  summaryByCurrency: {
    NGN: { spend: 125000, revenue: 480000, cpa: 271.74 },
    USD: { spend: 850, revenue: 2100, cpa: 17.0 },
  },
  campaigns: [
    ...mockMIPerformanceSingleCurrency.campaigns,
    {
      platform: "LINKEDIN", accountId: "urn:li:sponsoredAccount:509821", campaignExternalId: "campaign-902",
      campaignName: "US Provider Network", currency: "USD", spend: 850, impressions: 40000,
      clicks: 800, signups: 30, activeUsers: 20, payments: 5, revenue: 2100,
      cpa: 17.0, conversionRate: 0.63,
    },
  ],
};

// ─── Manual sync ─────────────────────────────────────────────────────────────

export const mockMISyncResult = (): MISyncResult => ({
  runId: "run-" + Math.random().toString(36).slice(2, 10),
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  results: [
    { platform: "META", connectionId: "mi-conn-meta-1", accountLabel: "CosmicForge Healthnet — Meta Ads", status: "SUCCESS", fetched: 42, inserted: 12, updated: 30, failed: 0, skipped: 0 },
    { platform: "TIKTOK", connectionId: "mi-conn-tiktok-1", accountLabel: "CosmicForge — TikTok Ads", status: "FAILED", fetched: 0, inserted: 0, updated: 0, failed: 1, skipped: 0, error: "REAUTHORIZATION_REQUIRED" },
    { platform: "X", connectionId: "mi-conn-x-1", accountLabel: null, status: "SKIPPED_NO_CREDENTIALS", fetched: 0, inserted: 0, updated: 0, failed: 0, skipped: 1 },
    { platform: "LINKEDIN", connectionId: "mi-conn-linkedin-1", accountLabel: "CosmicForge — LinkedIn Ads", status: "SUCCESS", fetched: 18, inserted: 4, updated: 14, failed: 0, skipped: 0 },
    { platform: "GOOGLE_ADS", connectionId: "mi-conn-googleads-1", accountLabel: "CosmicForge — Google Ads", status: "SUCCESS", fetched: 27, inserted: 9, updated: 18, failed: 0, skipped: 0 },
  ],
});

// ─── Provider validation ─────────────────────────────────────────────────────

export const mockMIProviderValidation: MIProviderValidationRow[] = [
  { platform: "META", codeStatus: "IMPLEMENTED", mockTests: "MOCK_VERIFIED", liveStatus: "CONNECTION_TEST_PASSED", blocker: "EXTERNAL_CREDENTIAL_OR_APPROVAL_REQUIRED", connections: [{ id: "mi-conn-meta-1", accountLabel: "CosmicForge Healthnet — Meta Ads", status: "ACTIVE" }] },
  { platform: "TIKTOK", codeStatus: "IMPLEMENTED", mockTests: "MOCK_VERIFIED", liveStatus: "CREDENTIAL_BLOCKED", blocker: "EXTERNAL_CREDENTIAL_OR_APPROVAL_REQUIRED", connections: [{ id: "mi-conn-tiktok-1", accountLabel: "CosmicForge — TikTok Ads", status: "ERROR" }] },
  { platform: "X", codeStatus: "IMPLEMENTED", mockTests: "MOCK_VERIFIED", liveStatus: "NOT_VALIDATED", blocker: "EXTERNAL_CREDENTIAL_OR_APPROVAL_REQUIRED", connections: [] },
  { platform: "LINKEDIN", codeStatus: "IMPLEMENTED", mockTests: "MOCK_VERIFIED", liveStatus: "BOUNDED_FETCH_PASSED", blocker: "EXTERNAL_CREDENTIAL_OR_APPROVAL_REQUIRED", connections: [{ id: "mi-conn-linkedin-1", accountLabel: "CosmicForge — LinkedIn Ads", status: "ACTIVE" }] },
  { platform: "GOOGLE_ADS", codeStatus: "IMPLEMENTED", mockTests: "MOCK_VERIFIED", liveStatus: "METRIC_RECONCILED", blocker: "EXTERNAL_CREDENTIAL_OR_APPROVAL_REQUIRED", connections: [{ id: "mi-conn-googleads-1", accountLabel: "CosmicForge — Google Ads", status: "ACTIVE" }] },
];