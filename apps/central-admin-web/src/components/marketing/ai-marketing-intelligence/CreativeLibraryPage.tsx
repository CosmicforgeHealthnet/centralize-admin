"use client";

import { useEffect } from "react";
import { Sparkles, Search, AlertCircle } from "lucide-react";
import { useAIMarketingIntelligenceStore } from "@/stores/ai-marketing-intelligence.store";
import DataTable, { type DataTableColumn } from "@/components/marketing/shared/DataTable";
import ProviderBadge, { type BadgeProvider } from "@/components/marketing/shared/ProviderBadge";
import DataSufficiencyBadge from "@/components/marketing/shared/DataSufficiencyBadge";
import FatigueBadge from "@/components/marketing/shared/FatigueBadge";
import ScoreGauge from "@/components/marketing/shared/ScoreGauge";
import type {
  AMICreativeListItem,
  AMICreativeType,
  AMIDataSufficiency,
  AMIFatigueStatus,
  MIPlatform,
} from "@/types/ai-marketing-intelligence.types";

const PLATFORM_OPTIONS: { value: MIPlatform | "all"; label: string }[] = [
  { value: "all", label: "All platforms" },
  { value: "META", label: "Meta" },
  { value: "TIKTOK", label: "TikTok" },
  { value: "X", label: "X" },
  { value: "LINKEDIN", label: "LinkedIn" },
  { value: "GOOGLE_ADS", label: "Google Ads" },
];

const TYPE_OPTIONS: { value: AMICreativeType | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "IMAGE", label: "Image" },
  { value: "VIDEO", label: "Video" },
  { value: "CAROUSEL", label: "Carousel" },
  { value: "TEXT", label: "Text" },
  { value: "DOCUMENT", label: "Document" },
  { value: "RESPONSIVE", label: "Responsive" },
  { value: "ASSET_GROUP", label: "Asset group" },
  { value: "OTHER", label: "Other" },
];

const SUFFICIENCY_OPTIONS: { value: AMIDataSufficiency | "all"; label: string }[] = [
  { value: "all", label: "All sufficiency" },
  { value: "INSUFFICIENT", label: "Insufficient" },
  { value: "LIMITED", label: "Limited" },
  { value: "SUFFICIENT", label: "Sufficient" },
  { value: "STRONG", label: "Strong" },
];

const FATIGUE_OPTIONS: { value: AMIFatigueStatus | "all"; label: string }[] = [
  { value: "all", label: "All fatigue" },
  { value: "NONE", label: "None" },
  { value: "WATCH", label: "Watch" },
  { value: "FATIGUED", label: "Fatigued" },
  { value: "RECOVERED", label: "Recovered" },
];

function selectClass() {
  return "font-poppins text-[12px] bg-card border border-border rounded-[8px] px-2.5 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30";
}

interface CreativeLibraryPageProps {
  onOpenCreative: (id: string) => void;
}

export default function CreativeLibraryPage({ onOpenCreative }: CreativeLibraryPageProps) {
  const {
    creatives,
    creativeFilters,
    isLoadingCreatives,
    error,
    fetchCreatives,
    setCreativeFilters,
  } = useAIMarketingIntelligenceStore();

  useEffect(() => {
    fetchCreatives();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns: DataTableColumn<AMICreativeListItem>[] = [
    {
      key: "creative",
      header: "Creative",
      render: (row) => (
        <div className="flex items-center gap-2 min-w-0">
          <ProviderBadge provider={row.platform as BadgeProvider} size="sm" />
          <div className="min-w-0">
            <p className="font-poppins text-[12px] font-medium text-foreground truncate max-w-[180px]" title={row.name}>
              {row.name}
            </p>
            <p className="font-poppins text-[10px] text-muted-foreground truncate">{row.type}</p>
          </div>
        </div>
      ),
      width: "220px",
    },
    {
      key: "hierarchy",
      header: "Campaign",
      render: (row) => (
        <div className="min-w-0">
          <p className="font-poppins text-[12px] text-foreground truncate max-w-[160px]" title={row.campaignName ?? undefined}>
            {row.campaignName ?? "Not available"}
          </p>
          <p className="font-poppins text-[10px] text-muted-foreground truncate">{row.campaignExternalId ?? "—"}</p>
        </div>
      ),
    },
    {
      key: "score",
      header: "Score",
      render: (row) => <ScoreGauge score={row.latestScore} dataSufficiency={row.dataSufficiency} size="sm" />,
      width: "70px",
    },
    {
      key: "sufficiency",
      header: "Sufficiency",
      render: (row) => <DataSufficiencyBadge value={row.dataSufficiency} />,
    },
    {
      key: "fatigue",
      header: "Fatigue",
      render: (row) => <FatigueBadge value={row.fatigueStatus} />,
    },
    {
      key: "performance",
      header: "Spend / CTR / CPA",
      render: (row) => (
        <div className="font-poppins text-[11px] text-foreground whitespace-nowrap">
          {row.spend !== null ? `${row.currency ?? ""} ${row.spend.toLocaleString()}` : "Not available"}
          <span className="text-muted-foreground"> · </span>
          {row.ctr !== null ? `${(row.ctr * 100).toFixed(2)}%` : "—"}
          <span className="text-muted-foreground"> · </span>
          {row.cpa !== null ? `${row.currency ?? ""} ${row.cpa.toFixed(2)}` : "—"}
        </div>
      ),
    },
    {
      key: "freshness",
      header: "Last scored",
      render: (row) => (
        <span className="font-poppins text-[11px] text-muted-foreground whitespace-nowrap">
          {row.lastScoredAt ? new Date(row.lastScoredAt).toLocaleDateString() : "Not scored"}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (row) => (
        <button
          onClick={() => onOpenCreative(row.id)}
          className="font-poppins text-[11px] font-medium text-primary hover:opacity-80"
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
        <Sparkles className="w-4 h-4 text-primary" strokeWidth={2} />
        <div>
          <h2 className="font-poppins text-[14px] font-semibold text-foreground">Creative Intelligence Library</h2>
          <p className="font-poppins text-[11px] text-muted-foreground">
            Creative assets, performance, scores, fatigue and evidence.
          </p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" strokeWidth={2} />
          <input
            value={creativeFilters.search}
            onChange={(e) => setCreativeFilters({ search: e.target.value })}
            placeholder="Search creative name…"
            className="font-poppins text-[12px] bg-card border border-border rounded-[8px] pl-8 pr-3 py-1.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 w-56"
          />
        </div>

        <select
          value={creativeFilters.platform}
          onChange={(e) => setCreativeFilters({ platform: e.target.value as MIPlatform | "all" })}
          className={selectClass()}
        >
          {PLATFORM_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <select
          value={creativeFilters.creativeType}
          onChange={(e) => setCreativeFilters({ creativeType: e.target.value as AMICreativeType | "all" })}
          className={selectClass()}
        >
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <select
          value={creativeFilters.dataSufficiency}
          onChange={(e) => setCreativeFilters({ dataSufficiency: e.target.value as AMIDataSufficiency | "all" })}
          className={selectClass()}
        >
          {SUFFICIENCY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <select
          value={creativeFilters.fatigueStatus}
          onChange={(e) => setCreativeFilters({ fatigueStatus: e.target.value as AMIFatigueStatus | "all" })}
          className={selectClass()}
        >
          {FATIGUE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" strokeWidth={2} />
          <p className="font-poppins text-[12px] text-red-700">{error}</p>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={creatives}
        rowKey={(row) => row.id}
        isLoading={isLoadingCreatives}
        emptyLabel="No creatives match the current filters"
      />
    </div>
  );
}