"use client";

import { useEffect } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { useSupportStore } from "@/stores/support.store";

const COLORS = {
  account:   "#272EA7",
  dispute:   "#e8b600",
  insurance: "#f64545",
  report:    "#5E64FF",
};

const RADIAN = Math.PI / 180;

const renderCustomizedLabel = ({
  cx, cy, midAngle, outerRadius, name, value,
}: any) => {
  if (value === 0) return null;
  const radius = outerRadius + 18;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);

  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={7}
      fontWeight="600"
      fill="var(--foreground)"
    >
      <tspan x={x} dy="-0.4em">{name}</tspan>
      <tspan x={x} dy="1.2em">{value}%</tspan>
    </text>
  );
};

export default function TicketTypeChart() {
  const { stats, fetchStats, isLoadingStats } = useSupportStore();

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const total = stats
    ? stats.byType.account.total +
      stats.byType.dispute.total +
      stats.byType.insurance.total +
      stats.byType.report.total
    : 0;

  const toPercent = (val: number) =>
    total === 0 ? 0 : Math.round((val / total) * 100);

  const data = stats
    ? [
        { name: "Account",   value: toPercent(stats.byType.account.total),   color: COLORS.account   },
        { name: "Dispute",   value: toPercent(stats.byType.dispute.total),   color: COLORS.dispute   },
        { name: "Insurance", value: toPercent(stats.byType.insurance.total), color: COLORS.insurance },
        { name: "Report",    value: toPercent(stats.byType.report.total),    color: COLORS.report    },
      ].filter((d) => d.value > 0)
    : [];

  return (
    <div className="bg-card rounded-lg border border-border p-4">
      <div className="mb-1">
        <h2 className="text-[14px] font-bold text-foreground">Ticket Type</h2>
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-muted-foreground">This Month</span>
          <span className="text-[11px] font-semibold text-destructive">▼ 5%</span>
        </div>
      </div>

      <div className="w-full h-[160px]">
        {isLoadingStats || !stats ? (
          <div className="w-full h-full flex items-center justify-center">
            <div className="w-24 h-24 rounded-full bg-muted animate-pulse" />
          </div>
        ) : total === 0 ? (
          <div className="w-full h-full flex items-center justify-center">
            <p className="text-[12px] text-muted-foreground">No ticket data</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart margin={{ top: 20, right: 30, bottom: 20, left: 30 }}>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                outerRadius={52}
                dataKey="value"
                strokeWidth={2}
                stroke="var(--card)"
                labelLine={false}
                label={renderCustomizedLabel}
              >
                {data.map((entry, index) => (
                  <Cell key={index} fill={entry.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}