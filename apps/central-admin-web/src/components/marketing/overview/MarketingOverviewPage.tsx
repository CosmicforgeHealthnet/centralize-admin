// src/components/marketing/overview/MarketingOverviewPage.tsx
"use client";

import { PlusCircle } from "lucide-react";
import MarketingStatCards from "./MarketingStatCards";
import ConversionFunnel from "./ConversionFunnel";
import PlatformIntegration from "./PlatformIntegration";
import QuickActions from "./QuickActions";
import AdsPerformanceCharts from "./AdsPerformanceCharts";
import { useMarketingStore } from "@/stores/marketing.store";
import { useEffect } from "react";

export default function MarketingOverviewPage() {
  const { error, clearError } = useMarketingStore();

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => clearError(), 5000);
      return () => clearTimeout(timer);
    }
  }, [error, clearError]);

  return (
    <div className="flex flex-col gap-5">
      {/* Error toast */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* Header row */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="font-poppins text-[14px] font-semibold text-foreground">Marketing — Dashboard</h2>
          <p className="font-poppins text-[12px] text-muted-foreground">
            Monitor your marketing performance and campaign metrics
          </p>
        </div>
        <button className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white text-[12px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors shrink-0 w-fit">
          <PlusCircle className="w-3.5 h-3.5" />
          New Campaign
        </button>
      </div>

      {/* Stat cards */}
      <MarketingStatCards />

      {/* Funnel / Platform / Quick Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ConversionFunnel />
        <PlatformIntegration />
        <QuickActions />
      </div>

      {/* Charts */}
      <AdsPerformanceCharts />
    </div>
  );
}