import type { MailView, MessageStatus, Party, ScanStatus } from "@/types/mail.types";

export const MAIL_VIEWS: { id: MailView; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "starred", label: "Starred" },
  { id: "unread", label: "Unread" },
  { id: "sent", label: "Sent" },
  { id: "drafts", label: "Drafts" },
  { id: "archive", label: "Archive" },
  { id: "spam", label: "Spam" },
  { id: "trash", label: "Trash" },
];

export function isMailView(value: string | null | undefined): value is MailView {
  return !!value && [...MAIL_VIEWS.map((v) => v.id), "all"].includes(value as MailView);
}

// Honest delivery wording: provider acceptance is not delivery.
export const STATUS_LABELS: Record<MessageStatus, string> = {
  QUEUED: "Queued",
  PROVIDER_ACCEPTED: "Accepted by provider",
  DELIVERED: "Delivered",
  DELAYED: "Delivery delayed",
  FAILED: "Failed",
  BOUNCED: "Bounced",
  COMPLAINED: "Marked as spam by recipient",
  RECEIVED: "Received",
  QUARANTINED: "Quarantined",
  // The provider may or may not have sent it; an administrator must review.
  OUTCOME_UNKNOWN: "Delivery status unknown (under review)",
};

export function statusTone(status: string): string {
  switch (status) {
    case "DELIVERED":
    case "INTERNAL_DELIVERED":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "FAILED":
    case "BOUNCED":
    case "COMPLAINED":
    case "QUARANTINED":
      return "bg-red-50 text-red-700 border-red-200";
    case "DELAYED":
    case "OUTCOME_UNKNOWN":
      return "bg-amber-50 text-amber-700 border-amber-200";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

export function recipientStatusLabel(status: string): string {
  if (status in STATUS_LABELS) return STATUS_LABELS[status as MessageStatus];
  if (status === "PENDING") return "Pending";
  if (status === "INTERNAL_DELIVERED") return "Delivered internally";
  return status;
}

export const SCAN_LABELS: Record<ScanStatus, string> = {
  PENDING: "Scanning",
  CLEAN: "Clean",
  INFECTED: "Blocked: malware detected",
  SCAN_FAILED: "Quarantined: scan failed",
  SCANNER_UNAVAILABLE: "Quarantined: scanner unavailable",
};

export function partyLabel(p: Party | null | undefined): string {
  if (!p) return "";
  return p.name ? `${p.name} <${p.address}>` : p.address;
}

export function shortParty(p: Party | null | undefined): string {
  if (!p) return "";
  return p.name || p.address;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMailDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString();
}

export function formatFullDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

const EMAIL_RE = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]+$/;
export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** True when keyboard shortcuts should be ignored (typing in a field). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}
