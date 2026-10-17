"use client";

import React from "react";
import {
  LayoutDashboard,
  Rocket,
  FileText,
  Mail,
  Share2,
  Image as ImageIcon,
  LineChart,
  Sparkles,
  Users,
  Gauge,
  type LucideIcon,
} from "lucide-react";
import { ShieldCheck } from "lucide-react"; 

interface NavItemDef {
  label: string;
  href: string;
  icon: LucideIcon;
}

interface NavGroupDef {
  label: string;
  icon: LucideIcon;
  items: NavItemDef[];
}

const NAV_GROUPS: NavGroupDef[] = [
  {
    label: "Marketing",
    icon: Rocket,
    items: [
      { label: "Overview",              href: "overview",              icon: LayoutDashboard },
      { label: "Campaigns",             href: "campaigns",             icon: Rocket },
      { label: "Content Manager",       href: "content-manager",       icon: FileText },
      { label: "Email Template",        href: "email-template",        icon: Mail },
      { label: "Social Media",          href: "social-media",          icon: Share2 },
      { label: "Banners & Promotion",   href: "banners-promotion",     icon: ImageIcon },
      { label: "Performance Dashboard", href: "performance-dashboard", icon: LineChart },
    ],
  },
 
  {
    label: "Marketing Intelligence",
    icon: Gauge,
    items: [
      { label: "Marketing Intelligence", href: "marketing-intelligence", icon: Gauge },
    ],
  },
  {
    label: "Social Operations",
    icon: Users,
    items: [
      { label: "Social Operations", href: "social-operations", icon: Users },
    ],
  },
   {
    label: "AI Marketing Intelligence",
    icon: Sparkles,
    items: [
      { label: "AI Marketing Intelligence", href: "ai-marketing-intelligence", icon: Sparkles },
    ],
  },
   
   {
  label: "Advertising Execution",
  icon: ShieldCheck,
  items: [
    { label: "Advertising Execution", href: "advertising-execution", icon: ShieldCheck },
  ],
},
];

function SectionLabel({ label, icon: Icon }: { label: string; icon: LucideIcon }) {
  return (
    <div className="flex items-center gap-1.5 px-3 pb-2">
      <Icon className="w-3 h-3 text-muted-foreground/45" strokeWidth={2.25} />
      <span className="text-[10px] font-poppins font-semibold uppercase tracking-widest text-muted-foreground/55 select-none">
        {label}
      </span>
    </div>
  );
}

function NavItem({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="relative flex items-center gap-2.5 pl-3 pr-3 py-2 rounded-[8px] w-full text-left transition-colors duration-150 group"
    >
      <span
        className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-full bg-primary transition-all duration-200 ease-out ${
          active ? "h-4 opacity-100" : "h-0 opacity-0"
        }`}
      />
      <span
        className={`absolute inset-0 rounded-[8px] transition-colors duration-150 ${
          active ? "bg-primary/8" : "bg-transparent group-hover:bg-muted/40"
        }`}
      />
      <span
        className={`relative flex items-center justify-center w-6 h-6 rounded-[6px] shrink-0 transition-colors duration-150 ${
          active ? "bg-primary/12" : "bg-transparent"
        }`}
      >
        <Icon
          className={`w-[14px] h-[14px] transition-colors duration-150 ${
            active ? "text-primary" : "text-muted-foreground/70 group-hover:text-foreground"
          }`}
          strokeWidth={2}
        />
      </span>
      <span
        className={`relative text-[13px] font-poppins leading-tight transition-colors duration-150 ${
          active ? "text-foreground font-semibold" : "text-muted-foreground group-hover:text-foreground"
        }`}
      >
        {label}
      </span>
    </button>
  );
}

const scrollRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  overflowX: "auto",
  paddingBottom: "2px",
  scrollbarWidth: "none",
  msOverflowStyle: "none",
};

interface MarketingSubNavProps {
  activeSection: string;
  onSectionChange: (section: string) => void;
}

export default function MarketingSubNav({ activeSection, onSectionChange }: MarketingSubNavProps) {
  return (
    <>
      {/* Desktop sidebar */}
      <div className="hidden min-[1014px]:flex flex-col w-[200px] shrink-0 sticky top-4 gap-5">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col">
            <SectionLabel label={group.label} icon={group.icon} />
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <NavItem
                  key={item.href}
                  label={item.label}
                  icon={item.icon}
                  active={activeSection === item.href}
                  onClick={() => onSectionChange(item.href)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Mobile horizontal scroll */}
      <div className="flex min-[1014px]:hidden flex-col gap-3 pb-1">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} style={scrollRowStyle}>
            <span className="flex items-center gap-1 text-[10px] font-poppins font-semibold uppercase tracking-widest text-muted-foreground/55 shrink-0 pr-1">
              <group.icon className="w-3 h-3" strokeWidth={2.25} />
              {group.label}
            </span>
            {group.items.map((item) => {
              const active = activeSection === item.href;
              return (
                <button
                  key={item.href}
                  onClick={() => onSectionChange(item.href)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full whitespace-nowrap shrink-0 transition-all duration-150 text-[12px] font-poppins border ${
                    active
                      ? "bg-primary text-white border-primary font-semibold shadow-sm"
                      : "bg-card text-muted-foreground border-border hover:border-primary/40 hover:text-foreground"
                  }`}
                >
                  <item.icon className="w-3.5 h-3.5" strokeWidth={2} />
                  {item.label}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}