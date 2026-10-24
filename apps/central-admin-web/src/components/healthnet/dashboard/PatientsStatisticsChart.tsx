"use client";
import type { AdminChartTooltipProps } from "@/types/chart-tooltip.types";

import React, { useEffect, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { ChevronDown } from "lucide-react";
import { useHealthnetStore } from "@/stores/healthnet.store";
import ServiceDataState from "@/components/shared/ServiceDataState";

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

const CustomTooltip = ({ active, payload, label }: AdminChartTooltipProps) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md">
        <p className="text-[12px] font-poppins font-semibold text-foreground">{label}</p>
        <p className="text-[12px] font-poppins font-bold text-destructive">{payload[0].value}%</p>
      </div>
    );
  }
  return null;
};

function SkeletonCard() {
  return (
    <div className="bg-card rounded-lg border border-border p-5 flex flex-col w-full animate-pulse">
      <div className="w-36 h-4 bg-muted rounded mb-4" />
      <div className="h-[220px] bg-muted rounded" />
    </div>
  );
}

export default function PatientsStatisticsChart() {
  const [month, setMonth] = useState("March");
  const [open, setOpen] = useState(false);

  const { patientsChart, patientsChartLoading, patientsChartError, fetchPatientsChart } = useHealthnetStore();

  useEffect(() => {
    fetchPatientsChart(month);
  }, [month, fetchPatientsChart]);

  if (patientsChartError && !patientsChartLoading) return <ServiceDataState title="HealthNet patient statistics unavailable" message={patientsChartError} retry={() => void fetchPatientsChart(month)} />;
  if (patientsChartLoading || !patientsChart) {
    return <SkeletonCard />;
  }

  const selectedShort = patientsChart.selectedMonth.slice(0, 3);

  return (
    <div className="bg-card rounded-lg border border-border p-5 flex flex-col w-full">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-4">
        <h2 className="text-[15px] font-bold text-foreground font-poppins">
          Patients Statistics
        </h2>

        <div className="relative">
          <button
            onClick={() => setOpen((p) => !p)}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-[6px] border border-border bg-card text-[12px] font-poppins text-foreground hover:bg-muted transition-colors"
          >
            {month}
            <ChevronDown
              className={`w-3 h-3 text-muted-foreground transition-transform duration-150 ${
                open ? "rotate-180" : ""
              }`}
            />
          </button>
          {open && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
              <div className="absolute top-full right-0 mt-1 z-20 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[120px] max-h-[200px] overflow-y-auto">
                {MONTHS.map((m) => (
                  <button
                    key={m}
                    onClick={() => { setMonth(m); setOpen(false); }}
                    className={`w-full text-left px-3 py-1.5 text-[12px] font-poppins transition-colors hover:bg-muted ${
                      m === month ? "text-primary font-semibold" : "text-muted-foreground"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Chart */}
      <div className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={patientsChart.data}
            margin={{ top: 4, right: 4, left: -24, bottom: 0 }}
            barSize={16}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--border)"
              vertical={false}
            />
            <XAxis
              dataKey="month"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fontFamily: "Poppins", fill: "var(--muted-foreground)" }}
            />
            <YAxis
              tickFormatter={(v) => `${v}%`}
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fontFamily: "Poppins", fill: "var(--muted-foreground)" }}
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: "var(--muted)", radius: 4 }} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {patientsChart.data.map((entry) => (
                <Cell
                  key={entry.month}
                  fill="#8B1A1A"
                  opacity={entry.month === selectedShort ? 1 : 0.4}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}