"use client";

import { useEffect } from "react";
import { ArrowLeft, AlertCircle } from "lucide-react";
import { useAIMarketingIntelligenceStore } from "@/stores/ai-marketing-intelligence.store";
import ProviderBadge, { type BadgeProvider } from "@/components/marketing/shared/ProviderBadge";
import RunStatusBadge from "@/components/marketing/shared/RunStatusBadge";

interface EvaluationRunDetailPageProps {
  id: string;
  onBack: () => void;
}

export default function EvaluationRunDetailPage({ id, onBack }: EvaluationRunDetailPageProps) {
  const { runDetail, isLoadingRunDetail, error, fetchRunDetail } = useAIMarketingIntelligenceStore();

  useEffect(() => {
    fetchRunDetail(id);
  }, [id, fetchRunDetail]);

  if (isLoadingRunDetail && !runDetail) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-8 w-32 rounded bg-muted animate-pulse" />
        <div className="h-56 rounded-[10px] bg-muted animate-pulse" />
      </div>
    );
  }

  if (error && !runDetail) {
    return (
      <div className="flex flex-col gap-3">
        <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={2} /> Back to Evaluation Runs
        </button>
        <div className="flex items-center gap-2 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" strokeWidth={2} />
          <p className="font-poppins text-[12px] text-red-700">{error}</p>
        </div>
      </div>
    );
  }

  if (!runDetail) return null;
  const r = runDetail;

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
        <ArrowLeft className="w-3.5 h-3.5" strokeWidth={2} /> Back to Evaluation Runs
      </button>

      {/* Header */}
      <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-poppins text-[15px] font-semibold text-foreground">{r.runType.replace(/_/g, " ")}</h2>
            <p className="font-poppins text-[11px] text-muted-foreground mt-0.5">Trigger: {r.trigger} {r.actor && `· ${r.actor}`}</p>
          </div>
          <RunStatusBadge value={r.status} />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
          <div>
            <p className="font-poppins text-[10px] uppercase tracking-wide text-muted-foreground/70">Processed</p>
            <p className="font-poppins text-[16px] font-semibold text-foreground">{r.processed}</p>
          </div>
          <div>
            <p className="font-poppins text-[10px] uppercase tracking-wide text-muted-foreground/70">Created</p>
            <p className="font-poppins text-[16px] font-semibold text-foreground">{r.created}</p>
          </div>
          <div>
            <p className="font-poppins text-[10px] uppercase tracking-wide text-muted-foreground/70">Updated</p>
            <p className="font-poppins text-[16px] font-semibold text-foreground">{r.updated}</p>
          </div>
          <div>
            <p className="font-poppins text-[10px] uppercase tracking-wide text-muted-foreground/70">Failed</p>
            <p className={`font-poppins text-[16px] font-semibold ${r.failed > 0 ? "text-red-600" : "text-foreground"}`}>{r.failed}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-poppins text-muted-foreground pt-1 border-t border-border/70">
          <span>Started: {r.startedAt ? new Date(r.startedAt).toLocaleString() : "—"}</span>
          <span>Completed: {r.completedAt ? new Date(r.completedAt).toLocaleString() : "—"}</span>
          <span>Duration: {r.durationMs !== null ? `${(r.durationMs / 1000).toFixed(1)}s` : "—"}</span>
          {r.dateWindow && <span>Window: {r.dateWindow.from} → {r.dateWindow.to}</span>}
        </div>
      </div>

      {r.status === "SKIPPED_LOCKED" && (
        <div className="rounded-[10px] border border-border bg-muted/30 px-4 py-3">
          <p className="font-poppins text-[12px] text-muted-foreground">
            This run was skipped because another run held the lock. This is informational, not a system failure.
          </p>
        </div>
      )}

      {/* Timeline */}
      <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-3">
        <h3 className="font-poppins text-[13px] font-semibold text-foreground">Timeline</h3>
        <div className="flex flex-col gap-2">
          {r.timeline.map((t, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-primary shrink-0" />
              <span className="font-poppins text-[12px] text-foreground flex-1">{t.label}</span>
              <span className="font-poppins text-[11px] text-muted-foreground whitespace-nowrap">
                {t.at ? new Date(t.at).toLocaleTimeString() : "—"}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Per-platform results */}
      {r.platformResults.length > 0 && (
        <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-3">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">Per-Platform Results</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {r.platformResults.map((pr, i) => (
              <div key={i} className="rounded-[8px] border border-border p-3 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <ProviderBadge provider={pr.platform as BadgeProvider} size="sm" />
                  <RunStatusBadge value={pr.status} />
                </div>
                <div className="font-poppins text-[11px] text-muted-foreground">
                  {pr.processed} processed · {pr.created} created · {pr.updated} updated · {pr.failed} failed
                </div>
                {pr.errorCategory && (
                  <p className="font-poppins text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-[6px] px-2 py-1">
                    {pr.errorCategory} {pr.retryable === false && "· Not retryable"}
                  </p>
                )}
                {pr.safeRequestId && (
                  <p className="font-poppins text-[10px] text-muted-foreground">Request ID: {pr.safeRequestId}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}