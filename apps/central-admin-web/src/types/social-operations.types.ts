// Same envelope as Marketing Intelligence — always { success, message, data, meta }
export interface SOApiEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
  meta?: Record<string, unknown>;
}

// ─── Enums ───────────────────────────────────────────────────────────────────

export type SOProvider = "FACEBOOK" | "INSTAGRAM" | "TIKTOK" | "X" | "LINKEDIN";

export type SOConnectionStatus =
  | "PENDING_AUTHORIZATION"
  | "PENDING_PLATFORM_APPROVAL"
  | "ACTIVE"
  | "DISABLED"
  | "ERROR"
  | "REAUTHORIZATION_REQUIRED";

export type SOCapabilityState =
  | "AVAILABLE"
  | "READ_ONLY"
  | "REQUIRES_REAUTHORIZATION"
  | "REQUIRES_PLATFORM_APPROVAL"
  | "RATE_LIMITED"
  | "NATIVE_ONLY"
  | "UNSUPPORTED_ACCOUNT_TYPE"
  | "DISABLED_BY_POLICY";

export type SOIdentityType =
  | "FACEBOOK_PAGE"
  | "INSTAGRAM_PROFESSIONAL"
  | "TIKTOK_ACCOUNT"
  | "X_USER"
  | "LINKEDIN_ORGANIZATION"
  | "LINKEDIN_MEMBER";

export type SOPostStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "SCHEDULED"
  | "PUBLISHING"
  | "PARTIALLY_PUBLISHED"
  | "PUBLISHED"
  | "FAILED"
  | "CANCELLED"
  | "LEGACY_UNVERIFIED";

export type SOMediaStatus = "UPLOADING" | "PROCESSING" | "READY" | "FAILED" | "DELETED";

export type SOPublicationStatus =
  | "PENDING"
  | "VALIDATING"
  | "UPLOADING"
  | "PROCESSING"
  | "PUBLISHING"
  | "AWAITING_USER_ACTION"
  | "PUBLISHED"
  | "FAILED_RETRYABLE"
  | "FAILED_PERMANENT"
  | "CANCELLED"
  | "DELETED";

export type SOContentSource = "ADMIN_PUBLISHED" | "PROVIDER_IMPORTED";

export type SOConversationStatus = "OPEN" | "PENDING" | "SNOOZED" | "RESOLVED" | "SPAM" | "ARCHIVED";

export type SOCommentStatus = "VISIBLE" | "HIDDEN" | "DELETED" | "FLAGGED" | "ESCALATED";

export type SOEscalationClassification =
  | "MEDICAL_EMERGENCY"
  | "SELF_HARM_RISK"
  | "CLINICAL_ADVICE_REQUEST"
  | "PRESCRIPTION_REQUEST"
  | "PROTECTED_HEALTH_INFORMATION"
  | "PRIVACY_INCIDENT"
  | "PATIENT_COMPLAINT"
  | "LEGAL_THREAT"
  | "MEDICAL_MISINFORMATION"
  | "GENERAL_INQUIRY";

export type SOEscalationStatus = "DETECTED" | "CONFIRMED" | "DISMISSED" | "RESOLVED";

export type SOJobType = "PUBLISHING" | "ACTION";

export type SOJobStatus =
  | "PENDING"
  | "CLAIMED"
  | "RUNNING"
  | "RETRY_SCHEDULED"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

// ─── Connections & Identities (SO-02, SO-03) ──────────────────────────────────

export interface SOConnection {
  id: string;
  provider: SOProvider;
  label: string;
  status: SOConnectionStatus;
  scopes: string[];
  expiresAt: string | null;
  webhookHealthy: boolean;
  identityCount: number;
  hasRequiredCredentials: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SOIdentity {
  id: string;
  connectionId: string;
  provider: SOProvider;
  identityType: SOIdentityType;
  username: string;
  avatarUrl: string | null;
  role: string | null;
  capabilities: Record<string, SOCapabilityState>;
  lastDiscoveryAt: string | null;
  status: SOConnectionStatus;
}

// ─── Content, Composer, Approvals (SO-04, SO-05, SO-06) ───────────────────────

export interface SOPostTargetVariant {
  identityId: string;
  provider: SOProvider;
  text: string;
  mediaIds: string[];
  firstComment?: string;
  altText?: string;
  options?: Record<string, unknown>;
}

export interface SOPost {
  id: string;
  title: string;
  baseText: string;
  campaign: string | null;
  status: SOPostStatus;
  targets: SOPostTargetVariant[];
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  scheduledFor: string | null;
  rejectionReason?: string;
}

export interface SOMedia {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  aspectRatio: string | null;
  checksum: string;
  status: SOMediaStatus;
  ownerId: string;
  usageCount: number;
  thumbnailUrl: string | null;
  createdAt: string;
}

export interface SOApprovalQueueItem {
  postId: string;
  postTitle: string;
  version: number;
  submittedBy: string;
  submittedAt: string;
  targetIdentities: string[];
  ageHours: number;
}

// ─── Publishing & Calendar (SO-07, SO-08) ─────────────────────────────────────

export interface SOPublicationTargetResult {
  identityId: string;
  identityLabel: string;
  provider: SOProvider;
  status: SOPublicationStatus;
  providerPostId?: string;
  providerUrl?: string;
  postingMode?: "DIRECT_POST" | "UPLOAD_TO_DRAFT";
  errorCategory?: string;
  retryable?: boolean;
}

export interface SOPublication {
  id: string;
  postId: string;
  postTitle: string;
  status: SOPublicationStatus;
  targets: SOPublicationTargetResult[];
  attempts: number;
  scheduledFor: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Provider Content Library (SO-09) ─────────────────────────────────────────

export interface SOContentMetrics {
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  videoViews?: number;
}

export interface SOContentItem {
  id: string;
  source: SOContentSource;
  provider: SOProvider;
  identityId: string;
  identityLabel: string;
  type: string;
  text: string | null;
  providerUrl: string | null;
  publishedAt: string | null;
  metrics: SOContentMetrics;
  commentCount: number;
}

// ─── Inbox & Comments (SO-10, SO-11) ───────────────────────────────────────────

export interface SOConversation {
  id: string;
  provider: SOProvider;
  identityId: string;
  contactName: string;
  unreadCount: number;
  lastMessageAt: string;
  lastMessagePreview: string;
  owner: string | null;
  priority: "LOW" | "MEDIUM" | "HIGH" | null;
  status: SOConversationStatus;
  restricted: boolean;
}

export interface SOComment {
  id: string;
  contentId: string;
  provider: SOProvider;
  author: string;
  text: string;
  direction: "INBOUND" | "OUTBOUND";
  parentId: string | null;
  status: SOCommentStatus;
  createdAt: string;
}

// ─── Escalation (SO-12) ─────────────────────────────────────────────────────────

export interface SOEscalation {
  id: string;
  classification: SOEscalationClassification;
  status: SOEscalationStatus;
  sourceType: "COMMENT" | "CONVERSATION";
  sourceId: string;
  assignee: string | null;
  taskId: string | null;
  detectedAt: string;
  restrictedVisibility: boolean;
}

// ─── Analytics (SO-13) ───────────────────────────────────────────────────────

export interface SOAnalyticsPostPoint {
  date: string;
  posts: number;
  successRate: number;
  impressions: number;
  reach: number;
  engagements: number;
}

export interface SOAnalyticsInboxStats {
  totalConversations: number;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  slaBreaches: number;
}

// ─── Operations Monitor (SO-14) ────────────────────────────────────────────────

export interface SOJob {
  id: string;
  type: SOJobType;
  provider: SOProvider;
  identityId: string | null;
  status: SOJobStatus;
  attempts: number;
  nextAttemptAt: string | null;
  error: string | null;
  relatedPostId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Settings (SO-15) ──────────────────────────────────────────────────────────

export interface SOSettings {
  approvalSelfReviewAllowed: boolean;
  defaultTimezone: string;
  retryLimit: number;
  slaFirstResponseMinutes: number;
  slaResolutionMinutes: number;
  retentionDays: number;
}

// ─── Filters (shared list-screen shape) ────────────────────────────────────────

export interface SOListFilters {
  search: string;
  status: string;
  provider: SOProvider | "";
  page: number;
  limit: number;
}