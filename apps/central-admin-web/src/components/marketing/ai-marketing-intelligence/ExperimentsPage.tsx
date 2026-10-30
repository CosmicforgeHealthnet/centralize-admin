"use client";

import { useEffect, useState } from "react";
import { FlaskConical, AlertCircle, Plus } from "lucide-react";
import { useAIMarketingIntelligenceStore } from "@/stores/ai-marketing-intelligence.store";
import DataTable, { type DataTableColumn } from "@/components/marketing/shared/DataTable";
import ProviderBadge, { type BadgeProvider } from "@/components/marketing/shared/ProviderBadge";
import StatusChip from "@/components/marketing/shared/StatusChip";
import ExperimentFormModal from "./ExperimentFormModal";
import type { AMIExperimentListItem, AMIExperimentStatus, AMIExperimentMetric, MIPlatform } from "@/types/ai-marketing-intelligence.types";

const STATUS_OPTIONS: { value: AMIExperimentStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "RUNNING", label: "Running" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
];

const METRIC_OPTIONS: { value: AMIExperimentMetric | "all"; label: string }[] = [
  { value: "all", label: "All metrics" },
  { value: "CTR", label: "CTR" },
  { value: "CPC", label: "CPC" },
  { value: "CPA", label: "CPA" },
  { value: "CONVERSION_RATE", label: "Conversion rate" },
  { value: "ROAS", label: "ROAS" },
  { value: "ENGAGEMENT_RATE", label: "Engagement rate" },
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

interface ExperimentsPageProps {
  onOpenExperiment: (id: string) => void;
}

export default function ExperimentsPage({ onOpenExperiment }: ExperimentsPageProps) {
  const { experiments, experimentFilters, isLoadingExperiments, error, fetchExperiments, setExperimentFilters } =
    useAIMarketingIntelligenceStore();
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    fetchExperiments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns: DataTableColumn<AMIExperimentListItem>[] = [
    {
      key: "name",
      header: "Experiment",
      render: (row) => (
        <div className="min-w-0">
          <p className="font-poppins text-[12px] font-medium text-foreground truncate max-w-[220px]" title={row.name}>{row.name}</p>
          <p className="font-poppins text-[10px] text-muted-foreground truncate max-w-[220px]" title={row.hypothesis}>{row.hypothesis}</p>
        </div>
      ),
    },
    {
      key: "platform",
      header: "Platform",
      render: (row) => (row.platform ? <ProviderBadge provider={row.platform as BadgeProvider} size="sm" /> : <span className="font-poppins text-[11px] text-muted-foreground">—</span>),
    },
    {
      key: "metric",
      header: "Metric",
      render: (row) => <span className="font-poppins text-[11px] text-foreground">{row.metric.replace(/_/g, " ")}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (row) => <StatusChip status={row.status} />,
    },
    {
      key: "owner",
      header: "Owner",
      render: (row) => <span className="font-poppins text-[11px] text-muted-foreground">{row.owner ?? "—"}</span>,
    },
    {
      key: "dates",
      header: "Started / Ended",
      render: (row) => (
        <div className="font-poppins text-[11px] text-muted-foreground whitespace-nowrap">
          <p>{row.startedAt ? new Date(row.startedAt).toLocaleDateString() : "Not started"}</p>
          <p>{row.endedAt ? new Date(row.endedAt).toLocaleDateString() : "—"}</p>
        </div>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (row) => (
        <button onClick={() => onOpenExperiment(row.id)} className="font-poppins text-[11px] font-medium text-primary hover:opacity-80 whitespace-nowrap">
          View
        </button>
      ),
      width: "60px",
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-primary" strokeWidth={2} />
          <div>
            <h2 className="font-poppins text-[14px] font-semibold text-foreground">Experiments Workspace</h2>
            <p className="font-poppins text-[11px] text-muted-foreground">Tracking-only A/B experiment records.</p>
          </div>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-1.5 font-poppins text-[12px] font-medium px-3.5 py-2 rounded-[8px] bg-primary text-primary-foreground"
        >
          <Plus className="w-3.5 h-3.5" strokeWidth={2.5} /> New experiment
        </button>
      </div>

      <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2">
        <select value={experimentFilters.status} onChange={(e) => setExperimentFilters({ status: e.target.value as AMIExperimentStatus | "all" })} className={selectClass()}>
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={experimentFilters.platform} onChange={(e) => setExperimentFilters({ platform: e.target.value as MIPlatform | "all" })} className={selectClass()}>
          {PLATFORM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={experimentFilters.metric} onChange={(e) => setExperimentFilters({ metric: e.target.value as AMIExperimentMetric | "all" })} className={selectClass()}>
          {METRIC_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
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
        rows={experiments}
        rowKey={(row) => row.id}
        isLoading={isLoadingExperiments}
        emptyLabel="No experiments match the current filters"
      />

      {showCreateModal && (
        <ExperimentFormModal
          mode="create"
          onClose={() => setShowCreateModal(false)}
          onSaved={(id) => { setShowCreateModal(false); onOpenExperiment(id); }}
        />
      )}
    </div>
  );
}