"use client";
import SectionNavigation from "../SectionNavigation";

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
  return <SectionNavigation label="AI Marketing Intelligence views" value={activeSection} groups={[{label: "Views", items: SECTIONS.map(item => ({value: item.key, label: item.label}))}]} onChange={value => onSectionChange(value as AMISection)} />;
}
