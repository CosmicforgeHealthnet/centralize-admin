"use client";

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