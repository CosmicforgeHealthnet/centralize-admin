import type {
  AEProvider,
  AEExecutionSafetyState,
  AEOverviewResponse,
  AEProviderCapability,
  AEPlanListItem,
  AEPlanDetail,
  AEValidationResult,
  AEApprovalQueueItem,
  AEApprovalPacket,
  AERunListItem,
  AERunDetail,
  AEOperationDetail,
  AEIncidentListItem,
  AEIncidentDetail,
  AECreativePublicationListItem,
  AECreativePublicationDetail,
  AEPolicyRow,
  AEKillSwitch,
  AEOverrideRecord,
  AEHealthResponse,
  AEActivityEvent,
} from "@/types/advertising-execution.types";

export const delay = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Safety state (shared across Overview / Health / banners) ─────────────────────────────────

export const mockAESafetyState: AEExecutionSafetyState = {
  masterEnabled: false,
  dryRunEnabled: true,
  workerEnabled: false,
  providerWritesEnabled: {
    META: false,
    TIKTOK: false,
    X: false,
    LINKEDIN: false,
    GOOGLE_ADS: false,
  },
  connectionWritesEnabled: {},
};

// ─── Activity ───────────────────────────────────────────────────────────────

const mockAEActivity: AEActivityEvent[] = [
  {
    id: "act-1",
    type: "EXECUTION_PLAN_SUBMITTED",
    actorLabel: "David Odimayo",
    at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    planId: "plan-1",
    runId: null,
    fingerprint: "a1b2c3d4",
    category: null,
    correlationId: "corr-101",
  },
  {
    id: "act-2",
    type: "EXECUTION_DRIFT_DETECTED",
    actorLabel: "System Worker",
    at: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
    planId: "plan-2",
    runId: "run-2",
    fingerprint: "e5f6a7b8",
    category: "BUDGET_DRIFT",
    correlationId: "corr-102",
  },
];

// ─── Provider capabilities / readiness ─────────────────────────────────────────

export const mockAEProviderCapabilities: AEProviderCapability[] = [
  {
    provider: "META",
    apiVersion: "v19.0",
    connectionId: "conn-meta-1",
    connectionLabel: "CosmicForge Meta Ads",
    connectionStatus: "CONNECTED",
    accountId: "act_1234567890",
    accountLabel: "CosmicForge HealthNet - Primary",
    accountCurrency: "USD",
    accountTimezone: "Africa/Lagos",
    credentialPresent: true,
    liveValidationStatus: "NOT_LIVE_VALIDATED",
    supportedOperations: ["CREATE", "UPDATE", "PAUSE", "RESUME"],
    supportedResourceTypes: ["CAMPAIGN", "GROUP", "CREATIVE", "AD", "BUDGET"],
    supportedFormats: ["IMAGE", "VIDEO", "CAROUSEL"],
    blockers: [],
    staleCapability: false,
  },
  {
    provider: "GOOGLE_ADS",
    apiVersion: "v17",
    connectionId: "conn-google-1",
    connectionLabel: "CosmicForge Google Ads",
    connectionStatus: "CONNECTED",
    accountId: "123-456-7890",
    accountLabel: "CosmicForge HealthNet - Search",
    accountCurrency: "USD",
    accountTimezone: "Africa/Lagos",
    credentialPresent: true,
    liveValidationStatus: "NOT_LIVE_VALIDATED",
    supportedOperations: ["CREATE", "UPDATE", "PAUSE", "RESUME"],
    supportedResourceTypes: ["CAMPAIGN", "BUDGET", "TARGETING", "AD"],
    supportedFormats: ["TEXT", "RESPONSIVE"],
    blockers: [],
    staleCapability: false,
  },
  {
    provider: "TIKTOK",
    apiVersion: "v1.3",
    connectionId: null,
    connectionLabel: null,
    connectionStatus: "NOT_CONFIGURED",
    accountId: null,
    accountLabel: null,
    accountCurrency: null,
    accountTimezone: null,
    credentialPresent: false,
    liveValidationStatus: "NOT_LIVE_VALIDATED",
    supportedOperations: [],
    supportedResourceTypes: [],
    supportedFormats: [],
    blockers: [{ code: "CREDENTIALS_REQUIRED", message: "No connection configured for this provider." }],
    staleCapability: false,
  },
  {
    provider: "LINKEDIN",
    apiVersion: "202506",
    connectionId: null,
    connectionLabel: null,
    connectionStatus: "NOT_CONFIGURED",
    accountId: null,
    accountLabel: null,
    accountCurrency: null,
    accountTimezone: null,
    credentialPresent: false,
    liveValidationStatus: "NOT_LIVE_VALIDATED",
    supportedOperations: [],
    supportedResourceTypes: [],
    supportedFormats: [],
    blockers: [{ code: "CREDENTIALS_REQUIRED", message: "No connection configured for this provider." }],
    staleCapability: false,
  },
  {
    provider: "X",
    apiVersion: "12",
    connectionId: null,
    connectionLabel: null,
    connectionStatus: "NOT_CONFIGURED",
    accountId: null,
    accountLabel: null,
    accountCurrency: null,
    accountTimezone: null,
    credentialPresent: false,
    liveValidationStatus: "NOT_LIVE_VALIDATED",
    supportedOperations: [],
    supportedResourceTypes: [],
    supportedFormats: [],
    blockers: [{ code: "PROVIDER_APPROVAL_REQUIRED", message: "Ads API approval has not been granted." }],
    staleCapability: false,
  },
];

// ─── Plans ──────────────────────────────────────────────────────────────────

export const mockAEPlans: AEPlanListItem[] = [
  {
    id: "plan-1",
    name: "Q3 Search - Cardiology Awareness",
    provider: "GOOGLE_ADS",
    connectionId: "conn-google-1",
    accountLabel: "CosmicForge HealthNet - Search",
    currency: "USD",
    source: "MANUAL",
    status: "PENDING_APPROVAL",
    version: 3,
    fingerprint: "a1b2c3d4",
    validationCurrent: true,
    approvalProgress: { approved: 1, required: 2 },
    itemCount: 5,
    runStatus: null,
    compensationForPlanId: null,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
  },
  {
    id: "plan-2",
    name: "Meta Retargeting - Telehealth Signups",
    provider: "META",
    connectionId: "conn-meta-1",
    accountLabel: "CosmicForge HealthNet - Primary",
    currency: "USD",
    source: "RECOMMENDATION",
    status: "PARTIAL_SUCCESS",
    version: 2,
    fingerprint: "e5f6a7b8",
    validationCurrent: true,
    approvalProgress: { approved: 2, required: 2 },
    itemCount: 3,
    runStatus: "RECONCILING",
    compensationForPlanId: null,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
  },
  {
    id: "plan-3",
    name: "Meta Retargeting - Compensation",
    provider: "META",
    connectionId: "conn-meta-1",
    accountLabel: "CosmicForge HealthNet - Primary",
    currency: "USD",
    source: "COMPENSATION",
    status: "DRAFT",
    version: 1,
    fingerprint: null,
    validationCurrent: false,
    approvalProgress: null,
    itemCount: 1,
    runStatus: null,
    compensationForPlanId: "plan-2",
    createdAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
  },
];

export const mockAEPlanDetail = (id: string): AEPlanDetail => {
  const base = mockAEPlans.find((p) => p.id === id) ?? mockAEPlans[0];
  return {
    ...base,
    description: "Search campaign targeting cardiology-related queries in Lagos and Abuja.",
    items: [
      {
        id: "item-1",
        clientReference: "budget-1",
        operationType: "UPDATE",
        resourceType: "BUDGET",
        existingProviderResourceId: "budget-9981",
        dependsOnClientReferences: [],
        intent: { dailyAmount: "150.00", currency: "USD" },
        beforeState: { dailyAmount: "100.00" },
        materialHash: "h-budget-1",
      },
      {
        id: "item-2",
        clientReference: "campaign-1",
        operationType: "UPDATE",
        resourceType: "CAMPAIGN",
        existingProviderResourceId: "campaign-5521",
        dependsOnClientReferences: ["budget-1"],
        intent: { status: "ENABLED" },
        beforeState: { status: "PAUSED" },
        materialHash: "h-campaign-1",
      },
    ],
    budgetExposure: [
      {
        currency: base.currency,
        currentValue: "100.00",
        proposedValue: "150.00",
        budgetType: "DAILY",
        deltaAbsolute: "50.00",
        deltaPct: "0.50",
        policyCap: "500.00",
        sharedBudgetImpact: [],
        approvalRequired: true,
      },
    ],
    sourceRecommendationId: base.source === "RECOMMENDATION" ? "rec-88" : null,
    compensationOriginalPlanId: base.compensationForPlanId,
    activity: mockAEActivity,
  };
};

// ─── Validation ─────────────────────────────────────────────────────────────

export const mockAEValidationResult = (planId: string, version: number, fingerprint: string): AEValidationResult => ({
  planId,
  version,
  fingerprint,
  status: "SUCCEEDED",
  issues: [
    {
      severity: "WARNING",
      code: "BUDGET_INCREASE_ABOVE_TYPICAL",
      message: "Proposed daily budget is 50% above the account's 30-day average.",
      fieldPath: "items.budget-1.intent.dailyAmount",
    },
  ],
  beforeStateHash: "before-hash-123",
  providerApiVersion: "v17",
  validatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
});

// ─── Approvals ──────────────────────────────────────────────────────────────

export const mockAEApprovalQueue: AEApprovalQueueItem[] = [
  {
    planId: "plan-1",
    planName: "Q3 Search - Cardiology Awareness",
    provider: "GOOGLE_ADS",
    accountLabel: "CosmicForge HealthNet - Search",
    authorLabel: "David Odimayo",
    version: 3,
    fingerprint: "a1b2c3d4",
    validationExpiresAt: new Date(Date.now() + 1000 * 60 * 60 * 20).toISOString(),
    approvalProgress: { approved: 1, required: 2 },
    spendExposure: "150.00 USD/day",
    activationExposure: true,
    warningCount: 1,
    currentUserEligible: true,
  },
];

export const mockAEApprovalPacket = (planId: string): AEApprovalPacket => {
  const plan = mockAEPlans.find((p) => p.id === planId) ?? mockAEPlans[0];
  const detail = mockAEPlanDetail(planId);
  return {
    planId: plan.id,
    version: plan.version,
    fingerprint: plan.fingerprint ?? "a1b2c3d4",
    authorLabel: "David Odimayo",
    source: plan.source,
    beforeState: { dailyAmount: "100.00", status: "PAUSED" },
    desiredState: { dailyAmount: "150.00", status: "ENABLED" },
    hierarchy: detail.items,
    budgetExposure: detail.budgetExposure,
    activationExposure: ["campaign-5521 will begin serving on approval"],
    validationWarnings: mockAEValidationResult(plan.id, plan.version, plan.fingerprint ?? "a1b2c3d4").issues,
    requiredApprovals: 2,
    approvals: [
      { id: "appr-1", actorLabel: "Amaka Obi", decision: "APPROVED", reason: null, decidedAt: new Date(Date.now() - 1000 * 60 * 40).toISOString() },
    ],
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 20).toISOString(),
    currentUserEligible: true,
    currentUserIneligibleReason: null,
  };
};

// ─── Runs / operations ────────────────────────────────────────────────────────

export const mockAERuns: AERunListItem[] = [
  {
    id: "run-2",
    planId: "plan-2",
    planName: "Meta Retargeting - Telehealth Signups",
    planVersion: 2,
    fingerprint: "e5f6a7b8",
    provider: "META",
    accountLabel: "CosmicForge HealthNet - Primary",
    jobStatus: "RECONCILING",
    operationCounts: { total: 3, succeeded: 2, failed: 0, unknown: 1, drifted: 0 },
    startedAt: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
    completedAt: null,
    compensationForRunId: null,
  },
];

export const mockAERunDetail = (id: string): AERunDetail => {
  const base = mockAERuns.find((r) => r.id === id) ?? mockAERuns[0];
  return {
    ...base,
    approvalSummary: { approved: 2, required: 2 },
    timeline: mockAEActivity,
    operations: [
      {
        id: "op-1",
        runId: base.id,
        clientReference: "adset-1",
        resourceType: "GROUP",
        operationType: "UPDATE",
        status: "VERIFIED",
        certainty: "KNOWN_SUCCESS",
        nativeSafeId: "adset-7781",
        nativeSafeName: "Telehealth Retarget - 25-44",
        dependsOnOperationIds: [],
      },
      {
        id: "op-2",
        runId: base.id,
        clientReference: "ad-1",
        resourceType: "AD",
        operationType: "CREATE",
        status: "UNKNOWN",
        certainty: "UNKNOWN",
        nativeSafeId: null,
        nativeSafeName: null,
        dependsOnOperationIds: ["op-1"],
      },
    ],
    reconciliationStatus: "UNKNOWN",
    compensationPlanId: null,
  };
};

export const mockAEOperationDetail = (id: string): AEOperationDetail => {
  const run = mockAERunDetail("run-2");
  const op = run.operations.find((o) => o.id === id) ?? run.operations[0];
  return {
    ...op,
    beforeState: { status: "PAUSED" },
    desiredState: { status: "ENABLED" },
    afterState: null,
    attempts: [
      {
        id: "att-1",
        attemptNumber: 1,
        outcome: "UNKNOWN",
        providerRequestId: "req-99211",
        errorCategory: "PROVIDER_TIMEOUT",
        retryable: null,
        attemptedAt: new Date(Date.now() - 1000 * 60 * 100).toISOString(),
      },
    ],
    reconciliationStatus: "UNKNOWN",
    retryEligible: false,
    retryIneligibleReason: "Outcome is UNKNOWN — read-back must resolve before retry can be reviewed.",
  };
};

// ─── Drift / incidents ────────────────────────────────────────────────────────

export const mockAEIncidents: AEIncidentListItem[] = [
  {
    id: "inc-1",
    classification: "UNKNOWN",
    severity: "HIGH",
    provider: "META",
    accountLabel: "CosmicForge HealthNet - Primary",
    planId: "plan-2",
    runId: "run-2",
    operationId: "op-2",
    ageMinutes: 100,
    acknowledged: false,
    compensationPlanId: null,
    summary: "Ad creation outcome could not be confirmed after provider timeout.",
  },
];

export const mockAEIncidentDetail = (id: string): AEIncidentDetail => {
  const base = mockAEIncidents.find((i) => i.id === id) ?? mockAEIncidents[0];
  return {
    ...base,
    expectedState: { status: "ENABLED", adId: "expected-pending" },
    actualState: { status: "UNKNOWN" },
    expectedHash: "exp-hash-1",
    actualHash: null,
    readBackAt: null,
    acknowledgedBy: null,
    acknowledgedAt: null,
    acknowledgmentReason: null,
    escalated: false,
  };
};

// ─── Creative publications ─────────────────────────────────────────────────────

export const mockAECreativePublications: AECreativePublicationListItem[] = [
  {
    id: "pub-1",
    sourceAssetId: "asset-44",
    sourceAssetName: "Telehealth Hero Banner",
    provider: "META",
    accountLabel: "CosmicForge HealthNet - Primary",
    revision: 2,
    format: "IMAGE",
    destinationDomain: "cosmicforgehealth.com",
    reviewStatus: "APPROVED",
    reuseClassification: "REUSED",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
  },
  {
    id: "pub-2",
    sourceAssetId: "asset-51",
    sourceAssetName: "Cardiology Awareness Video",
    provider: "GOOGLE_ADS",
    accountLabel: "CosmicForge HealthNet - Search",
    revision: 1,
    format: "RESPONSIVE",
    destinationDomain: "cosmicforgehealth.com",
    reviewStatus: "PENDING_REVIEW",
    reuseClassification: "NEW",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString(),
  },
];

export const mockAECreativePublicationDetail = (id: string): AECreativePublicationDetail => {
  const base = mockAECreativePublications.find((p) => p.id === id) ?? mockAECreativePublications[0];
  return {
    ...base,
    copy: { headline: "Your heart deserves attention", body: "Book a cardiology consult today.", cta: "Book Now" },
    destinationUrl: "https://cosmicforgehealth.com/cardiology",
    utm: { utm_source: "META", utm_medium: "paid", utm_campaign: "cardio-q3" },
    identityLabel: "CosmicForge HealthNet (Page)",
    accessibilityText: "A doctor consulting a patient about heart health.",
    mediaMetadata: { width: 1200, height: 628, sizeKb: 340 },
    contentHash: "content-hash-abc",
    reviewHistory: [{ status: "PENDING_REVIEW", at: base.createdAt, note: null }],
  };
};

// ─── Policies / kill switches / overrides ─────────────────────────────────────

export const mockAEPolicies: AEPolicyRow[] = [
  {
    key: "maxDailyBudgetIncreasePct",
    scope: "GLOBAL",
    provider: null,
    connectionId: null,
    currency: null,
    configuredValue: 0.5,
    effectiveValue: 0.5,
    effectiveSourceScope: "GLOBAL",
    version: 4,
  },
  {
    key: "requiredApprovalCount",
    scope: "GLOBAL",
    provider: null,
    connectionId: null,
    currency: null,
    configuredValue: 2,
    effectiveValue: 2,
    effectiveSourceScope: "GLOBAL",
    version: 2,
  },
];

export const mockAEKillSwitches: AEKillSwitch[] = [
  { scope: "MASTER", provider: null, connectionId: null, enabled: false, updatedBy: "David Odimayo", updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString() },
  { scope: "PROVIDER", provider: "TIKTOK", connectionId: null, enabled: false, updatedBy: null, updatedAt: null },
];

export const mockAEOverrides: AEOverrideRecord[] = [];

// ─── Health ─────────────────────────────────────────────────────────────────

export const mockAEHealth: AEHealthResponse = {
  overallState: "DISABLED",
  schemaOk: true,
  safety: mockAESafetyState,
  workerStatus: "STOPPED",
  queueAgeMinutes: null,
  providerReadiness: [
    { provider: "META", state: "READY", reason: null },
    { provider: "GOOGLE_ADS", state: "READY", reason: null },
    { provider: "TIKTOK", state: "UNAVAILABLE", reason: "No connection configured." },
    { provider: "LINKEDIN", state: "UNAVAILABLE", reason: "No connection configured." },
    { provider: "X", state: "UNAVAILABLE", reason: "Provider approval required." },
  ],
  recentFailureCategories: [],
};

// ─── Overview ───────────────────────────────────────────────────────────────

export const mockAEOverview: AEOverviewResponse = {
  safety: mockAESafetyState,
  providerReadiness: [
    { provider: "META", liveValidationStatus: "NOT_LIVE_VALIDATED", blockerCount: 0 },
    { provider: "GOOGLE_ADS", liveValidationStatus: "NOT_LIVE_VALIDATED", blockerCount: 0 },
    { provider: "TIKTOK", liveValidationStatus: "NOT_LIVE_VALIDATED", blockerCount: 1 },
    { provider: "LINKEDIN", liveValidationStatus: "NOT_LIVE_VALIDATED", blockerCount: 1 },
    { provider: "X", liveValidationStatus: "NOT_LIVE_VALIDATED", blockerCount: 1 },
  ],
  plansByStatus: { DRAFT: 1, PENDING_APPROVAL: 1, PARTIAL_SUCCESS: 1 },
  approvalQueue: { pendingCount: 1, expiringSoonCount: 0, eligibleForCurrentUser: 1 },
  queue: { queuedCount: 0, executingCount: 0, oldestQueuedAgeMinutes: null },
  incidents: { unresolvedCount: 1, unknownCount: 1, driftedCount: 0, externalChangeCount: 0 },
  recentPlans: mockAEPlans,
  recentActivity: mockAEActivity,
};