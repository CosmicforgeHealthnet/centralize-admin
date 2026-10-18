"use client";

import { Gauge, Link2, RefreshCw, type LucideIcon } from "lucide-react";

export type MISection = "performance-dashboard" | "connections" | "sync-health";

const MI_TABS: { key: MISection; label: string; icon: LucideIcon }[] = [
  { key: "performance-dashboard", label: "Performance Dashboard", icon: Gauge },
  { key: "connections",           label: "Connections",           icon: Link2 },
  { key: "sync-health",           label: "Sync & Provider Health", icon: RefreshCw },
];

interface MarketingIntelligenceSubNavProps {
  activeSection: MISection;
  onSectionChange: (section: MISection) => void;
}

export default function MarketingIntelligenceSubNav({
  activeSection,
  onSectionChange,
}: MarketingIntelligenceSubNavProps) {
  return (
    <div className="flex items-center gap-1 flex-wrap border-b border-border pb-3">
      {MI_TABS.map((tab) => {
        const active = activeSection === tab.key;
        return (
          <button
            key={tab.key}
            onClick={() => onSectionChange(tab.key)}
            className={`flex items-center gap-1.5 font-poppins text-[12px] font-medium px-3 py-1.5 rounded-full transition-colors duration-150 ${
              active
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/70"
            }`}
          >
            <tab.icon className="w-3.5 h-3.5" strokeWidth={2} />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}