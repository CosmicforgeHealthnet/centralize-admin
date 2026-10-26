"use client";

import type { PreflightStatus, TemplateClassification } from "@/types/mail-marketing.types";

const STATUS_TONES: Record<PreflightStatus, string> = {
  PASS: "bg-emerald-50 text-emerald-700",
  WARNING: "bg-amber-50 text-amber-700",
  BLOCKED: "bg-red-50 text-red-700",
  UNKNOWN: "bg-slate-100 text-slate-700",
};

const STATUS_LABELS: Record<PreflightStatus, string> = { PASS: "Pass", WARNING: "Warning", BLOCKED: "Blocked", UNKNOWN: "Unknown" };

/** Preflight / QA check state. UNKNOWN means "could not be verified", never a pass. */
export function QaStatusBadge({ status }: { status: PreflightStatus }) {
  return (
    <span data-status={status} className={`inline-flex min-w-[64px] justify-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${STATUS_TONES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

/** Status of a check, deriving it from `ok` for responses without `status`. */
export function checkStatus(check: { ok: boolean; status?: PreflightStatus }): PreflightStatus {
  return check.status ?? (check.ok ? "PASS" : "BLOCKED");
}

const CLASS_TONES: Record<TemplateClassification, string> = {
  MARKETING: "bg-sky-50 text-sky-700",
  TRANSACTIONAL: "bg-violet-50 text-violet-700",
  TRANSACTIONAL_SECURITY: "bg-red-50 text-red-700",
};

export const CLASSIFICATION_LABELS: Record<TemplateClassification, string> = {
  MARKETING: "Marketing",
  TRANSACTIONAL: "Transactional",
  TRANSACTIONAL_SECURITY: "Transactional · Security",
};

export function ClassificationBadge({ value }: { value: TemplateClassification }) {
  return (
    <span data-testid="template-classification-badge" data-classification={value} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${CLASS_TONES[value]}`}>
      {CLASSIFICATION_LABELS[value]}
    </span>
  );
}
