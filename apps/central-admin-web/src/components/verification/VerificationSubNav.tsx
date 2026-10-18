"use client";

import React from "react";
import { useVerificationStore } from "@/stores/verification.store";
import type { VerificationRole } from "@/types/verification.types";

const NAV_ITEMS: { label: string; role: VerificationRole | "Stuck" }[] = [
  { label: "All",        role: "All"        },
  { label: "Doctors",    role: "Doctors"    },
  { label: "Labs",       role: "Labs"       },
  { label: "Pharmacies", role: "Pharmacies" },
  { label: "Dispatch",   role: "Dispatch"   },
  { label: "Stuck",      role: "Stuck"      },
];

function NavItem({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2.5 px-3 py-2 rounded-[8px] w-full text-left transition-all duration-150 ${
        active
          ? "bg-primary/8 text-foreground font-semibold"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${active ? "bg-primary" : "bg-transparent"}`} />
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

export default function VerificationSubNav() {
  const activeRole    = useVerificationStore((s) => s.activeRole);
  const setActiveRole = useVerificationStore((s) => s.setActiveRole);

  return (
    <>
      <div className="hidden min-[1014px]:flex flex-col gap-0.5 w-[168px] shrink-0 pt-1">
        <SectionLabel label="Verification" />
        {NAV_ITEMS.map(({ label, role }) => (
          <NavItem
            key={role}
            label={label}
            active={activeRole === role}
            onClick={() => setActiveRole(role)}
          />
        ))}
      </div>

      <div className="flex min-[1014px]:hidden flex-col gap-2 pb-1">
        <div style={scrollRowStyle}>
          <span className="text-[10px] font-poppins font-semibold uppercase tracking-widest text-muted-foreground/60 shrink-0 pr-1">
            Verification
          </span>
          {NAV_ITEMS.map(({ label, role }) => (
            <button
              key={role}
              onClick={() => setActiveRole(role)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] whitespace-nowrap shrink-0 transition-all duration-150 text-[12px] font-poppins border ${
                activeRole === role
                  ? "bg-primary text-white border-primary font-semibold"
                  : "bg-card text-muted-foreground border-border hover:border-primary/40 hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}