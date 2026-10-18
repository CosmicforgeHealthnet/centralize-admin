"use client";

import { useEffect, useState, useRef } from "react";
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { useDashboardStore } from "@/stores/dashboard.store";
import type { RevenueChartItem } from "@/types/dashboard.types";

function downloadCSV(data: RevenueChartItem[], filename: string) {
  const headers = ["Month", "Appointments (₦)", "Membership (₦)", "Total (₦)"];
  const rows = data.map((m) => [
    m.month,
    m.Appointments,
    m.Membership,
    (parseFloat(m.Appointments) + parseFloat(m.Membership)).toFixed(2),
  ]);
  const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function RevenueTrackingSkeleton() {
  return (
    <div className="bg-card rounded-lg border border-border p-4 md:p-6 animate-pulse">
      <div className="flex items-start justify-between mb-6">
        <div className="flex flex-col gap-2">
          <div className="w-32 h-4 bg-muted rounded" />
          <div className="w-48 h-3 bg-muted rounded" />
        </div>
        <div className="w-28 h-7 bg-muted rounded" />
      </div>
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="w-full sm:w-[200px] md:w-[240px] flex flex-col gap-2">
          <div className="w-20 h-3 bg-muted rounded" />
          <div className="w-32 h-7 bg-muted rounded" />
          <div className="w-40 h-3 bg-muted rounded" />
          <div className="h-[90px] bg-muted rounded mt-2" />
        </div>
        <div className="flex-1 h-[200px] bg-muted rounded" />
      </div>
    </div>
  );
}

export default function RevenueTracking() {
  const { revenueChart, isLoadingRevenue, fetchRevenueChart } = useDashboardStore();
  const [showTooltip, setShowTooltip] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetchRevenueChart();
  }, [fetchRevenueChart]);

  const handlePressStart = () => {
    pressTimer.current = setTimeout(() => setShowTooltip(true), 500);
  };

  const handlePressEnd = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    setTimeout(() => setShowTooltip(false), 1000);
  };

  const handleDownload = () => {
    const filename = `revenue-report-${new Date().toISOString().split("T")[0]}.csv`;
    downloadCSV(revenueChart, filename);
  };

  if (isLoadingRevenue || !revenueChart.length) return <RevenueTrackingSkeleton />;

  // ── Totals ─────────────────────────────────────────────────────────────
  const totalRevenue = revenueChart.reduce(
    (sum, m) => sum + parseFloat(m.Appointments) + parseFloat(m.Membership),
    0
  );

  // ── Date range — correctly shows both years e.g. "May 2025 – Apr 2026" ─
  const firstMonth = revenueChart[0]?.month;
  const lastMonth = revenueChart[revenueChart.length - 1]?.month;
  const currentYear = new Date().getFullYear();
  const previousYear = currentYear - 1;

  // ── Area chart data ─────────────────────────────────────────────────────
  const areaData = revenueChart.map((m) => ({
    month: m.month,
    value: parseFloat(m.Appointments) + parseFloat(m.Membership),
  }));

  // ── Bar chart data (relative % for visual comparison) ──────────────────
  const maxBarValue = Math.max(
    ...revenueChart.flatMap((m) => [parseFloat(m.Appointments), parseFloat(m.Membership)]),
    1
  );

  const barData = revenueChart.map((m) => ({
    month: m.month,
    Appointments: Math.round((parseFloat(m.Appointments) / maxBarValue) * 100),
    Membership: Math.round((parseFloat(m.Membership) / maxBarValue) * 100),
  }));

  // ── Month-over-month change ─────────────────────────────────────────────
  const lastMonthTotal = areaData[areaData.length - 1]?.value ?? 0;
  const prevMonthTotal = areaData[areaData.length - 2]?.value ?? 0;
  const revenueChange =
    prevMonthTotal === 0
      ? 0
      : ((lastMonthTotal - prevMonthTotal) / prevMonthTotal) * 100;
  const revenuePositive = revenueChange >= 0;

  // ── Net figures ─────────────────────────────────────────────────────────
  // Net Revenue = 30% (company's share after paying doctors)
  // Net Profit  = 70% (doctors' share — what goes out)
  // NOTE: update these percentages to match your actual commission logic if needed
  const netRevenue = (totalRevenue * 0.3).toFixed(2);   // company keeps 30%
  const doctorsPayout = (totalRevenue * 0.7).toFixed(2); // paid out to doctors

  return (
    <div className="bg-card rounded-lg border border-border p-4 md:p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-4 md:mb-6">
        <div className="shrink-0 min-w-0">
          <h2 className="text-[14px] md:text-[16px] font-sans font-bold text-foreground">
            Revenue Tracking
          </h2>
          <p className="text-[11px] md:text-[12px] font-poppins text-muted-foreground">
            Revenue Performance and Report
          </p>
        </div>

        <div className="flex items-center gap-2 md:gap-3 shrink-0">
          <div className="hidden sm:flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-secondary inline-block" />
            <span className="text-[11px] md:text-[12px] font-poppins text-muted-foreground">
              Appointments
            </span>
          </div>
          <div className="hidden sm:flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-primary inline-block" />
            <span className="text-[11px] md:text-[12px] font-poppins text-muted-foreground">
              Membership
            </span>
          </div>

          {/* Desktop button */}
          <Button
            onClick={handleDownload}
            className="hidden sm:flex h-[28px] text-[11px] font-poppins gap-1 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 border-none px-3"
          >
            Download Report
          </Button>

          {/* Mobile button */}
          <div className="relative sm:hidden">
            <button
              onClick={handleDownload}
              onMouseDown={handlePressStart}
              onMouseUp={handlePressEnd}
              onTouchStart={handlePressStart}
              onTouchEnd={handlePressEnd}
              className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shrink-0"
            >
              <Download className="w-3.5 h-3.5 text-white" />
            </button>
            {showTooltip && (
              <div className="absolute right-0 top-10 z-50 bg-[#1A1C1E] text-white text-[10px] font-poppins px-3 py-1.5 rounded-[6px] whitespace-nowrap shadow-lg">
                Download Report
                <div className="absolute -top-1.5 right-2.5 w-3 h-3 bg-[#1A1C1E] rotate-45" />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-col sm:flex-row gap-4 md:gap-6">
        {/* Left: Total Revenue + Area Chart */}
        <div className="w-full sm:w-[200px] md:w-[240px] shrink-0">
          <p className="text-[11px] md:text-[12px] font-poppins text-muted-foreground">
            Total Revenue:
          </p>

          {/* ✅ Fixed: ₦ instead of $ */}
          <p className="text-[22px] md:text-[28px] font-sans font-bold text-foreground">
            ₦{totalRevenue.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>

          {/* ✅ Fixed: shows both years e.g. "May 2025 – Apr 2026" */}
          <p className="text-[10px] md:text-[11px] font-poppins text-muted-foreground mb-3">
            {firstMonth} {previousYear} – {lastMonth} {currentYear}
          </p>

          <ResponsiveContainer width="100%" height={90}>
            <AreaChart data={areaData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#272EA7" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#272EA7" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="value"
                stroke="#272EA7"
                fill="url(#revenueGrad)"
                strokeWidth={2}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>

          {/* Month-over-month change badge */}
          <div className="flex items-center gap-2 mt-2">
            <div
              className={`text-[11px] font-poppins font-semibold px-2 py-0.5 rounded-[4px] flex items-center gap-1 ${
                revenuePositive
                  ? "bg-success/10 text-success"
                  : "bg-destructive/10 text-destructive"
              }`}
            >
              {revenuePositive ? "▲" : "▼"} {Math.abs(revenueChange).toFixed(1)}%
            </div>
            <span className="text-[10px] font-poppins text-muted-foreground">
              vs last month
            </span>
          </div>

          {/* ✅ Fixed: correct labels and ₦ symbol */}
          <div className="flex justify-between mt-3">
            <div>
              <p className="text-[11px] md:text-[12px] font-poppins font-semibold text-primary">
                ● ₦{Number(netRevenue).toLocaleString("en-NG", { minimumFractionDigits: 2 })}
              </p>
              <p className="text-[10px] md:text-[11px] font-poppins text-muted-foreground">
                Net Revenue
              </p>
            </div>
            <div>
              <p className="text-[11px] md:text-[12px] font-poppins font-semibold text-destructive">
                ● ₦{Number(doctorsPayout).toLocaleString("en-NG", { minimumFractionDigits: 2 })}
              </p>
              <p className="text-[10px] md:text-[11px] font-poppins text-muted-foreground">
                Doctors Payout
              </p>
            </div>
          </div>
        </div>

        {/* Right: Bar Chart */}
        <div className="flex-1 min-w-0">
          <ResponsiveContainer
            width="100%"
            height={200}
            {...{ className: "md:!h-[230px] lg:!h-[250px]" }}
          >
            <BarChart
              data={barData}
              barSize={10}
              barGap={3}
              margin={{ top: 5, right: 5, left: -10, bottom: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--border)"
                vertical={false}
              />
              <XAxis
                dataKey="month"
                tick={{
                  fontSize: 10,
                  fontFamily: "Poppins",
                  fill: "var(--muted-foreground)",
                }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(v) => `${v}%`}
                ticks={[0, 25, 50, 75, 100]}
                domain={[0, 100]}
                tick={{
                  fontSize: 10,
                  fontFamily: "Poppins",
                  fill: "var(--muted-foreground)",
                }}
                axisLine={false}
                tickLine={false}
                width={32}
              />
              <Tooltip
                formatter={(value, name) => [`${value}% of peak`, name]}
                contentStyle={{
                  borderRadius: "8px",
                  border: "none",
                  fontSize: "12px",
                  fontFamily: "Poppins",
                  backgroundColor: "var(--primary)",
                  color: "var(--primary-foreground)",
                }}
                labelStyle={{
                  color: "var(--primary-foreground)",
                  fontWeight: 600,
                }}
                itemStyle={{ color: "var(--primary-foreground)" }}
              />
              <Bar
                dataKey="Appointments"
                fill="var(--secondary)"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="Membership"
                fill="var(--primary)"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}