// Marketing Email Studio types. Source of truth: docs/cosmicforge-mail-api-contract.md

export type CampaignStatus =
  | "DRAFT"
  | "READY_FOR_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "SCHEDULED"
  | "QUEUED"
  | "SENDING"
  | "COMPLETE"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED"
  | "OUTCOME_UNKNOWN";

export type ContactStatus = "ACTIVE" | "UNSUBSCRIBED" | "BOUNCED" | "COMPLAINED" | "SUPPRESSED";
export type ConsentStatus = "PENDING_CONFIRMATION" | "GRANTED" | "WITHDRAWN";
export type ConsentSource = "WEB_FORM" | "IMPORT" | "MANUAL" | "API" | "EVENT";
export type SuppressionReason = "UNSUBSCRIBED" | "BOUNCED" | "COMPLAINED" | "MANUAL" | "LEGAL";

export interface MarketingOrganization {
  id: string;
  slug: string;
  name: string;
  canAuthor: boolean;
  canApprove: boolean;
}

export interface Consent {
  id: string;
  topic: string;
  status: ConsentStatus;
  source: ConsentSource;
  policyVersion: string;
  doubleOptIn: boolean;
  consentedAt: string | null;
  confirmedAt: string | null;
  withdrawnAt: string | null;
  sourceEvidence?: Record<string, unknown> | null;
}

export interface Contact {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: ContactStatus;
  source: string;
  attributes?: Record<string, unknown> | null;
  consents: Consent[];
  createdAt: string;
  updatedAt?: string;
}

export interface ConsentInput {
  topic: string;
  source: ConsentSource;
  evidence: Record<string, unknown>;
  policyVersion: string;
  doubleOptIn?: boolean;
}

export interface ContactInput {
  email: string;
  firstName?: string;
  lastName?: string;
  attributes?: Record<string, unknown>;
  consent?: ConsentInput;
}

export interface MarketingSenderIdentity {
  addressId: string;
  address: string;
  displayName: string | null;
  kind: string;
  mailboxName: string | null;
  purpose: string;
  domainVerifiedForSending: boolean;
}

export interface AudienceMembershipResult {
  changed: number;
  added: number;
  removed: number;
  rejected: number | { contactId: string; reason: string }[];
}

export interface ImportRowResult {
  row: number;
  line?: number;
  email: string | null;
  status: "CREATED" | "UPDATED" | "SKIPPED" | "REJECTED";
  reason?: string | null;
}

export interface ImportReport {
  total: number;
  created: number;
  updated: number;
  rejected: number;
  skipped: number;
  rows: ImportRowResult[];
}

export interface Suppression {
  id: string;
  email: string;
  reason: SuppressionReason;
  source: string;
  note: string | null;
  organizationId: string | null;
  createdAt: string;
  liftedAt: string | null;
}

export interface Audience {
  id: string;
  name: string;
  description: string | null;
  topic: string;
  status: string;
  contactCount?: number;
  createdAt: string;
}

export interface SegmentRule {
  field: string;
  op: string;
  value: unknown;
}

export interface Segment {
  id: string;
  audienceId: string;
  name: string;
  definition: { match?: "all" | "any"; rules: SegmentRule[] } & Record<string, unknown>;
  createdAt: string;
}

export interface SegmentPreview {
  total: number;
  eligibleCount: number;
  excludedCount: number;
  excluded?: unknown;
  sample?: { email: string; firstName?: string | null }[];
}

export type Block =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "text"; text: string }
  | { type: "button"; label: string; url: string }
  | { type: "image"; src: string; alt: string; href?: string; width?: number }
  | { type: "divider" }
  | { type: "spacer"; height?: number }
  | { type: "footer"; text: string };

export interface Brand {
  primaryColor?: string;
  backgroundColor?: string;
  logoUrl?: string;
  brandName?: string;
}

export interface TemplateVersion {
  id: string;
  version: number;
  subject: string;
  preheader: string | null;
  blocks: Block[];
  brand: Brand | null;
  html?: string;
  text?: string;
  variables: string[];
  contentSha256: string;
  createdAt: string;
  createdBy?: string | null;
  /** Final gap 1: classification snapshot taken when the version was created. */
  classification?: TemplateClassification;
  approval?: TemplateVersionApproval | null;
}

export interface EmailTemplate {
  id: string;
  name: string;
  description: string | null;
  status: string;
  latestVersion: number;
  legacyTemplateId: string | null;
  versions?: TemplateVersion[];
  /** Final gap 1: current template class (MARKETING before migration 37). */
  classification?: TemplateClassification;
  classificationAvailable?: boolean;
  classificationReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RenderResult {
  html: string;
  text: string;
  variables: string[];
  warnings: string[];
  accessibility: { id?: string; ok?: boolean; detail?: string; message?: string }[] | Record<string, unknown>;
}

export interface LegacyTemplate {
  id: string;
  eventId: string;
  validFrom: string;
  validTo: string;
  language: string;
  status: string;
  eventName?: string | null;
}

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  topic: string;
  senderAddressId: string | null;
  senderAddress?: string | null;
  replyTo: string | null;
  subjectOverride: string | null;
  templateVersionId: string | null;
  audienceId: string | null;
  segmentId: string | null;
  frequencyCapHours: number;
  legacyCampaignId: string | null;
  revision: number;
  createdByAdminUserId: string;
  submittedAt: string | null;
  approvedAt: string | null;
  approvedByAdminUserId: string | null;
  createdAt: string;
  updatedAt: string;
  /** M7: true only when MAIL_BROADCAST_DISPATCH_ENABLED is on for this environment. */
  dispatchEnabled?: boolean;
}

export type CampaignInput = Partial<
  Pick<
    Campaign,
    | "name"
    | "topic"
    | "senderAddressId"
    | "replyTo"
    | "subjectOverride"
    | "templateVersionId"
    | "audienceId"
    | "segmentId"
    | "frequencyCapHours"
    | "legacyCampaignId"
  >
>;

export interface PreflightResult {
  ok: boolean;
  checks: { id: string; ok: boolean; detail: string; status?: PreflightStatus }[];
  summary?: Record<PreflightStatus, number>;
  preflightSha256?: string;
  eligibleCount: number;
  excludedCount: number;
}

export interface CampaignHistory {
  approvals: {
    id: string;
    revision: number;
    decision: "APPROVED" | "REJECTED" | "INVALIDATED";
    reviewerAdminUserId: string;
    comment: string | null;
    createdAt: string;
  }[];
  snapshots: {
    id: string;
    revision: number;
    kind: "SUBMISSION" | "APPROVAL";
    subject: string;
    senderAddress: string;
    eligibleCount: number;
    excludedCount: number;
    contentSha256: string;
    createdAt: string;
  }[];
  audit: { id: string; action: string; actorAdminUserId: string | null; createdAt: string; metadata?: Record<string, unknown> | null }[];
}

// ── M7: broadcasts ────────────────────────────────────────────────────────
export type BroadcastStatus = "SCHEDULED" | "QUEUED" | "PREPARING" | "SENDING" | "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED" | "OUTCOME_UNKNOWN" | "PAUSED";

export interface BroadcastDispatch {
  id: string;
  campaignId: string;
  status: BroadcastStatus;
  scheduledFor: string;
  timeZone: string;
  localSendTime: string | null;
  provider: string;
  providerStatus: string | null;
  providerHandoffAt: string | null;
  recipientCount: number;
  excludedCount: number;
  cancelRequestedAt: string | null;
  pausedAt: string | null;
  lastErrorCode: string | null;
  completedAt: string | null;
  ambiguousLocalTime?: boolean;
  note?: string | null;
}

export type RecipientCounts = Record<string, number>;

export interface DispatchState {
  dispatch: BroadcastDispatch | null;
  campaignStatus: string;
  counts?: RecipientCounts;
  dispatchEnabled: boolean;
}

export interface BroadcastReport {
  dispatch: BroadcastDispatch;
  counts: RecipientCounts;
  totals: { handedToProvider: number; delivered: number; awaitingDeliveryEvidence: number; outcomeUnknown: number; excluded: number };
  rates: { deliveredPercent: number | null; bouncePercent: number | null; complaintPercent: number | null; openPercentIndicative: number | null; clickPercentIndicative: number | null; replyPercent?: number | null };
  engagement: { opened: number; clicked: number; note: string };
  // Evidence-based reply attribution; null until the database update is applied.
  replied?: { replied: number; method: string; denominator: string; window: { from: string | null; to: string | null; days: number }; firstReplyAt: string | null; note: string } | null;
  exclusions: { reason: string; count: number }[];
  timeline: { action: string; actor: string | null; outcome: string; at: string }[];
}

export interface BroadcastRecipient {
  id: string;
  contactId: string;
  email: string;
  status: string;
  exclusionReason: string | null;
  lastEventType: string | null;
  lastEventAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
}

export interface BrandSettings {
  organizationId: string;
  confirmationSenderAddressId: string | null;
  defaultTimeZone: string;
  postalAddress: string | null;
  dailyBroadcastCap: number;
  dailyAutomationCap: number;
  maxBroadcastRecipients: number;
  hardMaxBroadcastRecipients: number;
  dispatchPaused: boolean;
  pausedReason: string | null;
  pausedAt: string | null;
  provider: { configured: boolean; credentialSource: string; credentialEnvName: string };
  flags: { broadcastDispatchEnabled: boolean; automationEnabled: boolean; confirmationEmailsEnabled: boolean; emergencyStop: boolean };
}

export interface MarketingOverview {
  campaigns: Record<string, number>;
  recipientsLast30Days: Record<string, number>;
  activeSuppressions: Record<string, number>;
  automations: Record<string, number>;
  enrollments: Record<string, number>;
  jobs: { kind: string; status: string; count: number; oldestNextAttemptAt: string | null }[];
  flags: { broadcastDispatchEnabled: boolean; automationEnabled: boolean; emergencyStop: boolean };
}

// ── M7: automation ────────────────────────────────────────────────────────
export type AutomationTrigger = "CONSENT_GRANTED" | "PRODUCT_EVENT" | "SCHEDULE";
export type AutomationStep =
  | { id: string; type: "send_email"; templateVersionId: string; senderAddressId: string; subjectOverride?: string | null; window?: AutomationWindow; next: string | null }
  | { id: string; type: "delay"; minutes: number; until?: AutomationUntil; window?: AutomationWindow; next: string | null }
  | { id: string; type: "condition"; condition: { field: string; op: string; value: string | string[] | null }; then: string | null; else: string | null }
  | { id: string; type: "exit" };

export interface AutomationDefinition {
  topic: string;
  entryStepId?: string;
  steps: AutomationStep[];
}

export interface AutomationVersion {
  id: string;
  version: number;
  status: "DRAFT" | "PENDING_REVIEW" | "PUBLISHED" | "SUPERSEDED" | "REJECTED";
  definition: AutomationDefinition;
  triggerConfig: Record<string, unknown>;
  definitionSha256: string;
  createdBy: string;
  submittedBy: string | null;
  reviewedBy: string | null;
  reviewComment: string | null;
  publishedAt: string | null;
  createdAt: string;
}

export interface Automation {
  id: string;
  name: string;
  description: string | null;
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
  triggerType: AutomationTrigger;
  activeVersionId: string | null;
  enrollmentLimit: number;
  maxActiveEnrollments: number;
  frequencyCapHours: number;
  executionEnabled: boolean;
  createdBy: string;
  updatedAt: string;
  versions?: AutomationVersion[];
  enrollments?: Record<string, number>;
}

export interface AutomationEnrollment {
  id: string;
  contactId: string;
  email: string;
  version: number;
  status: string;
  currentStepId: string | null;
  stepCount: number;
  nextRunAt: string | null;
  exitReason: string | null;
  createdAt: string;
}

// ---- final gap 4: recipient time zones, automation test mode, replay / recovery
/** "recipient" (contact attributes.timezone -> brand default -> UTC), "brand", or an IANA name. */
export type AutomationZoneSpec = "recipient" | "brand" | string;
export interface AutomationUntil { localTime: string; timezone?: AutomationZoneSpec }
/** ISO weekdays 1 = Monday ... 7 = Sunday. */
export interface AutomationWindow { start: string; end: string; days?: number[]; timezone?: AutomationZoneSpec }

export interface AutomationTestInput {
  contactId?: string;
  contact?: { email: string; firstName?: string; lastName?: string; timezone?: string; consentStatus?: "GRANTED" | "WITHDRAWN" | "NONE" | "PENDING_CONFIRMATION" };
  event?: { topic?: string; origin?: string; eventType?: string; version?: number; eventId?: string; payload?: Record<string, unknown> };
  now?: string;
  engagement?: { previous_send_delivered?: boolean; previous_send_opened?: boolean; previous_send_clicked?: boolean };
}

export interface AutomationTestPathEntry {
  sequence: number;
  stepId: string;
  type: AutomationStep["type"];
  at: string;
  localAt: string;
  action?: "WOULD_SEND" | "WOULD_EXIT" | "WOULD_FAIL";
  reason?: string;
  next?: string | null;
  // delay
  minutes?: number;
  runAt?: string;
  localRunAt?: string;
  timeZone?: string;
  timeZoneSource?: string | null;
  timeZoneFallback?: boolean | null;
  fallbackReason?: string | null;
  ambiguous?: boolean;
  shiftedMinutes?: number;
  windowDeferred?: boolean;
  // condition
  condition?: { field: string; op: string; value: unknown };
  result?: boolean;
  branch?: "then" | "else";
  simulatedEngagement?: boolean;
  // send
  holds?: { reason: string; until: string; localUntil?: string }[];
  sendAt?: string;
  localSendAt?: string;
  template?: { versionId: string; version: number; templateName: string; classification: string | null; classificationAvailable: boolean };
  personalization?: { subject?: string; text?: string; variables?: string[]; missingVariables?: string[]; error?: string };
  warnings?: string[];
}

export interface AutomationTestResult {
  mode: "TEST";
  sideEffects: "NONE";
  simulatedNow: string;
  automation: { id: string; name: string; status: string; triggerType: AutomationTrigger };
  version: { id: string; version: number; status: string; definitionSha256: string };
  validation: { ok: boolean; errors: { field: string; reason?: string }[] };
  contact: { kind: "REAL" | "SYNTHETIC"; id: string | null; email: string; timeZone: string; timeZoneSource: string; timeZoneFallback: boolean; fallbackReason?: string; storedTimeZone: string | null; brandDefaultTimeZone: string | null };
  trigger: { type: AutomationTrigger; matches: boolean; reason: string | null; nextOccurrence?: string | null; recipientLocalRunAt?: string; simulatedEvent?: { droppedFields?: string[] } & Record<string, unknown>; duplicate?: { eventIdSeen: boolean; alreadyEnrolled: boolean; note: string | null } };
  eligibility: {
    automationStatus: string;
    executionEnabled: boolean;
    contactStatus: string;
    consent: { topic: string; status: string; ok: boolean; simulated: boolean };
    suppression: { suppressed: boolean; reason: string | null; scope: string | null };
    frequencyCap: { hours: number; lastMarketingSendAt: string | null };
    enrollmentCap: { limit: number; priorEnrollments: number; ok: boolean };
    maxActiveEnrollments: { limit: number; active: number; ok: boolean };
    wouldEnroll: boolean;
    enrollmentBlockers: string[];
    sendBlockers: string[];
  };
  path: AutomationTestPathEntry[];
  expected: { outcome: string; reason: string | null; sends: number; wouldEnroll: boolean; summary: string };
}

export type AutomationReplayScope = "STEP_RUN" | "ENROLLMENT" | "DEAD_LETTER_JOB";
export interface AutomationRecoveryRun { id: string; enrollmentId: string; stepId: string; stepType: string; sequence: number; status: string; errorCode: string | null; providerMessageId: string | null; firstAttemptAt: string | null; updatedAt: string; recipientEmail: string | null }
export interface AutomationRecoveryEnrollment { id: string; contactId: string; status: string; exitReason: string | null; currentStepId: string | null; stepCount: number; updatedAt: string }
export interface AutomationRecoveryJob { id: string; status: string; enrollmentId: string; sequence: number; attemptCount: number; lastErrorCode: string | null; idempotencyKey: string; completedAt: string | null }
interface RecoveryPage<T> { items: T[]; more: boolean }
export interface AutomationRecovery {
  failedStepRuns: RecoveryPage<AutomationRecoveryRun>;
  interruptedStepRuns: RecoveryPage<AutomationRecoveryRun>;
  failedEnrollments: RecoveryPage<AutomationRecoveryEnrollment>;
  stalledEnrollments: RecoveryPage<AutomationRecoveryEnrollment>;
  deadLetterJobs: RecoveryPage<AutomationRecoveryJob>;
  idempotencyWindowHours: number;
}
export interface AutomationReplayPlan {
  scope: AutomationReplayScope;
  action: string | null;
  enrollmentId: string;
  versionId: string;
  version: number | null;
  stepId: string | null;
  stepRunId: string | null;
  outboxJobId: string | null;
  idempotency: { key: string | null; reused: boolean; firstAttemptAt?: string; providerDeduplicatesUntil?: string; note?: string } | null;
  requiresAcknowledgement: boolean;
  checks: { contactStatus: string; consent: { status: string; ok: boolean }; suppressed: boolean; frequencyCapHoldsUntil: string | null } | null;
  refusal: { code: string; message: string } | null;
  steps: string[];
}
export interface AutomationReplay { id: string; scope: AutomationReplayScope; mode: "DRY_RUN" | "EXECUTE"; status: "PLANNED" | "EXECUTED" | "REFUSED" | "FAILED"; reason: string; requestedBy: string; enrollmentId: string | null; stepRunId: string | null; outboxJobId: string | null; result: { plan?: AutomationReplayPlan; outcome?: Record<string, unknown> } | null; createdAt: string; executedAt: string | null }
export interface AutomationReplayResponse { replay: AutomationReplay; plan: AutomationReplayPlan; executable?: boolean; requires?: string[]; outcome?: { action: string; jobId: string; idempotencyKey?: string; idempotencyKeyReused?: boolean } }

export interface ApprovedProductEvent {
  eventType: string;
  versions: number[];
  product: string;
  fields: string[];
}

// ---- final gaps 1 + 7: template classification, deliverability preflight, template QA
export type TemplateClassification = "MARKETING" | "TRANSACTIONAL" | "TRANSACTIONAL_SECURITY";
export type PreflightStatus = "PASS" | "WARNING" | "BLOCKED" | "UNKNOWN";

export interface TemplateVersionApproval {
  approved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface TemplateClassificationChange {
  templateId: string;
  classification: TemplateClassification;
  changed: boolean;
  newVersion: { id: string; version: number; contentSha256: string; classification: TemplateClassification } | null;
}

export interface QaCheck {
  id: string;
  ok: boolean;
  status: PreflightStatus;
  detail: string;
}

export interface TemplateQaReport {
  versionId: string;
  version: number;
  classification: TemplateClassification;
  disclaimer: string;
  locale: string;
  sampleContact: Record<string, string>;
  formatted: { date: string; number: string; currency: string };
  brandTokens: Record<string, unknown> | null;
  renders: {
    subject: string;
    desktop: { width: number; html: string };
    mobile: { width: number; html: string };
    dark: { html: string; supportsDarkMode: boolean; simulated: boolean };
    plaintext: string;
  } | null;
  checks: QaCheck[];
  summary: Record<PreflightStatus, number>;
  compatibility: { id: string; status: PreflightStatus; detail: string }[];
  approval: TemplateVersionApproval | null;
}

// ── Final gaps 2/3: provider subscription state, re-subscriptions, estimated spend, provider quota ──
export type ProviderSubscriptionState = "SUBSCRIBED" | "UNSUBSCRIBED" | "SUPPRESSED" | "UNKNOWN";
export interface ContactProviderState {
  contactId?: string;
  state: ProviderSubscriptionState;
  reason: string | null;
  provider?: string | null;
  observedAt: string | null;
}
export type ResubscriptionStatus = "PENDING_APPROVAL" | "APPROVED" | "APPLIED" | "UNSUPPORTED" | "FAILED" | "REFUSED" | "CANCELLED";
export interface ProviderResubscription {
  id: string;
  organizationId: string;
  contactId: string;
  email: string | null;
  topic: string;
  status: ResubscriptionStatus;
  evidence: { consentId: string | null; topic: string; source: string | null; policyVersion: string | null; consentedAt: string | null; confirmedAt: string | null; doubleOptIn: boolean; providerState: { state: string; reason: string | null; observedAt: string | null } | null };
  approvedBy: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  providerResult: Record<string, unknown> | null;
  completedAt: string | null;
  createdAt: string | null;
  operatorMessage: string | null;
  providerState?: ContactProviderState;
}
export interface ResubscriptionList {
  items: ProviderResubscription[];
  flags: { providerResubscribeEnabled: boolean };
}
export interface ReportSpend {
  status: "ESTIMATED" | "UNAVAILABLE";
  amount: string | null;
  currency: string | null;
  basis: string;
  basisCount: number | null;
  pricingSource: string | null;
  pricingReference: string | null;
  pricingEffectiveFrom: string | null;
  unitCost: string | null;
  computedAt: string | null;
  label: string;
  reason: string | null;
  includedAllowanceNote: string | null;
  billed: null;
  billedStatus: "UNAVAILABLE";
  billedReason: string;
}
export interface ProviderQuotaSnapshot {
  scope?: string;
  provider?: string;
  status: "OBSERVED" | "UNKNOWN" | "HIDDEN" | "UNAVAILABLE";
  reason?: string;
  dailyUsed?: number | null;
  monthlyUsed?: number | null;
  dailyLimit?: number | null;
  monthlyLimit?: number | null;
  remaining?: { daily: number | null; monthly: number | null };
  remainingStatus?: "KNOWN" | "UNKNOWN";
  observedAt?: string | null;
  source?: string | null;
  exhausted?: boolean;
  exhaustedKind?: "DAILY" | "MONTHLY" | null;
  exhaustedUntil?: string | null;
  rateLimit?: { limit: number | null; remaining: number | null; resetSeconds: number | null; observedAt: string } | null;
  notes?: string[];
}
export interface ReportWindowExtras {
  window?: { from: string | null; to: string | null; note: string };
  reportWindowEnd?: string;
  eventsSettleUntil?: string | null;
  eventsStillArriving?: boolean;
  eventsSettleHours?: number;
  sent?: { count: number; denominator: string };
  accepted?: { count: number; denominator: string };
  delivered?: { count: number; denominator: string };
  [key: string]: unknown;
}
// Interface merging: optional report/overview fields added by migration 37.
export interface BroadcastReport {
  spend?: ReportSpend | null;
  providerQuota?: ProviderQuotaSnapshot | null;
  denominators?: ReportWindowExtras;
}
export interface MarketingOverview {
  spend?: { available: boolean; label: string; estimated?: { currency: string; amount: string; dispatches: number; acceptedRecipients: number }[]; unavailableDispatches?: number; billed?: null; billedStatus?: "UNAVAILABLE"; window?: { from: string; to: string; basis: string } } | null;
}
