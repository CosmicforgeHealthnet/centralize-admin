"use client";

import SectionNavigation from "./SectionNavigation";
import { useRouter } from "next/navigation";
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
  MailPlus,
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
    // Absolute href: a deep-linkable route outside the in-page section switcher.
    label: "Email Marketing",
    icon: MailPlus,
    items: [
      { label: "Email Marketing", href: "/dashboard/marketing/email-marketing", icon: MailPlus },
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

export default function MarketingSubNav({ activeSection, onSectionChange }: {activeSection: string; onSectionChange: (section: string) => void}) {
  const router = useRouter();
  return <SectionNavigation label="Marketing sections" sidebar value={activeSection} groups={[
    {label: "Workspace", items: NAV_GROUPS[0].items.map(item => ({...item, href: undefined, value: item.href}))},
    {label: "Channels & intelligence", items: NAV_GROUPS.slice(1).flatMap(group => group.items.map(item => ({...item, href: item.href.startsWith("/") ? item.href : undefined, value: item.href})))}
  ]} onChange={value => value.startsWith("/") ? router.push(value) : onSectionChange(value)} />;
}
