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
}

export interface EmailTemplate {
  id: string;
  name: string;
  description: string | null;
  status: string;
  latestVersion: number;
  legacyTemplateId: string | null;
  versions?: TemplateVersion[];
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
  checks: { id: string; ok: boolean; detail: string }[];
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
  rates: { deliveredPercent: number | null; bouncePercent: number | null; complaintPercent: number | null; openPercentIndicative: number | null; clickPercentIndicative: number | null };
  engagement: { opened: number; clicked: number; note: string };
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
  | { id: string; type: "send_email"; templateVersionId: string; senderAddressId: string; subjectOverride?: string | null; next: string | null }
  | { id: string; type: "delay"; minutes: number; next: string | null }
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

export interface ApprovedProductEvent {
  eventType: string;
  versions: number[];
  product: string;
  fields: string[];
}
