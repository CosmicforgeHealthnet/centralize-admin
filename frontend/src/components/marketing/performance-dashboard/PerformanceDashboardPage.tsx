// src/components/marketing/performance-dashboard/PerformanceDashboardPage.tsx
"use client";

import { useEffect } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import WorldMapDots from "../social-media/WorldMapDots";
import { useMarketingStore } from "@/stores/marketing.store";
import { Skeleton } from "@/components/ui/skeleton";

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md">
      <p className="font-poppins text-[11px] text-muted-foreground mb-1">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.color ?? p.fill }} />
          <span className="font-poppins text-[11px] text-foreground">{p.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

export default function PerformanceDashboardPage() {
  const {
    analyticsOverviewStats,
    analyticsSocialStats,
    analyticsAdsPerformance,
    analyticsLocation,
    analyticsAudienceBreakdown,
    analyticsWeeklyEngagement,
    analyticsConversionFunnel,
    analyticsPerformanceData,
    isLoadingAnalytics,
    error,
    fetchAllAnalytics,
    clearError,
  } = useMarketingStore();

  useEffect(() => {
    fetchAllAnalytics();
  }, [fetchAllAnalytics]);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => clearError(), 5000);
      return () => clearTimeout(timer);
    }
  }, [error, clearError]);

  if (isLoadingAnalytics && !analyticsSocialStats) {
    return (
      <div className="flex flex-col gap-5">
        <div>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-32 mt-1" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[100px] rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[80px] rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Skeleton className="h-[280px] rounded-xl" />
          <Skeleton className="h-[280px] rounded-xl" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
          <Skeleton className="h-[300px] rounded-xl" />
          <Skeleton className="h-[300px] rounded-xl" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
          <Skeleton className="h-[280px] rounded-xl" />
          <Skeleton className="h-[280px] rounded-xl" />
        </div>
        <Skeleton className="h-[300px] rounded-xl" />
      </div>
    );
  }

  const stats = analyticsSocialStats;
  const overviewStats = analyticsOverviewStats;
  const adsData = analyticsAdsPerformance;
  const locations = analyticsLocation || [];
  const audience = analyticsAudienceBreakdown;
  const weeklyEngagement = analyticsWeeklyEngagement;
  const funnel = analyticsConversionFunnel;
  const performance = analyticsPerformanceData;

  const barData = adsData?.byPlatform || [];
  const lineData = adsData?.monthlyTrend || [];
  const engagementData = weeklyEngagement?.data || [];
  const funnelSteps = funnel
    ? [
        { label: "Leads", users: funnel.leads.users, percent: funnel.leads.percent, color: "#272EA7" },
        { label: "Nurture", users: funnel.nurture.users, percent: funnel.nurture.percent, color: "#EC4899" },
        { label: "Conversion", users: funnel.conversion.users, percent: funnel.conversion.percent, color: "#0DA53F" },
      ]
    : [];

  const audienceBreakdown = audience?.breakdown || [];

  // Secondary stat cards now read live data from analyticsOverviewStats
  // instead of hardcoded placeholder values.
  const secondaryStats = overviewStats
    ? [
        { label: "Leads Capture", ...overviewStats.leadsCapture },
        { label: "Campaign ROI", ...overviewStats.campaignRoi },
        { label: "Click Through Rate", ...overviewStats.clickThroughRate },
        { label: "Cost Per Click", ...overviewStats.costPerClick },
        { label: "Impressions", ...overviewStats.impressions },
      ]
    : [];

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      <div>
        <h2 className="font-poppins text-[16px] font-semibold text-foreground">Performance Dashboard</h2>
        <p className="font-poppins text-[12px] text-muted-foreground mt-0.5">Auto-Updates in 2 minutes</p>
      </div>

      {/* Top stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {stats ? [
          { 
            label: "User Engagement", 
            value: stats.userEngagement.value, 
            change: stats.userEngagement.change, 
            sub: `+ ${stats.userEngagement.today || 0} today`, 
            up: stats.userEngagement.up 
          },
          { 
            label: "Traffic Sources", 
            value: stats.trafficSources.value, 
            change: stats.trafficSources.change, 
            sub: `+ ${stats.trafficSources.today || 0} today`, 
            up: stats.trafficSources.up 
          },
          { 
            label: "Audience Growth", 
            value: stats.audienceGrowth.value, 
            change: stats.audienceGrowth.change, 
            sub: `${stats.audienceGrowth.today || 0} today`, 
            up: stats.audienceGrowth.up 
          },
          { 
            label: "Content Performance", 
            value: stats.contentPerformance.value, 
            change: stats.contentPerformance.change, 
            sub: `+ ${stats.contentPerformance.today || 0} today`, 
            up: stats.contentPerformance.up 
          },
        ].map(({ label, value, change, sub, up }) => (
          <div key={label} className="bg-card rounded-xl border border-border p-4 flex flex-col gap-2">
            <span className="font-poppins text-[12px] text-muted-foreground">{label}</span>
            <span className="font-poppins text-[22px] font-bold text-foreground">
              {typeof value === 'number' ? value.toLocaleString() : value}
            </span>
            <div className="flex items-center gap-2">
              <span className={`font-poppins text-[10px] font-semibold px-2 py-0.5 rounded-full ${up ? "bg-green-500/10 text-green-500" : "bg-red-500/10 text-red-500"}`}>
                {up ? "↑" : "↓"} {change}
              </span>
              <span className="font-poppins text-[10px] text-muted-foreground">{sub}</span>
            </div>
          </div>
        )) : (
          <div className="col-span-4 text-center text-muted-foreground py-4">No stats available</div>
        )}
      </div>

      {/* Secondary stat cards — now driven by analyticsOverviewStats, not hardcoded */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {secondaryStats.length > 0 ? secondaryStats.map(({ label, value, change, up }) => (
          <div key={label} className="bg-card rounded-xl border border-border p-4 flex flex-col gap-1.5">
            <div className={`flex items-center gap-1 ${up ? "text-green-500" : "text-red-500"}`}>
              <span className="font-poppins text-[10px] font-semibold">{up ? "↑" : "↓"} {change}</span>
            </div>
            <span className="font-poppins text-[20px] font-bold text-foreground">
              {typeof value === 'number' ? value.toLocaleString() : value}
            </span>
            <span className="font-poppins text-[11px] text-muted-foreground">{label}</span>
          </div>
        )) : (
          <div className="col-span-5 text-center text-muted-foreground text-sm py-4">No stats available</div>
        )}
      </div>

      {/* Ads performance charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-card rounded-xl border border-border p-4">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground mb-3">Ads Performance By Platform</h3>
          {barData.length === 0 ? (
            <div className="h-[240px] flex items-center justify-center text-muted-foreground text-sm">
              No data available
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={barData} barGap={4} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
                <XAxis dataKey="platform" tick={{ fontFamily: "Poppins", fontSize: 9, fill: "#94a3b8" }} axisLine={false} tickLine={false} interval={0} />
                <YAxis tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(39,46,167,0.04)" }} />
                <Bar dataKey="spend" fill="#0DA53F" radius={[3, 3, 0, 0]} />
                <Bar dataKey="result" fill="#EC4899" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="bg-card rounded-xl border border-border p-4">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground mb-3">Monthly Performance Trend</h3>
          {lineData.length === 0 ? (
            <div className="h-[240px] flex items-center justify-center text-muted-foreground text-sm">
              No data available
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
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

      {/* Map + audience */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
        <div className="bg-card rounded-xl border border-border p-4">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground mb-4">Visit by Location</h3>
          <div className="flex flex-col md:flex-row gap-4 items-center">
            <div className="w-full md:w-[55%] shrink-0">
              <WorldMapDots />
            </div>
            <div className="flex flex-col gap-2.5 w-full">
              {locations.length === 0 ? (
                <div className="text-center text-muted-foreground text-sm py-4">No location data available</div>
              ) : (
                locations.map((loc) => (
                  <div key={loc.country} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px]">{loc.flag}</span>
                      <span className="font-poppins text-[12px] text-foreground">{loc.country}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-poppins text-[12px] font-semibold text-foreground">{loc.value.toLocaleString()}</span>
                      <span className={`font-poppins text-[10px] font-semibold ${loc.up ? "text-green-500" : "text-red-500"}`}>
                        {loc.up ? "↑" : "↓"} {loc.change}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-4">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">Social Media Audience</h3>
          <div>
            <span className="font-poppins text-[11px] text-muted-foreground">Total Audience</span>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="font-poppins text-[24px] font-bold text-foreground">
                {audience?.total?.toLocaleString() || "0"}
              </span>
              {audience?.change && (
                <span className="font-poppins text-[10px] font-semibold text-green-500 bg-green-500/10 px-2 py-0.5 rounded-full">
                  ↑ {audience.change}
                </span>
              )}
            </div>
          </div>
          {audienceBreakdown.length > 0 && (
            <>
              <div className="flex w-full h-2 rounded-full overflow-hidden">
                {audienceBreakdown.map((a: any) => (
                  <div key={a.platform} style={{ backgroundColor: a.color || "#3B82F6", flex: 1 }} />
                ))}
              </div>
              <div className="flex flex-col gap-2.5">
                {audienceBreakdown.map((a: any) => (
                  <div key={a.platform} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: a.color || "#3B82F6" }} />
                      <span className="font-poppins text-[12px] text-foreground">{a.platform}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-poppins text-[12px] font-semibold text-foreground">{a.value.toLocaleString()}</span>
                      <span className={`font-poppins text-[10px] font-semibold ${a.up ? "text-green-500" : "text-red-500"}`}>
                        {a.up ? "↑" : "↓"} {a.change}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {audienceBreakdown.length === 0 && (
            <div className="text-center text-muted-foreground text-sm py-4">No audience data available</div>
          )}
        </div>
      </div>

      {/* Engagement + conversion funnel */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
        <div className="bg-card rounded-xl border border-border p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-poppins text-[13px] font-semibold text-foreground">This Week&apos;s Engagement</h3>
            {weeklyEngagement?.change && (
              <span className="font-poppins text-[12px] font-semibold text-green-500">+{weeklyEngagement.change}</span>
            )}
          </div>
          {engagementData.length === 0 ? (
            <div className="h-[220px] flex items-center justify-center text-muted-foreground text-sm">
              No engagement data available
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={engagementData} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}>
                <XAxis dataKey="day" tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: "rgba(39,46,167,0.15)" }} />
                <Line type="monotone" dataKey="value" stroke="#272EA7" strokeWidth={2} dot={{ r: 4, fill: "#272EA7" }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-4">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">Conversion Funnel</h3>
          {funnelSteps.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              No funnel data available
            </div>
          ) : (
            funnelSteps.map((step) => (
              <div key={step.label} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-poppins text-[12px] text-foreground">{step.label}</span>
                  <span className="font-poppins text-[11px] text-muted-foreground">{step.users.toLocaleString()} Users</span>
                </div>
                <div className="relative w-full h-6 bg-muted rounded-md overflow-hidden">
                  <div
                    className="h-full rounded-md flex items-center justify-center"
                    style={{ width: `${step.percent}%`, backgroundColor: step.color }}
                  >
                    <span className="font-poppins text-[10px] font-semibold text-white">{step.percent}%</span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Performance Data */}
      <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-4">
        <h3 className="font-poppins text-[14px] font-semibold text-foreground">Performance Data</h3>
        <div>
          <span className="font-poppins text-[11px] text-muted-foreground">Total Views</span>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="font-poppins text-[26px] font-bold text-foreground">
              {performance?.totalViews?.toLocaleString() || "0"}
            </span>
            {performance?.change && (
              <span className="font-poppins text-[10px] font-semibold text-green-500 bg-green-500/10 px-2 py-0.5 rounded-full">
                ↑ {performance.change}
              </span>
            )}
          </div>
        </div>

        <div className="flex w-full h-2 rounded-full overflow-hidden">
          <div style={{ backgroundColor: "#10B981", flex: 2 }} />
          <div style={{ backgroundColor: "#EF4444", flex: 1.5 }} />
          <div style={{ backgroundColor: "#3B82F6", flex: 1.2 }} />
        </div>

        <div className="flex items-center gap-4 flex-wrap">
          {[
            { label: "likes", color: "#10B981" },
            { label: "Reposts", color: "#EF4444" },
            { label: "Comments", color: "#3B82F6" },
          ].map((l) => (
            <div key={l.label} className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: l.color }} />
              <span className="font-poppins text-[11px] text-muted-foreground">{l.label}</span>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2">
          {performance ? [
            { label: "Likes", value: performance.likes.value, change: performance.likes.change, up: performance.likes.up },
            { label: "Reposts", value: performance.reposts.value, change: performance.reposts.change, up: performance.reposts.up },
            { label: "Comments", value: performance.comments.value, change: performance.comments.change, up: performance.comments.up },
          ].map((row) => (
            <div key={row.label} className="flex items-center justify-between">
              <span className="font-poppins text-[12px] text-foreground">{row.label}</span>
              <div className="flex items-center gap-2">
                <span className="font-poppins text-[12px] font-semibold text-foreground">
                  {typeof row.value === 'number' ? row.value.toLocaleString() : row.value}
                </span>
                <span className={`font-poppins text-[10px] font-semibold ${row.up ? "text-green-500" : "text-red-500"}`}>
                  {row.up ? "↑" : "↓"} {row.change}
                </span>
              </div>
            </div>
          )) : (
            <div className="text-center text-muted-foreground text-sm py-4">No performance data available</div>
          )}
        </div>
      </div>
    </div>
  );
}