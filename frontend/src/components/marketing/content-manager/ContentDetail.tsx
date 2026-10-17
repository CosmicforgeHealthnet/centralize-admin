// src/components/marketing/content-manager/ContentDetail.tsx
"use client";
import type { AdminChartTooltipProps } from "@/types/chart-tooltip.types";

import { useState, useEffect } from "react";
import { ArrowLeft, Edit2, ChevronDown, Download } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { useMarketingStore } from "@/stores/marketing.store";
import { Skeleton } from "@/components/ui/skeleton";

function ChartTooltip({ active, payload, label }: AdminChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md">
      <p className="font-poppins text-[11px] text-muted-foreground mb-0.5">{label}</p>
      <p className="font-poppins text-[13px] font-semibold text-foreground">{payload[0].value}%</p>
    </div>
  );
}

interface Props {
  contentId: string;
  onBack: () => void;
}

export default function ContentDetail({ contentId, onBack }: Props) {
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadFormat, setDownloadFormat] = useState<"csv" | "pdf">("csv");

  const {
    selectedContent,
    contentPerformance,
    isLoadingContentDetail,
    fetchContentDetail,
    downloadContentReport,
    error,
  } = useMarketingStore();

  useEffect(() => {
    if (contentId) {
      fetchContentDetail(contentId);
    }
  }, [contentId, fetchContentDetail]);

  const handleDownload = async (format: "csv" | "pdf") => {
    setDownloadFormat(format);
    await downloadContentReport(contentId, format);
    setDownloadOpen(false);
  };

  if (isLoadingContentDetail || !selectedContent) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-[200px] w-full rounded-xl" />
        <Skeleton className="h-[320px] w-full rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <p className="text-red-500 text-sm">{error}</p>
        <button onClick={onBack} className="mt-4 text-primary hover:underline">
          Go back
        </button>
      </div>
    );
  }

  const content = selectedContent;
  const chartData = contentPerformance.length > 0 ? contentPerformance : [];

  return (
    <div className="flex flex-col gap-4">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span className="font-poppins text-[12px] font-medium">Content Manager</span>
      </button>

      <div className="bg-card rounded-xl border border-border p-4 sm:p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-poppins text-[14px] font-semibold text-foreground">Content Details</h3>
          <button className="text-muted-foreground hover:text-primary transition-colors">
            <Edit2 className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
          <div className="flex flex-col gap-0.5">
            <span className="font-poppins text-[11px] text-muted-foreground">Enter Content Title</span>
            <span className="font-poppins text-[13px] font-semibold text-foreground">{content.title}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-poppins text-[11px] text-muted-foreground">Content Type</span>
            <span className="font-poppins text-[13px] font-semibold text-foreground">{content.type}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-poppins text-[11px] text-muted-foreground">Author</span>
            <span className="font-poppins text-[13px] font-semibold text-primary underline w-fit">{content.author}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-poppins text-[11px] text-muted-foreground">Content Link</span>
            <span className="font-poppins text-[13px] font-semibold text-foreground truncate">
              {content.link || "—"}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-0.5 mt-4">
          <span className="font-poppins text-[11px] text-muted-foreground">Description</span>
          <p className="font-poppins text-[12px] text-foreground leading-relaxed">
            {content.description || "No description provided."}
          </p>
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-1">
          <div>
            <h3 className="font-poppins text-[14px] font-semibold text-foreground">Content Overview</h3>
            <p className="font-poppins text-[11px] text-muted-foreground">January-Till date</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" defaultChecked className="w-3.5 h-3.5 rounded border-border accent-primary" />
              <span className="font-poppins text-[12px] text-foreground">Performance</span>
            </label>
            <div className="relative">
              <button
                onClick={() => setDownloadOpen((v) => !v)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white text-[11px] font-poppins font-semibold rounded-lg hover:bg-primary/90 transition-colors"
              >
                <Download className="w-3 h-3" />
                Download Report
                <ChevronDown className="w-3 h-3" />
              </button>
              {downloadOpen && (
                <div className="absolute right-0 top-9 z-10 bg-card border border-border rounded-lg shadow-lg py-1.5 w-[120px]">
                  {["CSV", "PDF"].map((f) => (
                    <button
                      key={f}
                      onClick={() => handleDownload(f.toLowerCase() as "csv" | "pdf")}
                      className="w-full text-left px-3 py-1.5 text-[12px] font-poppins text-foreground hover:bg-muted/50 transition-colors"
                    >
                      {f}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {chartData.length === 0 ? (
          <div className="h-[280px] flex items-center justify-center text-muted-foreground text-sm">
            No performance data available
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} barSize={22} margin={{ top: 16, right: 4, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontFamily: "Poppins", fontSize: 10, fill: "#94a3b8" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${v}%`}
                domain={[0, 100]}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(39,46,167,0.04)" }} />
              <Bar dataKey="value" fill="rgba(39,46,167,0.55)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}