"use client";

import React from "react";

const subNavItems = [
  "Profile Info",
  "Projects",
  "Tasks",
  "Teams",
  "Activity Logs",
  "Notification",
] as const;

type ProfileSubNavItem = (typeof subNavItems)[number];

function NavItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2.5 px-3 py-2 rounded-[8px] w-full text-left transition-all duration-150 ${
        active
          ? "bg-primary/8 text-foreground font-semibold"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${
          active ? "bg-primary" : "bg-transparent"
        }`}
      />
      <span className="text-[13px] font-poppins">{label}</span>
    </button>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <span className="px-3 pt-3 pb-1 text-[10px] font-poppins font-semibold uppercase tracking-widest text-muted-foreground/60 select-none">
      {label}
    </span>
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

interface ProfileSubNavProps {
  activeItem: string;
  onItemClick: (item: string) => void;
}

export default function ProfileSubNav({
  activeItem,
  onItemClick,
}: ProfileSubNavProps) {
  return (
    <>
      {/* Desktop — vertical sidebar */}
      <div className="hidden min-[1014px]:flex flex-col gap-0.5 w-[168px] shrink-0 pt-1">
        <SectionLabel label="Profile" />
        {subNavItems.map((item) => (
          <NavItem
            key={item}
            label={item}
            active={activeItem === item}
            onClick={() => onItemClick(item)}
          />
        ))}
      </div>

      {/* Mobile — horizontal scroll */}
      <div className="flex min-[1014px]:hidden flex-col gap-2 pb-1">
        <div style={scrollRowStyle}>
          <span className="text-[10px] font-poppins font-semibold uppercase tracking-widest text-muted-foreground/60 shrink-0 pr-1">
            Profile
          </span>
          {subNavItems.map((item) => (
            <button
              key={item}
              onClick={() => onItemClick(item)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] whitespace-nowrap shrink-0 transition-all duration-150 text-[12px] font-poppins border ${
                activeItem === item
                  ? "bg-primary text-white border-primary font-semibold"
                  : "bg-card text-muted-foreground border-border hover:border-primary/40 hover:text-foreground"
              }`}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}