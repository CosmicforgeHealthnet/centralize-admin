"use client";

import { useEffect } from "react";
import { useITStore } from "@/stores/it.store";
import { Activity, Video, Package, CreditCard, FileText, Bell } from "lucide-react";

function SkeletonCard() {
  return (
    <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-3 animate-pulse">
      <div className="h-4 bg-muted rounded w-24" />
      <div className="h-7 bg-muted rounded w-16" />
      <div className="h-3 bg-muted rounded w-32" />
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  color,
}: {
  label: string;
  value: string | number;
  sub: string;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-poppins text-muted-foreground">{label}</span>
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: `${color}18` }}
        >
          <Icon className="w-4 h-4" style={{ color }} />
        </div>
      </div>
      <span className="text-[24px] font-poppins font-bold text-foreground">{value}</span>
      <span className="text-[12px] font-poppins text-muted-foreground">{sub}</span>
    </div>
  );
}

export default function ITStatCards() {
  const stats      = useITStore((s) => s.stats);
  const isLoading  = useITStore((s) => s.isLoadingStats);
  const fetchStats = useITStore((s) => s.fetchStats);

  useEffect(() => { fetchStats(); }, []);

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

  const cards = [
    {
      label: "Consultations",
      value: stats.telemedicine.total,
      sub: `${stats.telemedicine.scheduled} scheduled`,
      icon: Activity,
      color: "#272EA7",
    },
    {
      label: "RTC Sessions",
      value: stats.rtc.total,
      sub: `${stats.rtc.active} active`,
      icon: Video,
      color: "#0DA53F",
    },
    {
      label: "Deliveries",
      value: stats.logistics.total,
      sub: `${stats.logistics.readyForDelivery} ready`,
      icon: Package,
      color: "#E8B600",
    },
    {
      label: "Transactions",
      value: stats.payments.total,
      sub: `$${stats.payments.monthlyRevenueUsd} this month`,
      icon: CreditCard,
      color: "#272EA7",
    },
    {
      label: "Audit Events",
      value: stats.audit.total,
      sub: `${stats.audit.today} today`,
      icon: FileText,
      color: "#8F90A4",
    },
    {
      label: "Notifications",
      value: stats.notifications.total,
      sub: `${stats.notifications.unread} unread`,
      icon: Bell,
      color: "#F64545",
    },
  ];

  return (
    <div style={gridStyle}>
      {cards.map((c) => (
        <StatCard key={c.label} {...c} />
      ))}
    </div>
  );
}