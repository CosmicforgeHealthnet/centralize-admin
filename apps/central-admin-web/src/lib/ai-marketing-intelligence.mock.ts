import type {
  AMIOverviewResponse,
  AMIProviderValidationRow,
  AMICreativeListItem,
  AMICreativeDetail,
  AMIRecommendationListItem,
  AMIRecommendationDetail,
  AMIConvertToTaskResult,
  AMIEligibleAssignee,
  AMIAlertListItem,
  AMIAlertDetail,
  AMIExperimentListItem,
  AMIExperimentDetail,
  AMIEvaluationRunListItem,
  AMIEvaluationRunDetail,
  AMIManualOperationResult,
  AMISettingRow,
  MIPlatform,
} from "@/types/ai-marketing-intelligence.types";

export const delay = (ms = 400) => new Promise((res) => setTimeout(res, ms));

const PLATFORMS: MIPlatform[] = ["META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"];

// ─── Overview ──────────────────────────────────────────────────────────────

export const mockAMIOverview: AMIOverviewResponse = {
  environment: "STAGING",
  phase2State: "DARK_LAUNCH",
  rolloutStage: "SCHEMA_DARK_LAUNCH",
  lastSuccessfulFullEvaluationAt: null,
  providerReadiness: PLATFORMS.map((platform) => ({ platform, status: "CREDENTIALS_REQUIRED" as const })),
  creativeHealth: {
    totalEligible: 42,
    insufficient: 12,
    limited: 9,
    sufficient: 15,
    strong: 6,
    watch: 4,
    fatigued: 2,
    latestScoringAt: "2026-07-28T09:12:00.000Z",
  },
  recommendationQueue: {
    pendingByType: { PAUSE: 3, SCALE: 2, REALLOCATE_BUDGET: 1, CREATE_CONTENT: 4 },
    acceptedAwaitingTask: 2,
    expiringSoon: 1,
  },
  alertQueue: {
    openCritical: 1,
    openWarning: 5,
    openInfo: 2,
    oldestUnresolvedAt: "2026-07-25T14:30:00.000Z",
    notificationSuppressedCount: 3,
  },
  recentRuns: [],
  attention: [
    { key: "missing-cpa", label: "Missing target CPA", description: "3 connections have no configured target CPA", linkSection: "settings" },
    { key: "no-assignee", label: "No eligible Task assignee", description: "Default Marketing assignee is not configured", linkSection: "settings" },
    { key: "stale-connection", label: "Stale provider connection", description: "Google Ads connection has not synced in 9 days", linkSection: "connections" },
  ],
};

// ─── Provider Validation ───────────────────────────────────────────────────

export const mockAMIProviderValidation: AMIProviderValidationRow[] = PLATFORMS.map((platform) => ({
  platform,
  status: "CREDENTIALS_REQUIRED",
  blocker: "Provider credentials not yet supplied for this environment",
  checklist: [
    { label: "Connection test", passed: null },
    { label: "Bounded account and date-range fetch", passed: null },
    { label: "Pagination behaviour", passed: null },
    { label: "Rate-limit classification", passed: null },
    { label: "Campaign reconciliation against Phase 1", passed: null },
    { label: "Stable creative/ad identifiers on repeat fetch", passed: null },
    { label: "Currency handling", passed: null },
    { label: "Sanitised raw-storage policy", passed: null },
  ],
  connections: [],
}));

// ─── Creative Intelligence ──────────────────────────────────────────────────

export const mockAMICreatives: AMICreativeListItem[] = [
  {
    id: "cr-001",
    name: "Summer Checkup Promo — Carousel",
    type: "CAROUSEL",
    platform: "META",
    connectionId: "conn-meta-1",
    accountId: "act_10293",
    campaignExternalId: "campaign-123",
    campaignName: "Doctor Awareness",
    adGroupExternalId: "adset-55",
    adExternalId: "ad-901",
    thumbnailUrl: null,
    providerStatus: "ACTIVE",
    latestScore: 78,
    dataSufficiency: "STRONG",
    fatigueStatus: "NONE",
    currency: "NGN",
    spend: 50000,
    impressions: 180000,
    clicks: 4200,
    ctr: 0.0233,
    cpa: 238.1,
    roas: 4.4,
    lastSeenAt: "2026-07-28T08:00:00.000Z",
    lastPerformanceDate: "2026-07-27",
    lastScoredAt: "2026-07-28T09:12:00.000Z",
  },
  {
    id: "cr-002",
    name: "Telehealth Launch — Video",
    type: "VIDEO",
    platform: "TIKTOK",
    connectionId: "conn-tiktok-1",
    accountId: "adv-8821",
    campaignExternalId: "campaign-201",
    campaignName: "Telehealth Q3",
    adGroupExternalId: "group-14",
    adExternalId: "ad-402",
    thumbnailUrl: null,
    providerStatus: "ACTIVE",
    latestScore: 41,
    dataSufficiency: "SUFFICIENT",
    fatigueStatus: "WATCH",
    currency: "NGN",
    spend: 32000,
    impressions: 210000,
    clicks: 2900,
    ctr: 0.0138,
    cpa: 410.0,
    roas: 1.2,
    lastSeenAt: "2026-07-28T07:40:00.000Z",
    lastPerformanceDate: "2026-07-27",
    lastScoredAt: "2026-07-28T09:12:00.000Z",
  },
  {
    id: "cr-003",
    name: "Pharmacy Partner Banner",
    type: "IMAGE",
    platform: "GOOGLE_ADS",
    connectionId: "conn-google-1",
    accountId: "123-456-7890",
    campaignExternalId: "campaign-330",
    campaignName: "Pharmacy Network",
    adGroupExternalId: "ag-77",
    adExternalId: "ad-119",
    thumbnailUrl: null,
    providerStatus: "ACTIVE",
    latestScore: null,
    dataSufficiency: "INSUFFICIENT",
    fatigueStatus: "NONE",
    currency: "NGN",
    spend: 4200,
    impressions: 9800,
    clicks: 110,
    ctr: 0.0112,
    cpa: null,
    roas: null,
    lastSeenAt: "2026-07-27T22:00:00.000Z",
    lastPerformanceDate: "2026-07-27",
    lastScoredAt: null,
  },
  {
    id: "cr-004",
    name: "HealthNet Brand — Static",
    type: "IMAGE",
    platform: "LINKEDIN",
    connectionId: "conn-linkedin-1",
    accountId: "urn:li:sponsoredAccount:998877",
    campaignExternalId: "campaign-410",
    campaignName: "B2B Provider Outreach",
    adGroupExternalId: null,
    adExternalId: "ad-620",
    thumbnailUrl: null,
    providerStatus: "ACTIVE",
    latestScore: 88,
    dataSufficiency: "STRONG",
    fatigueStatus: "RECOVERED",
    currency: "USD",
    spend: 850,
    impressions: 22000,
    clicks: 540,
    ctr: 0.0245,
    cpa: 17.0,
    roas: 5.1,
    lastSeenAt: "2026-07-28T06:15:00.000Z",
    lastPerformanceDate: "2026-07-27",
    lastScoredAt: "2026-07-28T09:12:00.000Z",
  },
  {
    id: "cr-005",
    name: "Refill Reminder — Thread",
    type: "TEXT",
    platform: "X",
    connectionId: "conn-x-1",
    accountId: "x-ads-4471",
    campaignExternalId: "campaign-512",
    campaignName: "Refill Reminders",
    adGroupExternalId: null,
    adExternalId: "ad-733",
    thumbnailUrl: null,
    providerStatus: "PAUSED",
    latestScore: 22,
    dataSufficiency: "LIMITED",
    fatigueStatus: "FATIGUED",
    currency: "USD",
    spend: 610,
    impressions: 15400,
    clicks: 98,
    ctr: 0.0064,
    cpa: 95.5,
    roas: 0.4,
    lastSeenAt: "2026-07-26T18:00:00.000Z",
    lastPerformanceDate: "2026-07-26",
    lastScoredAt: "2026-07-27T09:00:00.000Z",
  },
];

export const mockAMICreativeDetail = (id: string): AMICreativeDetail => {
  const base = mockAMICreatives.find((c) => c.id === id) ?? mockAMICreatives[0];
  return {
    ...base,
    accountLabel: `${base.platform} Account`,
    nativeIdentifiers: {
      account: base.accountId ?? "",
      campaign: base.campaignExternalId ?? "",
      adGroup: base.adGroupExternalId ?? "",
      ad: base.adExternalId ?? "",
    },
    primaryWindow: {
      from: "2026-07-14",
      to: "2026-07-27",
      spend: base.spend ?? 0,
      impressions: base.impressions ?? 0,
      clicks: base.clicks ?? 0,
      ctr: base.ctr,
      cpa: base.cpa,
      roas: base.roas,
    },
    comparisonWindow: {
      from: "2026-06-30",
      to: "2026-07-13",
      spend: (base.spend ?? 0) * 0.9,
      impressions: (base.impressions ?? 0) * 0.95,
      clicks: (base.clicks ?? 0) * 1.1,
      ctr: base.ctr ? base.ctr * 1.15 : null,
      cpa: base.cpa ? base.cpa * 0.92 : null,
      roas: base.roas ? base.roas * 1.05 : null,
    },
    latestScoreDetail:
      base.dataSufficiency === "INSUFFICIENT"
        ? null
        : {
            id: `score-${base.id}`,
            creativeId: base.id,
            score: base.latestScore,
            dataSufficiency: base.dataSufficiency,
            components: [
              { key: "ctrEfficiency", label: "CTR efficiency", defaultWeight: 0.2, appliedWeight: 0.2, value: 0.62 },
              { key: "cpcEfficiency", label: "CPC efficiency", defaultWeight: 0.15, appliedWeight: 0.15, value: 0.48 },
              { key: "conversionRateEfficiency", label: "Conversion-rate efficiency", defaultWeight: 0.2, appliedWeight: 0.2, value: 0.55 },
              { key: "cpaEfficiency", label: "CPA efficiency", defaultWeight: 0.25, appliedWeight: 0.25, value: 0.7 },
              { key: "roasEfficiency", label: "ROAS efficiency", defaultWeight: 0.15, appliedWeight: base.roas ? 0.15 : null, value: base.roas ? 0.66 : null },
              { key: "trendStability", label: "Trend stability", defaultWeight: 0.05, appliedWeight: 0.05, value: 0.8 },
            ],
            peerBasis: `Compatible peers on ${base.platform}, same currency and format`,
            ruleVersion: "score-rules-v2.3",
            generatedAt: base.lastScoredAt ?? new Date().toISOString(),
            analysisWindow: { from: "2026-07-14", to: "2026-07-27" },
            comparisonWindow: { from: "2026-06-30", to: "2026-07-13" },
          },
    fatigueEvidence: {
      status: base.fatigueStatus,
      primarySignal: base.fatigueStatus !== "NONE" ? "CTR declined 27% vs comparison window" : null,
      confirmingSignal: base.fatigueStatus === "FATIGUED" ? "CPA increased 31% over 3 consecutive evaluations" : null,
      persistenceCount: base.fatigueStatus === "FATIGUED" ? 3 : base.fatigueStatus === "WATCH" ? 1 : 0,
      volumeGateMet: base.dataSufficiency !== "INSUFFICIENT",
      recentWindow: { from: "2026-07-21", to: "2026-07-27", ctr: base.ctr, cpc: base.cpa ? base.cpa / 12 : null, cpa: base.cpa },
      comparisonWindow: { from: "2026-07-14", to: "2026-07-20", ctr: base.ctr ? base.ctr * 1.27 : null, cpc: null, cpa: base.cpa ? base.cpa * 0.76 : null },
      recoveryHistory: base.fatigueStatus === "RECOVERED" ? [{ recoveredAt: "2026-07-20T00:00:00.000Z", note: "CTR recovered above threshold for 4 consecutive days" }] : [],
    },
    scoreHistory: Array.from({ length: 8 }).map((_, i) => ({
      date: `2026-07-${(20 + i).toString().padStart(2, "0")}`,
      score: base.latestScore ? Math.max(0, base.latestScore - (7 - i) * 2) : null,
      dataSufficiency: base.dataSufficiency,
    })),
    dailyMetricTrend: Array.from({ length: 8 }).map((_, i) => ({
      date: `2026-07-${(20 + i).toString().padStart(2, "0")}`,
      spend: (base.spend ?? 0) / 8,
      impressions: (base.impressions ?? 0) / 8,
      clicks: (base.clicks ?? 0) / 8,
      ctr: base.ctr,
    })),
    copy: { headline: "Book your checkup today", body: "Same-week appointments across our partner network.", cta: "Book now" },
    mediaPreviewUrl: null,
    mediaPreviewAvailable: false,
  };
};

// ─── Recommendations ────────────────────────────────────────────────────────

export const mockAMIRecommendations: AMIRecommendationListItem[] = [
  {
    id: "rec-001",
    type: "PAUSE",
    status: "PENDING",
    platform: "X",
    connectionId: "conn-x-1",
    targetCampaignExternalId: "campaign-512",
    targetCampaignName: "Refill Reminders",
    sourceCampaignExternalId: null,
    destinationCampaignExternalId: null,
    currencyCode: "USD",
    confidence: 0.86,
    dataSufficiency: "STRONG",
    analysisWindow: { from: "2026-07-01", to: "2026-07-14" },
    generatedAt: "2026-07-28T09:12:00.000Z",
    expiresAt: "2026-08-04T09:12:00.000Z",
  },
  {
    id: "rec-002",
    type: "SCALE",
    status: "PENDING",
    platform: "LINKEDIN",
    connectionId: "conn-linkedin-1",
    targetCampaignExternalId: "campaign-410",
    targetCampaignName: "B2B Provider Outreach",
    sourceCampaignExternalId: null,
    destinationCampaignExternalId: null,
    currencyCode: "USD",
    confidence: 0.74,
    dataSufficiency: "STRONG",
    analysisWindow: { from: "2026-07-01", to: "2026-07-14" },
    generatedAt: "2026-07-27T09:00:00.000Z",
    expiresAt: "2026-08-03T09:00:00.000Z",
  },
  {
    id: "rec-003",
    type: "CREATE_CONTENT",
    status: "ACCEPTED",
    platform: "TIKTOK",
    connectionId: "conn-tiktok-1",
    targetCampaignExternalId: "campaign-201",
    targetCampaignName: "Telehealth Q3",
    sourceCampaignExternalId: null,
    destinationCampaignExternalId: null,
    currencyCode: "NGN",
    confidence: 0.62,
    dataSufficiency: "SUFFICIENT",
    analysisWindow: { from: "2026-07-01", to: "2026-07-14" },
    generatedAt: "2026-07-26T09:00:00.000Z",
    expiresAt: "2026-08-02T09:00:00.000Z",
  },
];

export const mockAMIRecommendationDetail = (id: string): AMIRecommendationDetail => {
  const base = mockAMIRecommendations.find((r) => r.id === id) ?? mockAMIRecommendations[0];
  return {
    ...base,
    reasoning: "CPA exceeded the configured target for two consecutive analysis windows, while spend held steady.",
    evidence: { spend: "640.00", attributedSignups: 8, cpa: "80.00", targetCpa: "50.00", distancePct: "0.60" },
    confidenceBreakdown: { sampleSufficiency: 0.4, multiDayConsistency: 0.28, targetDistance: 0.14, dataCompleteness: 0.1 },
    suggestedAction: { action: base.type === "PAUSE" ? "PAUSE_AND_REVIEW" : base.type === "SCALE" ? "SCALE_AND_MONITOR" : "REVIEW" },
    ruleCode: "RULE_CPA_BREACH_V2",
    ruleVersion: "rules-2.3.1",
    evidenceFingerprint: "fp_8a21c9",
    history: base.status !== "PENDING" ? [{ event: base.status, at: base.generatedAt, actor: "David O.", note: null }] : [],
    convertedTaskId: base.status === "CONVERTED_TO_TASK" ? "task-8821" : null,
  };
};

export const mockAMIEligibleAssignees: AMIEligibleAssignee[] = [
  { id: "admin-1", name: "David Idowu" },
  { id: "admin-2", name: "Favour A." },
];

export const mockAMIConvertToTaskResult = (assigneeId?: string): AMIConvertToTaskResult => ({
  taskId: "task-" + Date.now(),
  resolvedAssigneeSource: assigneeId ? "REQUEST" : "RUNTIME_FALLBACK",
  resolvedAssigneeName: assigneeId
    ? mockAMIEligibleAssignees.find((a) => a.id === assigneeId)?.name ?? null
    : mockAMIEligibleAssignees[0].name,
});

// ─── Alerts ─────────────────────────────────────────────────────────────────

export const mockAMIAlerts: AMIAlertListItem[] = [
  {
    id: "alert-001",
    type: "SPEND_WITHOUT_CONVERSION",
    severity: "CRITICAL",
    status: "OPEN",
    platform: "GOOGLE_ADS",
    connectionId: "conn-google-1",
    campaignExternalId: "campaign-330",
    creativeId: "cr-003",
    occurrenceCount: 1,
    firstTriggeredAt: "2026-07-25T14:30:00.000Z",
    lastTriggeredAt: "2026-07-25T14:30:00.000Z",
    cooldownUntil: null,
    message: "Configured spend threshold reached with zero eligible internal conversions.",
  },
  {
    id: "alert-002",
    type: "CREATIVE_FATIGUE",
    severity: "WARNING",
    status: "OPEN",
    platform: "X",
    connectionId: "conn-x-1",
    campaignExternalId: "campaign-512",
    creativeId: "cr-005",
    occurrenceCount: 3,
    firstTriggeredAt: "2026-07-24T10:00:00.000Z",
    lastTriggeredAt: "2026-07-27T08:00:00.000Z",
    cooldownUntil: "2026-07-29T08:00:00.000Z",
    message: "Creative reached confirmed fatigue state.",
  },
  {
    id: "alert-003",
    type: "TOKEN_REFRESH_FAILED",
    severity: "CRITICAL",
    status: "ACKNOWLEDGED",
    platform: "TIKTOK",
    connectionId: "conn-tiktok-1",
    campaignExternalId: null,
    creativeId: null,
    occurrenceCount: 2,
    firstTriggeredAt: "2026-07-23T06:00:00.000Z",
    lastTriggeredAt: "2026-07-26T06:00:00.000Z",
    cooldownUntil: null,
    message: "Connection can no longer refresh authorisation.",
  },
];

export const mockAMIAlertDetail = (id: string): AMIAlertDetail => {
  const base = mockAMIAlerts.find((a) => a.id === id) ?? mockAMIAlerts[0];
  return {
    ...base,
    evidence: { threshold: "500.00", observedSpend: "620.00", conversions: 0 },
    triggerHistory: [{ at: base.firstTriggeredAt, note: "Initial trigger" }, { at: base.lastTriggeredAt, note: "Re-evaluated, condition persists" }],
    notificationState: "SENT",
    autoRecovered: false,
    resolvedAt: base.status === "RESOLVED" ? "2026-07-28T00:00:00.000Z" : null,
    resolvedBy: base.status === "RESOLVED" ? "David Idowu" : null,
    resolutionReason: base.status === "RESOLVED" ? "Connection credentials repaired" : null,
  };
};

// ─── Experiments ────────────────────────────────────────────────────────────

export const mockAMIExperiments: AMIExperimentListItem[] = [
  {
    id: "exp-001",
    name: "Carousel vs Single Image — Checkup Promo",
    hypothesis: "Carousel format will improve CTR by at least 15% over single image for the checkup campaign.",
    platform: "META",
    connectionId: "conn-meta-1",
    campaignExternalId: "campaign-123",
    metric: "CTR",
    status: "RUNNING",
    startedAt: "2026-07-20T00:00:00.000Z",
    endedAt: null,
    owner: "David Idowu",
  },
  {
    id: "exp-002",
    name: "Headline test — Telehealth Q3",
    hypothesis: "Benefit-led headline will reduce CPA compared to feature-led headline.",
    platform: "TIKTOK",
    connectionId: "conn-tiktok-1",
    campaignExternalId: "campaign-201",
    metric: "CPA",
    status: "DRAFT",
    startedAt: null,
    endedAt: null,
    owner: "Favour A.",
  },
];

export const mockAMIExperimentDetail = (id: string): AMIExperimentDetail => {
  const base = mockAMIExperiments.find((e) => e.id === id) ?? mockAMIExperiments[0];
  return {
    ...base,
    variants: [
      { key: "A", label: "Control", config: { format: "SINGLE_IMAGE" } },
      { key: "B", label: "Variant", config: { format: "CAROUSEL" } },
    ],
    result: base.status === "COMPLETED" ? "Variant B outperformed control by 18% CTR" : null,
    conclusion: base.status === "COMPLETED" ? "Adopt carousel format for future checkup campaigns" : null,
    cancelReason: base.status === "CANCELLED" ? "Campaign paused before sufficient data collected" : null,
  };
};

// ─── Evaluation Runs ────────────────────────────────────────────────────────

export const mockAMIEvaluationRuns: AMIEvaluationRunListItem[] = [
  {
    id: "run-001",
    runType: "CREATIVE_SYNC",
    trigger: "MANUAL",
    status: "PARTIAL_SUCCESS",
    platform: null,
    connectionId: null,
    dateWindow: { from: "2026-07-21", to: "2026-07-27" },
    processed: 212,
    created: 18,
    updated: 194,
    failed: 1,
    startedAt: "2026-07-28T09:00:00.000Z",
    completedAt: "2026-07-28T09:04:12.000Z",
    durationMs: 252000,
    actor: "David Idowu",
  },
  {
    id: "run-002",
    runType: "SCORE",
    trigger: "SCHEDULED",
    status: "SUCCEEDED",
    platform: null,
    connectionId: null,
    dateWindow: { from: "2026-07-14", to: "2026-07-27" },
    processed: 42,
    created: 42,
    updated: 0,
    failed: 0,
    startedAt: "2026-07-28T09:10:00.000Z",
    completedAt: "2026-07-28T09:12:00.000Z",
    durationMs: 120000,
    actor: null,
  },
  {
    id: "run-003",
    runType: "ALERT",
    trigger: "MANUAL",
    status: "FAILED",
    platform: "TIKTOK",
    connectionId: "conn-tiktok-1",
    dateWindow: null,
    processed: 0,
    created: 0,
    updated: 0,
    failed: 1,
    startedAt: "2026-07-26T06:00:00.000Z",
    completedAt: "2026-07-26T06:00:05.000Z",
    durationMs: 5000,
    actor: "David Idowu",
  },
  {
    id: "run-004",
    runType: "FULL_EVALUATION",
    trigger: "SCHEDULED",
    status: "SKIPPED_LOCKED",
    platform: null,
    connectionId: null,
    dateWindow: null,
    processed: 0,
    created: 0,
    updated: 0,
    failed: 0,
    startedAt: "2026-07-28T00:00:00.000Z",
    completedAt: "2026-07-28T00:00:01.000Z",
    durationMs: 1000,
    actor: null,
  },
];

export const mockAMIEvaluationRunDetail = (id: string): AMIEvaluationRunDetail => {
  const base = mockAMIEvaluationRuns.find((r) => r.id === id) ?? mockAMIEvaluationRuns[0];
  return {
    ...base,
    timeline: [
      { stage: "REQUESTED", label: "Run requested", at: base.startedAt ?? "" },
      { stage: "LOCK_ACQUIRED", label: "Lock acquired", at: base.startedAt ?? "" },
      { stage: "WORK", label: "Processing platforms", at: base.startedAt ?? "" },
      { stage: "COMPLETED", label: "Run completed", at: base.completedAt ?? "" },
    ],
    platformResults:
      base.runType === "CREATIVE_SYNC"
        ? [
            { platform: "META", connectionId: "conn-meta-1", status: "SUCCEEDED", processed: 124, created: 12, updated: 112, failed: 0, errorCategory: null, retryable: null, safeRequestId: "req_a1b2" },
            { platform: "GOOGLE_ADS", connectionId: "conn-google-1", status: "SUCCEEDED", processed: 88, created: 6, updated: 82, failed: 0, errorCategory: null, retryable: null, safeRequestId: "req_c3d4" },
            { platform: "X", connectionId: "conn-x-1", status: "FAILED", processed: 0, created: 0, updated: 0, failed: 1, errorCategory: "PLATFORM_PERMISSION_ERROR", retryable: false, safeRequestId: "req_e5f6" },
          ]
        : [],
  };
};

export const mockAMIManualOperationResult = (): AMIManualOperationResult => ({
  runId: "run-" + Date.now(),
  status: "SUCCEEDED",
  summary: { processed: 12, created: 3, updated: 9, failed: 0 },
});

// ─── Settings ───────────────────────────────────────────────────────────────

export const mockAMISettings: AMISettingRow[] = [
  { key: "attributionWindowDays", scope: "GLOBAL", platform: null, connectionId: null, currency: null, configuredValue: 30, effectiveValue: 30, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: false, isPercentage: false },
  { key: "recommendationLookbackDays", scope: "GLOBAL", platform: null, connectionId: null, currency: null, configuredValue: 14, effectiveValue: 14, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: false, isPercentage: false },
  { key: "comparisonLookbackDays", scope: "GLOBAL", platform: null, connectionId: null, currency: null, configuredValue: 14, effectiveValue: 14, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: false, isPercentage: false },
  { key: "creativeMinimumImpressions", scope: "GLOBAL", platform: null, connectionId: null, currency: null, configuredValue: 1000, effectiveValue: 1000, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: false, isPercentage: false },
  { key: "minimumClicks", scope: "GLOBAL", platform: null, connectionId: null, currency: null, configuredValue: 30, effectiveValue: 30, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: false, isPercentage: false },
  { key: "minimumSignups", scope: "GLOBAL", platform: null, connectionId: null, currency: null, configuredValue: 3, effectiveValue: 3, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: false, isPercentage: false },
  { key: "minimumPayments", scope: "GLOBAL", platform: null, connectionId: null, currency: null, configuredValue: 3, effectiveValue: 3, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: false, isPercentage: false },
  { key: "targetCpa", scope: "GLOBAL", platform: null, connectionId: null, currency: "NGN", configuredValue: null, effectiveValue: null, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: true, isPercentage: false },
  { key: "minimumSpend", scope: "GLOBAL", platform: null, connectionId: null, currency: "NGN", configuredValue: null, effectiveValue: null, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: true, isPercentage: false },
  { key: "underperformThresholdPct", scope: "GLOBAL", platform: null, connectionId: null, currency: null, configuredValue: 0.3, effectiveValue: 0.3, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: false, isPercentage: true },
  { key: "scaleThresholdPct", scope: "GLOBAL", platform: null, connectionId: null, currency: null, configuredValue: 0.2, effectiveValue: 0.2, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: false, isPercentage: true },
  { key: "maximumRecommendedScalePct", scope: "GLOBAL", platform: null, connectionId: null, currency: null, configuredValue: 0.2, effectiveValue: 0.2, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: false, isPercentage: true },
  { key: "creativeFatigueThresholdPct", scope: "GLOBAL", platform: null, connectionId: null, currency: null, configuredValue: 0.25, effectiveValue: 0.25, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: false, isPercentage: true },
  { key: "alertCooldownMinutes", scope: "GLOBAL", platform: null, connectionId: null, currency: null, configuredValue: 1440, effectiveValue: 1440, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: false, isPercentage: false },
  { key: "defaultMarketingAssigneeAdminUserId", scope: "GLOBAL", platform: null, connectionId: null, currency: null, configuredValue: null, effectiveValue: null, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: false, isPercentage: false },
  { key: "creativeSyncEnabled", scope: "GLOBAL", platform: null, connectionId: null, currency: null, configuredValue: false, effectiveValue: false, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: false, isPercentage: false },
  { key: "recommendationEvaluationEnabled", scope: "GLOBAL", platform: null, connectionId: null, currency: null, configuredValue: false, effectiveValue: false, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: false, isPercentage: false },
  { key: "alertEvaluationEnabled", scope: "GLOBAL", platform: null, connectionId: null, currency: null, configuredValue: false, effectiveValue: false, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: false, isPercentage: false },
  { key: "llmCommentaryEnabled", scope: "GLOBAL", platform: null, connectionId: null, currency: null, configuredValue: false, effectiveValue: false, effectiveSourceScope: "GLOBAL", version: 1, isMonetary: false, isPercentage: false },
];