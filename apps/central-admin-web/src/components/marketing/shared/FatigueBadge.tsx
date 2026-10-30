"use client";

import { Minus, Eye, AlertTriangle, RotateCcw } from "lucide-react";
import type { AMIFatigueStatus } from "@/types/ai-marketing-intelligence.types";

const CONFIG: Record<AMIFatigueStatus, { label: string; className: string; icon: typeof Minus }> = {
  NONE: { label: "None", className: "bg-green-50 text-green-700 border-green-200", icon: Minus },
  WATCH: { label: "Watch", className: "bg-amber-50 text-amber-700 border-amber-200", icon: Eye },
  FATIGUED: { label: "Fatigued", className: "bg-red-50 text-red-700 border-red-200", icon: AlertTriangle },
  RECOVERED: { label: "Recovered", className: "bg-green-50 text-green-700 border-green-200", icon: RotateCcw },
};

export default function FatigueBadge({ value }: { value: AMIFatigueStatus }) {
  const cfg = CONFIG[value];
  const Icon = cfg.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-poppins font-medium ${cfg.className}`}
    >
      <Icon className="w-3 h-3" strokeWidth={2.25} />
      {cfg.label}
    </span>
  );
}