"use client";

import { useState } from "react";
import { X, AlertCircle, CheckCircle2 } from "lucide-react";
import { useAIMarketingIntelligenceStore } from "@/stores/ai-marketing-intelligence.store";
import type { AMIManualOperationType, MIPlatform } from "@/types/ai-marketing-intelligence.types";

const OPERATION_LABELS: Record<AMIManualOperationType, { label: string; description: string }> = {
  PHASE1_SYNC: { label: "Phase 1 sync", description: "Bounded read-only sync of campaign/day performance data." },
  CREATIVE_SYNC: { label: "Creative sync", description: "Fetch and normalise creative catalog data from the provider." },
  CREATIVE_SCORE: { label: "Creative score", description: "Recompute creative scores over the analysis and comparison windows." },
  RECOMMENDATION_EVALUATE: { label: "Recommendation evaluate", description: "Generate advisory recommendations from current evidence." },
  ALERT_EVALUATE: { label: "Alert evaluate", description: "Evaluate operational and performance alert conditions." },
};

const PLATFORM_OPTIONS: { value: MIPlatform | ""; label: string }[] = [
  { value: "", label: "All platforms" },
  { value: "META", label: "Meta" },
  { value: "TIKTOK", label: "TikTok" },
  { value: "X", label: "X" },
  { value: "LINKEDIN", label: "LinkedIn" },
  { value: "GOOGLE_ADS", label: "Google Ads" },
];

interface ManualOperationsModalProps {
  operation: AMIManualOperationType;
  onClose: () => void;
}

export default function ManualOperationsModal({ operation, onClose }: ManualOperationsModalProps) {
  const { isRunningOperation, lastOperationResult, error, runManualOperation } = useAIMarketingIntelligenceStore();

  const [platform, setPlatform] = useState<MIPlatform | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [alertContext, setAlertContext] = useState<"HEALTH" | "PERFORMANCE">("HEALTH");
  const [submitted, setSubmitted] = useState(false);

  const meta = OPERATION_LABELS[operation];
  const needsDateRange = operation === "PHASE1_SYNC" || operation === "CREATIVE_SYNC" || operation === "CREATIVE_SCORE";
  const needsAlertContext = operation === "ALERT_EVALUATE";

  const handleSubmit = async () => {
    setSubmitted(true);
    await runManualOperation({
      operation,
      platform: platform || undefined,
      from: from || undefined,
      to: to || undefined,
      analysisWindow: from && to ? { from, to } : undefined,
      alertContext: needsAlertContext ? alertContext : undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div className="relative w-full sm:max-w-md bg-card rounded-t-[16px] sm:rounded-[14px] border border-border shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 border-b border-border sticky top-0 bg-card">
          <h3 className="font-poppins text-[14px] font-semibold text-foreground">{meta.label}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" strokeWidth={2} />
          </button>
        </div>

        <div className="p-4 sm:p-5 flex flex-col gap-4">
          <p className="font-poppins text-[12px] text-muted-foreground">{meta.description}</p>

          {!submitted || (submitted && error) ? (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="font-poppins text-[12px] font-medium text-foreground">Platform / connection scope</label>
                <select
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value as MIPlatform | "")}
                  className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-2.5 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  {PLATFORM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>

              {needsDateRange && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label className="font-poppins text-[12px] font-medium text-foreground">From</label>
                    <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-2.5 py-2" />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="font-poppins text-[12px] font-medium text-foreground">To</label>
                    <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-2.5 py-2" />
                  </div>
                </div>
              )}

              {needsAlertContext && (
                <div className="flex flex-col gap-1.5">
                  <label className="font-poppins text-[12px] font-medium text-foreground">Alert context</label>
                  <select
                    value={alertContext}
                    onChange={(e) => setAlertContext(e.target.value as "HEALTH" | "PERFORMANCE")}
                    className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-2.5 py-2"
                  >
                    <option value="HEALTH">Operational health</option>
                    <option value="PERFORMANCE">Performance</option>
                  </select>
                </div>
              )}

              {error && (
                <div className="flex items-center gap-2 rounded-[8px] border border-red-200 bg-red-50 px-3 py-2.5">
                  <AlertCircle className="w-3.5 h-3.5 text-red-600 shrink-0" strokeWidth={2} />
                  <p className="font-poppins text-[11px] text-red-700">{error}</p>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center gap-2 rounded-[8px] border border-green-200 bg-green-50 px-3 py-2.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" strokeWidth={2} />
              <p className="font-poppins text-[11px] text-green-700">
                {lastOperationResult ? `Run started (${lastOperationResult.runId}). Processed: ${lastOperationResult.summary.processed ?? 0}.` : "Operation submitted."}
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 sm:px-5 py-3.5 border-t border-border sticky bottom-0 bg-card">
          <button onClick={onClose} className="font-poppins text-[12px] font-medium px-3.5 py-2 rounded-[8px] border border-border text-foreground hover:border-muted-foreground/40">
            {submitted && !error ? "Close" : "Cancel"}
          </button>
          {(!submitted || error) && (
            <button
              onClick={handleSubmit}
              disabled={isRunningOperation}
              className="font-poppins text-[12px] font-medium px-3.5 py-2 rounded-[8px] bg-primary text-primary-foreground disabled:opacity-50"
            >
              {isRunningOperation ? "Running…" : "Run"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}