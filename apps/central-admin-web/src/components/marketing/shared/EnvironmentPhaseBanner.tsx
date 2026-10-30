"use client";

import { Info, Rocket, Eye, Megaphone, CheckCircle2 } from "lucide-react";
import type { AMIPhase2State } from "@/types/ai-marketing-intelligence.types";

const CONFIG: Record<AMIPhase2State, { label: string; description: string; className: string; icon: typeof Info }> = {
  DISABLED: {
    label: "Phase 2 disabled",
    description: "Phase 2 is installed in this environment but operational evaluation is disabled. Read-only and setup screens remain available.",
    className: "bg-muted border-border text-muted-foreground",
    icon: Info,
  },
  DARK_LAUNCH: {
    label: "Dark launch",
    description: "Schema and read/setup experiences are live. Operational features (sync, scoring, recommendations) remain disabled.",
    className: "bg-muted border-border text-muted-foreground",
    icon: Rocket,
  },
  OBSERVATION: {
    label: "Observation",
    description: "Creative sync, scoring and fatigue evidence are visible for review. Recommendations and Task conversion are not yet active.",
    className: "bg-blue-50 border-blue-200 text-blue-800",
    icon: Eye,
  },
  ADVISORY: {
    label: "Advisory",
    description: "Recommendations and alerts are active. Accepted recommendations cannot yet be converted to Tasks.",
    className: "bg-amber-50 border-amber-200 text-amber-800",
    icon: Megaphone,
  },
  RELEASED: {
    label: "Full release",
    description: "All Phase 2 capabilities are active for platforms whose live-validation gate has passed.",
    className: "bg-green-50 border-green-200 text-green-800",
    icon: CheckCircle2,
  },
};

interface EnvironmentPhaseBannerProps {
  environment: "STAGING" | "PRODUCTION";
  phase2State: AMIPhase2State;
}

export default function EnvironmentPhaseBanner({ environment, phase2State }: EnvironmentPhaseBannerProps) {
  const cfg = CONFIG[phase2State];
  const Icon = cfg.icon;
  return (
    <div className={`flex items-start gap-3 rounded-[10px] border px-4 py-3 ${cfg.className}`}>
      <Icon className="w-4 h-4 mt-0.5 shrink-0" strokeWidth={2} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12px] font-poppins font-semibold">{cfg.label}</span>
          <span className="text-[10px] font-poppins font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-black/5">
            {environment}
          </span>
        </div>
        <p className="text-[12px] font-poppins mt-0.5 opacity-90">{cfg.description}</p>
      </div>
    </div>
  );
}