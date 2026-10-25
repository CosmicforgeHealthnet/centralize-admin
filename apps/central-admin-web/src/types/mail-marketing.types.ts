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
  | "CANCELLED";

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
