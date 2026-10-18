"use client";

import { useState, useEffect } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { useHealthnetStore } from "@/stores/healthnet.store";

const CustomTooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-[8px] shadow-[0_4px_16px_rgba(0,0,0,0.10)] dark:shadow-[0_4px_16px_rgba(0,0,0,0.3)] px-3 py-2 text-[12px]">
      <p className="font-semibold text-foreground mb-1">{label}</p>
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: "#C0392B" }} />
        <span className="text-muted-foreground">Patients:</span>
        <span className="font-semibold text-foreground">{payload[0].value}%</span>
      </div>
    </div>
  );
};

export default function AnalyticsPatientsStatChart() {
  const {
    analyticsPatientsStatistics,
    analyticsPatientsStatisticsLoading,
    fetchAnalyticsPatientsStatistics,
  } = useHealthnetStore();

  // Fetch data when component mounts
  useEffect(() => {
    fetchAnalyticsPatientsStatistics({});
  }, [fetchAnalyticsPatientsStatistics]);

  // Transform store data into chart format
  const chartData = analyticsPatientsStatistics?.data?.map((item) => ({
    month: item.month,
    value: item.value,
  })) ?? [];

  return (
    <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-5 flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-foreground tracking-tight">
          Patients Statistics
        </h3>
      </div>

      {/* Chart */}
      {analyticsPatientsStatisticsLoading ? (
        <div className="w-full h-[200px] bg-muted animate-pulse rounded-[8px]" />
      ) : (
        <div className="w-full h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              barCategoryGap="20%"
              margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
            >
              <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.5} strokeDasharray="0" />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(v) => `${v}%`}
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
              />
              <Tooltip
                content={<CustomTooltip />}
                cursor={{ fill: "rgba(192,57,43,0.06)" }}
              />
              <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill="#C0392B" />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}