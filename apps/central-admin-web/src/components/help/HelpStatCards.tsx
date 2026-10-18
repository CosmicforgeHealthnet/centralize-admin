"use client";

import { useEffect } from "react";
import { useSupportStore } from "@/stores/support.store";

export default function HelpStatCards() {
  const { stats, fetchStats, isLoadingStats } = useSupportStore();

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const formatValue = (value: number | null): string => {
    if (value === null) return "—";
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return value.toString();
  };

  const cards = [
    {
      title: "All Tickets",
      value: stats?.total.value ?? null,
      change: stats?.total.change ?? "0.0",
      positive: stats?.total.positive ?? true,
      period: stats?.total.period ?? "from last week",
    },
    {
      title: "Resolved Tickets",
      value: stats?.resolved.value ?? null,
      change: stats?.resolved.change ?? "0.0",
      positive: stats?.resolved.positive ?? true,
      period: stats?.resolved.period ?? "from last week",
    },
    {
      title: "Unresolved Tickets",
      value: stats?.unresolved.value ?? null,
      change: stats?.unresolved.change ?? "0.0",
      positive: stats?.unresolved.positive ?? false,
      period: stats?.unresolved.period ?? "from last week",
    },
    {
      title: "Live Chat Requests",
      subtitle: "(Healthnet)",
      value: stats?.liveChat.value ?? null,
      change: stats?.liveChat.change ?? "0.0",
      positive: stats?.liveChat.positive ?? true,
      period: stats?.liveChat.period ?? "from last week",
    },
  ];

  return (
    <div className="grid grid-cols-2 min-[1100px]:grid-cols-4 gap-3">
      {cards.map((stat, i) => (
        <div
          key={i}
          className="bg-card rounded-lg border border-border p-3 flex flex-col justify-between min-h-[90px] text-center items-center"
        >
          <div>
            <p className="text-[11px] font-poppins font-semibold text-foreground leading-tight">
              {stat.title}
            </p>
            {"subtitle" in stat && stat.subtitle && (
              <p className="text-[10px] font-poppins text-muted-foreground leading-tight">
                {stat.subtitle}
              </p>
            )}
          </div>

          {isLoadingStats ? (
            <div className="w-12 h-5 bg-muted animate-pulse rounded my-1" />
          ) : (
            <p className="text-[16px] min-[1100px]:text-[20px] font-sans font-bold text-primary leading-tight my-1">
              {formatValue(stat.value)}
            </p>
          )}

          <div className="flex items-center gap-1 flex-wrap justify-center">
            <span
              className={`text-[10px] font-poppins font-semibold ${
                stat.positive ? "text-success" : "text-destructive"
              }`}
            >
              {stat.positive ? "▲" : "▼"} {stat.change}%
            </span>
            <span className="text-[10px] font-poppins text-muted-foreground">
              {stat.period}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}