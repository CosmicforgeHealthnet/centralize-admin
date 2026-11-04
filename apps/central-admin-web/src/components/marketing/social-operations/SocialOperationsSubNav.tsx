"use client";
import SectionNavigation from "../SectionNavigation";

const SECTIONS = [
  { key: "overview", label: "Overview" },
  { key: "content", label: "Content" },
  { key: "accounts", label: "Accounts" },
  { key: "inbox", label: "Inbox" },
  { key: "analytics", label: "Analytics" },
  { key: "operations", label: "Operations" },
  { key: "settings", label: "Settings" },
] as const;

export type SOSection = (typeof SECTIONS)[number]["key"];

interface SocialOperationsSubNavProps {
  activeSection: SOSection;
  onSectionChange: (section: SOSection) => void;
}

export default function SocialOperationsSubNav({ activeSection, onSectionChange }: SocialOperationsSubNavProps) {
  return <SectionNavigation label="Social Operations views" value={activeSection} groups={[{label: "Views", items: SECTIONS.map(item => ({value: item.key, label: item.label}))}]} onChange={value => onSectionChange(value as SOSection)} />;
}
