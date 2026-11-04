"use client";
import SectionNavigation from "../SectionNavigation";

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
  return <SectionNavigation label="Advertising Execution views" value={activeSection} groups={[{label: "Views", items: SECTIONS.map(item => ({value: item.key, label: item.label}))}]} onChange={value => onSectionChange(value as AESection)} />;
}
