"use client";
import SectionNavigation from "../SectionNavigation";

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
  return <SectionNavigation label="Marketing Intelligence views" value={activeSection} groups={[{label: "Views", items: MI_TABS.map(item => ({value: item.key, label: item.label}))}]} onChange={value => onSectionChange(value as MISection)} />;
}
