"use client";

import { FolderKanban, Users, CalendarDays, Settings } from "lucide-react";

const NAV_ITEMS = [
  { id: "overview", label: "Projects", icon: FolderKanban },
  { id: "teams", label: "Teams", icon: Users },
  { id: "events", label: "Events", icon: CalendarDays },
  { id: "settings", label: "Settings", icon: Settings },
];

interface Props {
  active: string;
  onChange: (id: string) => void;
}

export default function PerformanceSubNav({ active, onChange }: Props) {
  return (
    <div className="flex flex-col gap-1 w-full">
      {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`flex items-center gap-2.5 px-3 py-2.5 rounded-[8px] w-full text-left transition-all duration-150 ${
            active === id
              ? "bg-primary/8 text-foreground font-semibold"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
          }`}
        >
          <Icon className={`w-4 h-4 shrink-0 ${active === id ? "text-primary" : "text-muted-foreground"}`} />
          <span className="text-[13px] font-poppins">{label}</span>
        </button>
      ))}
    </div>
  );
}