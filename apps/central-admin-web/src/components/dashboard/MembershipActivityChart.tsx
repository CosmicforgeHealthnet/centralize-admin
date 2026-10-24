"use client";

import { useEffect } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { useDashboardStore } from "@/stores/dashboard.store";
import ServiceDataState from "@/components/shared/ServiceDataState";

const MEMBERSHIP_CONFIG = [
  { key: "doctorPercentage" as const, countKey: "doctorCount" as const, name: "Doctors Membership", color: "#272EA7" },
  { key: "patientPercentage" as const, countKey: "patientCount" as const, name: "Patient Membership", color: "#0da53f" },
];

function MembershipSkeleton() {
  return (
    <div className="bg-card rounded-lg border border-border p-4 flex flex-col animate-pulse">
      <div className="w-32 h-4 bg-muted rounded mb-2" />
      <div className="w-20 h-3 bg-muted rounded mb-4" />
      <div className="h-[100px] bg-muted rounded" />
      <div className="flex flex-col gap-2 mt-4">
        <div className="w-full h-3 bg-muted rounded" />
        <div className="w-full h-3 bg-muted rounded" />
      </div>
    </div>
  );
}

export default function MembershipActivityChart() {
  const { overview, isLoadingOverview, overviewError, fetchOverview } = useDashboardStore();

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  if (overviewError && !isLoadingOverview) {
    return (
      <div className="bg-card rounded-lg border border-border p-4 flex flex-col">
        <div className="mb-2">
          <h2 className="text-[14px] font-sans font-bold text-foreground">Membership Activity</h2>
          <p className="text-[11px] font-poppins text-muted-foreground mt-1">Total members: —</p>
        </div>
        <ServiceDataState embedded compact title="Membership data unavailable" message={overviewError}
          retry={() => void fetchOverview()} />
        <div className="flex flex-col gap-1 mt-3">
          {MEMBERSHIP_CONFIG.map((item) => (
            <div className="flex items-center justify-between" key={item.key}>
              <span className="text-[11px] font-poppins text-muted-foreground">{item.name}</span>
              <span className="text-[11px] text-muted-foreground">—</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4 mt-3">
          <span className="text-[11px] text-muted-foreground">Doctors</span>
          <span className="text-[11px] text-muted-foreground">Patients</span>
        </div>
      </div>
    );
  }
  if (isLoadingOverview || !overview) return <MembershipSkeleton />;

  const { membershipActivity } = overview;

  const chartData = MEMBERSHIP_CONFIG.map((config) => ({
    name: config.name,
    value: parseFloat(membershipActivity[config.key]),
    color: config.color,
  }));

  const totalFormatted = membershipActivity.total >= 1000
    ? `${(membershipActivity.total / 1000).toFixed(1)}k`
    : membershipActivity.total.toString();

  return (
    <div className="bg-card rounded-lg border border-border p-4 flex flex-col">
      {/* Header */}
      <div className="mb-2">
        <h2 className="text-[14px] font-sans font-bold text-foreground">
          Membership Activity
        </h2>
        <div className="flex items-center gap-1">
          <span className="text-[11px] font-poppins text-muted-foreground">
            Total members
          </span>
          <span className="text-[11px] font-poppins font-semibold text-success">
            {membershipActivity.total.toLocaleString()}
          </span>
        </div>
      </div>

      {/* Semi-circle gauge */}
      <div className="relative flex justify-center items-end mt-2" style={{ height: 100 }}>
        <ResponsiveContainer width="100%" height={100}>
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="100%"
              startAngle={180}
              endAngle={0}
              innerRadius={55}
              outerRadius={75}
              paddingAngle={2}
              dataKey="value"
              strokeWidth={0}
            >
              {chartData.map((entry, index) => (
                <Cell key={index} fill={entry.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>

        {/* Center value */}
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 text-center pb-1">
          <p className="text-[22px] font-sans font-bold text-foreground leading-none">
            {totalFormatted}
          </p>
        </div>
      </div>

      {/* Stats below chart */}
      <div className="flex flex-col gap-1 mt-4">
        {MEMBERSHIP_CONFIG.map((config) => (
          <div key={config.key} className="flex items-center justify-between">
            <span className="text-[11px] font-poppins text-muted-foreground">
              {config.name}
            </span>
            <span
              className="text-[11px] font-poppins font-bold"
              style={{ color: config.color }}
            >
              {membershipActivity[config.key]}%
            </span>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-3">
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
          <span className="text-[11px] font-poppins text-muted-foreground">
            Doctors
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-success shrink-0" />
          <span className="text-[11px] font-poppins text-muted-foreground">
            Patients
          </span>
        </div>
      </div>
    </div>
  );
}