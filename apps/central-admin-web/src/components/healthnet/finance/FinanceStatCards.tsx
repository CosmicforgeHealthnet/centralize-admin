"use client";

import { useEffect } from "react";
import { TrendingUp, TrendingDown, Wallet, CalendarCheck, ShoppingBag } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";
import type { FinanceCurrencyTotals } from "@/types/healthnet.types";

interface StatCardProps {
  title: string;
  value: string;
  currency?: string;
  change: string;
  positive: boolean;
  icon: React.ReactNode;
  iconBg: string;
  loading?: boolean;
  currencies?: FinanceCurrencyTotals;
}

function formatCurrency(value: number | null, currency: string): string {
  if (value == null) return "—";
  if (value >= 1_000_000) return `${currency} ${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${currency} ${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${currency} ${value.toFixed(2)}`;
}

function formatValue(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return n.toFixed(2);
}

function StatCard({ title, value, currency, change, positive, icon, iconBg, loading, currencies }: StatCardProps) {
  return (
    <div className="bg-card rounded-[16px] shadow-[0_1px_20px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_20px_0_rgba(0,0,0,0.3)] p-5 flex flex-col gap-3 flex-1 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-poppins font-medium text-muted-foreground leading-tight">{title}</p>
        <div className={`w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0 ${iconBg}`}>
          {icon}
        </div>
      </div>
      <div>
        {loading ? (
          <>
            <div className="h-8 w-24 bg-muted animate-pulse rounded-[6px]" />
            <div className="h-4 w-32 bg-muted animate-pulse rounded-[6px] mt-2" />
            <div className="h-3 w-40 bg-muted animate-pulse rounded-[6px] mt-2" />
          </>
        ) : (
          <>
            <p className="text-[26px] font-poppins font-bold text-foreground leading-none tracking-tight flex items-end gap-1.5">
              {value}
              {currency && (
                <span className="text-[13px] font-poppins font-medium text-muted-foreground mb-0.5">{currency}</span>
              )}
            </p>
            <div className="flex items-center gap-1 mt-2">
              {positive ? (
                <TrendingUp className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400 shrink-0" />
              ) : (
                <TrendingDown className="w-3.5 h-3.5 text-destructive shrink-0" />
              )}
              <span className={`text-[12px] font-poppins font-semibold ${positive ? "text-emerald-500 dark:text-emerald-400" : "text-destructive"}`}>
                {change}
              </span>
              <span className="text-[11px] font-poppins text-muted-foreground">vs last month</span>
            </div>
            {currencies && (
              <div className="flex items-center gap-2 mt-1.5">
                <span className="text-[11px] font-poppins font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded-[4px]">
                  {formatCurrency(currencies.usdValue, currencies.usdCurrency)}
                </span>
                <span className="text-[11px] font-poppins font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded-[4px]">
                  {formatCurrency(currencies.nairaValue, currencies.nairaCurrency)}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function FinanceStatCards() {
  const { financeStats, financeStatsLoading, fetchFinanceStats } = useHealthnetStore();

  useEffect(() => {
    fetchFinanceStats();
  }, [fetchFinanceStats]);

  const loading = financeStatsLoading || !financeStats;

  const totalBalance = financeStats?.totalBalance;
  const totalAppointments = financeStats?.totalAppointments;
  const totalSales = financeStats?.totalSales;

  const cards: StatCardProps[] = [
    {
      title: "Total Balance",
      value: totalBalance ? formatValue(totalBalance.value) : "—",
      currency: totalBalance?.usdCurrency,
      change: totalBalance?.change ?? "—",
      positive: totalBalance?.trend !== "down",
      iconBg: "bg-primary/10 dark:bg-primary/20",
      icon: <Wallet style={{ width: 18, height: 18 }} className="text-primary" />,
      loading,
      currencies: totalBalance,
    },
    {
      title: "Total Appointments",
      value: totalAppointments ? formatValue(totalAppointments.value) : "—",
      change: totalAppointments?.change ?? "—",
      positive: totalAppointments?.trend !== "down",
      iconBg: "bg-emerald-100 dark:bg-emerald-500/20",
      icon: <CalendarCheck style={{ width: 18, height: 18 }} className="text-emerald-600 dark:text-emerald-400" />,
      loading,
    },
    {
      title: "Total Sales",
      value: totalSales ? formatValue(totalSales.value) : "—",
      currency: totalSales?.usdCurrency,
      change: totalSales?.change ?? "—",
      positive: totalSales?.trend !== "down",
      iconBg: "bg-red-100 dark:bg-red-500/20",
      icon: <ShoppingBag style={{ width: 18, height: 18 }} className="text-red-500 dark:text-red-400" />,
      loading,
      currencies: totalSales,
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {cards.map((card) => (
        <StatCard key={card.title} {...card} />
      ))}
    </div>
  );
}