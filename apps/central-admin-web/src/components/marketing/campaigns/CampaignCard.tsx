// src/components/marketing/campaigns/CampaignCard.tsx
"use client";

import { useState, useRef, useEffect } from "react";
import {
  MoreVertical, Eye, Edit, BarChart3, Play, Copy, Settings, Archive, Trash2,
} from "lucide-react";
import type { CampaignListItem, CampaignType, CampaignListStatus } from "@/types/marketing.types";

const TYPE_STYLES: Record<CampaignType, { bg: string; text: string }> = {
  Email:  { bg: "rgba(39,46,167,0.08)",  text: "#272EA7" },
  Social: { bg: "rgba(236,72,153,0.10)", text: "#EC4899" },
  Events: { bg: "rgba(13,165,63,0.10)",  text: "#0DA53F" },
  Ads:    { bg: "rgba(232,182,0,0.10)",  text: "#E8B600" },
};

const STATUS_STYLES: Record<CampaignListStatus, string> = {
  Active:    "text-green-500",
  Drafts:    "text-muted-foreground",
  Completed: "text-primary",
  Paused:    "text-yellow-500",
};

interface Props {
  campaign: CampaignListItem;
  onView: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onStatusChange: (id: string, status: CampaignListStatus) => void;
  onArchive: (id: string) => void;
}

export default function CampaignCard({ 
  campaign, 
  onView, 
  onDuplicate, 
  onDelete, 
  onStatusChange,
  onArchive 
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const typeStyle = TYPE_STYLES[campaign.type];
  const status = campaign.status as CampaignListStatus;

  // Skip rendering if status is Archived
  if (campaign.status === "Archived") return null;

  const MENU_ITEMS = [
    { icon: Eye,      label: "View Details",     action: () => onView(campaign.id) },
    { icon: Edit,     label: "Edit Campaign",    action: () => {} },
    { icon: BarChart3, label: "View Analytics",  action: () => {} },
    { divider: true },
    { icon: Play,     label: "Launch Campaign",  action: () => onStatusChange(campaign.id, "Active") },
    { icon: Copy,     label: "Duplicate Campaign", action: () => onDuplicate(campaign.id) },
    { icon: Settings, label: "Settings",         action: () => {} },
    { divider: true },
    { icon: Archive,  label: "Archive",          action: () => onArchive(campaign.id) },
    { icon: Trash2,   label: "Delete Campaign",  action: () => onDelete(campaign.id), danger: true },
  ];

  return (
    <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-3 relative">
      <div className="flex items-start justify-between">
        <button
          onClick={() => onView(campaign.id)}
          className="font-poppins text-[13px] font-semibold text-foreground text-left hover:text-primary transition-colors"
        >
          {campaign.title}
        </button>
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="text-muted-foreground hover:text-foreground transition-colors p-0.5"
          >
            <MoreVertical className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-6 z-20 w-[190px] bg-card border border-border rounded-lg shadow-lg py-1.5 flex flex-col">
              {MENU_ITEMS.map((item, i) =>
                item.divider ? (
                  <div key={i} className="my-1 border-t border-border" />
                ) : (
                  <button
                    key={item.label}
                    onClick={() => {
                      item.action?.();
                      setMenuOpen(false);
                    }}
                    className={`flex items-center gap-2 px-3 py-1.5 text-[12px] font-poppins hover:bg-muted/50 transition-colors ${
                      item.danger ? "text-red-500" : "text-foreground"
                    }`}
                  >
                    {item.icon && <item.icon className="w-3.5 h-3.5" />}
                    {item.label}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span
          className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-poppins font-semibold w-fit"
          style={{ backgroundColor: typeStyle.bg, color: typeStyle.text }}
        >
          {campaign.type}
        </span>
      </div>

      <div className="flex items-center justify-between">
        <span className={`font-poppins text-[12px] font-semibold ${STATUS_STYLES[status]}`}>
          {campaign.status}
        </span>
        <span className="font-poppins text-[11px] text-muted-foreground">{campaign.date || "—"}</span>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="font-poppins text-[11px] text-muted-foreground">Progress</span>
          <span className="font-poppins text-[11px] text-muted-foreground">{campaign.progress}%</span>
        </div>
        <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-foreground rounded-full transition-all"
            style={{ width: `${campaign.progress}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 pt-1">
        {campaign.metrics.map((m) => (
          <div key={m.label} className="flex flex-col">
            <span className="font-poppins text-[13px] font-bold text-foreground">{m.value}</span>
            <span className="font-poppins text-[10px] text-muted-foreground truncate">{m.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}