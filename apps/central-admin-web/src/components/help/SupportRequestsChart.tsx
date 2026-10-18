"use client";

import { useEffect } from "react";
import {
  RadialBarChart,
  RadialBar,
  ResponsiveContainer,
  PolarAngleAxis,
} from "recharts";
import { useSupportStore } from "@/stores/support.store";

export default function SupportRequestsChart() {
  const { stats, fetchStats, isLoadingStats } = useSupportStore();

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const total = stats?.total.value ?? 0;
  const liveChat = stats?.liveChat.value ?? 0;
  const combined = total + liveChat;

  const ticketPct = combined > 0 ? Math.round((total / combined) * 100) : 0;
  const liveChatPct = combined > 0 ? Math.round((liveChat / combined) * 100) : 0;

  const data = [
    {
      name: "Support Ticket",
      value: ticketPct,
      fill: "#272EA7",
      isReal: true,
      display: `${ticketPct}%`,
    },
    {
      name: "Live Chat",
      value: liveChatPct,
      fill: "#0da53f",
      isReal: true,
      display: `${liveChatPct}%`,
    },
    {
      name: "Email",
      value: 0, // TODO: no endpoint yet
      fill: "#f64545",
      isReal: false,
      display: "—",
    },
  ];

  const chartData = [...data].reverse();

  return (
    <div className="bg-card rounded-lg border border-border p-4">
      {/* Header */}
      <div className="mb-1">
        <h2 className="text-[14px] font-bold text-foreground leading-tight">
          Support Requests
        </h2>
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-muted-foreground">This week</span>
          <span
            className={`text-[11px] font-semibold ${
              stats?.total.positive ? "text-success" : "text-destructive"
            }`}
          >
            {stats?.total.positive ? "▲" : "▼"} {stats?.total.change ?? "0.0"}%
          </span>
        </div>
      </div>

      {/* Radial Chart */}
      <div className="relative w-full h-[160px]">
        {isLoadingStats || !stats ? (
          <div className="w-full h-full flex items-center justify-center">
            <div className="w-24 h-24 rounded-full bg-muted animate-pulse" />
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height="100%">
              <RadialBarChart
                cx="50%"
                cy="58%"
                innerRadius="42%"
                outerRadius="95%"
                barSize={9}
                data={chartData}
                startAngle={210}
                endAngle={-30}
              >
                <PolarAngleAxis
                  type="number"
                  domain={[0, 100]}
                  angleAxisId={0}
                  tick={false}
                />
                <RadialBar
                  background={{ fill: "var(--muted)" }}
                  dataKey="value"
                  cornerRadius={6}
                />
              </RadialBarChart>
            </ResponsiveContainer>

            {/* Center label */}
            <div className="absolute inset-0 flex flex-col items-center justify-center translate-y-2">
              <span className="text-[8px] font-semibold text-muted-foreground text-center leading-tight w-[52px]">
                Total Support Requests
              </span>
              <span className="text-[22px] font-bold text-foreground leading-none mt-0.5">
                {combined}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-col gap-1.5 mt-1">
        {data.map((item, i) => (
          <div key={i} className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: item.fill }}
              />
              <span className="text-[10px] text-muted-foreground">
                {item.name}
              </span>
            </div>
            <span className="text-[10px] font-bold text-primary">
              {item.display}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}