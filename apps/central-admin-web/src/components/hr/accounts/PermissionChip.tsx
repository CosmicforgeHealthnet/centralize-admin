"use client";

import { X } from "lucide-react";
import { Module } from "@/types/hrm.types";

interface PermissionChipProps {
  module: Module;
  section: string;
  mode: "VIEW" | "EDIT";
  onRemove?: () => void;
  className?: string;
  size?: "sm" | "md" | "lg";
}

export default function PermissionChip({
  module,
  section,
  mode,
  onRemove,
  className = "",
  size = "md",
}: PermissionChipProps) {
  // Format labels for display
  const moduleLabel = module.charAt(0).toUpperCase() + module.slice(1);
  const sectionLabel = section.charAt(0).toUpperCase() + section.slice(1);

  // Size variants
  const sizeClasses = {
    sm: "px-2 py-0.5 text-[10px] gap-1",
    md: "px-3 py-1.5 text-[11px] gap-1.5",
    lg: "px-4 py-2 text-[13px] gap-2",
  };

  // Mode colors
  const modeColors = {
    VIEW: {
      bg: "bg-blue-50 dark:bg-blue-950/30",
      text: "text-blue-700 dark:text-blue-300",
      border: "border-blue-200 dark:border-blue-800",
      badge: "bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300",
    },
    EDIT: {
      bg: "bg-emerald-50 dark:bg-emerald-950/30",
      text: "text-emerald-700 dark:text-emerald-300",
      border: "border-emerald-200 dark:border-emerald-800",
      badge: "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-300",
    },
  };

  const colors = modeColors[mode];

  return (
    <div
      className={`
        inline-flex items-center rounded-full border font-medium transition-all
        ${colors.bg}
        ${colors.text}
        ${colors.border}
        ${sizeClasses[size]}
        hover:shadow-sm hover:scale-[1.02] active:scale-[0.98]
        ${className}
      `}
    >
      {/* Module + Section */}
      <span className="font-semibold">{moduleLabel}</span>
      <span className="opacity-40">/</span>
      <span>{sectionLabel}</span>

      {/* Mode Badge */}
      <span
        className={`
          px-1.5 py-0.5 rounded font-bold text-[8px] uppercase tracking-wider
          ${colors.badge}
        `}
      >
        {mode}
      </span>

      {/* Remove Button */}
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className={`
            ml-0.5 p-0.5 rounded-full transition-all
            hover:bg-black/10 dark:hover:bg-white/10
            hover:scale-110 active:scale-90
            focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-primary/50
          `}
          aria-label={`Remove ${moduleLabel} / ${sectionLabel} permission`}
          type="button"
        >
          <X className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  );
}