"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, AlertCircle, ShieldAlert, Pencil } from "lucide-react";
import { useAIMarketingIntelligenceStore } from "@/stores/ai-marketing-intelligence.store";
import ProviderBadge, { type BadgeProvider } from "@/components/marketing/shared/ProviderBadge";
import StatusChip from "@/components/marketing/shared/StatusChip";
import ExperimentFormModal from "./ExperimentFormModal";

interface ExperimentDetailPageProps {
  id: string;
  onBack: () => void;
}

export default function ExperimentDetailPage({ id, onBack }: ExperimentDetailPageProps) {
  const {
    experimentDetail,
    isLoadingExperimentDetail,
    error,
    actionLoading,
    fetchExperimentDetail,
    startExperiment,
    completeExperiment,
    cancelExperiment,
  } = useAIMarketingIntelligenceStore();

  const [showEditModal, setShowEditModal] = useState(false);
  const [showCompleteForm, setShowCompleteForm] = useState(false);
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [result, setResult] = useState("");
  const [conclusion, setConclusion] = useState("");
  const [cancelReason, setCancelReason] = useState("");

  useEffect(() => {
    fetchExperimentDetail(id);
  }, [id, fetchExperimentDetail]);

  if (isLoadingExperimentDetail && !experimentDetail) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-8 w-32 rounded bg-muted animate-pulse" />
        <div className="h-56 rounded-[10px] bg-muted animate-pulse" />
      </div>
    );
  }

  if (error && !experimentDetail) {
    return (
      <div className="flex flex-col gap-3">
        <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={2} /> Back to Experiments
        </button>
        <div className="flex items-center gap-2 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" strokeWidth={2} />
          <p className="font-poppins text-[12px] text-red-700">{error}</p>
        </div>
      </div>
    );
  }

  if (!experimentDetail) return null;
  const e = experimentDetail;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={2} /> Back to Experiments
        </button>
        {e.status === "DRAFT" && (
          <button
            onClick={() => setShowEditModal(true)}
            className="flex items-center gap-1.5 font-poppins text-[12px] font-medium text-primary hover:opacity-80"
          >
            <Pencil className="w-3.5 h-3.5" strokeWidth={2} /> Edit draft
          </button>
        )}
      </div>

      {/* Header */}
      <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <StatusChip status={e.status} />
          {e.platform && <ProviderBadge provider={e.platform as BadgeProvider} />}
        </div>
        <div>
          <h2 className="font-poppins text-[15px] font-semibold text-foreground">{e.name}</h2>
          <p className="font-poppins text-[12px] text-muted-foreground mt-1 leading-relaxed">{e.hypothesis}</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-poppins text-muted-foreground">
          <span>Metric: {e.metric.replace(/_/g, " ")}</span>
          <span>Owner: {e.owner ?? "Unassigned"}</span>
          {e.campaignExternalId && <span>Campaign: {e.campaignExternalId}</span>}
        </div>
      </div>

      {/* Safety banner */}
      <div className="flex items-start gap-2 rounded-[10px] border border-blue-200 bg-blue-50 px-4 py-3">
        <ShieldAlert className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" strokeWidth={2} />
        <p className="font-poppins text-[12px] text-blue-800">
          This record tracks an experiment only. It does not publish, pause, edit or deploy anything to an advertising provider.
        </p>
      </div>

      {/* Variants */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {e.variants.map((v) => (
          <div key={v.key} className="bg-card rounded-[10px] border border-border p-4 sm:p-5">
            <p className="font-poppins text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              Variant {v.key} — {v.label}
            </p>
            <div className="mt-2 flex flex-col gap-1">
              {Object.entries(v.config).map(([k, val]) => (
                <p key={k} className="font-poppins text-[12px] text-foreground">
                  <span className="text-muted-foreground">{k}:</span> {val}
                </p>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Result / conclusion */}
      {(e.result || e.conclusion) && (
        <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-2">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">Result</h3>
          {e.result && <p className="font-poppins text-[12px] text-foreground">{e.result}</p>}
          {e.conclusion && (
            <p className="font-poppins text-[12px] text-muted-foreground pt-1 border-t border-border/70">
              Conclusion: {e.conclusion}
            </p>
          )}
        </div>
      )}

      {e.cancelReason && (
        <div className="rounded-[10px] border border-border bg-muted/30 px-4 py-3">
          <p className="font-poppins text-[12px] text-muted-foreground">Cancelled: {e.cancelReason}</p>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" strokeWidth={2} />
          <p className="font-poppins text-[12px] text-red-700">{error}</p>
        </div>
      )}

      {/* Actions */}
      {e.status === "DRAFT" && (
        <div className="flex flex-col sm:flex-row gap-2 sticky bottom-0 bg-background/95 backdrop-blur-sm py-3 border-t border-border sm:border-0 sm:bg-transparent sm:py-0">
          <button
            onClick={() => startExperiment(e.id)}
            disabled={actionLoading === `start-${e.id}`}
            className="font-poppins text-[12px] font-medium px-4 py-2.5 rounded-[8px] bg-primary text-primary-foreground disabled:opacity-50 flex-1 sm:flex-none"
          >
            {actionLoading === `start-${e.id}` ? "Starting…" : "Start"}
          </button>
          {!showCancelForm ? (
            <button
              onClick={() => setShowCancelForm(true)}
              className="font-poppins text-[12px] font-medium px-4 py-2.5 rounded-[8px] border border-border text-foreground hover:border-muted-foreground/40 flex-1 sm:flex-none"
            >
              Cancel experiment
            </button>
          ) : (
            <div className="flex flex-col sm:flex-row gap-2 flex-1">
              <input
                value={cancelReason}
                onChange={(e2) => setCancelReason(e2.target.value)}
                placeholder="Cancellation reason"
                className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-3 py-2.5 flex-1"
              />
              <button
                onClick={() => { cancelExperiment(e.id, cancelReason || undefined); setShowCancelForm(false); }}
                className="font-poppins text-[12px] font-medium px-4 py-2.5 rounded-[8px] bg-red-600 text-white"
              >
                Confirm cancel
              </button>
            </div>
          )}
        </div>
      )}

      {e.status === "RUNNING" && (
        <div className="flex flex-col gap-2 sticky bottom-0 bg-background/95 backdrop-blur-sm py-3 border-t border-border sm:border-0 sm:bg-transparent sm:py-0">
          {!showCompleteForm ? (
            <div className="flex flex-col sm:flex-row gap-2">
              <button
                onClick={() => setShowCompleteForm(true)}
                className="font-poppins text-[12px] font-medium px-4 py-2.5 rounded-[8px] bg-primary text-primary-foreground flex-1 sm:flex-none"
              >
                Complete experiment
              </button>
              {!showCancelForm ? (
                <button
                  onClick={() => setShowCancelForm(true)}
                  className="font-poppins text-[12px] font-medium px-4 py-2.5 rounded-[8px] border border-border text-foreground hover:border-muted-foreground/40 flex-1 sm:flex-none"
                >
                  Cancel
                </button>
              ) : (
                <div className="flex flex-col sm:flex-row gap-2 flex-1">
                  <input
                    value={cancelReason}
                    onChange={(e2) => setCancelReason(e2.target.value)}
                    placeholder="Cancellation reason (required)"
                    className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-3 py-2.5 flex-1"
                  />
                  <button
                    onClick={() => { if (cancelReason.trim()) { cancelExperiment(e.id, cancelReason); setShowCancelForm(false); } }}
                    disabled={!cancelReason.trim()}
                    className="font-poppins text-[12px] font-medium px-4 py-2.5 rounded-[8px] bg-red-600 text-white disabled:opacity-50"
                  >
                    Confirm cancel
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2 bg-card border border-border rounded-[10px] p-3.5">
              <textarea
                value={result}
                onChange={(e2) => setResult(e2.target.value)}
                placeholder="Result (required) — e.g. Variant B outperformed control by 18% CTR"
                rows={2}
                className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-3 py-2 resize-none"
              />
              <textarea
                value={conclusion}
                onChange={(e2) => setConclusion(e2.target.value)}
                placeholder="Conclusion (recommended)"
                rows={2}
                className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-3 py-2 resize-none"
              />
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setShowCompleteForm(false)}
                  className="font-poppins text-[12px] font-medium px-3.5 py-2 rounded-[8px] border border-border text-foreground"
                >
                  Cancel
                </button>
                <button
                  onClick={() => { if (result.trim()) { completeExperiment(e.id, { result, conclusion: conclusion || undefined }); setShowCompleteForm(false); } }}
                  disabled={!result.trim()}
                  className="font-poppins text-[12px] font-medium px-3.5 py-2 rounded-[8px] bg-primary text-primary-foreground disabled:opacity-50"
                >
                  Submit result
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {showEditModal && (
        <ExperimentFormModal
          mode="edit"
          experiment={e}
          onClose={() => setShowEditModal(false)}
          onSaved={() => { setShowEditModal(false); fetchExperimentDetail(e.id); }}
        />
      )}
    </div>
  );
}