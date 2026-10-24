"use client";

import { useEffect } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { useDashboardStore } from "@/stores/dashboard.store";
import ServiceDataState from "@/components/shared/ServiceDataState";

const RING_CONFIG = [
  { key: "newDoctors" as const,    label: "New Doctors",  color: "#f64545", inner: 78, outer: 88, start: 90  },
  { key: "newPatients" as const,   label: "New Patients", color: "#0da53f", inner: 63, outer: 73, start: 180 },
  { key: "appointments" as const,  label: "Appointments", color: "#272EA7", inner: 48, outer: 58, start: -45 },
];

function UserActivitySkeleton() {
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

export default function UserActivityChart() {
  const { overview, isLoadingOverview, overviewError, fetchOverview } = useDashboardStore();

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  if (overviewError && !isLoadingOverview) return <ServiceDataState title="HealthNet user activity unavailable" message={overviewError} retry={() => void fetchOverview()} />;
  if (isLoadingOverview || !overview) return <UserActivitySkeleton />;

  const { userActivity } = overview;

  const overall = userActivity.newPatients;

  const rings = RING_CONFIG.map((config) => ({
    ...config,
    value: userActivity[config.key].value as number,
    change: userActivity[config.key].change,
    positive: userActivity[config.key].positive,
  }));

  const maxValue = Math.max(...rings.map((r) => r.value), 1);
  const normalized = rings.map((r) => ({
    ...r,
    percentage: Math.min(Math.round((r.value / maxValue) * 100), 100),
  }));

  return (
    <div className="bg-card rounded-lg border border-border p-5 flex flex-col w-full">
      {/* Header */}
      <div className="mb-4">
        <h2 className="text-[15px] font-bold text-foreground">User Activity</h2>
        <div className="flex items-center gap-1 mt-1">
          <span className="text-[11px] text-muted-foreground font-medium">
            {overall.period}
          </span>
          <span
            className={`text-[11px] font-bold flex items-center ${
              overall.positive ? "text-success" : "text-destructive"
            }`}
          >
            {overall.positive ? "▲" : "▼"} {overall.change}%
          </span>
        </div>
      </div>

      {/* Multi-Ring Chart */}
      <div className="relative h-[200px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            {normalized.map((ring, index) => (
              <Pie
                key={index}
                data={[
                  { value: ring.percentage },
                  { value: 100 - ring.percentage },
                ]}
                cx="50%"
                cy="50%"
                innerRadius={`${ring.inner}%`}
                outerRadius={`${ring.outer}%`}
                startAngle={ring.start}
                endAngle={ring.start - 360}
                dataKey="value"
                stroke="none"
                cornerRadius={10}
              >
                <Cell fill={ring.color} />
                <Cell fill="var(--muted)" />
              </Pie>
            ))}
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <div className="flex flex-col gap-3 mt-4">
        {normalized.map((item) => (
          <div key={item.key} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: item.color }}
              />
              <span className="text-[13px] font-medium text-muted-foreground">
                {item.label}
              </span>
            </div>
            <span className="text-[13px] font-bold" style={{ color: item.color }}>
              {item.value.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}