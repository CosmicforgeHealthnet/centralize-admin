// src/components/marketing/social-media/EngagementChart.tsx
"use client";

import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell,
} from "recharts";
import { useMarketingStore } from "@/stores/marketing.store";
import { Skeleton } from "@/components/ui/skeleton";
import { useEffect } from "react";

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md">
      <p className="font-poppins text-[11px] text-muted-foreground mb-0.5">{label}</p>
      <p className="font-poppins text-[13px] font-semibold text-foreground">{payload[0].value}%</p>
    </div>
  );
}

export default function EngagementChart() {
  const {
    analyticsWeeklyEngagement,
    isLoadingAnalytics,
    fetchAnalyticsWeeklyEngagement,
  } = useMarketingStore();

  useEffect(() => {
    if (!analyticsWeeklyEngagement) {
      fetchAnalyticsWeeklyEngagement();
    }
  }, [analyticsWeeklyEngagement, fetchAnalyticsWeeklyEngagement]);

  if (isLoadingAnalytics && !analyticsWeeklyEngagement) {
    return (
      <div className="bg-card rounded-xl border border-border p-4 h-full flex flex-col">
        <Skeleton className="h-5 w-32 mb-3" />
        <Skeleton className="h-[200px] w-full" />
      </div>
    );
  }

  const data = analyticsWeeklyEngagement?.data || [];
  const maxValue = data.length > 0 ? Math.max(...data.map(d => d.value)) : 100;

  // Find the peak day
  const peakIndex = data.length > 0 ? data.indexOf(data.reduce((a, b) => a.value > b.value ? a : b)) : -1;

  return (
    <div className="bg-card rounded-xl border border-border p-4 h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-poppins text-[13px] font-semibold text-foreground">This Week's Engagement</h3>
        {analyticsWeeklyEngagement?.change && (
          <span className="font-poppins text-[12px] font-semibold text-green-500">+{analyticsWeeklyEngagement.change}</span>
        )}
      </div>
      {data.length === 0 ? (
        <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
          No engagement data available
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} barSize={18} margin={{ top: 10, right: 4, left: -30, bottom: 0 }}>
            <XAxis dataKey="day" tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
            <YAxis hide />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(39,46,167,0.04)" }} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {data.map((d: any, i: number) => (
                <Cell key={i} fill={i === peakIndex ? "#272EA7" : "rgba(39,46,167,0.18)"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}