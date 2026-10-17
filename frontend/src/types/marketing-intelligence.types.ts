// ─── Envelope ────────────────────────────────────────────────────────────────
// New backend (v1) always wraps responses: { success, message, data, meta }
// Unlike legacy /api/marketing/*, GETs are wrapped too — always unwrap data.data.

export interface MIApiEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
  meta?: Record<string, unknown>;
}

// ─── Enums ───────────────────────────────────────────────────────────────────

export type MIPlatform = "META" | "TIKTOK" | "X" | "LINKEDIN" | "GOOGLE_ADS";
export type MIPlatformFilter = "all" | MIPlatform;

export type MIConnectionStatus = "ACTIVE" | "DISABLED" | "ERROR";

export type MIErrorCategory =
  | "INVALID_CREDENTIALS"
  | "REAUTHORIZATION_REQUIRED"
  | "INSUFFICIENT_PERMISSION"
  | "ACCOUNT_NOT_FOUND"
  | "API_ACCESS_NOT_APPROVED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_CONFIGURATION";

export type MILiveStatus =
  | "NOT_VALIDATED"
  | "MOCK_VERIFIED"
  | "CONNECTION_TEST_PASSED"
  | "BOUNDED_FETCH_PASSED"
  | "METRIC_RECONCILED"
  | "LIVE_VALIDATED"
  | "CREDENTIAL_BLOCKED"
  | "APPROVAL_BLOCKED"
  | "FAILED";

export type MISyncStatus =
  | "SUCCESS"
  | "PARTIAL"
  | "FAILED"
  | "SKIPPED_NO_CREDENTIALS"
  | "SKIPPED_LOCKED";

// ─── Connections ─────────────────────────────────────────────────────────────

export interface MIConnection {
  id: string;
  platform: MIPlatform;
  accountId: string | null;
  accountLabel: string | null;
  currency: string | null;
  status: MIConnectionStatus;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  hasRequiredCredentials: boolean;
  requiresReauthorization: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface MIConnectionTestResult {
  status: "SUCCESS" | "FAILED";
  errorCategory?: MIErrorCategory;
  message?: string;
  testedAt: string;
}

// Provider-specific credential fields are loosely typed — shape varies per platform.
export type MICredentialFields = Record<string, string | number | boolean | undefined>;

export interface MICreateConnectionPayload {
  platform: MIPlatform;
  accountId?: string;
  currency?: string;
  credentials: MICredentialFields;
}

export interface MIUpdateConnectionPayload {
  accountId?: string;
  currency?: string;
  credentials?: MICredentialFields;
}

export interface MIConnectionFilters {
  platform: MIPlatformFilter;
  status: MIConnectionStatus | "";
}

// ─── Performance Dashboard (MI-01) ────────────────────────────────────────────

export interface MICampaignRow {
  platform: MIPlatform;
  accountId: string;
  campaignExternalId: string;
  campaignName: string;
  currency: string;
  spend: number;
  impressions: number;
  clicks: number;
  signups: number;
  activeUsers: number;
  payments: number;
  revenue: number;
  cpa: number | null;
  conversionRate: number | null;
}

export interface MIPerformanceSummary {
  currency: string | null;
  spend: number | null;
  impressions: number;
  clicks: number;
  signups: number;
  activeUsers: number;
  payments: number;
  revenue: number | null;
  cpa: number | null;
  conversionRate: number | null;
  mixedCurrencies: boolean;
  currencyCompatibility: boolean;
}

export interface MICurrencyTotals {
  spend: number;
  revenue: number;
  cpa: number | null;
}

export interface MIPlatformError {
  platform: MIPlatform;
  code: MIErrorCategory;
  retryable: boolean;
}

export interface MIPerformanceResponse {
  summary: MIPerformanceSummary;
  summaryByCurrency: Record<string, MICurrencyTotals> | null;
  campaigns: MICampaignRow[];
  asOf: string;
  partial: boolean;
  platformErrors: MIPlatformError[];
}

export interface MIPerformanceQuery {
  from: string;
  to: string;
  platform?: MIPlatformFilter;
}

export interface MIDashboardFilters {
  from: string;
  to: string;
  platform: MIPlatformFilter;
  search: string;
  // Display-only pin into summaryByCurrency when the range is mixed-currency — never mixes amounts.
  currency: string | "all";
}

// ─── Manual Sync (MI-03) ───────────────────────────────────────────────────────

export interface MISyncRequest {
  platforms: MIPlatform[];
  connectionIds: string[];
  since: string;
  until: string;
}

export interface MISyncPlatformResult {
  platform: MIPlatform;
  connectionId: string;
  accountLabel: string | null;
  status: MISyncStatus;
  fetched: number;
  inserted: number;
  updated: number;
  failed: number;
  skipped: number;
  error?: string;
}

export interface MISyncResult {
  runId: string;
  startedAt: string;
  completedAt: string | null;
  results: MISyncPlatformResult[];
}

// ─── Provider Validation ───────────────────────────────────────────────────────

export interface MIProviderValidationRow {
  platform: MIPlatform;
  codeStatus: "IMPLEMENTED";
  mockTests: "MOCK_VERIFIED" | "NOT_VERIFIED";
  liveStatus: MILiveStatus;
  blocker: string | null;
  connections: Array<{
    id: string;
    accountLabel: string | null;
    status: MIConnectionStatus;
  }>;
}