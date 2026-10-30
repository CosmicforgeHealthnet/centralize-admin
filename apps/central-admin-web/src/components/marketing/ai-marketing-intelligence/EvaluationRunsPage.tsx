"use client";

import { useEffect, useState } from "react";
import { History, AlertCircle, Play } from "lucide-react";
import { useAIMarketingIntelligenceStore } from "@/stores/ai-marketing-intelligence.store";
import DataTable, { type DataTableColumn } from "@/components/marketing/shared/DataTable";
import ProviderBadge, { type BadgeProvider } from "@/components/marketing/shared/ProviderBadge";
import RunStatusBadge from "@/components/marketing/shared/RunStatusBadge";
import ManualOperationsModal from "./ManualOperationsModal";
import type { AMIEvaluationRunListItem, AMIEvaluationRunStatus, AMIEvaluationRunType, MIPlatform, AMIManualOperationType } from "@/types/ai-marketing-intelligence.types";

const TYPE_OPTIONS: { value: AMIEvaluationRunType | "all"; label: string }[] = [
  { value: "all", label: "All run types" },
  { value: "CREATIVE_SYNC", label: "Creative sync" },
  { value: "SCORE", label: "Score" },
  { value: "RECOMMEND", label: "Recommend" },
  { value: "ALERT", label: "Alert" },
  { value: "FULL_EVALUATION", label: "Full evaluation" },
];

const STATUS_OPTIONS: { value: AMIEvaluationRunStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "PENDING", label: "Pending" },
  { value: "RUNNING", label: "Running" },
  { value: "PARTIAL_SUCCESS", label: "Partial success" },
  { value: "SUCCEEDED", label: "Succeeded" },
  { value: "FAILED", label: "Failed" },
  { value: "SKIPPED_LOCKED", label: "Skipped (locked)" },
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

const MANUAL_OPS: { operation: AMIManualOperationType; label: string }[] = [
  { operation: "PHASE1_SYNC", label: "Phase 1 sync" },
  { operation: "CREATIVE_SYNC", label: "Creative sync" },
  { operation: "CREATIVE_SCORE", label: "Creative score" },
  { operation: "RECOMMENDATION_EVALUATE", label: "Recommendation evaluate" },
  { operation: "ALERT_EVALUATE", label: "Alert evaluate" },
];

interface EvaluationRunsPageProps {
  onOpenRun: (id: string) => void;
}

export default function EvaluationRunsPage({ onOpenRun }: EvaluationRunsPageProps) {
  const { evaluationRuns, runFilters, isLoadingRuns, error, fetchEvaluationRuns, setRunFilters } = useAIMarketingIntelligenceStore();
  const [activeOperation, setActiveOperation] = useState<AMIManualOperationType | null>(null);
  const [showOpsMenu, setShowOpsMenu] = useState(false);

  useEffect(() => {
    fetchEvaluationRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns: DataTableColumn<AMIEvaluationRunListItem>[] = [
    {
      key: "type",
      header: "Run type",
      render: (row) => <span className="font-poppins text-[12px] font-medium text-foreground">{row.runType.replace(/_/g, " ")}</span>,
    },
    {
      key: "trigger",
      header: "Trigger",
      render: (row) => <span className="font-poppins text-[11px] text-muted-foreground">{row.trigger}</span>,
      width: "90px",
    },
    {
      key: "status",
      header: "Status",
      render: (row) => <RunStatusBadge value={row.status} />,
    },
    {
      key: "scope",
      header: "Scope",
      render: (row) => (row.platform ? <ProviderBadge provider={row.platform as BadgeProvider} size="sm" /> : <span className="font-poppins text-[11px] text-muted-foreground">All platforms</span>),
    },
    {
      key: "counters",
      header: "Processed / Failed",
      render: (row) => (
        <span className="font-poppins text-[11px] text-foreground whitespace-nowrap">
          {row.processed} processed · {row.failed} failed
        </span>
      ),
    },
    {
      key: "timing",
      header: "Started / Duration",
      render: (row) => (
        <div className="font-poppins text-[11px] text-muted-foreground whitespace-nowrap">
          <p>{row.startedAt ? new Date(row.startedAt).toLocaleString() : "—"}</p>
          <p>{row.durationMs !== null ? `${(row.durationMs / 1000).toFixed(1)}s` : "—"}</p>
        </div>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (row) => (
        <button onClick={() => onOpenRun(row.id)} className="font-poppins text-[11px] font-medium text-primary hover:opacity-80 whitespace-nowrap">
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
          <History className="w-4 h-4 text-primary" strokeWidth={2} />
          <div>
            <h2 className="font-poppins text-[14px] font-semibold text-foreground">Evaluation Runs</h2>
            <p className="font-poppins text-[11px] text-muted-foreground">Sync, scoring, recommendation and alert run history.</p>
          </div>
        </div>

        <div className="relative">
          <button
            onClick={() => setShowOpsMenu((s) => !s)}
            className="flex items-center gap-1.5 font-poppins text-[12px] font-medium px-3.5 py-2 rounded-[8px] bg-primary text-primary-foreground"
          >
            <Play className="w-3.5 h-3.5" strokeWidth={2.5} /> Run manual operation
          </button>
          {showOpsMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowOpsMenu(false)} />
              <div className="absolute right-0 mt-1.5 w-52 bg-card border border-border rounded-[10px] shadow-lg z-20 py-1.5">
                {MANUAL_OPS.map((op) => (
                  <button
                    key={op.operation}
                    onClick={() => { setActiveOperation(op.operation); setShowOpsMenu(false); }}
                    className="w-full text-left font-poppins text-[12px] px-3.5 py-2 text-foreground hover:bg-muted/50"
                  >
                    {op.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2">
        <select value={runFilters.runType} onChange={(e) => setRunFilters({ runType: e.target.value as AMIEvaluationRunType | "all" })} className={selectClass()}>
          {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={runFilters.status} onChange={(e) => setRunFilters({ status: e.target.value as AMIEvaluationRunStatus | "all" })} className={selectClass()}>
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={runFilters.platform} onChange={(e) => setRunFilters({ platform: e.target.value as MIPlatform | "all" })} className={selectClass()}>
          {PLATFORM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
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
        rows={evaluationRuns}
        rowKey={(row) => row.id}
        isLoading={isLoadingRuns}
        emptyLabel="No evaluation runs match the current filters"
      />

      {activeOperation && (
        <ManualOperationsModal operation={activeOperation} onClose={() => { setActiveOperation(null); fetchEvaluationRuns(); }} />
      )}
    </div>
  );
}