// src/components/marketing/overview/ConversionFunnel.tsx
"use client";

import { useMarketingStore } from "@/stores/marketing.store";
import { Skeleton } from "@/components/ui/skeleton";
import { useEffect } from "react";

export default function ConversionFunnel() {
  const {
    analyticsConversionFunnel,
    isLoadingAnalytics,
    fetchAnalyticsConversionFunnel,
  } = useMarketingStore();

  useEffect(() => {
    if (!analyticsConversionFunnel) {
      fetchAnalyticsConversionFunnel();
    }
  }, [analyticsConversionFunnel, fetchAnalyticsConversionFunnel]);

  if (isLoadingAnalytics && !analyticsConversionFunnel) {
    return (
      <div className="bg-card rounded-xl border border-border p-4 shadow-[0px_1px_2px_rgba(16,24,40,0.05)] flex flex-col gap-4 h-full">
        <Skeleton className="h-5 w-32" />
        <div className="flex flex-col gap-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </div>
    );
  }

  const funnelData = analyticsConversionFunnel;
  const steps = funnelData
    ? [
        { label: "Leads", users: funnelData.leads.users, percent: funnelData.leads.percent, color: "#272EA7" },
        { label: "Nurture", users: funnelData.nurture.users, percent: funnelData.nurture.percent, color: "#EC4899" },
        { label: "Conversion", users: funnelData.conversion.users, percent: funnelData.conversion.percent, color: "#0DA53F" },
      ]
    : [];

  return (
    <div className="bg-card rounded-xl border border-border p-4 shadow-[0px_1px_2px_rgba(16,24,40,0.05)] flex flex-col gap-4 h-full">
      <h3 className="font-poppins text-[13px] font-semibold text-foreground">Conversion Funnel</h3>

      {steps.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          No data available
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {steps.map((step) => (
            <div key={step.label} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="font-poppins text-[12px] text-foreground">{step.label}</span>
                <span className="font-poppins text-[11px] text-muted-foreground">
                  {step.users.toLocaleString()} Users
                </span>
              </div>
              <div className="relative w-full h-6 bg-muted rounded-md overflow-hidden">
                <div
                  className="h-full rounded-md flex items-center justify-center transition-all"
                  style={{ width: `${step.percent}%`, backgroundColor: step.color }}
                >
                  <span className="font-poppins text-[10px] font-semibold text-white">{step.percent}%</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}