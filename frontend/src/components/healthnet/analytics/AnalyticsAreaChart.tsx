"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { useHealthnetStore } from "@/stores/healthnet.store";

const YEARS = ["2026","2025", "2024"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

export type AreaChartVariant = "sales" | "delivery" | "billing";

const STATIC_CONFIGS = {
  sales: {
    title: "Sales Analytics",
    subtitle: "Keep Track of Sales",
    legendLabel: "Sales progression",
    color: "#818CF8",
    gradientId: "salesGrad",
    filterType: "year" as const,
    yFormatter: (v: number) => `${v / 1000}K`,
    yTicks: [0, 1000, 2000, 3000, 4000, 5000],
    yDomain: [0, 5000] as [number, number],
  },
  delivery: {
    title: "Delivery Overview",
    subtitle: "Keep Track of Delivery",
    legendLabel: "Delivery",
    color: "#F472B6",
    gradientId: "deliveryGrad",
    filterType: "year" as const,
    yFormatter: (v: number) => `${v / 1000}K`,
    yTicks: [0, 1000, 2000, 3000, 4000, 5000],
    yDomain: [0, 5000] as [number, number],
  },
  billing: {
    title: "Billing & Memberships",
    subtitle: "Tracking Billing Performance and Membership progress",
    legendLabel: "Billing",
    color: "#22C55E",
    gradientId: "billingGrad",
    filterType: "month" as const,
    yFormatter: (v: number) => `${v}%`,
    yTicks: [0, 25, 50, 75, 100],
    yDomain: [0, 100] as [number, number],
  },
};

const CustomTooltip = ({
  active, payload, label, legendLabel, color,
}: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
  legendLabel: string;
  color: string;
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-[8px] shadow-[0_4px_16px_rgba(0,0,0,0.10)] dark:shadow-[0_4px_16px_rgba(0,0,0,0.3)] px-3 py-2 text-[12px] font-poppins">
      <p className="font-semibold text-foreground mb-1">{label}</p>
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
        <span className="text-muted-foreground">{legendLabel}:</span>
        <span className="font-semibold text-foreground">{payload[0].value}</span>
      </div>
    </div>
  );
};

export default function AnalyticsAreaChart({ variant }: { variant: AreaChartVariant }) {
  const cfg = STATIC_CONFIGS[variant];
  const filterOptions = cfg.filterType === "year" ? YEARS : MONTHS;
  const defaultFilter = cfg.filterType === "year" ? "2024" : "March";
  const [filter, setFilter] = useState(defaultFilter);
  const [open, setOpen] = useState(false);

  const {
    analyticsSalesAnalytics, analyticsSalesAnalyticsLoading, fetchAnalyticsSalesAnalytics,
    analyticsDeliveryOverview, analyticsDeliveryOverviewLoading, fetchAnalyticsDeliveryOverview,
    analyticsBillingMemberships, analyticsBillingMembershipsLoading, fetchAnalyticsBillingMemberships,
  } = useHealthnetStore();

  useEffect(() => {
    if (variant === "sales") fetchAnalyticsSalesAnalytics({ year: Number(filter) });
    if (variant === "delivery") fetchAnalyticsDeliveryOverview({ year: Number(filter) });
    if (variant === "billing") fetchAnalyticsBillingMemberships({ month: filter });
  }, [filter, variant]);

  const loading =
    variant === "sales" ? analyticsSalesAnalyticsLoading :
    variant === "delivery" ? analyticsDeliveryOverviewLoading :
    analyticsBillingMembershipsLoading;

  const rawData =
    variant === "sales" ? analyticsSalesAnalytics?.months :
    variant === "delivery" ? analyticsDeliveryOverview?.months :
    analyticsBillingMemberships?.data;

  const chartData = rawData?.map((d) => ({
    month: d.month.slice(0, 3),
    value: d.value,
  })) ?? [];

  return (
    <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-5 sm:p-6">
      <div className="flex flex-col xs:flex-row xs:items-start justify-between gap-3 mb-5">
        <div>
          <h2 className="text-[16px] font-poppins font-bold text-foreground">{cfg.title}</h2>
          <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">{cfg.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 mr-1">
            <span className="w-3 h-3 rounded-sm" style={{ background: cfg.color }} />
            <span className="text-[11px] font-poppins text-muted-foreground">{cfg.legendLabel}</span>
          </div>
          <div className="relative">
            <button
              onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-card border border-border rounded-[8px] text-[11px] font-poppins text-foreground shadow-[0_1px_4px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_4px_rgba(0,0,0,0.2)] hover:border-primary/40 transition-colors"
            >
              {filter}
              <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
            {open && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 bg-card border border-border rounded-[8px] shadow-[0_4px_16px_rgba(0,0,0,0.10)] dark:shadow-[0_4px_16px_rgba(0,0,0,0.3)] overflow-hidden min-w-[100px] max-h-[200px] overflow-y-auto">
                  {filterOptions.map((opt) => (
                    <button 
                      key={opt} 
                      onClick={() => { setFilter(opt); setOpen(false); }}
                      className={`w-full text-left px-3.5 py-2 text-[11px] font-poppins transition-colors ${
                        filter === opt 
                          ? "bg-primary/8 text-primary font-semibold" 
                          : "text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="w-full h-[200px] sm:h-[230px] bg-muted animate-pulse rounded-[8px]" />
      ) : (
        <div className="w-full h-[200px] sm:h-[230px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id={cfg.gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={cfg.color} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={cfg.color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.5} />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 11, fontFamily: "Poppins, sans-serif", fill: "var(--muted-foreground)" }}
                axisLine={false} tickLine={false}
              />
              <YAxis
                tickFormatter={cfg.yFormatter}
                tick={{ fontSize: 11, fontFamily: "Poppins, sans-serif", fill: "var(--muted-foreground)" }}
                axisLine={false} tickLine={false}
                domain={cfg.yDomain}
                ticks={cfg.yTicks}
              />
              <Tooltip
                content={<CustomTooltip legendLabel={cfg.legendLabel} color={cfg.color} />}
                cursor={{ stroke: cfg.color, strokeWidth: 1, strokeDasharray: "4 4" }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={cfg.color}
                strokeWidth={2}
                fill={`url(#${cfg.gradientId})`}
                dot={false}
                activeDot={{ r: 4, fill: cfg.color, stroke: "var(--card)", strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}