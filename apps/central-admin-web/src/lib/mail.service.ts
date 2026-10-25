import api from "./api";
import { inspectHttpError } from "./error-messages";
import type {
  ActivityEvent,
  Attachment,
  BulkAction,
  ConversationStatus,
  Draft,
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

const BASE = "/api/mail/v1";

interface Envelope<T> {
  success: boolean;
  message?: string;
  data: T;
  meta?: { nextCursor?: string | null };
}

async function getPaged<T>(url: string, params?: Record<string, unknown>): Promise<Paged<T>> {
  const { data } = await api.get<Envelope<T[]>>(`${BASE}${url}`, { params });
  return { items: data.data ?? [], nextCursor: data.meta?.nextCursor ?? null };
}

async function get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const { data } = await api.get<Envelope<T>>(`${BASE}${url}`, { params });
  return data.data;
}

async function post<T>(url: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const { data } = await api.post<Envelope<T>>(`${BASE}${url}`, body ?? {}, { headers });
  return data.data;
}

async function patch<T>(url: string, body: unknown): Promise<T> {
  const { data } = await api.patch<Envelope<T>>(`${BASE}${url}`, body);
  return data.data;
}

async function put<T>(url: string, body?: unknown): Promise<T> {
  const { data } = await api.put<Envelope<T>>(`${BASE}${url}`, body ?? {});
  return data.data;
}

async function del<T>(url: string): Promise<T> {
  const { data } = await api.delete<Envelope<T>>(`${BASE}${url}`);
  return data.data;
}

// ── Error classification ──────────────────────────────────────────────────
export type MailErrorKind = "disabled" | "forbidden" | "notFound" | "conflict" | "network" | "other";

export interface MailErrorInfo {
  kind: MailErrorKind;
  status?: number;
  code?: string;
  message: string;
  detail?: Record<string, unknown>;
}

export function classifyMailError(error: unknown): MailErrorInfo {
  const info = inspectHttpError(error);
  const code = info.responseCode;
  const firstError = Array.isArray(info.responseData?.errors)
    ? (info.responseData?.errors[0] as Record<string, unknown> | undefined)
    : undefined;
  const message = info.message || info.originalMessage || "Something went wrong.";
  if (!info.hasResponse) {
    return { kind: "network", message: "Unable to reach the Mail service. Check your connection and retry." };
  }
  if (info.status === 503 && (code === "MAIL_DISABLED" || code?.startsWith("MAIL_"))) {
    return { kind: "disabled", status: 503, code, message, detail: firstError };
  }
  if (info.status === 403) return { kind: "forbidden", status: 403, code, message, detail: firstError };
  if (info.status === 404) return { kind: "notFound", status: 404, code, message, detail: firstError };
  if (info.status === 409) return { kind: "conflict", status: 409, code, message, detail: firstError };
  return { kind: "other", status: info.status, code, message, detail: firstError };
}

// ── Entitlements & mailboxes ──────────────────────────────────────────────
export const fetchEntitlements = () => get<MailEntitlements>("/me/entitlements");
export const fetchMyMailboxes = () => get<MailboxSummary[]>("/me/mailboxes");
export const fetchMailbox = (mailboxId: string) => get<MailboxDetail>(`/mailboxes/${mailboxId}`);

export const fetchThreads = (
  mailboxId: string,
  params: { view: Exclude<MailView, "drafts">; labelId?: string; cursor?: string | null; limit?: number },
) => getPaged<ThreadSummary>(`/mailboxes/${mailboxId}/threads`, { ...params, cursor: params.cursor ?? undefined });

export const fetchThread = (threadId: string) => get<ThreadSummary>(`/threads/${threadId}`);
export const fetchThreadMessages = (threadId: string, remoteImages: "block" | "allow" = "block") =>
  get<MailMessage[]>(`/threads/${threadId}/messages`, { remoteImages });

export const updateThreadState = (threadId: string, body: { isRead?: boolean; isStarred?: boolean }) =>
  patch<unknown>(`/threads/${threadId}/state`, body);
export const moveThread = (threadId: string, folder: ThreadFolder) => post<unknown>(`/threads/${threadId}/move`, { folder });
export const bulkThreads = (mailboxId: string, threadIds: string[], action: BulkAction) =>
  post<{ updated: number }>(`/mailboxes/${mailboxId}/threads/bulk`, { threadIds, action });

export const fetchLabels = (mailboxId: string) => get<MailLabel[]>(`/mailboxes/${mailboxId}/labels`);
export const createLabel = (mailboxId: string, body: { name: string; color?: string }) =>
  post<MailLabel>(`/mailboxes/${mailboxId}/labels`, body);
export const addThreadLabel = (threadId: string, labelId: string) => put<unknown>(`/threads/${threadId}/labels/${labelId}`);
export const removeThreadLabel = (threadId: string, labelId: string) => del<unknown>(`/threads/${threadId}/labels/${labelId}`);

export const searchMailbox = (mailboxId: string, params: SearchParams & { cursor?: string | null }) =>
  getPaged<ThreadSummary>(`/mailboxes/${mailboxId}/search`, { ...params, cursor: params.cursor ?? undefined });
export const searchAll = (params: SearchParams & { cursor?: string | null }) =>
  getPaged<ThreadSummary>(`/search`, { ...params, cursor: params.cursor ?? undefined });
export const suggestContacts = (q: string) => get<Party[]>(`/contacts/suggest`, { q });

// ── Drafts & sending ──────────────────────────────────────────────────────
export const fetchDrafts = (mailboxId: string) => getPaged<Draft>(`/mailboxes/${mailboxId}/drafts`);
export const createDraft = (mailboxId: string, body: DraftInput) => post<Draft>(`/mailboxes/${mailboxId}/drafts`, body);
export const fetchDraft = (draftId: string) => get<Draft>(`/drafts/${draftId}`);
export const updateDraft = (draftId: string, body: DraftInput & { revision: number }) => patch<Draft>(`/drafts/${draftId}`, body);
export const discardDraft = (draftId: string) => del<unknown>(`/drafts/${draftId}`);

export async function uploadDraftAttachment(draftId: string, file: File): Promise<Attachment> {
  const form = new FormData();
  form.append("file", file);
  const { data } = await api.post<Envelope<Attachment>>(`${BASE}/drafts/${draftId}/attachments`, form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data.data;
}
export const removeDraftAttachment = (draftId: string, attachmentId: string) =>
  del<unknown>(`/drafts/${draftId}/attachments/${attachmentId}`);

export const sendDraft = (draftId: string, revision: number, idempotencyKey: string) =>
  post<SendResult>(`/drafts/${draftId}/send`, { revision }, { "Idempotency-Key": idempotencyKey });
export const fetchMessageStatus = (messageId: string) => get<MessageStatusResult>(`/messages/${messageId}/status`);

export async function downloadAttachment(attachment: Attachment): Promise<void> {
  const res = await api.get(`${BASE}/attachments/${attachment.id}/download`, { responseType: "blob" });
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
) => getPaged<ThreadSummary>(`/mailboxes/${mailboxId}/queue`, { ...params, cursor: params.cursor ?? undefined });
export const assignThread = (threadId: string, assigneeAdminUserId: string | null) =>
  post<ThreadSummary>(`/threads/${threadId}/assign`, { assigneeAdminUserId });
export const setThreadStatus = (threadId: string, status: ConversationStatus, revision: number) =>
  post<ThreadSummary>(`/threads/${threadId}/status`, { status, revision });
export const lockThread = (threadId: string) => post<{ lockExpiresAt: string }>(`/threads/${threadId}/lock`);
export const unlockThread = (threadId: string) => del<unknown>(`/threads/${threadId}/lock`);
export const fetchNotes = (threadId: string) => get<InternalNote[]>(`/threads/${threadId}/notes`);
export const addNote = (threadId: string, body: string, mentions: string[] = []) =>
  post<InternalNote>(`/threads/${threadId}/notes`, { body, mentions });
export const setTicketLink = (threadId: string, ticketRef: string | null) =>
  put<ThreadSummary>(`/threads/${threadId}/ticket-link`, { ticketRef });
export const fetchActivity = (threadId: string) => get<ActivityEvent[]>(`/threads/${threadId}/activity`);
export const fetchMembers = (mailboxId: string) => get<MailboxMember[]>(`/mailboxes/${mailboxId}/members`);
export const addMember = (mailboxId: string, body: { adminUserId: string; role: MembershipRole; canSend: boolean }) =>
  post<MailboxMember>(`/mailboxes/${mailboxId}/members`, body);
export const revokeMember = (mailboxId: string, membershipId: string) =>
  del<unknown>(`/mailboxes/${mailboxId}/members/${membershipId}`);
export const updateMailboxSettings = (mailboxId: string, body: MailboxSettingsInput) =>
  patch<MailboxDetail>(`/mailboxes/${mailboxId}/settings`, body);
export const fetchSupportMailboxes = () => get<MailboxSummary[]>(`/support/mailboxes`);

export const searchStaffDirectory = (q: string) => get<StaffDirectoryEntry[]>(`/directory/staff`, { q });

// ── Step-up ───────────────────────────────────────────────────────────────
export const stepUp = (code: string, purpose: string) => post<StepUpResult>(`/security/step-up`, { code, purpose });
