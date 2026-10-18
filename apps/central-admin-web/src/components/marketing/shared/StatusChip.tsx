"use client";

import { Check, Clock, AlertTriangle, X, Ban, HelpCircle } from "lucide-react";

export type StatusTone = "success" | "info" | "warning" | "danger" | "purple" | "neutral";

const TONE_STYLE: Record<StatusTone, { bg: string; text: string; icon: React.ElementType }> = {
  success: { bg: "rgba(13,165,63,0.1)",   text: "#0DA53F", icon: Check },
  info:    { bg: "rgba(39,46,167,0.08)",  text: "#272EA7", icon: Clock },
  warning: { bg: "rgba(232,182,0,0.12)",  text: "#E8B600", icon: AlertTriangle },
  danger:  { bg: "rgba(239,68,68,0.1)",   text: "#EF4444", icon: X },
  purple:  { bg: "rgba(124,58,237,0.1)",  text: "#7C3AED", icon: HelpCircle },
  neutral: { bg: "rgba(148,163,184,0.15)", text: "#64748B", icon: Ban },
};

// Maps the most common status strings across MI/SO domains to a visual tone.
// Anything not listed falls back to "neutral" — pass an explicit `tone` prop to override.
const STATUS_TONE_MAP: Record<string, StatusTone> = {
  ACTIVE: "success", PUBLISHED: "success", SUCCEEDED: "success", SUCCESS: "success",
  APPROVED: "success", RESOLVED: "success", LIVE_VALIDATED: "success",
  PENDING: "info", PENDING_APPROVAL: "info", SCHEDULED: "info", PUBLISHING: "info",
  RUNNING: "info", CLAIMED: "info", VALIDATING: "info", UPLOADING: "info", PROCESSING: "info",
  OPEN: "info", SNOOZED: "info", RETRY_SCHEDULED: "info", NOT_VALIDATED: "info",
  RATE_LIMITED: "warning", PARTIALLY_PUBLISHED: "warning", PARTIAL: "warning",
  AWAITING_USER_ACTION: "warning", REAUTHORIZATION_REQUIRED: "warning",
  PENDING_PLATFORM_APPROVAL: "warning", PENDING_AUTHORIZATION: "warning",
  ERROR: "danger", FAILED: "danger", FAILED_RETRYABLE: "danger", FAILED_PERMANENT: "danger",
  REJECTED: "danger", CREDENTIAL_BLOCKED: "danger", APPROVAL_BLOCKED: "danger",
  NATIVE_ONLY: "purple", LEGACY_UNVERIFIED: "purple",
  DISABLED: "neutral", CANCELLED: "neutral", ARCHIVED: "neutral", SPAM: "neutral",
  DRAFT: "neutral", DELETED: "neutral", SKIPPED_NO_CREDENTIALS: "neutral", SKIPPED_LOCKED: "neutral",
};

export function statusTone(status: string): StatusTone {
  return STATUS_TONE_MAP[status] ?? "neutral";
}

interface StatusChipProps {
  status: string;
  tone?: StatusTone;
  label?: string;
}

export default function StatusChip({ status, tone, label }: StatusChipProps) {
  const resolvedTone = tone ?? statusTone(status);
  const style = TONE_STYLE[resolvedTone];
  const Icon = style.icon;

  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-poppins text-[10px] font-semibold w-fit"
      style={{ backgroundColor: style.bg, color: style.text }}
    >
      <Icon className="w-2.5 h-2.5" />
      {label ?? status.replace(/_/g, " ")}
    </span>
  );
}