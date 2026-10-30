// src/components/marketing/overview/MarketingStatCards.tsx
"use client";

import { Users, DollarSign, MousePointerClick, CreditCard, Eye, TrendingUp, TrendingDown } from "lucide-react";
import { useMarketingStore } from "@/stores/marketing.store";
import { Skeleton } from "@/components/ui/skeleton";
import { useEffect } from "react";

const STAT_ICONS = {
  leadsCapture: Users,
  campaignRoi: DollarSign,
  clickThroughRate: MousePointerClick,
  costPerClick: CreditCard,
  impressions: Eye,
} as const;

export default function MarketingStatCards() {
  const {
    analyticsOverviewStats,
    isLoadingAnalytics,
    fetchAnalyticsOverviewStats,
  } = useMarketingStore();

  useEffect(() => {
    if (!analyticsOverviewStats) {
      fetchAnalyticsOverviewStats();
    }
  }, [analyticsOverviewStats, fetchAnalyticsOverviewStats]);

  if (isLoadingAnalytics && !analyticsOverviewStats) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[100px] rounded-xl" />
        ))}
      </div>
    );
  }

  const stats = analyticsOverviewStats;
  const statEntries = stats
    ? [
        { key: "leadsCapture", label: "Leads Capture", value: stats.leadsCapture.value, change: stats.leadsCapture.change, trendUp: stats.leadsCapture.up },
        { key: "campaignRoi", label: "Campaign ROI", value: stats.campaignRoi.value, change: stats.campaignRoi.change, trendUp: stats.campaignRoi.up },
        { key: "clickThroughRate", label: "Click Through Rate", value: stats.clickThroughRate.value, change: stats.clickThroughRate.change, trendUp: stats.clickThroughRate.up },
        { key: "costPerClick", label: "Cost Per Click", value: stats.costPerClick.value, change: stats.costPerClick.change, trendUp: stats.costPerClick.up },
        { key: "impressions", label: "Impressions", value: stats.impressions.value, change: stats.impressions.change, trendUp: stats.impressions.up },
      ]
    : [];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
      {statEntries.map(({ key, label, value, change, trendUp }) => {
        const Icon = STAT_ICONS[key as keyof typeof STAT_ICONS];
        return (
          <div
            key={label}
            className="bg-card rounded-xl border border-border p-4 shadow-[0px_1px_2px_rgba(16,24,40,0.05)] flex flex-col gap-1.5"
          >
            <div className="flex items-center justify-between">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Icon className="w-4 h-4 text-primary" />
              </div>
              <div className={`flex items-center gap-1 ${trendUp ? "text-green-500" : "text-red-500"}`}>
                {trendUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                <span className="font-poppins text-[10px] font-semibold">{change}</span>
              </div>
            </div>
            <span className="font-poppins text-[22px] font-bold text-foreground leading-none mt-1">
              {typeof value === 'number' ? value.toLocaleString() : value}
            </span>
            <span className="font-poppins text-[11px] text-muted-foreground leading-tight">{label}</span>
          </div>
        );
      })}
    </div>
  );
}