"use client";

// Sub-navigation of the CF Meet section. The active page is the `?section=`
// query parameter (default Overview), so every page has a shareable link.

import Link from "next/link";
import React from "react";
import { CFMEET_SECTIONS, OVERVIEW_SECTION } from "./sections";

const ITEMS = [{ id: OVERVIEW_SECTION, label: "Overview" }, ...CFMEET_SECTIONS.map((s) => ({ id: s.id, label: s.label }))];

export const sectionHref = (id: string) => (id === OVERVIEW_SECTION ? "/dashboard/cfmeet" : `/dashboard/cfmeet?section=${id}`);

const scrollRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  overflowX: "auto",
  paddingBottom: "2px",
  scrollbarWidth: "none",
  msOverflowStyle: "none",
};

export default function CfMeetSubNav({ active }: { active: string }) {
  return (
    <>
      <nav aria-label="CF Meet sections" className="hidden min-[1014px]:flex flex-col gap-0.5 w-[168px] shrink-0 pt-1">
        <span className="px-3 pt-3 pb-1 text-[10px] font-poppins font-semibold uppercase tracking-widest text-muted-foreground/60 select-none">CF Meet</span>
        {ITEMS.map(({ id, label }) => {
          const on = active === id;
          return (
            <Link
              key={id}
              href={sectionHref(id)}
              scroll={false}
              aria-current={on ? "page" : undefined}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-[8px] w-full text-left transition-all duration-150 ${
                on ? "bg-primary/8 text-foreground font-semibold" : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${on ? "bg-primary" : "bg-transparent"}`} />
              <span className="text-[13px] font-poppins">{label}</span>
            </Link>
          );
        })}
      </nav>

      <nav aria-label="CF Meet sections" className="flex min-[1014px]:hidden flex-col gap-2 pb-1">
        <div style={scrollRowStyle}>
          <span className="text-[10px] font-poppins font-semibold uppercase tracking-widest text-muted-foreground/60 shrink-0 pr-1">CF Meet</span>
          {ITEMS.map(({ id, label }) => {
            const on = active === id;
            return (
              <Link
                key={id}
                href={sectionHref(id)}
                scroll={false}
                aria-current={on ? "page" : undefined}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] whitespace-nowrap shrink-0 transition-all duration-150 text-[12px] font-poppins border ${
                  on ? "bg-primary text-white border-primary font-semibold" : "bg-card text-muted-foreground border-border hover:border-primary/40 hover:text-foreground"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
