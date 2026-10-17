"use client";

import { useEffect } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from "recharts";
import { Download } from "lucide-react";
import { useUsersStore } from "@/stores/users.store";

const SERIES = [
  { key: "Doctors",    label: "Doctors",    color: "#272EA7" },
  { key: "Patients",   label: "Patients",   color: "#0DA53F" },
  { key: "Pharmacies", label: "Pharmacies", color: "#E8B600" },
  { key: "Labs",       label: "Labs",       color: "#8F90A4" },
];

function downloadCSV(data: any[]) {
  const headers = ["Month", "Doctors", "Patients", "Pharmacies", "Labs"];
  const rows = data.map((m) => [m.month, m.Doctors, m.Patients, m.Pharmacies, m.Labs]);
  const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `signup-trends-${new Date().toISOString().split("T")[0]}.csv`;
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
      </div>
      <div className="w-full h-[220px] bg-muted rounded" />
    </div>
  );
}

export default function SignUpTrendsChart() {
  const signUpTrends = useUsersStore((s) => s.signUpTrends);
  const isLoading = useUsersStore((s) => s.isLoadingCharts);

  if (isLoading || !signUpTrends.length) return <Skeleton />;

  return (
    <div className="bg-card rounded-lg border border-border p-4 md:p-6">
      <div className="flex items-start justify-between gap-3 mb-4 md:mb-6">
        <div>
          <h2 className="text-[14px] md:text-[16px] font-sans font-bold text-foreground">Sign Up Trends</h2>
          <p className="text-[11px] md:text-[12px] font-poppins text-muted-foreground">New signups by role over 12 months</p>
        </div>
        <div className="flex items-center gap-2 md:gap-3 shrink-0">
          {SERIES.map((s) => (
            <div key={s.key} className="hidden sm:flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
              <span className="text-[11px] font-poppins text-muted-foreground">{s.label}</span>
            </div>
          ))}
          <button
            onClick={() => downloadCSV(signUpTrends)}
            className="hidden sm:flex h-[28px] px-3 text-[11px] font-poppins font-semibold gap-1 items-center bg-primary text-white rounded-md hover:bg-primary/90 transition-colors"
          >
            Download
          </button>
          <button
            onClick={() => downloadCSV(signUpTrends)}
            className="sm:hidden w-8 h-8 rounded-full bg-primary flex items-center justify-center"
          >
            <Download className="w-3.5 h-3.5 text-white" />
          </button>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={signUpTrends} barSize={8} barGap={2} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="month" tick={{ fontSize: 10, fontFamily: "Poppins", fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 10, fontFamily: "Poppins", fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} width={30} />
          <Tooltip
            contentStyle={{ borderRadius: "8px", border: "none", fontSize: "12px", fontFamily: "Poppins", backgroundColor: "var(--primary)", color: "var(--primary-foreground)" }}
            labelStyle={{ color: "var(--primary-foreground)", fontWeight: 600 }}
            itemStyle={{ color: "var(--primary-foreground)" }}
          />
          {SERIES.map((s) => (
            <Bar key={s.key} dataKey={s.key} fill={s.color} radius={[4, 4, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}