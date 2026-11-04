// src/components/marketing/overview/QuickActions.tsx
"use client";

import { PlusCircle, CalendarClock, Image as ImageIcon, ChevronRight } from "lucide-react";

interface Action {
  icon: React.ElementType;
  title: string;
  subtitle: string;
  section: string;
}

const ACTIONS: Action[] = [
  { icon: PlusCircle,    title: "Campaigns", section: "campaigns", subtitle: "Create A New Marketing Campaign" },
  { icon: CalendarClock, title: "Social Media", section: "social-media",  subtitle: "Plan your social media content" },
  { icon: ImageIcon,     title: "Banners & Promotion", section: "banners-promotion",   subtitle: "Design Promotional Banners" },
];

export default function QuickActions({ onNavigate }: { onNavigate: (section: string) => void }) {
  return (
    <div className="bg-card rounded-xl border border-border p-4 shadow-[0px_1px_2px_rgba(16,24,40,0.05)] flex flex-col gap-3 h-full">
      <h3 className="font-poppins text-[13px] font-semibold text-foreground">Quick Actions</h3>

      <div className="flex flex-col gap-2">
        {ACTIONS.map(({ icon: Icon, title, subtitle, section }) => (
          <button
            key={title}
            type="button"
            onClick={() => onNavigate(section)}
            className="flex items-center gap-3 bg-primary/5 hover:bg-primary/10 border border-primary/10 rounded-lg px-3 py-3 text-left transition-colors"
          >
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Icon className="w-4 h-4 text-primary" />
            </div>
            <div className="flex flex-col min-w-0 flex-1">
              <span className="font-poppins text-[12px] font-semibold text-foreground truncate">{title}</span>
              <span className="font-poppins text-[10px] text-muted-foreground truncate">{subtitle}</span>
            </div>
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          </button>
        ))}
      </div>
    </div>
  );
}