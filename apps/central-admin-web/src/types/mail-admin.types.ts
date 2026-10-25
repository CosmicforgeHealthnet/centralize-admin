// Mail administration (IT) and HR provisioning. Shapes mirror the
// /api/mail/v1/admin/* and /provisioning/* responses. Nothing here carries
// message content, secrets or provider keys.

export type DomainStatus = "PENDING_VERIFICATION" | "VERIFIED" | "FAILED" | "SUSPENDED";
export type CapabilityStatus = "NOT_CONFIGURED" | "PENDING" | "VERIFIED" | "FAILED" | "DISABLED";

export interface AdminOrganization {
  id: string;
  slug: string;
  name: string;
  kind: "COMPANY" | "BRAND";
}

export interface DnsRecord {
  record?: string;
  type?: string;
  name?: string;
  value?: string;
  status?: string;
  priority?: number | null;
}

export interface AdminDomain {
  id: string;
  organizationId: string;
  domain: string;
  status: DomainStatus;
  sendingStatus: CapabilityStatus;
  receivingStatus: CapabilityStatus;
  providerDomainId: string | null;
  dnsRecords: DnsRecord[] | null;
  lastCheckedAt: string | null;
  verifiedAt: string | null;
  organization?: { id: string; slug: string; name: string };
}

export interface AdminAddressRef {
  id: string;
  address: string;
  kind: string;
  status?: string;
}

export interface AdminMailbox {
  id: string;
  organizationId: string;
  type: "PERSONAL" | "SHARED";
  purpose: string | null;
  name: string;
  status: string;
  owner: { id: string; name: string | null; email: string | null } | null;
  addresses: AdminAddressRef[];
  memberCount: number;
  createdAt: string;
}

export type ProvisionType = "PERSONAL_MAILBOX" | "SHARED_MAILBOX" | "ALIAS" | "SENDER_GRANT";
export type ProvisionStatus = "PENDING" | "APPROVED" | "REJECTED" | "PROVISIONED" | "CANCELLED";

export interface ProvisionRequest {
  id: string;
  organizationId: string;
  type: ProvisionType;
  status: ProvisionStatus;
  requestedByAdminUserId: string;
  subjectAdminUserId: string | null;
  requestedAddress: string | null;
  mailboxId: string | null;
  justification: string | null;
  reviewedByAdminUserId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
}

export interface ProvisionRequestInput {
  type: ProvisionType;
  requestedAddress?: string;
  organizationId?: string;
  subjectAdminUserId?: string;
  mailboxId?: string;
  name?: string;
  justification?: string;
}

export interface SenderGrant {
  id: string;
  mailbox: { id: string; name: string };
  address: AdminAddressRef;
  member: { id: string; name: string | null; email: string | null };
  grantedBy: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface LegalHold {
  id: string;
  organizationId: string;
  mailboxId: string | null;
  subjectAdminUserId: string | null;
  reason: string;
  createdBy: string;
  releasedAt: string | null;
  createdAt: string;
}

export interface AdminRetentionPolicy {
  id: string;
  organizationId: string;
  mailboxId: string | null;
  name: string;
  retainDays: number;
  action: "ARCHIVE" | "DELETE";
  createdAt: string;
}

export interface MailAuditEvent {
  id: string;
  actorAdminUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  mailboxId: string | null;
  organizationId: string | null;
  outcome: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface MailWebhookEventRow {
  id: string;
  provider: string;
  eventType: string;
  status: string;
  signatureVerified: boolean;
  receivedAt: string;
  processedAt: string | null;
  lastError: string | null;
  lagSeconds: number | null;
}

export interface MailDeliveryEventRow {
  id: string;
  messageId: string | null;
  eventType: string;
  recipientDomain: string | null;
  occurredAt: string;
}

export interface MailJobRow {
  id: string;
  queue: string;
  kind: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  updatedAt: string;
}
