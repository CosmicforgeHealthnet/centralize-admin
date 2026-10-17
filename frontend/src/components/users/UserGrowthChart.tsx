"use client";

import { useEffect, useRef, useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from "recharts";
import { Download } from "lucide-react";
import { useUsersStore } from "@/stores/users.store";

const SERIES = [
  { key: "total",    label: "Total",    color: "#272EA7", gradientId: "gradTotal"    },
  { key: "doctors",  label: "Doctors",  color: "#0DA53F", gradientId: "gradDoctors"  },
  { key: "patients", label: "Patients", color: "#E8B600", gradientId: "gradPatients" },
  { key: "others",   label: "Others",   color: "#8F90A4", gradientId: "gradOthers"   },
];

function downloadCSV(data: any[]) {
  const headers = ["Month", "Total", "Doctors", "Patients", "Others"];
  const rows = data.map((m) => [m.month, m.total, m.doctors, m.patients, m.others]);
  const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `user-growth-${new Date().toISOString().split("T")[0]}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function Skeleton() {
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

export default function UserGrowthChart() {
  const growthChart = useUsersStore((s) => s.growthChart);
  const isLoading = useUsersStore((s) => s.isLoadingCharts);
  const fetchCharts = useUsersStore((s) => s.fetchCharts);

  const [showTooltip, setShowTooltip] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { fetchCharts(); }, []);

  const handlePressStart = () => { pressTimer.current = setTimeout(() => setShowTooltip(true), 500); };
  const handlePressEnd = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    setTimeout(() => setShowTooltip(false), 1000);
  };

  if (isLoading || !growthChart.length) return <Skeleton />;

  return (
    <div className="bg-card rounded-lg border border-border p-4 md:p-6">
      <div className="flex items-start justify-between gap-3 mb-4 md:mb-6">
        <div>
          <h2 className="text-[14px] md:text-[16px] font-sans font-bold text-foreground">User Growth Rate</h2>
          <p className="text-[11px] md:text-[12px] font-poppins text-muted-foreground">Monthly user growth over 12 months</p>
        </div>
        <div className="flex items-center gap-2 md:gap-3 shrink-0">
          {SERIES.map((s) => (
            <div key={s.key} className="hidden sm:flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
              <span className="text-[11px] font-poppins text-muted-foreground">{s.label}</span>
            </div>
          ))}
          <div className="relative sm:hidden">
            <button
              onClick={() => downloadCSV(growthChart)}
              onMouseDown={handlePressStart}
              onMouseUp={handlePressEnd}
              onTouchStart={handlePressStart}
              onTouchEnd={handlePressEnd}
              className="w-8 h-8 rounded-full bg-primary flex items-center justify-center"
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
          <button
            onClick={() => downloadCSV(growthChart)}
            className="hidden sm:flex h-[28px] px-3 text-[11px] font-poppins font-semibold gap-1 items-center bg-primary text-white rounded-md hover:bg-primary/90 transition-colors"
          >
            Download
          </button>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={growthChart} margin={{ top: 10, right: 5, left: -10, bottom: 0 }}>
          <defs>
            {SERIES.map((s) => (
              <linearGradient key={s.gradientId} id={s.gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={s.color} stopOpacity={0.4} />
                <stop offset="95%" stopColor={s.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="4 4" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="month" tick={{ fontSize: 11, fontFamily: "Poppins", fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fontFamily: "Poppins", fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} width={35} />
          <Tooltip
            contentStyle={{ borderRadius: "8px", border: "none", fontSize: "12px", fontFamily: "Poppins", backgroundColor: "var(--primary)", color: "var(--primary-foreground)" }}
            labelStyle={{ color: "var(--primary-foreground)", fontWeight: 600 }}
            itemStyle={{ color: "var(--primary-foreground)" }}
          />
          {SERIES.map((s) => (
            <Area key={s.key} type="monotone" dataKey={s.key} stroke={s.color} fill={`url(#${s.gradientId})`} strokeWidth={2} dot={false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}