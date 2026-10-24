"use client";

import React, { useEffect } from "react";
import { Calendar, Stethoscope, Users, Wallet } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";
import ServiceDataState from "@/components/shared/ServiceDataState";

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
  icon: Icon,
  color,
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className="bg-card rounded-xl border border-border p-4 flex items-center justify-between gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-poppins text-muted-foreground">{label}</span>
        <span className="text-[20px] font-poppins font-bold" style={{ color }}>
          {typeof value === "number" ? value.toLocaleString() : value}
        </span>
      </div>
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${color}18` }}
      >
        <Icon className="w-5 h-5" style={{ color }} />
      </div>
    </div>
  );
}

export default function HealthnetStatCards() {
  const { metrics, metricsLoading, metricsError, fetchMetrics } = useHealthnetStore();

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  if (metricsError && !metricsLoading) return <ServiceDataState title="HealthNet statistics unavailable" message="The HealthNet data source could not be reached." retry={() => void fetchMetrics()} />;

  if (metricsLoading || !metrics) {
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          gap: "12px",
        }}
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  const cards = [
    {
      label: "Appointments",
      value: metrics.totalAppointments,
      icon: Calendar,
      color: "#272EA7",
    },
    {
      label: "Doctors",
      value: metrics.totalDoctors,
      icon: Stethoscope,
      color: "#272EA7",
    },
    {
      label: "Patients",
      value: metrics.totalPatients,
      icon: Users,
      color: "#E8B600",
    },
    {
      label: "Balance",
      value: `$${metrics.balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      icon: Wallet,
      color: "#0DA53F",
    },
  ];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
        gap: "12px",
      }}
    >
      {cards.map((c) => (
        <StatCard key={c.label} {...c} />
      ))}
    </div>
  );
}