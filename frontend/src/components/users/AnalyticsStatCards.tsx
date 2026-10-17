"use client";

import { useEffect } from "react";
import { useUsersStore } from "@/stores/users.store";
import { Globe, Users, RefreshCw, TrendingUp, Monitor, Smartphone } from "lucide-react";

function SkeletonCard() {
  return (
    <div className="bg-card rounded-2xl border border-border p-4 flex flex-col gap-3 animate-pulse">
      <div className="h-3.5 bg-muted rounded-full w-24" />
      <div className="h-8 bg-muted rounded-full w-20" />
      <div className="h-3 bg-muted rounded-full w-32" />
    </div>
  );
}

function StatCard({
  label, value, sub, icon: Icon, color,
}: {
  label: string; value: string | number; sub: string;
  icon: React.ElementType; color: string;
}) {
  return (
    <div className="relative bg-card rounded-2xl border border-border p-4 flex flex-col gap-2 overflow-hidden group hover:border-primary/30 transition-all duration-300 hover:shadow-md hover:-translate-y-0.5">
      <div className="absolute -top-4 -right-4 w-16 h-16 rounded-full opacity-10 group-hover:opacity-20 transition-opacity duration-300 blur-xl" style={{ backgroundColor: color }} />
      <div className="flex items-center justify-between relative">
        <span className="text-[11px] font-poppins font-medium text-muted-foreground tracking-wide uppercase">{label}</span>
        <div className="w-8 h-8 rounded-xl flex items-center justify-center transition-transform duration-200 group-hover:scale-110" style={{ backgroundColor: `${color}18` }}>
          <Icon className="w-4 h-4" style={{ color }} />
        </div>
      </div>
      <span className="text-[24px] font-poppins font-bold text-foreground leading-none relative">{value}</span>
      <span className="text-[11px] font-poppins text-muted-foreground relative">{sub}</span>
      <div className="absolute bottom-0 left-0 h-[2px] w-0 group-hover:w-full transition-all duration-500 rounded-b-2xl" style={{ backgroundColor: color }} />
    </div>
  );
}

export default function AnalyticsStatCards() {
  const stats     = useUsersStore((s) => s.analyticsStats);
  const isLoading = useUsersStore((s) => s.isLoadingAnalyticsStats);
  const fetch     = useUsersStore((s) => s.fetchAnalyticsStats);

  useEffect(() => { fetch(); }, []);

  const gridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: "12px",
  };

  if (isLoading || !stats) {
    return (
      <div style={gridStyle}>
        {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
    );
  }

  const deviceTotal  = Object.values(stats.by_device).reduce((a, b) => a + b, 0);
  const desktopPct   = deviceTotal > 0 ? ((stats.by_device["desktop"] ?? 0) / deviceTotal * 100).toFixed(1) : "0";
  const mobilePct    = deviceTotal > 0 ? ((stats.by_device["mobile"]  ?? 0) / deviceTotal * 100).toFixed(1) : "0";
  const returningPct = stats.unique_sessions > 0
    ? ((stats.returning_visitors / stats.unique_sessions) * 100).toFixed(1)
    : "0";

  const cards = [
    { label: "Total Visitors", value: stats.total_visitors.toLocaleString(),       sub: `${stats.unique_sessions.toLocaleString()} unique sessions`, icon: Globe,       color: "#272EA7" },
    { label: "Returning",      value: stats.returning_visitors.toLocaleString(),   sub: `${returningPct}% of sessions`,                              icon: RefreshCw,   color: "#0DA53F" },
    { label: "Conversions",    value: stats.conversions.total.toLocaleString(),    sub: `${stats.conversions.rate} conversion rate`,                  icon: TrendingUp,  color: "#E8B600" },
    { label: "Top Country",    value: stats.by_country[0]?.country ?? "—",        sub: `${stats.by_country[0]?.count.toLocaleString() ?? 0} visitors`,icon: Users,      color: "#8F90A4" },
    { label: "Desktop",        value: `${desktopPct}%`,                            sub: `${(stats.by_device["desktop"] ?? 0).toLocaleString()} sessions`, icon: Monitor, color: "#272EA7" },
    { label: "Mobile",         value: `${mobilePct}%`,                             sub: `${(stats.by_device["mobile"]  ?? 0).toLocaleString()} sessions`, icon: Smartphone, color: "#F64545" },
  ];

  return (
    <div style={gridStyle}>
      {cards.map((c) => <StatCard key={c.label} {...c} />)}
    </div>
  );
}