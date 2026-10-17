"use client";

import { useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useHrmStore } from "@/stores/hrm.store";

const PERIOD_OPTIONS = ["Last Month", "Last Quarter", "This Year"];

// ─── Custom Tooltip ───────────────────────────────────────────────────────────

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md min-w-[140px]">
      <p className="font-poppins text-[11px] text-muted-foreground mb-1">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
            <span className="font-poppins text-[11px] text-foreground">{p.name}</span>
          </div>
          <span className="font-poppins text-[11px] font-semibold text-foreground">
            {p.value}%
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Custom Legend ────────────────────────────────────────────────────────────

function CustomLegend() {
  const lines = [
    { key: "marketing", label: "Marketing", color: "rgba(39,46,167,0.25)" },
    { key: "development", label: "Development", color: "#F64545" },
    { key: "socialMedia", label: "Social Media", color: "#272EA7" },
  ];

  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {lines.map((l) => (
        <div key={l.key} className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: l.color }} />
          <span className="font-poppins text-[11px] text-muted-foreground">{l.label}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function HRPerformanceChart() {
  const { performanceChart, isLoadingPerformanceChart, fetchPerformanceChart } = useHrmStore();

  useEffect(() => {
    fetchPerformanceChart();
  }, []);

  const data = performanceChart.length > 0 ? performanceChart : [];

  return (
    <div className="bg-card rounded-xl border border-border p-4 shadow-[0px_1px_2px_rgba(16,24,40,0.05)]">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">
            Employee Performance by Unit
          </h3>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <CustomLegend />
          <select className="text-[11px] font-poppins text-muted-foreground bg-muted border border-border rounded-lg px-2.5 py-1.5 outline-none cursor-pointer shrink-0">
            {PERIOD_OPTIONS.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Chart */}
      {isLoadingPerformanceChart ? (
        <div className="h-[260px] flex items-center justify-center">
          <span className="text-muted-foreground">Loading chart...</span>
        </div>
      ) : data.length > 0 ? (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
            <XAxis
              dataKey="month"
              tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<CustomTooltip />} />
            <Line
              type="monotone"
              dataKey="marketing"
              name="Marketing"
              stroke="rgba(39,46,167,0.25)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
            <Line
              type="monotone"
              dataKey="development"
              name="Development"
              stroke="#F64545"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
            <Line
              type="monotone"
              dataKey="socialMedia"
              name="Social Media"
              stroke="#272EA7"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-[260px] flex items-center justify-center">
          <span className="text-muted-foreground">No data available</span>
        </div>
      )}
    </div>
  );
}