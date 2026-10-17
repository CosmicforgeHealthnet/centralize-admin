"use client";

const SECTIONS = [
  { key: "overview",              label: "Overview" },
  { key: "plans",                 label: "Plans" },
  { key: "approvals",             label: "Approvals" },
  { key: "execution-runs",        label: "Execution Runs" },
  { key: "drift-incidents",       label: "Drift & Incidents" },
  { key: "creatives",             label: "Creatives" },
  { key: "policies-controls",     label: "Policies & Controls" },
  { key: "provider-readiness",    label: "Provider Readiness" },
  { key: "health",                label: "Health" },
] as const;

export type AESection = (typeof SECTIONS)[number]["key"];

interface AdvertisingExecutionSubNavProps {
  activeSection: AESection;
  onSectionChange: (section: AESection) => void;
}

export default function AdvertisingExecutionSubNav({
  activeSection,
  onSectionChange,
}: AdvertisingExecutionSubNavProps) {
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