"use client";

import React, { useEffect, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { ChevronDown } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

const RING_CONFIG = [
  { key: "newDoctors" as const,      label: "New Doctors",      color: "#272EA7", inner: 78, outer: 88 },
  { key: "appointments" as const,    label: "Appointments",     color: "#0DA53F", inner: 63, outer: 73 },
  { key: "productPurchase" as const, label: "Product Purchase", color: "#F64545", inner: 48, outer: 58 },
];

function SkeletonCard() {
  return (
    <div className="bg-card rounded-lg border border-border p-5 flex flex-col w-full animate-pulse">
      <div className="w-28 h-4 bg-muted rounded mb-2" />
      <div className="w-20 h-3 bg-muted rounded mb-4" />
      <div className="h-[200px] bg-muted rounded" />
      <div className="flex flex-col gap-3 mt-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center justify-between">
            <div className="w-24 h-3 bg-muted rounded" />
            <div className="w-10 h-3 bg-muted rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AnalyticsDoctorsChart() {
  const [month, setMonth] = useState("January");
  const [open, setOpen] = useState(false);

  const { activityChart, activityChartLoading, fetchActivityChart } = useHealthnetStore();

  useEffect(() => {
    fetchActivityChart(month);
  }, [month, fetchActivityChart]);

  if (activityChartLoading || !activityChart) return <SkeletonCard />;

  const raw = {
    newDoctors:      activityChart.newDoctors,
    appointments:    activityChart.appointments,
    productPurchase: activityChart.productPurchase,
  };

  // Rings are purely visual — relative fill so chart isn't all empty or all full
  const maxVal = Math.max(...Object.values(raw), 1);
  const ringFill = (n: number) => Math.max(Math.round((n / maxVal) * 100), n > 0 ? 8 : 0);

  return (
    <div className="bg-card rounded-lg border border-border p-5 flex flex-col w-full">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-4">
        <div>
          <h2 className="text-[15px] font-bold text-foreground font-poppins">Doctors Activity Overview</h2>
          <p className="text-[11px] text-muted-foreground font-medium mt-0.5 font-poppins">
            Total Doctors:{" "}
            <span className="text-primary font-semibold">
              {activityChart.totalDoctors.toLocaleString()}
            </span>
          </p>
        </div>

        {/* Month dropdown */}
        <div className="relative">
          <button
            onClick={() => setOpen((p) => !p)}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-[6px] border border-border bg-card text-[12px] font-poppins text-foreground hover:bg-muted transition-colors"
          >
            {month}
            <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
          </button>
          {open && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
              <div className="absolute top-full right-0 mt-1 z-20 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[120px] max-h-[200px] overflow-y-auto">
                {MONTHS.map((m) => (
                  <button
                    key={m}
                    onClick={() => { setMonth(m); setOpen(false); }}
                    className={`w-full text-left px-3 py-1.5 text-[12px] font-poppins transition-colors hover:bg-muted ${
                      m === month ? "text-primary font-semibold" : "text-muted-foreground"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Multi-Ring Chart */}
      <div className="relative h-[200px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            {RING_CONFIG.map((ring) => {
              const fill = ringFill(raw[ring.key]);
              return (
                <Pie
                  key={ring.key}
                  data={[{ value: fill }, { value: 100 - fill }]}
                  cx="50%"
                  cy="50%"
                  innerRadius={`${ring.inner}%`}
                  outerRadius={`${ring.outer}%`}
                  startAngle={90}
                  endAngle={-270}
                  dataKey="value"
                  stroke="none"
                  cornerRadius={8}
                >
                  <Cell fill={ring.color} />
                  <Cell fill="var(--muted)" />
                </Pie>
              );
            })}
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Legend — real counts, not percentages */}
      <div className="flex flex-col gap-3 mt-4">
        {RING_CONFIG.map((ring) => (
          <div key={ring.key} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: ring.color }} />
              <span className="text-[13px] font-medium text-muted-foreground font-poppins">
                {ring.label}
              </span>
            </div>
            <span className="text-[13px] font-bold font-poppins" style={{ color: ring.color }}>
              {raw[ring.key].toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}