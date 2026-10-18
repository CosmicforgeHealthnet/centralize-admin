"use client";

import { useEffect, useState, useRef } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from "recharts";
import { ChevronDown, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDashboardStore } from "@/stores/dashboard.store";
import type { PlatformUsageItem } from "@/types/dashboard.types";

const LEGEND_ITEMS = [
  { label: "AI",           color: "#0da53f", dataKey: "AI",           gradientId: "colorAI"           },
  { label: "Lab",          color: "#e8b600", dataKey: "Lab",          gradientId: "colorLab"          },
  { label: "Pharmacy",     color: "#f64545", dataKey: "Pharmacy",     gradientId: "colorPharmacy"     },
  { label: "Consultation", color: "#272EA7", dataKey: "Consultation", gradientId: "colorConsultation" },
];

function downloadCSV(data: PlatformUsageItem[], filename: string) {
  const headers = ["Month", "AI", "Lab", "Pharmacy", "Consultation"];
  const rows = data.map((m) => [m.month, m.AI, m.Lab, m.Pharmacy, m.Consultation]);
  const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function PlatformUsageSkeleton() {
  return (
    <div className="bg-card rounded-lg border border-border p-4 md:p-6 animate-pulse">
      <div className="flex items-start justify-between mb-6">
        <div className="flex flex-col gap-2">
          <div className="w-32 h-4 bg-muted rounded" />
          <div className="w-48 h-3 bg-muted rounded" />
        </div>
        <div className="w-28 h-7 bg-muted rounded" />
      </div>
      <div className="w-full h-[220px] bg-muted rounded" />
    </div>
  );
}

export default function PlatformUsageChart() {
  const { platformUsage, isLoadingPlatform, fetchPlatformUsage } = useDashboardStore();
  const [showTooltip, setShowTooltip] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetchPlatformUsage();
  }, [fetchPlatformUsage]);

  const handlePressStart = () => {
    pressTimer.current = setTimeout(() => setShowTooltip(true), 500);
  };

  const handlePressEnd = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    setTimeout(() => setShowTooltip(false), 1000);
  };

  const handleDownload = () => {
    const filename = `platform-usage-${new Date().toISOString().split("T")[0]}.csv`;
    downloadCSV(platformUsage, filename);
  };

  if (isLoadingPlatform || !platformUsage.length) return <PlatformUsageSkeleton />;

  const maxValue = Math.max(
    ...platformUsage.flatMap((m) => [m.AI, m.Lab, m.Pharmacy, m.Consultation]),
    1
  );

  const normalizedData = platformUsage.map((m) => ({
    month: m.month,
    AI:           Math.round((m.AI           / maxValue) * 100),
    Lab:          Math.round((m.Lab          / maxValue) * 100),
    Pharmacy:     Math.round((m.Pharmacy     / maxValue) * 100),
    Consultation: Math.round((m.Consultation / maxValue) * 100),
  }));

  return (
    <div className="bg-card rounded-lg border border-border p-4 md:p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-4 md:mb-6">
        <div className="shrink-0 min-w-0">
          <h2 className="text-[14px] md:text-[16px] font-sans font-bold text-foreground">
            Platform Usage
          </h2>
          <p className="text-[11px] md:text-[12px] font-poppins text-muted-foreground">
            Healthnet Performance and Report
          </p>
        </div>

        <div className="flex items-center gap-2 md:gap-3 shrink-0">
          {LEGEND_ITEMS.map((item) => (
            <div key={item.label} className="hidden sm:flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: item.color }} />
              <span className="text-[11px] md:text-[12px] font-poppins text-foreground font-medium">
                {item.label}
              </span>
            </div>
          ))}

          {/* Desktop button */}
          <Button
            onClick={handleDownload}
            className="hidden sm:flex h-[28px] text-[11px] font-poppins gap-1 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 border-none px-3"
          >
            Download Report 
          </Button>

          {/* Mobile button */}
          <div className="relative sm:hidden">
            <button
              onClick={handleDownload}
              onMouseDown={handlePressStart}
              onMouseUp={handlePressEnd}
              onTouchStart={handlePressStart}
              onTouchEnd={handlePressEnd}
              className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shrink-0"
            >
              <Download className="w-3.5 h-3.5 text-white" />
            </button>
            {showTooltip && (
              <div className="absolute right-0 top-10 z-50 bg-[#1A1C1E] text-white text-[10px] font-poppins px-3 py-1.5 rounded-[6px] whitespace-nowrap shadow-lg">
                Download Report
                <div className="absolute -top-1.5 right-2.5 w-3 h-3 bg-[#1A1C1E] rotate-45" />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={normalizedData} margin={{ top: 10, right: 5, left: -10, bottom: 0 }}>
          <defs>
            {LEGEND_ITEMS.map((item) => (
              <linearGradient key={item.gradientId} id={item.gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={item.color} stopOpacity={0.5}  />
                <stop offset="95%" stopColor={item.color} stopOpacity={0.05} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="4 4" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="month"
            tick={{ fontSize: 11, fontFamily: "Poppins", fill: "var(--muted-foreground)" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tickFormatter={(v) => `${v}%`}
            ticks={[0, 25, 50, 75, 100]}
            domain={[0, 100]}
            tick={{ fontSize: 11, fontFamily: "Poppins", fill: "var(--muted-foreground)" }}
            axisLine={false}
            tickLine={false}
            width={35}
          />
          <Tooltip
            formatter={(value, name) => [`${value}%`, name]}
            contentStyle={{
              borderRadius: "8px", border: "none", fontSize: "12px",
              fontFamily: "Poppins", backgroundColor: "var(--primary)",
              color: "var(--primary-foreground)",
            }}
            labelStyle={{ color: "var(--primary-foreground)", fontWeight: 600 }}
            itemStyle={{ color: "var(--primary-foreground)" }}
          />
          {LEGEND_ITEMS.map((item) => (
            <Area
              key={item.dataKey}
              type="monotone"
              dataKey={item.dataKey}
              stroke={item.color}
              fill={`url(#${item.gradientId})`}
              strokeWidth={2.5}
              dot={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}