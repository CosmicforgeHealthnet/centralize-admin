import api from "./api";
import { inspectHttpError } from "./error-messages";
import { MAIL_API_BASE, MAIL_OPERATIONS, mailPath, type MailBody, type MailOperationId, type MailPathParams, type MailPreferences } from "./generated/mail-api";
import type {
  ActivityEvent,
  Attachment,
  BulkAction,
  ConversationStatus,
  Draft,
  ForwardingRule,
  MailRule,
  MailRuleInput,
  OriginalHeaders,
  SearchIndexStatus,
  DraftInput,
  InternalNote,
  MailEntitlements,
  MailLabel,
  MailMessage,
  MailView,
  MailboxDetail,
  MailboxMember,
  MailboxSettingsInput,
  MailboxSummary,
  SupportMailboxSummary,
  MembershipRole,
  MessageStatusResult,
  Paged,
  Party,
  SearchParams,
  SendResult,
  StaffDirectoryEntry,
  StepUpResult,
  ThreadFolder,
  ThreadSummary,
} from "@/types/mail.types";

// SECURITY NOTE (documented release blocker): the existing HQ auth store keeps
// the access token in JavaScript-readable localStorage. Mail content itself is
// never persisted client-side (in-memory React Query cache only, purged on
// logout / revoked access), but private-mail production rollout requires the
// planned migration to httpOnly-cookie sessions. See the Mail deployment docs.

const BASE = MAIL_API_BASE;

interface Envelope<T> {
  success: boolean;
  message?: string;
  data: T;
  meta?: { nextCursor?: string | null };
}

// Every call goes through the generated operation table (OpenAPI ->
// src/lib/generated/mail-api.ts): methods and paths cannot drift from the
// backend contract without a compile error or a failing CI check.
async function request<T, O extends MailOperationId>(
  operation: O,
  params: MailPathParams<O>,
  config: { body?: unknown; query?: Record<string, unknown>; headers?: Record<string, string> } = {},
): Promise<Envelope<T>> {
  const spec = MAIL_OPERATIONS[operation];
  const { data } = await api.request<Envelope<T>>({
    method: spec.method,
    url: `${MAIL_API_BASE}${mailPath(operation, params)}`,
    params: config.query,
    data: spec.method === "GET" || spec.method === "DELETE" ? undefined : (config.body ?? {}),
    headers: config.headers,
  });
  return data;
}

// op(id, params) checks the path parameters against the generated table;
// .get/.paged/.send declare the payload type expected by the UI.
function op<O extends MailOperationId>(operation: O, params: MailPathParams<O>) {
  return {
    async get<T>(query?: Record<string, unknown>): Promise<T> {
      return (await request<T, O>(operation, params, { query })).data;
    },
    async paged<T>(query?: Record<string, unknown>): Promise<Paged<T>> {
      const data = await request<T[], O>(operation, params, { query });
      return { items: data.data ?? [], nextCursor: data.meta?.nextCursor ?? null };
    },
    async send<T>(body?: unknown, headers?: Record<string, string>): Promise<T> {
      return (await request<T, O>(operation, params, { body, headers })).data;
    },
  };
}

// ── Error classification ──────────────────────────────────────────────────
export type MailErrorKind =
  | "disabled"
  | "forbidden"
  | "notFound"
  | "conflict"
  | "network"
  | "tooLarge"
  | "proxyRejected"
  | "invalidFile"
  | "scanFailed"
  | "unavailable"
  | "session"
  | "other";

export interface MailErrorInfo {
  kind: MailErrorKind;
  status?: number;
  code?: string;
  message: string;
  detail?: Record<string, unknown>;
  /** Support reference from the API (X-Request / correlation id); safe to show. */
  correlationId?: string;
  retryable?: boolean;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Append the support reference to a message so it can be quoted to support. */
export function withReference(message: string, info: Pick<MailErrorInfo, "correlationId">): string {
  return info.correlationId ? `${message} (Reference: ${info.correlationId})` : message;
}

export function classifyMailError(error: unknown): MailErrorInfo {
  const info = inspectHttpError(error);
  const code = info.responseCode;
  const firstError = Array.isArray(info.responseData?.errors)
    ? (info.responseData?.errors[0] as Record<string, unknown> | undefined)
    : undefined;
  const message = info.message || info.originalMessage || "Something went wrong.";
  const rawCorrelation = info.responseData?.correlationId;
  const correlationId = typeof rawCorrelation === "string" ? rawCorrelation.slice(0, 80) : undefined;
  const reason = typeof firstError?.reason === "string" ? firstError.reason : undefined;
  const maxBytes = typeof firstError?.maxBytes === "number" ? firstError.maxBytes : undefined;
  if (!info.hasResponse) {
    const timedOut = info.transportCode === "ECONNABORTED" || info.transportCode === "ETIMEDOUT";
    return {
      kind: "network",
      correlationId,
      retryable: true,
      message: timedOut
        ? "The upload timed out before it finished. Check your connection and try again."
        : "The connection was interrupted or the Mail service could not be reached. Check your connection and try again; nothing was attached.",
    };
  }
  // Rejected by the gateway/reverse proxy before the API saw the request: the
  // body is not the API's JSON envelope (no code), e.g. a bare Nginx 413 page.
  if (info.status === 413 && !code) {
    return {
      kind: "proxyRejected",
      status: 413,
      correlationId,
      message: "The server's upload gateway rejected this file as too large before Mail received it. Try a smaller file, or contact support with the file size and this time.",
    };
  }
  if (code === "MAIL_ATTACHMENT_TOO_LARGE" || (info.status === 413 && reason === "MESSAGE_TOO_LARGE")) {
    return {
      kind: "tooLarge",
      status: 413,
      code,
      correlationId,
      detail: firstError,
      message:
        reason === "MESSAGE_TOO_LARGE"
          ? "Adding this file would make the message too large to send. Remove other attachments or choose a smaller file."
          : `This file is larger than the ${maxBytes ? formatBytes(maxBytes) : "allowed"} per-file limit. Choose a smaller file or share it by link.`,
    };
  }
  if (info.status === 401) {
    return { kind: "session", status: 401, code, correlationId, message: "Your session has expired. Sign in again, then retry; your draft is saved." };
  }
  if (code === "MAIL_STORAGE_UNAVAILABLE" || info.status === 502 || info.status === 503 || info.status === 504) {
    if (info.status === 503 && code === "MAIL_DISABLED") return { kind: "disabled", status: 503, code, message, detail: firstError, correlationId };
    if (!(info.status === 503 && code?.startsWith("MAIL_") && code !== "MAIL_STORAGE_UNAVAILABLE")) {
      return { kind: "unavailable", status: info.status, code, correlationId, retryable: true, message: "Mail attachment storage or the service is temporarily unavailable. Wait a moment and try again; nothing was attached." };
    }
  }
  if (info.status === 400 && code === "MAIL_VALIDATION_FAILED" && firstError?.field === "file") {
    const friendly: Record<string, string> = {
      TOO_MANY_ATTACHMENTS: "This message already has the maximum number of attachments. Remove one first.",
      MALFORMED_MULTIPART: "The upload was malformed (often an interrupted upload). Try attaching the file again.",
      LIMIT_UNEXPECTED_FILE: "The upload was not in the expected format. Try attaching the file again.",
    };
    return { kind: "invalidFile", status: 400, code, correlationId, detail: firstError, message: friendly[reason ?? ""] ?? "This file could not be attached. Check the file and try again." };
  }
  if (info.status === 503 && (code === "MAIL_DISABLED" || code?.startsWith("MAIL_"))) {
    return { kind: "disabled", status: 503, code, message, detail: firstError, correlationId };
  }
  if (info.status === 403 && code) {
    const friendly: Record<string, string> = {
      MAIL_ROLLOUT_NOT_ENABLED: "Sending hasn't been enabled for this mailbox yet. Ask a Mail administrator to open IT → Mail Administration → Sending permissions and authorize this mailbox. Your message was not sent.",
      MAIL_ROLLOUT_DENIED: "Sending is restricted for this mailbox. Contact your Mail administrator. Your message was not sent.",
      MAIL_SENDER_NOT_AUTHORIZED: "You can't send from this address. Select an approved sender identity or contact your Mail administrator.",
      MAIL_EMERGENCY_STOP: "Email sending is temporarily paused by an administrator. Your message was not sent.",
    };
    if (friendly[code]) return { kind: "forbidden", status: 403, code, message: friendly[code], detail: firstError, correlationId };
  }
  if (info.status === 403) return { kind: "forbidden", status: 403, code, message, detail: firstError, correlationId };
  if (info.status === 404) return { kind: "notFound", status: 404, code, message, detail: firstError, correlationId };
  if (info.status === 409) return { kind: "conflict", status: 409, code, message, detail: firstError, correlationId };
  return { kind: "other", status: info.status, code, message, detail: firstError, correlationId };
}

// ── Entitlements & mailboxes ──────────────────────────────────────────────
export const fetchEntitlements = () => op("getMeEntitlements", {}).get<MailEntitlements>();
export const fetchMyMailboxes = () => op("getMeMailboxes", {}).get<MailboxSummary[]>();
export const fetchMailbox = (mailboxId: string) => op("getMailboxesByMailboxId", { mailboxId }).get<MailboxDetail>();

export const fetchThreads = (
  mailboxId: string,
  params: { view: Exclude<MailView, "drafts">; labelId?: string; cursor?: string | null; limit?: number },
) => op("getMailboxesThreads", { mailboxId }).paged<ThreadSummary>({ ...params, cursor: params.cursor ?? undefined });

export const fetchThread = (threadId: string) => op("getThreadsByThreadId", { threadId }).get<ThreadSummary>();
export const fetchThreadMessages = (threadId: string, remoteImages: "block" | "allow" = "block") =>
  op("getThreadsMessages", { threadId }).get<MailMessage[]>({ remoteImages });

export const updateThreadState = (threadId: string, body: { isRead?: boolean; isStarred?: boolean }) =>
  op("patchThreadsState", { threadId }).send<unknown>(body);
export const moveThread = (threadId: string, folder: ThreadFolder) => op("postThreadsMove", { threadId }).send<unknown>({ folder });
export const bulkThreads = (mailboxId: string, threadIds: string[], action: BulkAction) =>
  op("postMailboxesThreadsBulk", { mailboxId }).send<{ updated: number }>({ threadIds, action });

export const fetchLabels = (mailboxId: string) => op("getMailboxesLabels", { mailboxId }).get<MailLabel[]>();
export const createLabel = (mailboxId: string, body: { name: string; color?: string }) =>
  op("postMailboxesLabels", { mailboxId }).send<MailLabel>(body);
export const addThreadLabel = (threadId: string, labelId: string) => op("putThreadsLabelsByLabelId", { threadId, labelId }).send<unknown>();
export const removeThreadLabel = (threadId: string, labelId: string) => op("deleteThreadsLabelsByLabelId", { threadId, labelId }).send<unknown>();

export const searchMailbox = (mailboxId: string, params: SearchParams & { cursor?: string | null }) =>
  op("getMailboxesSearch", { mailboxId }).paged<ThreadSummary>({ ...params, cursor: params.cursor ?? undefined });
export const searchAll = (params: SearchParams & { cursor?: string | null }) =>
  op("getSearch", {}).paged<ThreadSummary>({ ...params, cursor: params.cursor ?? undefined });
export const suggestContacts = (q: string) => op("getContactsSuggest", {}).get<Party[]>({ q });

// ── Drafts & sending ──────────────────────────────────────────────────────
export const fetchDrafts = (mailboxId: string) => op("getMailboxesDrafts", { mailboxId }).paged<Draft>();
export const createDraft = (mailboxId: string, body: DraftInput) => op("postMailboxesDrafts", { mailboxId }).send<Draft>(body);
export const fetchDraft = (draftId: string) => op("getDraftsByDraftId", { draftId }).get<Draft>();
export const updateDraft = (draftId: string, body: DraftInput & { revision: number }) => op("patchDraftsByDraftId", { draftId }).send<Draft>(body);
export const discardDraft = (draftId: string) => op("deleteDraftsByDraftId", { draftId }).send<unknown>();

export async function uploadDraftAttachment(draftId: string, file: File): Promise<Attachment> {
  const form = new FormData();
  form.append("file", file);
  // Do NOT set Content-Type here: the instance default is application/json and a
  // hand-written "multipart/form-data" lacks the boundary. `false` removes the
  // header so the browser generates "multipart/form-data; boundary=…" itself.
  const { data } = await api.post<Envelope<Attachment>>(`${BASE}${mailPath("postDraftsAttachments", { draftId })}`, form, {
    headers: { "Content-Type": false },
    timeout: 120_000,
  });
  return data.data;
}
export const removeDraftAttachment = (draftId: string, attachmentId: string) =>
  op("deleteDraftsAttachmentsByAttachmentId", { draftId, attachmentId }).send<unknown>();

export const sendDraft = (draftId: string, revision: number, idempotencyKey: string, replyToAddressId: string | null = null) =>
  op("postDraftsSend", { draftId }).send<SendResult>({ revision, ...(replyToAddressId ? { replyToAddressId } : {}) }, { "Idempotency-Key": idempotencyKey });
export const fetchMessageStatus = (messageId: string) => op("getMessagesStatus", { messageId }).get<MessageStatusResult>();

export async function downloadAttachment(attachment: Attachment): Promise<void> {
  const res = await api.get(`${BASE}${mailPath("getAttachmentsDownload", { attachmentId: attachment.id })}`, { responseType: "blob" });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = attachment.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Shared mailbox / support ──────────────────────────────────────────────
export const fetchQueue = (
  mailboxId: string,
  params: { status?: ConversationStatus; assignee?: string; cursor?: string | null },
) => op("getMailboxesQueue", { mailboxId }).paged<ThreadSummary>({ ...params, cursor: params.cursor ?? undefined });
export const assignThread = (threadId: string, assigneeAdminUserId: string | null) =>
  op("postThreadsAssign", { threadId }).send<ThreadSummary>({ assigneeAdminUserId });
export const setThreadStatus = (threadId: string, status: ConversationStatus, revision: number) =>
  op("postThreadsStatus", { threadId }).send<ThreadSummary>({ status, revision });
export const lockThread = (threadId: string) => op("postThreadsLock", { threadId }).send<{ lockExpiresAt: string }>();
export const unlockThread = (threadId: string) => op("deleteThreadsLock", { threadId }).send<unknown>();
export const fetchNotes = (threadId: string) => op("getThreadsNotes", { threadId }).get<InternalNote[]>();
export const addNote = (threadId: string, body: string, mentions: string[] = []) =>
  op("postThreadsNotes", { threadId }).send<InternalNote>({ body, mentions });
export const setTicketLink = (threadId: string, ticketRef: string | null) =>
  op("putThreadsTicketLink", { threadId }).send<ThreadSummary>({ ticketRef });
export const fetchActivity = (threadId: string) => op("getThreadsActivity", { threadId }).get<ActivityEvent[]>();
export const fetchMembers = (mailboxId: string) => op("getMailboxesMembers", { mailboxId }).get<MailboxMember[]>();
export const addMember = (mailboxId: string, body: { adminUserId: string; role: MembershipRole; canSend: boolean; stepUpId?: string }) =>
  op("postMailboxesMembers", { mailboxId }).send<MailboxMember>(body);
export const revokeMember = (mailboxId: string, membershipId: string) =>
  op("deleteMailboxesMembersByMembershipId", { mailboxId, membershipId }).send<unknown>();
export const updateMailboxSettings = (mailboxId: string, body: MailboxSettingsInput) =>
  op("patchMailboxesSettings", { mailboxId }).send<MailboxDetail>(body);
export const fetchSupportMailboxes = () => op("getSupportMailboxes", {}).get<SupportMailboxSummary[]>();

export const searchStaffDirectory = (q: string) => op("getDirectoryStaff", {}).get<StaffDirectoryEntry[]>({ q });

// ── Filters (mailbox rules) ───────────────────────────────────────────────
export const fetchRules = (mailboxId: string) => op("getMailboxesRules", { mailboxId }).get<MailRule[]>();
export const createRule = (mailboxId: string, body: MailRuleInput) => op("postMailboxesRules", { mailboxId }).send<MailRule>(body);
export const updateRule = (ruleId: string, body: MailRuleInput) => op("patchRulesByRuleId", { ruleId }).send<MailRule>(body);
export const deleteRule = (ruleId: string) => op("deleteRulesByRuleId", { ruleId }).send<{ deleted: boolean }>();
export const reorderRules = (mailboxId: string, ruleIds: string[]) => op("postMailboxesRulesReorder", { mailboxId }).send<MailRule[]>({ ruleIds });

// ── Per-user preferences (spec 15 "Profiles") ────────────────────────────
// Before migration 36 the GET answers the defaults with available=false and
// the PUT answers 503 MAIL_FEATURE_NOT_READY.
export type { MailPreferences };
export type MailPreferencesInput = MailBody<"putMePreferences">;
export const fetchPreferences = () => op("getMePreferences", {}).get<MailPreferences>();
export const updatePreferences = (body: MailPreferencesInput) => op("putMePreferences", {}).send<MailPreferences>(body);

// ── Forwarding (approved by a mail administrator) ─────────────────────────
export const fetchForwarding = (mailboxId: string) => op("getMailboxesForwarding", { mailboxId }).get<ForwardingRule[]>();
export const requestForwarding = (mailboxId: string, body: { targetAddress: string; reason: string }) =>
  op("postMailboxesForwarding", { mailboxId }).send<ForwardingRule>(body);
export const disableForwarding = (ruleId: string) => op("postForwardingDisable", { ruleId }).send<ForwardingRule>({});
export const fetchForwardingRequests = (status?: string) => op("getAdminForwarding", {}).get<ForwardingRule[]>(status ? { status } : undefined);
export const approveForwarding = (ruleId: string, body: { note?: string; stepUpId?: string }) => op("postAdminForwardingApprove", { ruleId }).send<ForwardingRule>(body);
export const rejectForwarding = (ruleId: string, body: { note?: string }) => op("postAdminForwardingReject", { ruleId }).send<ForwardingRule>(body);

// ── Original headers / raw MIME (audited reads) ───────────────────────────
export const fetchOriginalHeaders = (messageId: string) => op("getMessagesOriginalHeaders", { messageId }).get<OriginalHeaders>();
export async function downloadRawMessage(messageId: string): Promise<void> {
  const res = await api.get(`${BASE}${mailPath("getMessagesRaw", { messageId })}`, { responseType: "blob" });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `message-${messageId}.eml`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Search index (mail administrators) ────────────────────────────────────
export const fetchSearchIndexStatus = () => op("getAdminSearchIndex", {}).get<SearchIndexStatus>();
export const startSearchBackfill = () => op("postAdminSearchIndexBackfill", {}).send<{ jobId: string; status: string }>({});

// ── Step-up ───────────────────────────────────────────────────────────────
export const stepUp = (code: string, purpose: string) => op("postSecurityStepUp", {}).send<StepUpResult>({ code, purpose });
