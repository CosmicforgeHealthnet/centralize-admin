"use client";

import { Clock, Loader2, AlertTriangle, CheckCircle2, XCircle, Lock } from "lucide-react";
import type { AMIEvaluationRunStatus } from "@/types/ai-marketing-intelligence.types";

const CONFIG: Record<AMIEvaluationRunStatus, { label: string; className: string; icon: typeof Clock }> = {
  PENDING: { label: "Pending", className: "bg-muted text-muted-foreground border-border", icon: Clock },
  RUNNING: { label: "Running", className: "bg-blue-50 text-blue-700 border-blue-200", icon: Loader2 },
  PARTIAL_SUCCESS: { label: "Partial success", className: "bg-amber-50 text-amber-700 border-amber-200", icon: AlertTriangle },
  SUCCEEDED: { label: "Succeeded", className: "bg-green-50 text-green-700 border-green-200", icon: CheckCircle2 },
  FAILED: { label: "Failed", className: "bg-red-50 text-red-700 border-red-200", icon: XCircle },
  SKIPPED_LOCKED: { label: "Skipped (locked)", className: "bg-muted text-muted-foreground border-border", icon: Lock },
};

export default function RunStatusBadge({ value }: { value: AMIEvaluationRunStatus }) {
  const cfg = CONFIG[value];
  const Icon = cfg.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-poppins font-medium whitespace-nowrap ${cfg.className}`}
    >
      <Icon className={`w-3 h-3 ${value === "RUNNING" ? "animate-spin" : ""}`} strokeWidth={2.25} />
      {cfg.label}
    </span>
  );
}