import type { MIPlatform, MIConnection, MIConnectionStatus } from "@/types/marketing-intelligence.types";

// ─── Envelope ────────────────────────────────────────────────────────────────
// Same wrapper as Phase 1 MI: { success, message, data, meta }. Always unwrap data.data.

export interface AMIApiEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
  meta?: Record<string, unknown>;
}

// ─── Global rollout / phase state ─────────────────────────────────────────────

export type AMIPhase2State = "DISABLED" | "DARK_LAUNCH" | "OBSERVATION" | "ADVISORY" | "RELEASED";

export type AMIRolloutStage =
  | "SCHEMA_DARK_LAUNCH"
  | "INGESTION_OBSERVATION"
  | "SCORING_OBSERVATION"
  | "ADVISORY_RECOMMENDATIONS"
  | "TASK_WORKFLOW"
  | "FULL_FIVE_PLATFORM_RELEASE";

export type AMIRolloutStageStatus = "READY" | "PENDING";

export interface AMIRolloutStageRow {
  stage: AMIRolloutStage;
  label: string;
  status: AMIRolloutStageStatus;
}

// ─── Shared enums (Appendix A) ────────────────────────────────────────────────

export type AMICreativeType =
  | "IMAGE" | "VIDEO" | "CAROUSEL" | "TEXT" | "DOCUMENT" | "RESPONSIVE" | "ASSET_GROUP" | "OTHER";

export type AMIDataSufficiency = "INSUFFICIENT" | "LIMITED" | "SUFFICIENT" | "STRONG";

export type AMIFatigueStatus = "NONE" | "WATCH" | "FATIGUED" | "RECOVERED";

export type AMIRecommendationType = "SCALE" | "PAUSE" | "REALLOCATE_BUDGET" | "CREATE_CONTENT";

export type AMIRecommendationStatus = "PENDING" | "ACCEPTED" | "DISMISSED" | "EXPIRED" | "CONVERTED_TO_TASK";

export type AMIAlertSeverity = "INFO" | "WARNING" | "CRITICAL";

export type AMIAlertStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED";

export type AMIAlertType =
  | "CPA_TARGET_BREACH"
  | "SPEND_WITHOUT_CONVERSION"
  | "CONVERSION_RATE_DROP"
  | "CREATIVE_FATIGUE"
  | "SYNC_STALE"
  | "CAMPAIGN_PERFORMANCE_DROP"
  | "HIGH_PERFORMING_CAMPAIGN"
  | "TOKEN_REFRESH_FAILED"
  | "CONNECTION_DEGRADED"
  | "PLATFORM_PERMISSION_ERROR";

export type AMIExperimentStatus = "DRAFT" | "RUNNING" | "COMPLETED" | "CANCELLED";

export type AMIExperimentMetric =
  | "CTR" | "CPC" | "CPA" | "CONVERSION_RATE" | "ROAS" | "ENGAGEMENT_RATE";

export type AMIEvaluationRunStatus =
  | "PENDING" | "RUNNING" | "PARTIAL_SUCCESS" | "SUCCEEDED" | "FAILED" | "SKIPPED_LOCKED";

export type AMIEvaluationRunType = "CREATIVE_SYNC" | "SCORE" | "RECOMMEND" | "ALERT" | "FULL_EVALUATION";

export type AMIRunTrigger = "SCHEDULED" | "MANUAL" | "RETRY";

export type AMISettingScope = "GLOBAL" | "PLATFORM" | "CONNECTION";

export type AMIValidationStatus =
  | "NOT_CONFIGURED"
  | "CREDENTIALS_REQUIRED"
  | "PROVIDER_APPROVAL_REQUIRED"
  | "READY_FOR_LIVE_VALIDATION"
  | "LIVE_VALIDATION_IN_PROGRESS"
  | "LIVE_VALIDATION_PASSED"
  | "LIVE_VALIDATION_FAILED"
  | "CAPABILITY_LIMITED";

// Re-export for convenience so section pages only need one import source.
export type { MIPlatform, MIConnection, MIConnectionStatus };

// ─── Error / conflict codes (Section 23) ──────────────────────────────────────

export type AMIErrorCode =
  | "MARKETING_INTELLIGENCE_PHASE2_DISABLED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_PERMISSION_DENIED"
  | "TOKEN_REFRESH_FAILED"
  | "LOCK_CONFLICT"
  | "LOCK_OWNERSHIP_LOST"
  | "INSUFFICIENT_DATA"
  | "INVALID_TRANSITION"
  | "DUPLICATE_ACTION"
  | "PARTIAL_SUCCESS"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "STALE_VERSION"
  | "SETTING_VERSION_CONFLICT"
  | "SETTING_INVALID"
  | "TASK_INTEGRITY_CONFLICT"
  | "MARKETING_ASSIGNEE_UNAVAILABLE";

// ─── Provider validation (Section 8) ──────────────────────────────────────────

export interface AMIProviderValidationChecklistItem {
  label: string;
  passed: boolean | null; // null = not yet run
}

export interface AMIProviderValidationRow {
  platform: MIPlatform;
  status: AMIValidationStatus;
  blocker: string | null;
  checklist: AMIProviderValidationChecklistItem[];
  connections: Array<{ id: string; accountLabel: string | null; status: MIConnectionStatus }>;
}

// ─── Overview (Section 6) ──────────────────────────────────────────────────────

export interface AMICreativeHealthSummary {
  totalEligible: number;
  insufficient: number;
  limited: number;
  sufficient: number;
  strong: number;
  watch: number;
  fatigued: number;
  latestScoringAt: string | null;
}

export interface AMIRecommendationQueueSummary {
  pendingByType: Partial<Record<AMIRecommendationType, number>>;
  acceptedAwaitingTask: number;
  expiringSoon: number;
}

export interface AMIAlertQueueSummary {
  openCritical: number;
  openWarning: number;
  openInfo: number;
  oldestUnresolvedAt: string | null;
  notificationSuppressedCount: number;
}

export interface AMIAttentionItem {
  key: string;
  label: string;
  description: string;
  linkSection: string;
}

export interface AMIOverviewResponse {
  environment: "STAGING" | "PRODUCTION";
  phase2State: AMIPhase2State;
  rolloutStage: AMIRolloutStage;
  lastSuccessfulFullEvaluationAt: string | null;
  providerReadiness: Array<{ platform: MIPlatform; status: AMIValidationStatus }>;
  creativeHealth: AMICreativeHealthSummary;
  recommendationQueue: AMIRecommendationQueueSummary;
  alertQueue: AMIAlertQueueSummary;
  recentRuns: AMIEvaluationRunListItem[];
  attention: AMIAttentionItem[];
}

// ─── Creative Intelligence (Section 10-12) ─────────────────────────────────────

export interface AMICreativeListItem {
  id: string;
  name: string;
  type: AMICreativeType;
  platform: MIPlatform;
  connectionId: string;
  accountId: string | null;
  campaignExternalId: string | null;
  campaignName: string | null;
  adGroupExternalId: string | null;
  adExternalId: string | null;
  thumbnailUrl: string | null;
  providerStatus: string | null;
  latestScore: number | null;
  dataSufficiency: AMIDataSufficiency;
  fatigueStatus: AMIFatigueStatus;
  currency: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  cpa: number | null;
  roas: number | null;
  lastSeenAt: string | null;
  lastPerformanceDate: string | null;
  lastScoredAt: string | null;
}

export interface AMICreativeFilters {
  platform: MIPlatform | "all";
  connectionId: string | "all";
  campaignExternalId: string;
  creativeType: AMICreativeType | "all";
  providerStatus: string;
  dataSufficiency: AMIDataSufficiency | "all";
  fatigueStatus: AMIFatigueStatus | "all";
  minScore: number | null;
  maxScore: number | null;
  currency: string | "all";
  from: string;
  to: string;
  search: string;
}

export interface AMIScoreComponent {
  key: "ctrEfficiency" | "cpcEfficiency" | "conversionRateEfficiency" | "cpaEfficiency" | "roasEfficiency" | "trendStability";
  label: string;
  defaultWeight: number;
  appliedWeight: number | null; // null = "Not included"
  value: number | null;
}

export interface AMICreativeScore {
  id: string;
  creativeId: string;
  score: number | null;
  dataSufficiency: AMIDataSufficiency;
  components: AMIScoreComponent[];
  peerBasis: string;
  ruleVersion: string;
  generatedAt: string;
  analysisWindow: { from: string; to: string };
  comparisonWindow: { from: string; to: string };
}

export interface AMIFatigueEvidence {
  status: AMIFatigueStatus;
  primarySignal: string | null;
  confirmingSignal: string | null;
  persistenceCount: number;
  volumeGateMet: boolean;
  recentWindow: { from: string; to: string; ctr: number | null; cpc: number | null; cpa: number | null };
  comparisonWindow: { from: string; to: string; ctr: number | null; cpc: number | null; cpa: number | null };
  recoveryHistory: Array<{ recoveredAt: string; note: string | null }>;
}

export interface AMICreativeDetail extends AMICreativeListItem {
  accountLabel: string | null;
  nativeIdentifiers: Record<string, string>;
  primaryWindow: { from: string; to: string; spend: number; impressions: number; clicks: number; ctr: number | null; cpa: number | null; roas: number | null };
  comparisonWindow: { from: string; to: string; spend: number; impressions: number; clicks: number; ctr: number | null; cpa: number | null; roas: number | null };
  latestScoreDetail: AMICreativeScore | null;
  fatigueEvidence: AMIFatigueEvidence;
  scoreHistory: Array<{ date: string; score: number | null; dataSufficiency: AMIDataSufficiency }>;
  dailyMetricTrend: Array<{ date: string; spend: number; impressions: number; clicks: number; ctr: number | null }>;
  copy: { headline: string | null; body: string | null; cta: string | null } | null;
  mediaPreviewUrl: string | null;
  mediaPreviewAvailable: boolean;
}

// ─── Recommendations (Section 13-14) ───────────────────────────────────────────

export interface AMIConfidenceBreakdown {
  sampleSufficiency: number;
  multiDayConsistency: number;
  targetDistance: number;
  dataCompleteness: number;
}

export interface AMIRecommendationListItem {
  id: string;
  type: AMIRecommendationType;
  status: AMIRecommendationStatus;
  platform: MIPlatform;
  connectionId: string;
  targetCampaignExternalId: string;
  targetCampaignName: string | null;
  sourceCampaignExternalId: string | null;
  destinationCampaignExternalId: string | null;
  currencyCode: string | null;
  confidence: number;
  dataSufficiency: AMIDataSufficiency;
  analysisWindow: { from: string; to: string };
  generatedAt: string;
  expiresAt: string | null;
}

export interface AMIRecommendationDetail extends AMIRecommendationListItem {
  reasoning: string;
  evidence: Record<string, string | number | null>;
  confidenceBreakdown: AMIConfidenceBreakdown;
  suggestedAction: { action: string };
  ruleCode: string;
  ruleVersion: string;
  evidenceFingerprint: string;
  history: Array<{ event: string; at: string; actor: string | null; note: string | null }>;
  convertedTaskId: string | null;
}

export interface AMIRecommendationFilters {
  type: AMIRecommendationType | "all";
  status: AMIRecommendationStatus | "all";
  platform: MIPlatform | "all";
  connectionId: string | "all";
  campaignExternalId: string;
  currency: string | "all";
  minConfidence: number | null;
  maxConfidence: number | null;
  generatedFrom: string;
  generatedTo: string;
  onlyActionable: boolean;
  onlyAwaitingTaskConversion: boolean;
}

export interface AMIConvertToTaskPayload {
  assigneeAdminUserId?: string;
  dueDate?: string; // full ISO-8601
}

export interface AMIConvertToTaskResult {
  taskId: string;
  resolvedAssigneeSource: "REQUEST" | "CONNECTION_SETTING" | "GLOBAL_SETTING" | "RUNTIME_FALLBACK";
  resolvedAssigneeName: string | null;
}

export interface AMIEligibleAssignee {
  id: string;
  name: string;
}

// ─── Alerts (Section 15) ───────────────────────────────────────────────────────

export interface AMIAlertListItem {
  id: string;
  type: AMIAlertType;
  severity: AMIAlertSeverity;
  status: AMIAlertStatus;
  platform: MIPlatform | null;
  connectionId: string | null;
  campaignExternalId: string | null;
  creativeId: string | null;
  occurrenceCount: number;
  firstTriggeredAt: string;
  lastTriggeredAt: string;
  cooldownUntil: string | null;
  message: string;
}

export interface AMIAlertDetail extends AMIAlertListItem {
  evidence: Record<string, string | number | null>;
  triggerHistory: Array<{ at: string; note: string | null }>;
  notificationState: "SENT" | "SUPPRESSED" | "NOT_APPLICABLE";
  autoRecovered: boolean;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionReason: string | null;
}

export interface AMIAlertFilters {
  status: AMIAlertStatus | "all";
  severity: AMIAlertSeverity | "all";
  type: AMIAlertType | "all";
  platform: MIPlatform | "all";
  connectionId: string | "all";
  campaignExternalId: string;
  from: string;
  to: string;
  tab: "operational" | "performance" | "all";
}

// ─── Experiments (Section 16) ──────────────────────────────────────────────────

export interface AMIExperimentVariant {
  key: "A" | "B";
  label: string;
  config: Record<string, string>;
}

export interface AMIExperimentListItem {
  id: string;
  name: string;
  hypothesis: string;
  platform: MIPlatform | null;
  connectionId: string | null;
  campaignExternalId: string | null;
  metric: AMIExperimentMetric;
  status: AMIExperimentStatus;
  startedAt: string | null;
  endedAt: string | null;
  owner: string | null;
}

export interface AMIExperimentDetail extends AMIExperimentListItem {
  variants: AMIExperimentVariant[];
  result: string | null;
  conclusion: string | null;
  cancelReason: string | null;
}

export interface AMIExperimentFormPayload {
  name: string;
  hypothesis: string;
  platform?: MIPlatform;
  connectionId?: string;
  campaignExternalId?: string;
  metric: AMIExperimentMetric;
  variants: AMIExperimentVariant[];
}

export interface AMIExperimentFilters {
  status: AMIExperimentStatus | "all";
  platform: MIPlatform | "all";
  metric: AMIExperimentMetric | "all";
  createdFrom: string;
  createdTo: string;
}

// ─── Evaluation Runs (Section 18) ──────────────────────────────────────────────

export interface AMIEvaluationRunListItem {
  id: string;
  runType: AMIEvaluationRunType;
  trigger: AMIRunTrigger;
  status: AMIEvaluationRunStatus;
  platform: MIPlatform | null;
  connectionId: string | null;
  dateWindow: { from: string; to: string } | null;
  processed: number;
  created: number;
  updated: number;
  failed: number;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  actor: string | null;
}

export interface AMIRunPlatformResult {
  platform: MIPlatform;
  connectionId: string;
  status: AMIEvaluationRunStatus;
  processed: number;
  created: number;
  updated: number;
  failed: number;
  errorCategory: string | null;
  retryable: boolean | null;
  safeRequestId: string | null;
}

export interface AMIRunTimelineEvent {
  stage: "REQUESTED" | "LOCK_ACQUIRED" | "LOCK_SKIPPED" | "WORK" | "COMPLETED";
  label: string;
  at: string;
}

export interface AMIEvaluationRunDetail extends AMIEvaluationRunListItem {
  timeline: AMIRunTimelineEvent[];
  platformResults: AMIRunPlatformResult[];
}

export interface AMIEvaluationRunFilters {
  runType: AMIEvaluationRunType | "all";
  status: AMIEvaluationRunStatus | "all";
  platform: MIPlatform | "all";
  from: string;
  to: string;
}

// ─── Manual operations (Section 19) ────────────────────────────────────────────

export type AMIManualOperationType =
  | "PHASE1_SYNC" | "CREATIVE_SYNC" | "CREATIVE_SCORE" | "RECOMMENDATION_EVALUATE" | "ALERT_EVALUATE";

export interface AMIManualOperationPayload {
  operation: AMIManualOperationType;
  platform?: MIPlatform;
  connectionId?: string;
  from?: string;
  to?: string;
  analysisWindow?: { from: string; to: string };
  comparisonWindow?: { from: string; to: string };
  alertContext?: "HEALTH" | "PERFORMANCE";
}

export interface AMIManualOperationResult {
  runId: string;
  status: AMIEvaluationRunStatus;
  summary: Record<string, number>;
}

// ─── Settings (Section 17) ─────────────────────────────────────────────────────

export type AMISettingKey =
  | "attributionWindowDays"
  | "recommendationLookbackDays"
  | "comparisonLookbackDays"
  | "creativeMinimumImpressions"
  | "minimumClicks"
  | "minimumSignups"
  | "minimumPayments"
  | "minimumSpend"
  | "targetCpa"
  | "underperformThresholdPct"
  | "scaleThresholdPct"
  | "maximumRecommendedScalePct"
  | "creativeFatigueThresholdPct"
  | "alertCooldownMinutes"
  | "defaultMarketingAssigneeAdminUserId"
  | "creativeSyncEnabled"
  | "recommendationEvaluationEnabled"
  | "alertEvaluationEnabled"
  | "llmCommentaryEnabled";

export interface AMISettingRow {
  key: AMISettingKey;
  scope: AMISettingScope;
  platform: MIPlatform | null;
  connectionId: string | null;
  currency: string | null;
  configuredValue: string | number | boolean | null;
  effectiveValue: string | number | boolean | null;
  effectiveSourceScope: AMISettingScope;
  version: number;
  isMonetary: boolean;
  isPercentage: boolean;
}

export interface AMISettingUpdatePayload {
  key: AMISettingKey;
  scope: AMISettingScope;
  platform?: MIPlatform;
  connectionId?: string;
  currency?: string;
  value: string | number | boolean | null;
  expectedVersion: number;
}

export interface AMISettingVersionConflict {
  key: AMISettingKey;
  serverValue: string | number | boolean | null;
  serverVersion: number;
  draftValue: string | number | boolean | null;
}