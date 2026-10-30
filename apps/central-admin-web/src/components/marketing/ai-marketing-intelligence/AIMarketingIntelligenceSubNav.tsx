"use client";

const SECTIONS = [
  { key: "overview",              label: "Overview" },
  { key: "performance",           label: "Performance" },
  { key: "provider-connections",  label: "Provider Connections" },
  { key: "provider-validation",   label: "Provider Validation" },
  { key: "creative-intelligence", label: "Creative Intelligence" },
  { key: "recommendations",       label: "Recommendations" },
  { key: "alerts",                label: "Alerts" },
  { key: "experiments",           label: "Experiments" },
  { key: "evaluation-runs",       label: "Evaluation Runs" },
  { key: "settings-controls",     label: "Settings & Controls" },
] as const;

export type AMISection = (typeof SECTIONS)[number]["key"];

interface AIMarketingIntelligenceSubNavProps {
  activeSection: AMISection;
  onSectionChange: (section: AMISection) => void;
}

export default function AIMarketingIntelligenceSubNav({
  activeSection,
  onSectionChange,
}: AIMarketingIntelligenceSubNavProps) {
  return (
    <div className="flex items-center gap-1 border-b border-border overflow-x-auto">
      {SECTIONS.map((s) => (
        <button
          key={s.key}
          onClick={() => onSectionChange(s.key)}
          className={`font-poppins text-[12px] font-medium px-3 py-2 border-b-2 whitespace-nowrap transition-colors ${
            activeSection === s.key
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}