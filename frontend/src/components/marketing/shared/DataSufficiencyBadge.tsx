"use client";

import type { AMIDataSufficiency } from "@/types/ai-marketing-intelligence.types";

const CONFIG: Record<AMIDataSufficiency, { label: string; className: string }> = {
  INSUFFICIENT: { label: "Insufficient", className: "bg-muted text-muted-foreground border-border" },
  LIMITED: { label: "Limited", className: "bg-amber-50 text-amber-700 border-amber-200" },
  SUFFICIENT: { label: "Sufficient", className: "bg-blue-50 text-blue-700 border-blue-200" },
  STRONG: { label: "Strong", className: "bg-green-50 text-green-700 border-green-200" },
};

export default function DataSufficiencyBadge({ value }: { value: AMIDataSufficiency }) {
  const cfg = CONFIG[value];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-poppins font-medium ${cfg.className}`}
    >
      {cfg.label}
    </span>
  );
}