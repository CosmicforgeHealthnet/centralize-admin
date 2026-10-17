// src/components/marketing/overview/AdsPerformanceCharts.tsx
"use client";
import type { AdminChartTooltipProps } from "@/types/chart-tooltip.types";

import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from "recharts";
import { useMarketingStore } from "@/stores/marketing.store";
import { Skeleton } from "@/components/ui/skeleton";
import { useEffect } from "react";

function ChartTooltip({ active, payload, label }: AdminChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md">
      <p className="font-poppins text-[11px] text-muted-foreground mb-1">{label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.color ?? p.fill }} />
          <span className="font-poppins text-[11px] text-foreground">{p.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

export default function AdsPerformanceCharts() {
  const {
    analyticsAdsPerformance,
    isLoadingAnalytics,
    fetchAnalyticsAdsPerformance,
  } = useMarketingStore();

  useEffect(() => {
    if (!analyticsAdsPerformance) {
      fetchAnalyticsAdsPerformance();
    }
  }, [analyticsAdsPerformance, fetchAnalyticsAdsPerformance]);

  const barData = analyticsAdsPerformance?.byPlatform || [];
  const lineData = analyticsAdsPerformance?.monthlyTrend || [];

  if (isLoadingAnalytics && !analyticsAdsPerformance) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Skeleton className="h-[320px] rounded-xl" />
        <Skeleton className="h-[320px] rounded-xl" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Bar chart */}
      <div className="bg-card rounded-xl border border-border p-4 shadow-[0px_1px_2px_rgba(16,24,40,0.05)]">
        <h3 className="font-poppins text-[13px] font-semibold text-foreground mb-3">
          Ads Performance By Platform
        </h3>
        {barData.length === 0 ? (
          <div className="h-[260px] flex items-center justify-center text-muted-foreground text-sm">
            No data available
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={barData} barGap={4} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
              <XAxis
                dataKey="platform"
                tick={{ fontFamily: "Poppins", fontSize: 9, fill: "#94a3b8" }}
                axisLine={false}
                tickLine={false}
                interval={0}
              />
              <YAxis tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(39,46,167,0.04)" }} />
              <Bar dataKey="spend" fill="#0DA53F" radius={[3, 3, 0, 0]} />
              <Bar dataKey="result" fill="#EC4899" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Line chart */}
      <div className="bg-card rounded-xl border border-border p-4 shadow-[0px_1px_2px_rgba(16,24,40,0.05)]">
        <h3 className="font-poppins text-[13px] font-semibold text-foreground mb-3">
          Monthly Performance Trend
        </h3>
        {lineData.length === 0 ? (
          <div className="h-[260px] flex items-center justify-center text-muted-foreground text-sm">
            No data available
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={lineData} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: "rgba(39,46,167,0.15)" }} />
              <Line type="monotone" dataKey="value" stroke="#0DA53F" strokeWidth={2.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}