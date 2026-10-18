"use client";
import type { AdminChartTooltipProps } from "@/types/chart-tooltip.types";

import React, { useEffect } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from "recharts";
import { Download } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";

const CustomTooltip = ({ active, payload, label }: AdminChartTooltipProps) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md">
        <p className="text-[12px] font-poppins font-semibold text-foreground mb-1">{label}</p>
        {payload.map((p) => (
          <div key={p.dataKey} className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.fill }} />
            <span className="text-[11px] font-poppins text-muted-foreground capitalize">
              {p.dataKey === "incomeUsd" ? "Income (USD)" : "Expense (USD)"}:
            </span>
            <span className="text-[11px] font-poppins font-bold" style={{ color: p.fill }}>
              ${p.value.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    );
  }
  return null;
};

function SkeletonCard() {
  return (
    <div className="bg-card rounded-lg border border-border p-5 flex flex-col gap-3 animate-pulse">
      <div className="w-36 h-4 bg-muted rounded" />
      <div className="w-48 h-3 bg-muted rounded" />
      <div className="h-[260px] bg-muted rounded mt-2" />
    </div>
  );
}

export default function HealthnetRevenueTracking() {
  const { revenueChart, revenueChartLoading, fetchRevenueChart } = useHealthnetStore();

  useEffect(() => {
    fetchRevenueChart();
  }, [fetchRevenueChart]);

  if (revenueChartLoading || !revenueChart) {
    return <SkeletonCard />;
  }

  // Use USD figures for the chart; format month labels from the data
  const chartData = revenueChart.data.map((d) => ({
    month: d.month,
    incomeUsd: d.incomeUsd,
    expenseUsd: d.expenseUsd,
  }));

  const handleDownload = () => {
    const csv = [
      ["Month", "Income (USD)", "Income (NGN)", "Expense (USD)", "Expense (NGN)"],
      ...revenueChart.data.map((d) => [
        d.month, d.incomeUsd, d.incomeNgn, d.expenseUsd, d.expenseNgn,
      ]),
    ]
      .map((row) => row.join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "healthnet-revenue.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="bg-card rounded-lg border border-border p-5 flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-[17px] font-poppins font-bold text-foreground">
            Revenue Tracking
          </h2>
          <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">
            Revenue Performance and Report
          </p>
        </div>
        <button
          onClick={handleDownload}
          className="flex items-center gap-2 px-3 py-1.5 rounded-[8px] border border-border bg-card text-[12px] font-poppins text-foreground hover:bg-muted transition-colors"
        >
          <Download className="w-3.5 h-3.5 text-muted-foreground" />
          Download Report
        </button>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-primary" />
          <span className="text-[12px] font-poppins text-muted-foreground">Income (USD)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-success" />
          <span className="text-[12px] font-poppins text-muted-foreground">Expense (USD)</span>
        </div>
      </div>

      {/* Chart */}
      <div className="h-[260px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
            barSize={12}
            barGap={3}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="month"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fontFamily: "Poppins", fill: "var(--muted-foreground)" }}
            />
            <YAxis
              tickFormatter={(v) => `$${v}`}
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fontFamily: "Poppins", fill: "var(--muted-foreground)" }}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: "var(--muted)", radius: 4 }} />
            <Bar dataKey="incomeUsd"  fill="#272EA7" radius={[4, 4, 0, 0]} />
            <Bar dataKey="expenseUsd" fill="#0DA53F" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}