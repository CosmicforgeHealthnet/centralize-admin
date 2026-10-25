// GENERATED FILE - DO NOT EDIT.
// Source: services/central-admin-api/src/modules/mail/openapi/mail.openapi.js
// Regenerate: cd services/central-admin-api && npm run mail:client:generate
// CI fails when this file is stale (npm run mail:client:check).
/* eslint-disable */

export const MAIL_API_VERSION = "1.0.0";
export const MAIL_API_BASE = "/api/mail/v1";

// ── Schemas ─────────────────────────────────────────────────────────────
export interface Party {
  address: string;
  name?: string | null;
}

export interface MailboxSummary {
  id?: string;
  name?: string;
  type?: "PERSONAL" | "SHARED";
  purpose?: "GENERAL" | "SUPPORT" | "MARKETING";
  role?: "OWNER" | "MANAGER" | "MEMBER" | "READER";
  canSend?: boolean;
  primaryAddress?: string | null;
  unreadCount?: number;
  status?: string;
}

export type MailboxDetail = MailboxSummary & {
  senderIdentities?: Array<{
    addressId?: string;
    address?: string;
    displayName?: string | null;
    kind?: string;
  }>;
  signatureHtml?: string | null;
};

export interface ThreadSummary {
  id?: string;
  mailboxId?: string;
  subject?: string;
  snippet?: string;
  folder?: "INBOX" | "ARCHIVE" | "TRASH" | "SPAM";
  lastMessageAt?: string;
  messageCount?: number;
  isRead?: boolean;
  isStarred?: boolean;
  conversationStatus?: string | null;
  revision?: number;
}

export interface Attachment {
  id?: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  scanStatus?: "PENDING" | "CLEAN" | "INFECTED" | "SCAN_FAILED" | "SCANNER_UNAVAILABLE";
  downloadable?: boolean;
}

export interface Message {
  id?: string;
  direction?: "INBOUND" | "OUTBOUND" | "INTERNAL";
  status?: "QUEUED" | "PROVIDER_ACCEPTED" | "DELIVERED" | "DELAYED" | "FAILED" | "BOUNCED" | "COMPLAINED" | "RECEIVED" | "QUARANTINED";
  from?: Party;
  recipients?: Array<Record<string, unknown>>;
  html?: string | null;
  text?: string | null;
  remoteImagesBlocked?: number;
  attachments?: Array<Attachment>;
}

export interface Draft {
  id?: string;
  revision?: number;
  to?: Array<Party>;
  cc?: Array<Party>;
  bcc?: Array<Party>;
  subject?: string;
  html?: string;
  status?: string;
}

export interface SendAccepted {
  messageId: string;
  threadId?: string;
  jobId?: string | null;
  status: "QUEUED" | "DELIVERED";
}

export interface Entitlements {
  mailEnabled?: boolean;
  sendingEnabled?: boolean;
  marketingEnabled?: boolean;
  mailboxes?: Array<MailboxSummary>;
}

export interface BroadcastDispatch {
  id?: string;
  campaignId?: string;
  status?: "SCHEDULED" | "QUEUED" | "PREPARING" | "SENDING" | "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED" | "OUTCOME_UNKNOWN" | "PAUSED";
  scheduledFor?: string;
  timeZone?: string;
  providerStatus?: string | null;
  recipientCount?: number;
  excludedCount?: number;
  lastErrorCode?: string | null;
}

export interface DraftInput {
  mode?: "NEW" | "REPLY" | "REPLY_ALL" | "FORWARD";
  inReplyToMessageId?: string | null;
  senderAddressId?: string | null;
  to?: Array<string | Party>;
  cc?: Array<string | Party>;
  bcc?: Array<string | Party>;
  subject?: string;
  html?: string;
  text?: string;
}

export interface MailRuleInput {
  name?: string;
  enabled?: boolean;
  priority?: number;
  conditions?: {
    fromContains?: string;
    fromEquals?: string;
    toContains?: string;
    subjectContains?: string;
    hasAttachment?: boolean;
  };
  actions?: {
    labelId?: string;
    folder?: "ARCHIVE" | "SPAM" | "TRASH";
    markRead?: true;
    star?: true;
    stopProcessing?: true;
  };
}

export interface MailRule {
  id?: string;
  mailboxId?: string;
  name?: string;
  enabled?: boolean;
  priority?: number;
  conditions?: {
    fromContains?: string;
    fromEquals?: string;
    toContains?: string;
    subjectContains?: string;
    hasAttachment?: boolean;
  };
  actions?: {
    labelId?: string;
    folder?: "ARCHIVE" | "SPAM" | "TRASH";
    markRead?: true;
    star?: true;
    stopProcessing?: true;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface ForwardingRule {
  id?: string;
  mailboxId?: string;
  targetAddress?: string;
  targetKind?: "INTERNAL" | "EXTERNAL";
  status?: "PENDING_APPROVAL" | "ACTIVE" | "REJECTED" | "DISABLED";
  reason?: string;
  requestedAt?: string;
  decidedAt?: string | null;
  disabledAt?: string | null;
  disabledReason?: string | null;
  lastForwardedAt?: string | null;
  forwardedCount?: number;
}

export interface OriginalHeaders {
  available?: boolean;
  headers?: Array<{
    name?: string;
    value?: string;
  }>;
  rawMime?: {
    status?: "STORED" | "NOT_REQUESTED" | "UNAVAILABLE" | "TOO_LARGE" | "FAILED";
    sizeBytes?: number | null;
  };
}

export interface SearchIndexStatus {
  enabled?: boolean;
  unindexed?: number | null;
  oldestUnindexedAt?: string | null;
  staleKeyVersion?: number | null;
  activeKeyVersion?: string | null;
}

export interface Error {
  success?: false;
  code?: string;
  retryable?: boolean;
  message?: string;
  errors?: Array<Record<string, unknown>>;
  correlationId?: string | null;
}

// ── Operations ──────────────────────────────────────────────────────────
export const MAIL_OPERATIONS = {
  deleteAdminIntegrationsSendersBySenderId: { method: "DELETE", path: "/admin/integrations/{integrationId}/senders/{senderId}", status: 200 },
  deleteAdminRolloutCohortsMembersByAdminUserId: { method: "DELETE", path: "/admin/rollout/cohorts/{cohortId}/members/{adminUserId}", status: 200 },
  deleteAdminSenderGrantsByGrantId: { method: "DELETE", path: "/admin/sender-grants/{grantId}", status: 200 },
  deleteDraftsAttachmentsByAttachmentId: { method: "DELETE", path: "/drafts/{draftId}/attachments/{attachmentId}", status: 200 },
  deleteDraftsByDraftId: { method: "DELETE", path: "/drafts/{draftId}", status: 200 },
  deleteMailboxesMembersByMembershipId: { method: "DELETE", path: "/mailboxes/{mailboxId}/members/{membershipId}", status: 200 },
  deleteMarketingAudiencesContacts: { method: "DELETE", path: "/marketing/{orgId}/audiences/{audienceId}/contacts", status: 200 },
  deleteRulesByRuleId: { method: "DELETE", path: "/rules/{ruleId}", status: 200 },
  deleteThreadsByThreadId: { method: "DELETE", path: "/threads/{threadId}", status: 200 },
  deleteThreadsLabelsByLabelId: { method: "DELETE", path: "/threads/{threadId}/labels/{labelId}", status: 200 },
  deleteThreadsLock: { method: "DELETE", path: "/threads/{threadId}/lock", status: 200 },
  getAdminAddresses: { method: "GET", path: "/admin/addresses", status: 200 },
  getAdminAuditEvents: { method: "GET", path: "/admin/audit-events", status: 200 },
  getAdminDeliveryEvents: { method: "GET", path: "/admin/delivery-events", status: 200 },
  getAdminDomains: { method: "GET", path: "/admin/domains", status: 200 },
  getAdminForwarding: { method: "GET", path: "/admin/forwarding", status: 200 },
  getAdminIntegrations: { method: "GET", path: "/admin/integrations", status: 200 },
  getAdminIntegrationsEvents: { method: "GET", path: "/admin/integrations/{integrationId}/events", status: 200 },
  getAdminIntegrationsHealth: { method: "GET", path: "/admin/integrations/{integrationId}/health", status: 200 },
  getAdminIntegrationsSenders: { method: "GET", path: "/admin/integrations/{integrationId}/senders", status: 200 },
  getAdminJobs: { method: "GET", path: "/admin/jobs", status: 200 },
  getAdminLegalHolds: { method: "GET", path: "/admin/legal-holds", status: 200 },
  getAdminMailboxes: { method: "GET", path: "/admin/mailboxes", status: 200 },
  getAdminOpsAlerts: { method: "GET", path: "/admin/ops/alerts", status: 200 },
  getAdminOpsSnapshot: { method: "GET", path: "/admin/ops/snapshot", status: 200 },
  getAdminOrganizations: { method: "GET", path: "/admin/organizations", status: 200 },
  getAdminRetentionCapabilities: { method: "GET", path: "/admin/retention/capabilities", status: 200 },
  getAdminRetentionPolicies: { method: "GET", path: "/admin/retention-policies", status: 200 },
  getAdminRetentionRuns: { method: "GET", path: "/admin/retention/runs", status: 200 },
  getAdminRetentionRunsByRunId: { method: "GET", path: "/admin/retention/runs/{runId}", status: 200 },
  getAdminRollout: { method: "GET", path: "/admin/rollout", status: 200 },
  getAdminRolloutPilotByAdminUserId: { method: "GET", path: "/admin/rollout/pilot/{adminUserId}", status: 200 },
  getAdminRolloutReadiness: { method: "GET", path: "/admin/rollout/readiness", status: 200 },
  getAdminSearchIndex: { method: "GET", path: "/admin/search-index", status: 200 },
  getAdminSenderGrants: { method: "GET", path: "/admin/sender-grants", status: 200 },
  getAdminStatus: { method: "GET", path: "/admin/status", status: 200 },
  getAdminUsage: { method: "GET", path: "/admin/usage", status: 200 },
  getAdminWebhookEvents: { method: "GET", path: "/admin/webhook-events", status: 200 },
  getAttachmentsDownload: { method: "GET", path: "/attachments/{attachmentId}/download", status: 200 },
  getBreakGlassRequests: { method: "GET", path: "/break-glass/requests", status: 200 },
  getContactsSuggest: { method: "GET", path: "/contacts/suggest", status: 200 },
  getDirectoryStaff: { method: "GET", path: "/directory/staff", status: 200 },
  getDraftsByDraftId: { method: "GET", path: "/drafts/{draftId}", status: 200 },
  getHealthLive: { method: "GET", path: "/health/live", status: 200 },
  getHealthReady: { method: "GET", path: "/health/ready", status: 200 },
  getMailboxesByMailboxId: { method: "GET", path: "/mailboxes/{mailboxId}", status: 200 },
  getMailboxesDrafts: { method: "GET", path: "/mailboxes/{mailboxId}/drafts", status: 200 },
  getMailboxesForwarding: { method: "GET", path: "/mailboxes/{mailboxId}/forwarding", status: 200 },
  getMailboxesLabels: { method: "GET", path: "/mailboxes/{mailboxId}/labels", status: 200 },
  getMailboxesMembers: { method: "GET", path: "/mailboxes/{mailboxId}/members", status: 200 },
  getMailboxesQueue: { method: "GET", path: "/mailboxes/{mailboxId}/queue", status: 200 },
  getMailboxesRules: { method: "GET", path: "/mailboxes/{mailboxId}/rules", status: 200 },
  getMailboxesSearch: { method: "GET", path: "/mailboxes/{mailboxId}/search", status: 200 },
  getMailboxesThreads: { method: "GET", path: "/mailboxes/{mailboxId}/threads", status: 200 },
  getMarketingAudiences: { method: "GET", path: "/marketing/{orgId}/audiences", status: 200 },
  getMarketingAudiencesByAudienceId: { method: "GET", path: "/marketing/{orgId}/audiences/{audienceId}", status: 200 },
  getMarketingAudiencesSegments: { method: "GET", path: "/marketing/{orgId}/audiences/{audienceId}/segments", status: 200 },
  getMarketingAutomationEvents: { method: "GET", path: "/marketing/{orgId}/automation-events", status: 200 },
  getMarketingAutomations: { method: "GET", path: "/marketing/{orgId}/automations", status: 200 },
  getMarketingAutomationsByAutomationId: { method: "GET", path: "/marketing/{orgId}/automations/{automationId}", status: 200 },
  getMarketingAutomationsEnrollments: { method: "GET", path: "/marketing/{orgId}/automations/{automationId}/enrollments", status: 200 },
  getMarketingAutomationsHistory: { method: "GET", path: "/marketing/{orgId}/automations/{automationId}/history", status: 200 },
  getMarketingCampaigns: { method: "GET", path: "/marketing/{orgId}/campaigns", status: 200 },
  getMarketingCampaignsByCampaignId: { method: "GET", path: "/marketing/{orgId}/campaigns/{campaignId}", status: 200 },
  getMarketingCampaignsDispatch: { method: "GET", path: "/marketing/{orgId}/campaigns/{campaignId}/dispatch", status: 200 },
  getMarketingCampaignsHistory: { method: "GET", path: "/marketing/{orgId}/campaigns/{campaignId}/history", status: 200 },
  getMarketingCampaignsRecipients: { method: "GET", path: "/marketing/{orgId}/campaigns/{campaignId}/recipients", status: 200 },
  getMarketingCampaignsReport: { method: "GET", path: "/marketing/{orgId}/campaigns/{campaignId}/report", status: 200 },
  getMarketingCampaignsSnapshotsBySnapshotId: { method: "GET", path: "/marketing/{orgId}/campaigns/{campaignId}/snapshots/{snapshotId}", status: 200 },
  getMarketingContacts: { method: "GET", path: "/marketing/{orgId}/contacts", status: 200 },
  getMarketingContactsByContactId: { method: "GET", path: "/marketing/{orgId}/contacts/{contactId}", status: 200 },
  getMarketingLegacyTemplates: { method: "GET", path: "/marketing/{orgId}/legacy-templates", status: 200 },
  getMarketingOrganizations: { method: "GET", path: "/marketing/organizations", status: 200 },
  getMarketingReportsOverview: { method: "GET", path: "/marketing/{orgId}/reports/overview", status: 200 },
  getMarketingReportsSuppressions: { method: "GET", path: "/marketing/{orgId}/reports/suppressions", status: 200 },
  getMarketingSegmentsPreview: { method: "GET", path: "/marketing/{orgId}/segments/{segmentId}/preview", status: 200 },
  getMarketingSenderIdentities: { method: "GET", path: "/marketing/{orgId}/sender-identities", status: 200 },
  getMarketingSettings: { method: "GET", path: "/marketing/{orgId}/settings", status: 200 },
  getMarketingSuppressions: { method: "GET", path: "/marketing/{orgId}/suppressions", status: 200 },
  getMarketingTemplates: { method: "GET", path: "/marketing/{orgId}/templates", status: 200 },
  getMarketingTemplatesByTemplateId: { method: "GET", path: "/marketing/{orgId}/templates/{templateId}", status: 200 },
  getMeEntitlements: { method: "GET", path: "/me/entitlements", status: 200 },
  getMeMailboxes: { method: "GET", path: "/me/mailboxes", status: 200 },
  getMessagesOriginalHeaders: { method: "GET", path: "/messages/{messageId}/original-headers", status: 200 },
  getMessagesRaw: { method: "GET", path: "/messages/{messageId}/raw", status: 200 },
  getMessagesStatus: { method: "GET", path: "/messages/{messageId}/status", status: 200 },
  getOpsMetrics: { method: "GET", path: "/ops/metrics", status: 200 },
  getProvisioningRequests: { method: "GET", path: "/provisioning/requests", status: 200 },
  getPublicConsentConfirmByToken: { method: "GET", path: "/public/consent/confirm/{token}", status: 200 },
  getPublicUnsubscribeByToken: { method: "GET", path: "/public/unsubscribe/{token}", status: 200 },
  getSearch: { method: "GET", path: "/search", status: 200 },
  getSupportMailboxes: { method: "GET", path: "/support/mailboxes", status: 200 },
  getThreadsActivity: { method: "GET", path: "/threads/{threadId}/activity", status: 200 },
  getThreadsByThreadId: { method: "GET", path: "/threads/{threadId}", status: 200 },
  getThreadsMessages: { method: "GET", path: "/threads/{threadId}/messages", status: 200 },
  getThreadsNotes: { method: "GET", path: "/threads/{threadId}/notes", status: 200 },
  patchAdminAddressesByAddressId: { method: "PATCH", path: "/admin/addresses/{addressId}", status: 200 },
  patchAdminIntegrationsByIntegrationId: { method: "PATCH", path: "/admin/integrations/{integrationId}", status: 200 },
  patchDraftsByDraftId: { method: "PATCH", path: "/drafts/{draftId}", status: 200 },
  patchMailboxesSettings: { method: "PATCH", path: "/mailboxes/{mailboxId}/settings", status: 200 },
  patchMarketingAudiencesByAudienceId: { method: "PATCH", path: "/marketing/{orgId}/audiences/{audienceId}", status: 200 },
  patchMarketingCampaignsByCampaignId: { method: "PATCH", path: "/marketing/{orgId}/campaigns/{campaignId}", status: 200 },
  patchMarketingContactsByContactId: { method: "PATCH", path: "/marketing/{orgId}/contacts/{contactId}", status: 200 },
  patchMarketingSettings: { method: "PATCH", path: "/marketing/{orgId}/settings", status: 200 },
  patchRulesByRuleId: { method: "PATCH", path: "/rules/{ruleId}", status: 200 },
  patchThreadsState: { method: "PATCH", path: "/threads/{threadId}/state", status: 200 },
  postAdminAddresses: { method: "POST", path: "/admin/addresses", status: 201 },
  postAdminAttachmentsRescan: { method: "POST", path: "/admin/attachments/{attachmentId}/rescan", status: 200 },
  postAdminDomains: { method: "POST", path: "/admin/domains", status: 201 },
  postAdminDomainsVerify: { method: "POST", path: "/admin/domains/{domainId}/verify", status: 200 },
  postAdminEmergencyStops: { method: "POST", path: "/admin/emergency-stops", status: 201 },
  postAdminEmergencyStopsRelease: { method: "POST", path: "/admin/emergency-stops/{stopId}/release", status: 200 },
  postAdminForwardingApprove: { method: "POST", path: "/admin/forwarding/{ruleId}/approve", status: 200 },
  postAdminForwardingReject: { method: "POST", path: "/admin/forwarding/{ruleId}/reject", status: 200 },
  postAdminIntegrations: { method: "POST", path: "/admin/integrations", status: 201 },
  postAdminIntegrationsActivate: { method: "POST", path: "/admin/integrations/{integrationId}/activate", status: 200 },
  postAdminIntegrationsSenders: { method: "POST", path: "/admin/integrations/{integrationId}/senders", status: 201 },
  postAdminIntegrationsSuspend: { method: "POST", path: "/admin/integrations/{integrationId}/suspend", status: 200 },
  postAdminJobsRequeue: { method: "POST", path: "/admin/jobs/{jobId}/requeue", status: 200 },
  postAdminLegalHolds: { method: "POST", path: "/admin/legal-holds", status: 201 },
  postAdminLegalHoldsRelease: { method: "POST", path: "/admin/legal-holds/{holdId}/release", status: 200 },
  postAdminMailboxes: { method: "POST", path: "/admin/mailboxes", status: 201 },
  postAdminMailboxesReactivate: { method: "POST", path: "/admin/mailboxes/{mailboxId}/reactivate", status: 200 },
  postAdminMailboxesSuspend: { method: "POST", path: "/admin/mailboxes/{mailboxId}/suspend", status: 200 },
  postAdminOpsAlertsAcknowledge: { method: "POST", path: "/admin/ops/alerts/{alertId}/acknowledge", status: 200 },
  postAdminOrganizations: { method: "POST", path: "/admin/organizations", status: 201 },
  postAdminRetentionPolicies: { method: "POST", path: "/admin/retention-policies", status: 201 },
  postAdminRetentionRuns: { method: "POST", path: "/admin/retention/runs", status: 201 },
  postAdminRetentionRunsCancel: { method: "POST", path: "/admin/retention/runs/{runId}/cancel", status: 200 },
  postAdminRetentionRunsExecute: { method: "POST", path: "/admin/retention/runs/{runId}/execute", status: 201 },
  postAdminRolloutCohorts: { method: "POST", path: "/admin/rollout/cohorts", status: 201 },
  postAdminRolloutCohortsMembers: { method: "POST", path: "/admin/rollout/cohorts/{cohortId}/members", status: 201 },
  postAdminRolloutRules: { method: "POST", path: "/admin/rollout/rules", status: 201 },
  postAdminRolloutRulesRevoke: { method: "POST", path: "/admin/rollout/rules/{ruleId}/revoke", status: 200 },
  postAdminSearchIndexBackfill: { method: "POST", path: "/admin/search-index/backfill", status: 202 },
  postAdminSenderGrants: { method: "POST", path: "/admin/sender-grants", status: 201 },
  postAdminUsersOffboard: { method: "POST", path: "/admin/users/{adminUserId}/offboard", status: 200 },
  postBreakGlassRequests: { method: "POST", path: "/break-glass/requests", status: 201 },
  postBreakGlassRequestsApprove: { method: "POST", path: "/break-glass/requests/{requestId}/approve", status: 200 },
  postBreakGlassRequestsReject: { method: "POST", path: "/break-glass/requests/{requestId}/reject", status: 200 },
  postBreakGlassRequestsRevoke: { method: "POST", path: "/break-glass/requests/{requestId}/revoke", status: 200 },
  postDraftsAttachments: { method: "POST", path: "/drafts/{draftId}/attachments", status: 201 },
  postDraftsSend: { method: "POST", path: "/drafts/{draftId}/send", status: 202 },
  postForwardingDisable: { method: "POST", path: "/forwarding/{ruleId}/disable", status: 200 },
  postIntegrationsV1Events: { method: "POST", path: "/integrations/v1/events", status: 200 },
  postMailboxesDrafts: { method: "POST", path: "/mailboxes/{mailboxId}/drafts", status: 201 },
  postMailboxesForwarding: { method: "POST", path: "/mailboxes/{mailboxId}/forwarding", status: 201 },
  postMailboxesLabels: { method: "POST", path: "/mailboxes/{mailboxId}/labels", status: 201 },
  postMailboxesMembers: { method: "POST", path: "/mailboxes/{mailboxId}/members", status: 201 },
  postMailboxesRules: { method: "POST", path: "/mailboxes/{mailboxId}/rules", status: 201 },
  postMailboxesRulesReorder: { method: "POST", path: "/mailboxes/{mailboxId}/rules/reorder", status: 200 },
  postMailboxesThreadsBulk: { method: "POST", path: "/mailboxes/{mailboxId}/threads/bulk", status: 200 },
  postMarketingAudiences: { method: "POST", path: "/marketing/{orgId}/audiences", status: 201 },
  postMarketingAudiencesContacts: { method: "POST", path: "/marketing/{orgId}/audiences/{audienceId}/contacts", status: 200 },
  postMarketingAudiencesSegments: { method: "POST", path: "/marketing/{orgId}/audiences/{audienceId}/segments", status: 201 },
  postMarketingAutomations: { method: "POST", path: "/marketing/{orgId}/automations", status: 201 },
  postMarketingAutomationsActivate: { method: "POST", path: "/marketing/{orgId}/automations/{automationId}/activate", status: 200 },
  postMarketingAutomationsArchive: { method: "POST", path: "/marketing/{orgId}/automations/{automationId}/archive", status: 200 },
  postMarketingAutomationsPause: { method: "POST", path: "/marketing/{orgId}/automations/{automationId}/pause", status: 200 },
  postMarketingAutomationsVersionsApprove: { method: "POST", path: "/marketing/{orgId}/automations/{automationId}/versions/{versionId}/approve", status: 200 },
  postMarketingAutomationsVersionsReject: { method: "POST", path: "/marketing/{orgId}/automations/{automationId}/versions/{versionId}/reject", status: 200 },
  postMarketingAutomationsVersionsSubmit: { method: "POST", path: "/marketing/{orgId}/automations/{automationId}/versions/{versionId}/submit", status: 200 },
  postMarketingCampaigns: { method: "POST", path: "/marketing/{orgId}/campaigns", status: 201 },
  postMarketingCampaignsApprove: { method: "POST", path: "/marketing/{orgId}/campaigns/{campaignId}/approve", status: 200 },
  postMarketingCampaignsCancel: { method: "POST", path: "/marketing/{orgId}/campaigns/{campaignId}/cancel", status: 200 },
  postMarketingCampaignsPause: { method: "POST", path: "/marketing/{orgId}/campaigns/{campaignId}/pause", status: 200 },
  postMarketingCampaignsPreflight: { method: "POST", path: "/marketing/{orgId}/campaigns/{campaignId}/preflight", status: 200 },
  postMarketingCampaignsReject: { method: "POST", path: "/marketing/{orgId}/campaigns/{campaignId}/reject", status: 200 },
  postMarketingCampaignsResume: { method: "POST", path: "/marketing/{orgId}/campaigns/{campaignId}/resume", status: 200 },
  postMarketingCampaignsSchedule: { method: "POST", path: "/marketing/{orgId}/campaigns/{campaignId}/schedule", status: 201 },
  postMarketingCampaignsSubmit: { method: "POST", path: "/marketing/{orgId}/campaigns/{campaignId}/submit", status: 200 },
  postMarketingCampaignsTestSend: { method: "POST", path: "/marketing/{orgId}/campaigns/{campaignId}/test-send", status: 202 },
  postMarketingContacts: { method: "POST", path: "/marketing/{orgId}/contacts", status: 201 },
  postMarketingContactsConsents: { method: "POST", path: "/marketing/{orgId}/contacts/{contactId}/consents", status: 201 },
  postMarketingContactsConsentsWithdraw: { method: "POST", path: "/marketing/{orgId}/contacts/{contactId}/consents/{topic}/withdraw", status: 200 },
  postMarketingContactsImport: { method: "POST", path: "/marketing/{orgId}/contacts/import", status: 200 },
  postMarketingDispatchPause: { method: "POST", path: "/marketing/{orgId}/dispatch/pause", status: 200 },
  postMarketingDispatchResume: { method: "POST", path: "/marketing/{orgId}/dispatch/resume", status: 200 },
  postMarketingSuppressions: { method: "POST", path: "/marketing/{orgId}/suppressions", status: 201 },
  postMarketingSuppressionsLift: { method: "POST", path: "/marketing/{orgId}/suppressions/{suppressionId}/lift", status: 200 },
  postMarketingTemplates: { method: "POST", path: "/marketing/{orgId}/templates", status: 201 },
  postMarketingTemplatesRender: { method: "POST", path: "/marketing/{orgId}/templates/render", status: 200 },
  postMarketingTemplatesVersions: { method: "POST", path: "/marketing/{orgId}/templates/{templateId}/versions", status: 201 },
  postProvisioningRequests: { method: "POST", path: "/provisioning/requests", status: 201 },
  postProvisioningRequestsApprove: { method: "POST", path: "/provisioning/requests/{requestId}/approve", status: 200 },
  postProvisioningRequestsReject: { method: "POST", path: "/provisioning/requests/{requestId}/reject", status: 200 },
  postPublicConsentConfirm: { method: "POST", path: "/public/consent/confirm", status: 200 },
  postPublicConsentConfirmByToken: { method: "POST", path: "/public/consent/confirm/{token}", status: 200 },
  postPublicUnsubscribeByToken: { method: "POST", path: "/public/unsubscribe/{token}", status: 200 },
  postSecurityStepUp: { method: "POST", path: "/security/step-up", status: 201 },
  postThreadsAssign: { method: "POST", path: "/threads/{threadId}/assign", status: 200 },
  postThreadsLock: { method: "POST", path: "/threads/{threadId}/lock", status: 200 },
  postThreadsMove: { method: "POST", path: "/threads/{threadId}/move", status: 200 },
  postThreadsNotes: { method: "POST", path: "/threads/{threadId}/notes", status: 201 },
  postThreadsStatus: { method: "POST", path: "/threads/{threadId}/status", status: 200 },
  postWebhooksResend: { method: "POST", path: "/webhooks/resend", status: 200 },
  postWebhooksResendBrandBySlug: { method: "POST", path: "/webhooks/resend/brand/{slug}", status: 200 },
  putAdminQuotas: { method: "PUT", path: "/admin/quotas", status: 200 },
  putMarketingAutomationsDraft: { method: "PUT", path: "/marketing/{orgId}/automations/{automationId}/draft", status: 200 },
  putThreadsLabelsByLabelId: { method: "PUT", path: "/threads/{threadId}/labels/{labelId}", status: 200 },
  putThreadsTicketLink: { method: "PUT", path: "/threads/{threadId}/ticket-link", status: 200 },
} as const;

export type MailOperationId = keyof typeof MAIL_OPERATIONS;

/** Success payload (`data` of the success envelope) per operation. */
export interface MailResponses {
  /** Revoke a sender authorization */
  deleteAdminIntegrationsSendersBySenderId: Record<string, unknown>;
  /** Offboard a staff member from a cohort */
  deleteAdminRolloutCohortsMembersByAdminUserId: Record<string, unknown>;
  /** Revoke send-as */
  deleteAdminSenderGrantsByGrantId: Record<string, unknown>;
  /** Remove attachment */
  deleteDraftsAttachmentsByAttachmentId: Record<string, unknown>;
  /** Discard draft */
  deleteDraftsByDraftId: Record<string, unknown>;
  /** Revoke membership */
  deleteMailboxesMembersByMembershipId: Record<string, unknown>;
  /** Remove contacts */
  deleteMarketingAudiencesContacts: Record<string, unknown>;
  /** Delete a filter */
  deleteRulesByRuleId: Record<string, unknown>;
  /** Soft delete from trash (legal hold aware) */
  deleteThreadsByThreadId: Record<string, unknown>;
  /** Detach label */
  deleteThreadsLabelsByLabelId: Record<string, unknown>;
  /** Release reply lock */
  deleteThreadsLock: Record<string, unknown>;
  /** Addresses */
  getAdminAddresses: Record<string, unknown>;
  /** Mail access/audit trail (mail admins; metadata scrubbed, never content) */
  getAdminAuditEvents: Record<string, unknown>;
  /** Delivery events (recipient reduced to domain) */
  getAdminDeliveryEvents: Record<string, unknown>;
  /** Domains */
  getAdminDomains: Record<string, unknown>;
  /** Forwarding requests and rules (mail admins) */
  getAdminForwarding: Array<ForwardingRule>;
  /** List product integrations (mail admins; product owners see their own) */
  getAdminIntegrations: Record<string, unknown>;
  /** Event log (metadata only) */
  getAdminIntegrationsEvents: Record<string, unknown>;
  /** Product-isolated health and delivery summary */
  getAdminIntegrationsHealth: Record<string, unknown>;
  /** Authorized sender identities */
  getAdminIntegrationsSenders: Record<string, unknown>;
  /** Outbox/inbound/event jobs incl. dead letters (no payloads) */
  getAdminJobs: Record<string, unknown>;
  /** Legal holds */
  getAdminLegalHolds: Record<string, unknown>;
  /** Mailboxes (metadata only) */
  getAdminMailboxes: Record<string, unknown>;
  /** Ops alerts (open by default; includeResolved=true for history) */
  getAdminOpsAlerts: Record<string, unknown>;
  /** Operational snapshot: queues, webhooks, scanning, delivery, usage, open alerts */
  getAdminOpsSnapshot: Record<string, unknown>;
  /** Organizations/brands */
  getAdminOrganizations: Record<string, unknown>;
  /** Retention execution flag and configured system periods */
  getAdminRetentionCapabilities: Record<string, unknown>;
  /** Retention policies */
  getAdminRetentionPolicies: Record<string, unknown>;
  /** Retention runs */
  getAdminRetentionRuns: Record<string, unknown>;
  /** Retention run detail (counts only) */
  getAdminRetentionRunsByRunId: Record<string, unknown>;
  /** Rollout rules, cohorts and emergency stops for this environment */
  getAdminRollout: Record<string, unknown>;
  /** Pilot readiness checklist for one staff member */
  getAdminRolloutPilotByAdminUserId: Record<string, unknown>;
  /** Progressive rollout gates (automated PASS/FAIL + MANUAL sign-offs) */
  getAdminRolloutReadiness: Record<string, unknown>;
  /** Body-search index freshness */
  getAdminSearchIndex: SearchIndexStatus;
  /** Active send-as grants (optionally by mailbox) */
  getAdminSenderGrants: Record<string, unknown>;
  /** Mail configuration status (no secrets) */
  getAdminStatus: Record<string, unknown>;
  /** Usage by brand and purpose (counts only; cost only if operator-configured) */
  getAdminUsage: Record<string, unknown>;
  /** Provider webhook events (no payloads) with processing lag */
  getAdminWebhookEvents: Record<string, unknown>;
  /** Download clean attachment */
  getAttachmentsDownload: Blob;
  /** Break-glass requests */
  getBreakGlassRequests: Record<string, unknown>;
  /** Recipient autocomplete */
  getContactsSuggest: Record<string, unknown>;
  /** Active staff lookup for membership pickers (managers/admins) */
  getDirectoryStaff: Record<string, unknown>;
  /** Get draft */
  getDraftsByDraftId: Draft;
  /** Liveness (public; no dependencies checked) */
  getHealthLive: Record<string, unknown>;
  /** Readiness (public; booleans for schema, keyring, storage, infrastructure; 503 when an enabled Mail is not ready) */
  getHealthReady: Record<string, unknown>;
  /** Mailbox with sender identities */
  getMailboxesByMailboxId: MailboxDetail;
  /** Caller's drafts */
  getMailboxesDrafts: Record<string, unknown>;
  /** Forwarding rules of a mailbox */
  getMailboxesForwarding: Array<ForwardingRule>;
  /** List labels */
  getMailboxesLabels: Record<string, unknown>;
  /** List members */
  getMailboxesMembers: Record<string, unknown>;
  /** Shared mailbox queue */
  getMailboxesQueue: Array<ThreadSummary>;
  /** List mailbox filters (MANAGE access) */
  getMailboxesRules: Array<MailRule>;
  /** Mailbox-scoped search */
  getMailboxesSearch: Array<ThreadSummary>;
  /** List threads by view */
  getMailboxesThreads: Array<ThreadSummary>;
  /** Audiences */
  getMarketingAudiences: Record<string, unknown>;
  /** Audience with eligibility */
  getMarketingAudiencesByAudienceId: Record<string, unknown>;
  /** Segments */
  getMarketingAudiencesSegments: Record<string, unknown>;
  /** Approved product events usable as triggers */
  getMarketingAutomationEvents: Record<string, unknown>;
  /** List automations */
  getMarketingAutomations: Record<string, unknown>;
  /** Automation with versions and enrollment counts */
  getMarketingAutomationsByAutomationId: Record<string, unknown>;
  /** Enrollments (paginated) */
  getMarketingAutomationsEnrollments: Record<string, unknown>;
  /** Audit history or one enrollment's step runs */
  getMarketingAutomationsHistory: Record<string, unknown>;
  /** Campaigns */
  getMarketingCampaigns: Record<string, unknown>;
  /** Campaign */
  getMarketingCampaignsByCampaignId: Record<string, unknown>;
  /** Dispatch status and recipient counts */
  getMarketingCampaignsDispatch: Record<string, unknown>;
  /** Approval/snapshot/audit history */
  getMarketingCampaignsHistory: Record<string, unknown>;
  /** Recipient outcomes (paginated) */
  getMarketingCampaignsRecipients: Record<string, unknown>;
  /** Delivery report (acceptance is not delivery; opens indicative) */
  getMarketingCampaignsReport: Record<string, unknown>;
  /** Immutable snapshot */
  getMarketingCampaignsSnapshotsBySnapshotId: Record<string, unknown>;
  /** Contacts */
  getMarketingContacts: Record<string, unknown>;
  /** Contact */
  getMarketingContactsByContactId: Record<string, unknown>;
  /** Existing marketing_email_templates (read-only) */
  getMarketingLegacyTemplates: Record<string, unknown>;
  /** Brands accessible for marketing */
  getMarketingOrganizations: Record<string, unknown>;
  /** Brand dashboard: campaigns, recipients, suppressions, automations, jobs */
  getMarketingReportsOverview: Record<string, unknown>;
  /** Suppression report */
  getMarketingReportsSuppressions: Record<string, unknown>;
  /** Segment preview */
  getMarketingSegmentsPreview: Record<string, unknown>;
  /** Approved brand sender identities */
  getMarketingSenderIdentities: Record<string, unknown>;
  /** Brand marketing settings, caps, provider status (no secrets) */
  getMarketingSettings: Record<string, unknown>;
  /** Suppressions */
  getMarketingSuppressions: Record<string, unknown>;
  /** Templates */
  getMarketingTemplates: Record<string, unknown>;
  /** Template with versions */
  getMarketingTemplatesByTemplateId: Record<string, unknown>;
  /** Mail entitlements for the caller */
  getMeEntitlements: Entitlements;
  /** Mailboxes the caller may open */
  getMeMailboxes: Array<MailboxSummary>;
  /** Archived original headers (audited) */
  getMessagesOriginalHeaders: OriginalHeaders;
  /** Archived raw MIME (.eml; audited; quarantined: mail admins only) */
  getMessagesRaw: Blob;
  /** Delivery status */
  getMessagesStatus: Record<string, unknown>;
  /** Prometheus metrics (counts and ages only; Bearer MAIL_METRICS_TOKEN; 404 when not configured) */
  getOpsMetrics: Record<string, unknown>;
  /** Provisioning requests */
  getProvisioningRequests: Record<string, unknown>;
  /** Double opt-in landing page (does not confirm) */
  getPublicConsentConfirmByToken: Record<string, unknown>;
  /** Preference / unsubscribe page */
  getPublicUnsubscribeByToken: Record<string, unknown>;
  /** Search all authorized mailboxes */
  getSearch: Array<ThreadSummary>;
  /** Support mailboxes for caller */
  getSupportMailboxes: Record<string, unknown>;
  /** Thread audit activity */
  getThreadsActivity: Record<string, unknown>;
  /** Thread summary */
  getThreadsByThreadId: ThreadSummary;
  /** Messages (sanitized HTML) */
  getThreadsMessages: Array<Message>;
  /** Internal notes */
  getThreadsNotes: Record<string, unknown>;
  /** Change address status */
  patchAdminAddressesByAddressId: Record<string, unknown>;
  /** Update allowed event / trigger types */
  patchAdminIntegrationsByIntegrationId: Record<string, unknown>;
  /** Update draft (requires revision; 409 on conflict) */
  patchDraftsByDraftId: Draft;
  /** Mailbox settings */
  patchMailboxesSettings: Record<string, unknown>;
  /** Update audience */
  patchMarketingAudiencesByAudienceId: Record<string, unknown>;
  /** Update (revision; material edits invalidate approval) */
  patchMarketingCampaignsByCampaignId: Record<string, unknown>;
  /** Update contact */
  patchMarketingContactsByContactId: Record<string, unknown>;
  /** Update brand settings (approvers) */
  patchMarketingSettings: Record<string, unknown>;
  /** Edit / enable / disable / reprioritise a filter */
  patchRulesByRuleId: MailRule;
  /** Per-user read/star state */
  patchThreadsState: Record<string, unknown>;
  /** Create address / alias */
  postAdminAddresses: Record<string, unknown>;
  /** Re-scan an unscanned/failed attachment (never releases INFECTED) */
  postAdminAttachmentsRescan: Record<string, unknown>;
  /** Register domain */
  postAdminDomains: Record<string, unknown>;
  /** Read provider verification status */
  postAdminDomainsVerify: Record<string, unknown>;
  /** Activate an emergency stop (ALL, MARKETING or ORGANIZATION); immediate */
  postAdminEmergencyStops: Record<string, unknown>;
  /** Release an emergency stop (step-up MAIL_EMERGENCY_STOP_RELEASE) */
  postAdminEmergencyStopsRelease: Record<string, unknown>;
  /** Approve forwarding (external targets need MFA step-up and an allowed domain) */
  postAdminForwardingApprove: ForwardingRule;
  /** Reject forwarding */
  postAdminForwardingReject: ForwardingRule;
  /** Register a product integration (DISABLED until activated) */
  postAdminIntegrations: Record<string, unknown>;
  /** Activate with recorded owner approval + step-up MAIL_INTEGRATION_ACTIVATE */
  postAdminIntegrationsActivate: Record<string, unknown>;
  /** Authorize a brand sender identity for a purpose */
  postAdminIntegrationsSenders: Record<string, unknown>;
  /** Suspend an integration */
  postAdminIntegrationsSuspend: Record<string, unknown>;
  /** Requeue a dead-lettered/failed inbound or event job (mail admin + MFA step-up) */
  postAdminJobsRequeue: Record<string, unknown>;
  /** Create legal hold */
  postAdminLegalHolds: Record<string, unknown>;
  /** Release legal hold */
  postAdminLegalHoldsRelease: Record<string, unknown>;
  /** Create mailbox */
  postAdminMailboxes: Record<string, unknown>;
  /** Reactivate mailbox */
  postAdminMailboxesReactivate: Record<string, unknown>;
  /** Suspend mailbox */
  postAdminMailboxesSuspend: Record<string, unknown>;
  /** Acknowledge an ops alert */
  postAdminOpsAlertsAcknowledge: Record<string, unknown>;
  /** Create organization */
  postAdminOrganizations: Record<string, unknown>;
  /** Create retention policy */
  postAdminRetentionPolicies: Record<string, unknown>;
  /** Start a retention DRY RUN for a policy or system category */
  postAdminRetentionRuns: Record<string, unknown>;
  /** Cancel a queued or running retention run */
  postAdminRetentionRunsCancel: Record<string, unknown>;
  /** Execute a completed dry run (flag + step-up MAIL_RETENTION_EXECUTE) */
  postAdminRetentionRunsExecute: Record<string, unknown>;
  /** Create a pilot cohort */
  postAdminRolloutCohorts: Record<string, unknown>;
  /** Onboard a staff member to a cohort */
  postAdminRolloutCohortsMembers: Record<string, unknown>;
  /** Create an ALLOW (step-up MAIL_ROLLOUT_CHANGE) or DENY rollout rule */
  postAdminRolloutRules: Record<string, unknown>;
  /** Revoke a rule (revoking DENY needs step-up) */
  postAdminRolloutRulesRevoke: Record<string, unknown>;
  /** Queue body-search index backfill (202) */
  postAdminSearchIndexBackfill: Record<string, unknown>;
  /** Grant send-as */
  postAdminSenderGrants: Record<string, unknown>;
  /** Offboard employee (history retained) */
  postAdminUsersOffboard: Record<string, unknown>;
  /** Request break-glass */
  postBreakGlassRequests: Record<string, unknown>;
  /** Approve break-glass (different approver + MFA) */
  postBreakGlassRequestsApprove: Record<string, unknown>;
  /** Reject break-glass */
  postBreakGlassRequestsReject: Record<string, unknown>;
  /** Revoke break-glass */
  postBreakGlassRequestsRevoke: Record<string, unknown>;
  /** Upload attachment (multipart file) */
  postDraftsAttachments: Attachment;
  /** Queue send; returns 202 with durable job id */
  postDraftsSend: SendAccepted;
  /** Disable forwarding (owner/manager or mail admin) */
  postForwardingDisable: ForwardingRule;
  /** Product event ingestion (service HMAC: X-Service-Name/Timestamp/Signature; contract v1) */
  postIntegrationsV1Events: Record<string, unknown>;
  /** Create draft */
  postMailboxesDrafts: Draft;
  /** Request forwarding (admin approval required) */
  postMailboxesForwarding: ForwardingRule;
  /** Create label */
  postMailboxesLabels: Record<string, unknown>;
  /** Grant membership */
  postMailboxesMembers: Record<string, unknown>;
  /** Create a filter (declarative conditions/actions only) */
  postMailboxesRules: MailRule;
  /** Set filter execution order */
  postMailboxesRulesReorder: Array<MailRule>;
  /** Bulk thread action */
  postMailboxesThreadsBulk: Record<string, unknown>;
  /** Create audience */
  postMarketingAudiences: Record<string, unknown>;
  /** Add contacts */
  postMarketingAudiencesContacts: Record<string, unknown>;
  /** Create segment */
  postMarketingAudiencesSegments: Record<string, unknown>;
  /** Create automation */
  postMarketingAutomations: Record<string, unknown>;
  /** Start execution (approvers) */
  postMarketingAutomationsActivate: Record<string, unknown>;
  /** Archive and cancel active enrollments */
  postMarketingAutomationsArchive: Record<string, unknown>;
  /** Pause execution */
  postMarketingAutomationsPause: Record<string, unknown>;
  /** Publish (distinct approver + step-up MARKETING_AUTOMATION_PUBLISH) */
  postMarketingAutomationsVersionsApprove: Record<string, unknown>;
  /** Reject version */
  postMarketingAutomationsVersionsReject: Record<string, unknown>;
  /** Submit version for review */
  postMarketingAutomationsVersionsSubmit: Record<string, unknown>;
  /** Create campaign draft */
  postMarketingCampaigns: Record<string, unknown>;
  /** Approve (distinct reviewer + step-up) */
  postMarketingCampaignsApprove: Record<string, unknown>;
  /** Cancel (complete before handoff; after handoff stops unsent mail only) */
  postMarketingCampaignsCancel: BroadcastDispatch;
  /** Pause before provider handoff */
  postMarketingCampaignsPause: BroadcastDispatch;
  /** Preflight checks */
  postMarketingCampaignsPreflight: Record<string, unknown>;
  /** Reject */
  postMarketingCampaignsReject: Record<string, unknown>;
  /** Resume a paused dispatch */
  postMarketingCampaignsResume: BroadcastDispatch;
  /** Schedule an APPROVED campaign (sendAt + timeZone or sendAtUtc) */
  postMarketingCampaignsSchedule: BroadcastDispatch;
  /** Submit for review */
  postMarketingCampaignsSubmit: Record<string, unknown>;
  /** Send the rendered campaign to up to 5 active staff addresses (flag-gated) */
  postMarketingCampaignsTestSend: Record<string, unknown>;
  /** Create contact (+consent evidence) */
  postMarketingContacts: Record<string, unknown>;
  /** Record consent */
  postMarketingContactsConsents: Record<string, unknown>;
  /** Withdraw consent */
  postMarketingContactsConsentsWithdraw: Record<string, unknown>;
  /** CSV import with consent evidence */
  postMarketingContactsImport: Record<string, unknown>;
  /** Pause all brand dispatch (authors or approvers) */
  postMarketingDispatchPause: Record<string, unknown>;
  /** Resume brand dispatch (approver + step-up MARKETING_BROADCAST_OVERRIDE) */
  postMarketingDispatchResume: Record<string, unknown>;
  /** Suppress address */
  postMarketingSuppressions: Record<string, unknown>;
  /** Lift manual/bounce suppression */
  postMarketingSuppressionsLift: Record<string, unknown>;
  /** Create template */
  postMarketingTemplates: Record<string, unknown>;
  /** Render preview */
  postMarketingTemplatesRender: Record<string, unknown>;
  /** Create immutable version */
  postMarketingTemplatesVersions: Record<string, unknown>;
  /** Request mailbox/address/alias/grant */
  postProvisioningRequests: Record<string, unknown>;
  /** Approve and provision */
  postProvisioningRequestsApprove: Record<string, unknown>;
  /** Reject */
  postProvisioningRequestsReject: Record<string, unknown>;
  /** Confirm double opt-in */
  postPublicConsentConfirm: Record<string, unknown>;
  /** Confirm double opt-in */
  postPublicConsentConfirmByToken: Record<string, unknown>;
  /** Unsubscribe (form or RFC 8058 one-click) */
  postPublicUnsubscribeByToken: Record<string, unknown>;
  /** TOTP step-up verification */
  postSecurityStepUp: Record<string, unknown>;
  /** Assign conversation */
  postThreadsAssign: Record<string, unknown>;
  /** Acquire reply lock */
  postThreadsLock: Record<string, unknown>;
  /** Move thread to folder */
  postThreadsMove: Record<string, unknown>;
  /** Add internal note */
  postThreadsNotes: Record<string, unknown>;
  /** Set conversation status (revision) */
  postThreadsStatus: Record<string, unknown>;
  /** Resend (Svix-signed) webhook */
  postWebhooksResend: Record<string, unknown>;
  /** Brand marketing provider webhook (per-brand secret) */
  postWebhooksResendBrandBySlug: Record<string, unknown>;
  /** Set a brand/purpose quota (daily soft/hard, monthly hard) */
  putAdminQuotas: Record<string, unknown>;
  /** Create/update the editable draft version */
  putMarketingAutomationsDraft: Record<string, unknown>;
  /** Attach label */
  putThreadsLabelsByLabelId: Record<string, unknown>;
  /** Link support ticket reference */
  putThreadsTicketLink: Record<string, unknown>;
}

/** Typed JSON request bodies (operations without an entry take an untyped body or none). */
export interface MailRequestBodies {
  patchDraftsByDraftId: DraftInput & {
    revision: number;
  };
  patchMailboxesSettings: {
    signatureHtml?: string | null;
    slaFirstResponseMinutes?: number | null;
    supportTicketLinkEnabled?: boolean;
  };
  patchRulesByRuleId: MailRuleInput;
  patchThreadsState: {
    isRead?: boolean;
    isStarred?: boolean;
  };
  postAdminForwardingApprove: {
    note?: string;
    stepUpId?: string;
  };
  postAdminForwardingReject: {
    note?: string;
  };
  postAdminJobsRequeue: {
    reason: string;
    stepUpId: string;
  };
  postBreakGlassRequests: {
    mailboxId: string;
    reason: string;
    ticketRef?: string;
    durationMinutes?: number;
    stepUpId?: string;
  };
  postDraftsSend: {
    revision: number;
  };
  postForwardingDisable: {
    reason?: string;
  };
  postMailboxesDrafts: DraftInput;
  postMailboxesForwarding: {
    targetAddress: string;
    reason: string;
  };
  postMailboxesLabels: {
    name: string;
    color?: string;
  };
  postMailboxesMembers: {
    adminUserId: string;
    role: "OWNER" | "MANAGER" | "MEMBER" | "READER";
    canSend?: boolean;
  };
  postMailboxesRules: MailRuleInput & { name: unknown; conditions: unknown; actions: unknown; };
  postMailboxesRulesReorder: {
    ruleIds: Array<string>;
  };
  postMailboxesThreadsBulk: {
    threadIds: Array<string>;
    action: "archive" | "trash" | "spam" | "inbox" | "read" | "unread" | "star" | "unstar";
  };
  postProvisioningRequests: {
    organizationId?: string;
    type: "PERSONAL_MAILBOX" | "SHARED_MAILBOX" | "ALIAS" | "SENDER_GRANT";
    requestedAddress?: string;
    justification?: string;
  };
  postSecurityStepUp: {
    code: string;
    purpose: string;
  };
  postThreadsAssign: {
    assigneeAdminUserId?: string | null;
  };
  postThreadsMove: {
    folder: "INBOX" | "ARCHIVE" | "TRASH" | "SPAM";
  };
  postThreadsNotes: {
    body: string;
    mentions?: Array<string>;
  };
  postThreadsStatus: {
    status: "OPEN" | "PENDING" | "RESOLVED" | "CLOSED";
    revision: number;
  };
  putThreadsTicketLink: {
    ticketRef?: string | null;
  };
}

type ParamNames<P extends string> = P extends `${string}{${infer Name}}${infer Rest}` ? Name | ParamNames<Rest> : never;
export type MailPathParams<O extends MailOperationId> = Record<ParamNames<(typeof MAIL_OPERATIONS)[O]["path"]>, string>;
export type MailBody<O extends MailOperationId> = O extends keyof MailRequestBodies ? MailRequestBodies[O] : Record<string, unknown> | undefined;

/** Builds the path (relative to MAIL_API_BASE) of an operation; every parameter is URL-encoded. */
export function mailPath<O extends MailOperationId>(operation: O, params: MailPathParams<O>): string {
  const values = params as Record<string, string>;
  return MAIL_OPERATIONS[operation].path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined || value === null || value === "") throw new Error(`Missing path parameter ${name} for ${operation}`);
    return encodeURIComponent(String(value));
  });
}

export interface MailRequestOptions {
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  responseType?: "json" | "blob";
}

/** Minimal transport: resolves to the response `data` of the success envelope. */
export type MailTransport = (method: string, url: string, body: unknown, options: MailRequestOptions) => Promise<unknown>;

export function createMailClient(transport: MailTransport) {
  return {
    call<O extends MailOperationId>(operation: O, params: MailPathParams<O>, body?: MailBody<O>, options: MailRequestOptions = {}): Promise<MailResponses[O]> {
      const spec = MAIL_OPERATIONS[operation];
      return transport(spec.method, `${MAIL_API_BASE}${mailPath(operation, params)}`, body, options) as Promise<MailResponses[O]>;
    },
  };
}
