"use client";

import { useEffect } from "react";
import { Lightbulb, Search, AlertCircle } from "lucide-react";
import { useAIMarketingIntelligenceStore } from "@/stores/ai-marketing-intelligence.store";
import DataTable, { type DataTableColumn } from "@/components/marketing/shared/DataTable";
import ProviderBadge, { type BadgeProvider } from "@/components/marketing/shared/ProviderBadge";
import StatusChip from "@/components/marketing/shared/StatusChip";
import DataSufficiencyBadge from "@/components/marketing/shared/DataSufficiencyBadge";
import type {
  AMIRecommendationListItem,
  AMIRecommendationType,
  AMIRecommendationStatus,
  MIPlatform,
} from "@/types/ai-marketing-intelligence.types";

const TYPE_OPTIONS: { value: AMIRecommendationType | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "PAUSE", label: "Pause" },
  { value: "SCALE", label: "Scale" },
  { value: "REALLOCATE_BUDGET", label: "Reallocate budget" },
  { value: "CREATE_CONTENT", label: "Create content" },
];

const STATUS_OPTIONS: { value: AMIRecommendationStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "PENDING", label: "Pending" },
  { value: "ACCEPTED", label: "Accepted" },
  { value: "DISMISSED", label: "Dismissed" },
  { value: "EXPIRED", label: "Expired" },
  { value: "CONVERTED_TO_TASK", label: "Converted to Task" },
];

const PLATFORM_OPTIONS: { value: MIPlatform | "all"; label: string }[] = [
  { value: "all", label: "All platforms" },
  { value: "META", label: "Meta" },
  { value: "TIKTOK", label: "TikTok" },
  { value: "X", label: "X" },
  { value: "LINKEDIN", label: "LinkedIn" },
  { value: "GOOGLE_ADS", label: "Google Ads" },
];

function selectClass() {
  return "font-poppins text-[12px] bg-card border border-border rounded-[8px] px-2.5 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 w-full sm:w-auto";
}

interface RecommendationsPageProps {
  onOpenRecommendation: (id: string) => void;
}

export default function RecommendationsPage({ onOpenRecommendation }: RecommendationsPageProps) {
  const {
    recommendations,
    recommendationFilters,
    isLoadingRecommendations,
    error,
    fetchRecommendations,
    setRecommendationFilters,
  } = useAIMarketingIntelligenceStore();

  useEffect(() => {
    fetchRecommendations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns: DataTableColumn<AMIRecommendationListItem>[] = [
    {
      key: "type",
      header: "Type",
      render: (row) => (
        <StatusChip
          status={row.type}
          tone={row.type === "PAUSE" ? "danger" : row.type === "SCALE" ? "success" : row.type === "REALLOCATE_BUDGET" ? "info" : "purple"}
        />
      ),
      width: "140px",
    },
    {
      key: "target",
      header: "Target",
      render: (row) => (
        <div className="flex items-center gap-2 min-w-0">
          <ProviderBadge provider={row.platform as BadgeProvider} size="sm" />
          <div className="min-w-0">
            <p className="font-poppins text-[12px] font-medium text-foreground truncate max-w-[160px]" title={row.targetCampaignName ?? undefined}>
              {row.targetCampaignName ?? row.targetCampaignExternalId}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => <StatusChip status={row.status} />,
    },
    {
      key: "sufficiency",
      header: "Data",
      render: (row) => <DataSufficiencyBadge value={row.dataSufficiency} />,
    },
    {
      key: "confidence",
      header: "Confidence",
      render: (row) => (
        <span className="font-poppins text-[12px] font-medium text-foreground">
          {(row.confidence * 100).toFixed(0)}%
        </span>
      ),
      width: "90px",
    },
    {
      key: "currency",
      header: "Currency",
      render: (row) => (
        <span className="font-poppins text-[11px] text-muted-foreground">{row.currencyCode ?? "—"}</span>
      ),
      width: "80px",
    },
    {
      key: "window",
      header: "Generated / Expires",
      render: (row) => (
        <div className="font-poppins text-[11px] text-muted-foreground whitespace-nowrap">
          <p>{new Date(row.generatedAt).toLocaleDateString()}</p>
          <p>{row.expiresAt ? `Expires ${new Date(row.expiresAt).toLocaleDateString()}` : "No expiry"}</p>
        </div>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (row) => (
        <button
          onClick={() => onOpenRecommendation(row.id)}
          className="font-poppins text-[11px] font-medium text-primary hover:opacity-80 whitespace-nowrap"
        >
          View
        </button>
      ),
      width: "60px",
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Lightbulb className="w-4 h-4 text-primary" strokeWidth={2} />
        <div>
          <h2 className="font-poppins text-[14px] font-semibold text-foreground">Recommendations Centre</h2>
          <p className="font-poppins text-[11px] text-muted-foreground">
            Advisory actions and Task conversion workflow. Recommendations never write directly to a live provider.
          </p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2">
        <div className="relative w-full sm:w-56">
          <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" strokeWidth={2} />
          <input
            value={recommendationFilters.campaignExternalId}
            onChange={(e) => setRecommendationFilters({ campaignExternalId: e.target.value })}
            placeholder="Search campaign…"
            className="font-poppins text-[12px] bg-card border border-border rounded-[8px] pl-8 pr-3 py-1.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 w-full"
          />
        </div>

        <select value={recommendationFilters.type} onChange={(e) => setRecommendationFilters({ type: e.target.value as AMIRecommendationType | "all" })} className={selectClass()}>
          {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <select value={recommendationFilters.status} onChange={(e) => setRecommendationFilters({ status: e.target.value as AMIRecommendationStatus | "all" })} className={selectClass()}>
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <select value={recommendationFilters.platform} onChange={(e) => setRecommendationFilters({ platform: e.target.value as MIPlatform | "all" })} className={selectClass()}>
          {PLATFORM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <label className="flex items-center gap-1.5 font-poppins text-[12px] text-foreground px-1">
          <input
            type="checkbox"
            checked={recommendationFilters.onlyAwaitingTaskConversion}
            onChange={(e) => setRecommendationFilters({ onlyAwaitingTaskConversion: e.target.checked })}
            className="rounded border-border"
          />
          Awaiting Task conversion
        </label>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" strokeWidth={2} />
          <p className="font-poppins text-[12px] text-red-700">{error}</p>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={recommendations}
        rowKey={(row) => row.id}
        isLoading={isLoadingRecommendations}
        emptyLabel="No recommendations match the current filters"
      />
    </div>
  );
}