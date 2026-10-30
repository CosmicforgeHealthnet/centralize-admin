"use client";

import type { AMIValidationStatus } from "@/types/ai-marketing-intelligence.types";

const CONFIG: Record<AMIValidationStatus, { label: string; className: string }> = {
  NOT_CONFIGURED: { label: "Not configured", className: "bg-muted text-muted-foreground border-border" },
  CREDENTIALS_REQUIRED: { label: "Credentials required", className: "bg-amber-50 text-amber-700 border-amber-200" },
  PROVIDER_APPROVAL_REQUIRED: { label: "Provider approval required", className: "bg-amber-50 text-amber-700 border-amber-200" },
  READY_FOR_LIVE_VALIDATION: { label: "Ready for live validation", className: "bg-blue-50 text-blue-700 border-blue-200" },
  LIVE_VALIDATION_IN_PROGRESS: { label: "Live validation in progress", className: "bg-blue-50 text-blue-700 border-blue-200" },
  LIVE_VALIDATION_PASSED: { label: "Live validation passed", className: "bg-green-50 text-green-700 border-green-200" },
  LIVE_VALIDATION_FAILED: { label: "Live validation failed", className: "bg-red-50 text-red-700 border-red-200" },
  CAPABILITY_LIMITED: { label: "Capability limited", className: "bg-purple-50 text-purple-700 border-purple-200" },
};

export default function ValidationStatusBadge({ value }: { value: AMIValidationStatus }) {
  const cfg = CONFIG[value];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-poppins font-medium whitespace-nowrap ${cfg.className}`}
    >
      {cfg.label}
    </span>
  );
}