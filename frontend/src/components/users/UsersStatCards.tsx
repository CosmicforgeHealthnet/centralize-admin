"use client";

import { useEffect } from "react";
import { useUsersStore } from "@/stores/users.store";
import {
  Users, Stethoscope, Heart, Building2,
  FlaskConical, TrendingUp, Lock, Clock,
} from "lucide-react";

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
      <div
        className="absolute -top-4 -right-4 w-16 h-16 rounded-full opacity-10 group-hover:opacity-20 transition-opacity duration-300 blur-xl"
        style={{ backgroundColor: color }}
      />
      <div className="flex items-center justify-between relative">
        <span className="text-[11px] font-poppins font-medium text-muted-foreground tracking-wide uppercase">
          {label}
        </span>
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center transition-transform duration-200 group-hover:scale-110"
          style={{ backgroundColor: `${color}18` }}
        >
          <Icon className="w-4 h-4" style={{ color }} />
        </div>
      </div>
      <span className="text-[24px] font-poppins font-bold text-foreground leading-none relative">
        {value}
      </span>
      <span className="text-[11px] font-poppins text-muted-foreground relative">{sub}</span>
      <div
        className="absolute bottom-0 left-0 h-[2px] w-0 group-hover:w-full transition-all duration-500 rounded-b-2xl"
        style={{ backgroundColor: color }}
      />
    </div>
  );
}

export default function UsersStatCards() {
  const stats      = useUsersStore((s) => s.stats);
  const isLoading  = useUsersStore((s) => s.isLoadingStats);
  const fetchStats = useUsersStore((s) => s.fetchStats);

  useEffect(() => { fetchStats(); }, []);

  if (isLoading || !stats) {
    return (
      /*
        auto-fill + minmax(160px, 1fr):
        - Mobile (~360px main): 2 cols
        - Tablet (~696px main): 4 cols
        - Desktop expanded sidebar (~996px main): 4 cols
        - Desktop collapsed sidebar (~1208px main): 6–7 cols
        - Large screens (1400px+): 8 cols
        Never forces a fixed column count — always fits the available space.
      */
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "12px" }}>
        {Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
    );
  }

  const pct = (n: number) =>
    stats.total === 0 ? "0.0" : ((n / stats.total) * 100).toFixed(1);

  const showPercentage = stats.newThisMonth >= 20;
  const growthValue = showPercentage
    ? `${stats.growthRate > 0 ? "+" : ""}${stats.growthRate}%`
    : `${stats.newThisMonth} new`;
  const growthSub = showPercentage
    ? `${stats.newThisMonth} this month ${stats.growthRate > 0 ? "↑" : "↓"} ${Math.abs(stats.growthRate)}%`
    : "this month";

  const cards = [
    { label: "Total Users", value: stats.total.toLocaleString(),                sub: `${stats.newToday} joined today`,          icon: Users,        color: "#272EA7" },
    { label: "Doctors",     value: stats.totalDoctors.toLocaleString(),         sub: `${pct(stats.totalDoctors)}% of total`,    icon: Stethoscope,  color: "#272EA7" },
    { label: "Patients",    value: stats.totalPatients.toLocaleString(),        sub: `${pct(stats.totalPatients)}% of total`,   icon: Heart,        color: "#0DA53F" },
    { label: "Pharmacies",  value: stats.totalPharmacies.toLocaleString(),      sub: `${pct(stats.totalPharmacies)}% of total`, icon: Building2,    color: "#E8B600" },
    { label: "Labs",        value: stats.totalLabs.toLocaleString(),            sub: `${pct(stats.totalLabs)}% of total`,       icon: FlaskConical, color: "#8F90A4" },
    { label: "Locked",      value: stats.lockedUsers.toLocaleString(),          sub: `${pct(stats.lockedUsers)}% of total`,     icon: Lock,         color: "#F64545" },
    { label: "Pending",     value: stats.pendingVerification.toLocaleString(),  sub: "awaiting verification",                   icon: Clock,        color: "#F59E0B" },
    { label: "Growth",      value: growthValue,                                 sub: growthSub,                                 icon: TrendingUp,   color: stats.growthRate >= 0 ? "#0DA53F" : "#F64545" },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "12px" }}>
      {cards.map((c) => <StatCard key={c.label} {...c} />)}
    </div>
  );
}