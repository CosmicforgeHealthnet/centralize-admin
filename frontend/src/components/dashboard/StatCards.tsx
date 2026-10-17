"use client";

import { useEffect } from "react";
import { useDashboardStore } from "@/stores/dashboard.store";
import type { StatCards as StatCardsType } from "@/types/dashboard.types";

const STAT_CONFIG = [
  {
    key: "totalUsers" as keyof StatCardsType,
    title: "Total Users",
    subtitle: "All time · Across all Products",
    format: (v: number | string) => Number(v).toLocaleString(),
  },
  {
    key: "activeUsersThisWeek" as keyof StatCardsType,
    title: "Active Users",
    subtitle: "Last 7 days · Across all Products",
    format: (v: number | string) => Number(v).toLocaleString(),
  },
{
  key: "totalRevenue" as keyof StatCardsType,
  title: "Total Revenue",
  subtitle: "This month · NGN Transactions",
  format: (v: number | string) => `₦${Number(v).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`,
},
  {
    key: "activeDoctors" as keyof StatCardsType,
    title: "Active Doctors",
    subtitle: "All time · Healthnet",
    format: (v: number | string) => Number(v).toLocaleString(),
  },
  {
    key: "activePatients" as keyof StatCardsType,
    title: "Active Patients",
    subtitle: "All time · Healthnet",
    format: (v: number | string) => Number(v).toLocaleString(),
  },
];

const getColSpan = (i: number) => {
  if (i <= 2) return "col-span-1 sm:col-span-2 min-[1014px]:col-span-1";
  if (i === 3) return "col-span-1 sm:col-span-3 min-[1014px]:col-span-1";
  if (i === 4) return "col-span-2 sm:col-span-3 min-[1014px]:col-span-1";
  return "col-span-1";
};

// Skeleton for loading state
function StatCardSkeleton({ index }: { index: number }) {
  return (
    <div
      className={`
        bg-card rounded-lg border border-border p-3 md:p-4
        flex flex-col justify-between items-center text-center
        min-h-[90px] md:min-h-[110px] animate-pulse
        ${getColSpan(index)}
      `}
    >
      <div className="w-24 h-3 bg-muted rounded" />
      <div className="w-16 h-6 bg-muted rounded my-1" />
      <div className="w-20 h-3 bg-muted rounded" />
    </div>
  );
}

export default function StatCards() {
  const { overview, isLoadingOverview, fetchOverview } = useDashboardStore();

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  if (isLoadingOverview || !overview) {
    return (
      <>
        {STAT_CONFIG.map((_, i) => (
          <StatCardSkeleton key={i} index={i} />
        ))}
      </>
    );
  }

  return (
    <>
      {STAT_CONFIG.map((config, i) => {
        const stat = overview.statCards[config.key];
        return (
          <div
            key={config.key}
            className={`
              bg-card rounded-lg border border-border p-3 md:p-4
              flex flex-col justify-between items-center text-center
              min-h-[90px] md:min-h-[110px]
              ${getColSpan(i)}
            `}
          >
            <div>
              <p className="text-[11px] md:text-[12px] font-poppins font-semibold text-foreground leading-tight">
                {config.title}
              </p>
              <p className="text-[10px] md:text-[11px] font-poppins text-muted-foreground leading-tight mt-0.5">
                {config.subtitle}
              </p>
            </div>

            <p className="text-[18px] md:text-[22px] font-sans font-poppins font-bold text-foreground leading-tight my-1">
              {config.format(stat.value)}
            </p>

            <div className="flex items-center gap-1 flex-wrap justify-center">
              <span
                className={`text-[10px] md:text-[11px] font-poppins font-semibold ${
                  stat.positive ? "text-success" : "text-destructive"
                }`}
              >
                {stat.positive ? "▲" : "▼"} {stat.change}%
              </span>
              <span className="text-[10px] md:text-[11px] font-poppins text-muted-foreground">
                {stat.period}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}