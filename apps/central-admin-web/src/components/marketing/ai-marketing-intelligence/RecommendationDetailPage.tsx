"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, AlertCircle, ShieldAlert, ChevronDown } from "lucide-react";
import { useAIMarketingIntelligenceStore } from "@/stores/ai-marketing-intelligence.store";
import ProviderBadge, { type BadgeProvider } from "@/components/marketing/shared/ProviderBadge";
import StatusChip from "@/components/marketing/shared/StatusChip";
import DataSufficiencyBadge from "@/components/marketing/shared/DataSufficiencyBadge";
import EvidencePanel from "@/components/marketing/shared/EvidencePanel";
import ConvertToTaskModal from "./ConvertToTaskModal";

interface RecommendationDetailPageProps {
  id: string;
  onBack: () => void;
}

export default function RecommendationDetailPage({ id, onBack }: RecommendationDetailPageProps) {
  const {
    recommendationDetail,
    isLoadingRecommendationDetail,
    error,
    actionLoading,
    fetchRecommendationDetail,
    acceptRecommendation,
    dismissRecommendation,
  } = useAIMarketingIntelligenceStore();

  const [showTechnical, setShowTechnical] = useState(false);
  const [showConvertModal, setShowConvertModal] = useState(false);
  const [dismissReason, setDismissReason] = useState("");
  const [showDismissForm, setShowDismissForm] = useState(false);

  useEffect(() => {
    fetchRecommendationDetail(id);
  }, [id, fetchRecommendationDetail]);

  if (isLoadingRecommendationDetail && !recommendationDetail) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-8 w-40 rounded bg-muted animate-pulse" />
        <div className="h-56 rounded-[10px] bg-muted animate-pulse" />
      </div>
    );
  }

  if (error && !recommendationDetail) {
    return (
      <div className="flex flex-col gap-3">
        <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={2} /> Back to Recommendations
        </button>
        <div className="flex items-center gap-2 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" strokeWidth={2} />
          <p className="font-poppins text-[12px] text-red-700">{error}</p>
        </div>
      </div>
    );
  }

  if (!recommendationDetail) return null;
  const r = recommendationDetail;

  const evidenceRows = Object.entries(r.evidence).map(([label, value]) => ({
    label: label.replace(/([A-Z])/g, " $1").trim(),
    value: value as string | number | null,
  }));

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
        <ArrowLeft className="w-3.5 h-3.5" strokeWidth={2} /> Back to Recommendations
      </button>

      {/* Header */}
      <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusChip status={r.type} tone={r.type === "PAUSE" ? "danger" : r.type === "SCALE" ? "success" : "info"} />
            <StatusChip status={r.status} />
            <DataSufficiencyBadge value={r.dataSufficiency} />
          </div>
          <ProviderBadge provider={r.platform as BadgeProvider} subtitle={r.targetCampaignName ?? undefined} />
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-poppins text-muted-foreground">
          <span>Confidence: {(r.confidence * 100).toFixed(0)}%</span>
          <span>Currency: {r.currencyCode ?? "Not applicable"}</span>
          <span>Window: {r.analysisWindow.from} → {r.analysisWindow.to}</span>
          <span>Generated: {new Date(r.generatedAt).toLocaleString()}</span>
          {r.expiresAt && <span>Expires: {new Date(r.expiresAt).toLocaleString()}</span>}
        </div>
      </div>

      {/* Safety banner */}
      <div className="flex items-start gap-2 rounded-[10px] border border-blue-200 bg-blue-50 px-4 py-3">
        <ShieldAlert className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" strokeWidth={2} />
        <p className="font-poppins text-[12px] text-blue-800">
          This recommendation does not change the live advertising account. Review and convert it to an internal Task when action is required.
        </p>
      </div>

      {/* Reasoning */}
      <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-2">
        <h3 className="font-poppins text-[13px] font-semibold text-foreground">Reasoning</h3>
        <p className="font-poppins text-[12px] text-foreground leading-relaxed">{r.reasoning}</p>
      </div>

      {/* Evidence */}
      <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-3">
        <h3 className="font-poppins text-[13px] font-semibold text-foreground">Evidence</h3>
        <EvidencePanel rows={evidenceRows} />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
          {Object.entries(r.confidenceBreakdown).map(([key, value]) => (
            <div key={key}>
              <p className="font-poppins text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {key.replace(/([A-Z])/g, " $1").trim()}
              </p>
              <p className="font-poppins text-[13px] font-medium text-foreground mt-0.5">{(value * 100).toFixed(0)}%</p>
            </div>
          ))}
        </div>
      </div>

      {/* Technical details */}
      <div className="bg-card rounded-[10px] border border-border overflow-hidden">
        <button
          onClick={() => setShowTechnical((s) => !s)}
          className="w-full flex items-center justify-between px-4 sm:px-5 py-3.5 hover:bg-muted/30 transition-colors"
        >
          <span className="font-poppins text-[13px] font-semibold text-foreground">Technical details</span>
          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${showTechnical ? "rotate-180" : ""}`} strokeWidth={2} />
        </button>
        {showTechnical && (
          <div className="px-4 sm:px-5 pb-4 sm:pb-5 flex flex-col gap-1.5 font-poppins text-[11px] text-muted-foreground border-t border-border pt-3">
            <p>Rule code: {r.ruleCode}</p>
            <p>Rule version: {r.ruleVersion}</p>
            <p>Evidence fingerprint: {r.evidenceFingerprint}</p>
            <p>Suggested action: {r.suggestedAction.action}</p>
          </div>
        )}
      </div>

      {/* History */}
      {r.history.length > 0 && (
        <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-2">
          <h3 className="font-poppins text-[13px] font-semibold text-foreground">History</h3>
          <div className="flex flex-col gap-1.5">
            {r.history.map((h, i) => (
              <div key={i} className="flex items-center justify-between gap-2 text-[11px] font-poppins">
                <span className="text-foreground">{h.event}</span>
                <span className="text-muted-foreground">{new Date(h.at).toLocaleString()}{h.actor ? ` · ${h.actor}` : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" strokeWidth={2} />
          <p className="font-poppins text-[12px] text-red-700">{error}</p>
        </div>
      )}

      {/* Actions */}
      {r.status === "PENDING" && (
        <div className="flex flex-col sm:flex-row gap-2 sticky bottom-0 bg-background/95 backdrop-blur-sm py-3 border-t border-border sm:border-0 sm:bg-transparent sm:py-0">
          <button
            onClick={() => acceptRecommendation(r.id)}
            disabled={actionLoading === `accept-${r.id}`}
            className="font-poppins text-[12px] font-medium px-4 py-2.5 rounded-[8px] bg-primary text-primary-foreground disabled:opacity-50 flex-1 sm:flex-none"
          >
            {actionLoading === `accept-${r.id}` ? "Accepting…" : "Accept"}
          </button>
          {!showDismissForm ? (
            <button
              onClick={() => setShowDismissForm(true)}
              className="font-poppins text-[12px] font-medium px-4 py-2.5 rounded-[8px] border border-border text-foreground hover:border-muted-foreground/40 flex-1 sm:flex-none"
            >
              Dismiss
            </button>
          ) : (
            <div className="flex flex-col sm:flex-row gap-2 flex-1">
              <input
                value={dismissReason}
                onChange={(e) => setDismissReason(e.target.value)}
                placeholder="Reason (optional)"
                className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-3 py-2.5 flex-1"
              />
              <button
                onClick={() => { dismissRecommendation(r.id, dismissReason || undefined); setShowDismissForm(false); }}
                disabled={actionLoading === `dismiss-${r.id}`}
                className="font-poppins text-[12px] font-medium px-4 py-2.5 rounded-[8px] bg-red-600 text-white disabled:opacity-50"
              >
                Confirm dismiss
              </button>
            </div>
          )}
        </div>
      )}

      {r.status === "ACCEPTED" && !r.convertedTaskId && (
        <div className="sticky bottom-0 bg-background/95 backdrop-blur-sm py-3 border-t border-border sm:border-0 sm:bg-transparent sm:py-0">
          <button
            onClick={() => setShowConvertModal(true)}
            className="font-poppins text-[12px] font-medium px-4 py-2.5 rounded-[8px] bg-primary text-primary-foreground w-full sm:w-auto"
          >
            Convert to Task
          </button>
        </div>
      )}

      {r.status === "CONVERTED_TO_TASK" && r.convertedTaskId && (
        <div className="rounded-[10px] border border-green-200 bg-green-50 px-4 py-3">
          <p className="font-poppins text-[12px] text-green-800">
            Converted to Task <span className="font-medium">{r.convertedTaskId}</span>
          </p>
        </div>
      )}

      {showConvertModal && (
        <ConvertToTaskModal
          recommendation={r}
          onClose={() => setShowConvertModal(false)}
          onSuccess={() => setShowConvertModal(false)}
        />
      )}
    </div>
  );
}