// CosmicForge Mail API types. Source of truth: docs/cosmicforge-mail-api-contract.md

export type MailboxType = "PERSONAL" | "SHARED";
export type MailboxPurpose = "GENERAL" | "SUPPORT" | "MARKETING";
export type MembershipRole = "OWNER" | "MANAGER" | "MEMBER" | "READER";
export type RecordStatus = "ACTIVE" | "SUSPENDED" | "ARCHIVED";
export type ThreadFolder = "INBOX" | "ARCHIVE" | "TRASH" | "SPAM";
export type ConversationStatus = "OPEN" | "PENDING" | "RESOLVED" | "CLOSED";
export type MessageStatus =
  | "QUEUED"
  | "PROVIDER_ACCEPTED"
  | "DELIVERED"
  | "DELAYED"
  | "FAILED"
  | "BOUNCED"
  | "COMPLAINED"
  | "RECEIVED"
  | "QUARANTINED"
  | "OUTCOME_UNKNOWN";
export type ScanStatus = "PENDING" | "CLEAN" | "INFECTED" | "SCAN_FAILED" | "SCANNER_UNAVAILABLE";
export type DraftMode = "NEW" | "REPLY" | "REPLY_ALL" | "FORWARD";
export type DraftStatus = "ACTIVE" | "SENDING" | "SENT" | "DISCARDED";

export type MailView = "inbox" | "sent" | "drafts" | "archive" | "trash" | "spam" | "starred" | "unread" | "all";

export interface MailOrganizationRef {
  id: string;
  slug: string;
  name: string;
}

export interface MailboxSummary {
  id: string;
  name: string;
  type: MailboxType;
  purpose: MailboxPurpose;
  role: MembershipRole;
  canSend: boolean;
  primaryAddress: string | null;
  unreadCount: number;
  status: RecordStatus;
  organization: MailOrganizationRef;
}

export interface SenderIdentity {
  addressId: string;
  address: string;
  displayName: string | null;
  kind: string;
}

export interface MailboxDetail extends MailboxSummary {
  senderIdentities: SenderIdentity[];
  signatureHtml: string | null;
  slaFirstResponseMinutes?: number | null;
  supportTicketLinkEnabled?: boolean;
}

export interface MarketingEntitlement {
  organizationId: string;
  slug: string;
  name: string;
  canAuthor: boolean;
  canApprove: boolean;
}

export interface MailEntitlements {
  mailEnabled: boolean;
  sendingEnabled: boolean;
  marketingEnabled: boolean;
  identityActive: boolean;
  mailboxes: MailboxSummary[];
  canManageDomains: boolean;
  /** Read-only Mail administration (domains, mailboxes, audits). */
  canViewAdministration?: boolean;
  canProvision: boolean;
  canApproveProvisioning: boolean;
  canManageSharedMembership: boolean;
  marketing: MarketingEntitlement[];
}

export interface Party {
  address: string;
  name: string | null;
}

export interface MailLabel {
  id: string;
  name: string;
  color: string | null;
}

export interface ThreadSummary {
  id: string;
  mailboxId: string;
  subject: string;
  snippet: string;
  folder: ThreadFolder;
  lastMessageAt: string;
  messageCount: number;
  participants: Party[];
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  labels: MailLabel[];
  conversationStatus: ConversationStatus | null;
  assignedTo: { id: string; name: string } | null;
  slaDueAt: string | null;
  lastDeliveryStatus: MessageStatus | null;
  revision: number;
  lockedBy: { id: string; name: string } | null;
  lockExpiresAt: string | null;
  supportTicketRef: string | null;
}

export interface Recipient extends Party {
  type: "TO" | "CC" | "BCC";
  status: string;
}

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  isInline: boolean;
  scanStatus: ScanStatus;
  downloadable: boolean;
}

export interface DeliveryEvent {
  type: string;
  recipient: string | null;
  occurredAt: string;
}

export interface MailMessage {
  id: string;
  threadId: string;
  mailboxId: string;
  direction: "INBOUND" | "OUTBOUND" | "INTERNAL";
  status: MessageStatus;
  subject: string;
  from: Party;
  replyTo: string | null;
  recipients: Recipient[];
  sentAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  html: string | null;
  text: string | null;
  remoteImagesBlocked: number;
  attachments: Attachment[];
  sentBy: { id: string; name: string } | null;
  deliveryEvents: DeliveryEvent[];
  quarantineReason: string | null;
}

export interface Draft {
  id: string;
  mailboxId: string;
  mode: DraftMode;
  threadId: string | null;
  inReplyToMessageId: string | null;
  senderAddressId: string | null;
  to: Party[];
  cc: Party[];
  bcc: Party[];
  subject: string;
  html: string;
  text: string;
  revision: number;
  status: DraftStatus;
  attachments: Attachment[];
  updatedAt: string;
}

export interface DraftInput {
  mode?: DraftMode;
  threadId?: string | null;
  inReplyToMessageId?: string | null;
  senderAddressId?: string | null;
  to?: Party[];
  cc?: Party[];
  bcc?: Party[];
  subject?: string;
  html?: string;
  text?: string;
}

export interface SendResult {
  messageId: string;
  threadId: string;
  jobId: string;
  status: "QUEUED";
}

export interface MessageStatusResult {
  status: MessageStatus;
  recipients: Recipient[];
  deliveryEvents: DeliveryEvent[];
}

export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

export interface InternalNote {
  id: string;
  body: string;
  mentions: string[];
  createdAt: string;
  author: { id: string; name: string } | null;
}

export interface ActivityEvent {
  id: string;
  action: string;
  actor: { id: string; name: string } | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

export interface MailboxMember {
  id: string;
  adminUserId: string;
  name: string | null;
  email: string | null;
  role: MembershipRole;
  canSend: boolean;
  createdAt: string;
}

export interface MailboxSettingsInput {
  signatureHtml?: string | null;
  slaFirstResponseMinutes?: number | null;
  supportTicketLinkEnabled?: boolean;
}

export interface SearchParams {
  q?: string;
  from?: string;
  to?: string;
  subject?: string;
  after?: string;
  before?: string;
  labelId?: string;
}

export type BulkAction = "archive" | "trash" | "spam" | "inbox" | "read" | "unread" | "star" | "unstar";

export interface StaffDirectoryEntry {
  id: string;
  name: string;
  email: string;
  department: string | null;
}

export interface StepUpResult {
  stepUpId: string;
  expiresAt: string;
}
