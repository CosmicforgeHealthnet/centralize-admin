"use client";

import { useEffect } from "react";
import { CalendarCheck, Stethoscope, Users, Wallet } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";

export default function AnalyticsStatCards() {
  const { analyticsStats, analyticsStatsLoading, fetchAnalyticsStats } = useHealthnetStore();

  useEffect(() => {
    fetchAnalyticsStats();
  }, [fetchAnalyticsStats]);

  const loading = analyticsStatsLoading || !analyticsStats;

  const STATS = [
    {
      label: "Appointments",
      value: analyticsStats?.appointments,
      valueColor: "text-primary",
      iconBg: "bg-primary/10 dark:bg-primary/20",
      icon: <CalendarCheck style={{ width: 20, height: 20 }} className="text-primary" />,
    },
    {
      label: "Doctors",
      value: analyticsStats?.doctors,
      valueColor: "text-emerald-600 dark:text-emerald-400",
      iconBg: "bg-emerald-100 dark:bg-emerald-500/20",
      icon: <Stethoscope style={{ width: 20, height: 20 }} className="text-emerald-600 dark:text-emerald-400" />,
    },
    {
      label: "Patients",
      value: analyticsStats?.patients,
      valueColor: "text-amber-600 dark:text-amber-400",
      iconBg: "bg-amber-100 dark:bg-amber-500/20",
      icon: <Users style={{ width: 20, height: 20 }} className="text-amber-600 dark:text-amber-400" />,
    },
    {
      label: "Balance",
      value: analyticsStats?.balance,
      valueColor: "text-emerald-600 dark:text-emerald-400",
      iconBg: "bg-emerald-100 dark:bg-emerald-500/20",
      icon: <Wallet style={{ width: 20, height: 20 }} className="text-emerald-600 dark:text-emerald-400" />,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
      {STATS.map((stat) => (
        <div
          key={stat.label}
          className="bg-card rounded-[14px] shadow-[0_1px_16px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_16px_0_rgba(0,0,0,0.3)] p-4 flex items-center gap-3"
        >
          <div className={`w-10 h-10 rounded-[10px] flex items-center justify-center shrink-0 ${stat.iconBg}`}>
            {stat.icon}
          </div>
          <div className="min-w-0">
            {loading ? (
              <>
                <div className="h-5 w-14 bg-muted animate-pulse rounded-[4px]" />
                <div className="h-3 w-16 bg-muted animate-pulse rounded-[4px] mt-2" />
              </>
            ) : (
              <>
                <p className={`text-[20px] font-poppins font-bold leading-none ${stat.valueColor}`}>
                  {stat.label === "Balance"
                    ? `$${stat.value?.toLocaleString() ?? "—"}`
                    : stat.value?.toLocaleString() ?? "—"}
                </p>
                <p className="text-[11px] font-poppins text-muted-foreground mt-1 truncate">{stat.label}</p>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}