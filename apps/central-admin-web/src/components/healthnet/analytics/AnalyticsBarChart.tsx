"use client";

import { useEffect, useState } from "react";
import { Download, ChevronDown } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { useHealthnetStore } from "@/stores/healthnet.store";

const YEARS = ["2026","2025", "2024"];

interface AnalyticsBarChartProps {
  title: string;
  subtitle: string;
  variant: "dual" | "single";
  primaryLabel?: string;
  secondaryLabel?: string;
  primaryColor?: string;
  secondaryColor?: string;
}

const CustomTooltip = ({
  active, payload, label, primaryLabel, secondaryLabel,
}: {
  active?: boolean;
  payload?: { value: number; color: string }[];
  label?: string;
  primaryLabel: string;
  secondaryLabel?: string;
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-[10px] shadow-[0_4px_20px_rgba(0,0,0,0.10)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.3)] px-3.5 py-2.5 text-[12px] font-poppins">
      <p className="font-semibold text-foreground mb-1.5">{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: p.color }} />
          <span className="text-muted-foreground">{i === 0 ? primaryLabel : secondaryLabel}:</span>
          <span className="font-semibold text-foreground">{p.value}</span>
        </div>
      ))}
    </div>
  );
};

export default function AnalyticsBarChart({
  title,
  subtitle,
  variant,
  primaryLabel = "Appointments",
  secondaryLabel = "Sales",
  primaryColor = "#272EA7",
  secondaryColor = "#22C55E",
}: AnalyticsBarChartProps) {
  const [year, setYear] = useState("2024");
  const [open, setOpen] = useState(false);

  const {
    analyticsAppointmentsOverview, analyticsAppointmentsOverviewLoading, fetchAnalyticsAppointmentsOverview,
    analyticsRevenueTracking, analyticsRevenueTrackingLoading, fetchAnalyticsRevenueTracking,
  } = useHealthnetStore();

  useEffect(() => {
    fetchAnalyticsAppointmentsOverview({ year: Number(year) });
    if (variant === "dual") fetchAnalyticsRevenueTracking({ year: Number(year) });
  }, [year, variant]);

  const loading = analyticsAppointmentsOverviewLoading || (variant === "dual" && analyticsRevenueTrackingLoading);

  const chartData = analyticsAppointmentsOverview?.data?.months?.map((m) => {
    const salesMonth = analyticsRevenueTracking?.data?.months?.find((s) => s.month === m.month);
    return {
      month: m.month.slice(0, 3),
      a: m.appointments,
      b: salesMonth ? salesMonth.appointments + salesMonth.sales : 0,
    };
  }) ?? [];

  return (
    <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-5 sm:p-6">
      <div className="flex flex-col xs:flex-row xs:items-start justify-between gap-3 mb-5">
        <div>
          <h2 className="text-[16px] font-poppins font-bold text-foreground">{title}</h2>
          <p className="text-[12px] font-poppins text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm" style={{ background: primaryColor }} />
              <span className="text-[11px] font-poppins text-muted-foreground">{primaryLabel}</span>
            </div>
            {variant === "dual" && (
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm" style={{ background: secondaryColor }} />
                <span className="text-[11px] font-poppins text-muted-foreground">{secondaryLabel}</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                onClick={() => setOpen((o) => !o)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-card border border-border rounded-[8px] text-[11px] font-poppins text-foreground shadow-[0_1px_4px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_4px_rgba(0,0,0,0.2)] hover:border-primary/40 transition-colors"
              >
                {year}
                <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
              </button>
              {open && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 z-20 bg-card border border-border rounded-[8px] shadow-[0_4px_16px_rgba(0,0,0,0.10)] dark:shadow-[0_4px_16px_rgba(0,0,0,0.3)] overflow-hidden min-w-[80px]">
                    {YEARS.map((y) => (
                      <button 
                        key={y} 
                        onClick={() => { setYear(y); setOpen(false); }}
                        className={`w-full text-left px-3.5 py-2 text-[11px] font-poppins transition-colors ${
                          year === y 
                            ? "bg-primary/8 text-primary font-semibold" 
                            : "text-muted-foreground hover:bg-muted/50"
                        }`}
                      >
                        {y}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button className="flex items-center gap-1.5 px-3 py-1.5 bg-card border border-border rounded-[8px] text-[11px] font-poppins text-foreground shadow-[0_1px_4px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_4px_rgba(0,0,0,0.2)] hover:border-primary/40 transition-colors">
              <Download style={{ width: 12, height: 12 }} className="text-muted-foreground" />
              <span className="hidden xs:inline">Download Report</span>
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="w-full h-[220px] sm:h-[260px] bg-muted animate-pulse rounded-[8px]" />
      ) : (
        <div className="w-full h-[220px] sm:h-[260px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart 
              data={chartData} 
              barCategoryGap="30%" 
              barGap={3}
              margin={{ top: 4, right: 0, left: -20, bottom: 0 }}
            >
              <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.5} />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 11, fontFamily: "Poppins, sans-serif", fill: "var(--muted-foreground)" }}
                axisLine={false} 
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fontFamily: "Poppins, sans-serif", fill: "var(--muted-foreground)" }}
                axisLine={false} 
                tickLine={false}
              />
              <Tooltip
                content={<CustomTooltip primaryLabel={primaryLabel} secondaryLabel={secondaryLabel} />}
                cursor={{ fill: "var(--muted)" }}
              />
              <Bar dataKey="a" name={primaryLabel} fill={primaryColor} radius={[4, 4, 0, 0]} />
              {variant === "dual" && (
                <Bar dataKey="b" name={secondaryLabel} fill={secondaryColor} radius={[4, 4, 0, 0]} />
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}