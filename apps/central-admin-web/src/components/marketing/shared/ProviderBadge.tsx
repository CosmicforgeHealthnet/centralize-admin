"use client";

import { Facebook, Instagram, Music2, Twitter, Linkedin, Chrome } from "lucide-react";

export type BadgeProvider = "META" | "FACEBOOK" | "INSTAGRAM" | "TIKTOK" | "X" | "LINKEDIN" | "GOOGLE_ADS";

const PROVIDER_META: Record<BadgeProvider, { label: string; icon: React.ElementType; color: string }> = {
  META:        { label: "Meta",        icon: Facebook,  color: "#1877F2" },
  FACEBOOK:    { label: "Facebook",    icon: Facebook,  color: "#1877F2" },
  INSTAGRAM:   { label: "Instagram",   icon: Instagram, color: "#E4405F" },
  TIKTOK:      { label: "TikTok",      icon: Music2,    color: "#000000" },
  X:           { label: "X",           icon: Twitter,   color: "#3D3D3D" },
  LINKEDIN:    { label: "LinkedIn",    icon: Linkedin,  color: "#0A66C2" },
  GOOGLE_ADS:  { label: "Google Ads",  icon: Chrome,    color: "#4285F4" },
};

interface ProviderBadgeProps {
  provider: BadgeProvider;
  subtitle?: string;
  size?: "sm" | "md";
}

export default function ProviderBadge({ provider, subtitle, size = "md" }: ProviderBadgeProps) {
  const meta = PROVIDER_META[provider];
  if (!meta) return null;
  const Icon = meta.icon;
  const iconBox = size === "sm" ? "w-6 h-6" : "w-8 h-8";
  const iconSize = size === "sm" ? "w-3 h-3" : "w-4 h-4";

  return (
    <div className="flex items-center gap-2 min-w-0 max-w-full">
      <div
        className={`${iconBox} rounded-lg flex items-center justify-center shrink-0`}
        style={{ backgroundColor: `${meta.color}1A` }}
      >
        <Icon className={iconSize} style={{ color: meta.color }} />
      </div>
      <div className="flex flex-col min-w-0 flex-1">
        <span className="font-poppins text-[12px] font-medium text-foreground truncate" title={meta.label}>
          {meta.label}
        </span>
        {subtitle && (
          <span className="font-poppins text-[10px] text-muted-foreground truncate" title={subtitle}>
            {subtitle}
          </span>
        )}
      </div>
    </div>
  );
}