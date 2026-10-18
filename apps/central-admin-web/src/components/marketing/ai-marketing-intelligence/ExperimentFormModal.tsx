"use client";

import { useEffect, useState } from "react";
import { X, AlertCircle } from "lucide-react";
import { useAIMarketingIntelligenceStore } from "@/stores/ai-marketing-intelligence.store";
import type {
  AMIExperimentDetail,
  AMIExperimentMetric,
  AMIExperimentVariant,
  MIPlatform,
} from "@/types/ai-marketing-intelligence.types";

const METRIC_OPTIONS: { value: AMIExperimentMetric; label: string }[] = [
  { value: "CTR", label: "CTR" },
  { value: "CPC", label: "CPC" },
  { value: "CPA", label: "CPA" },
  { value: "CONVERSION_RATE", label: "Conversion rate" },
  { value: "ROAS", label: "ROAS" },
  { value: "ENGAGEMENT_RATE", label: "Engagement rate" },
];

const PLATFORM_OPTIONS: { value: MIPlatform | ""; label: string }[] = [
  { value: "", label: "No platform context" },
  { value: "META", label: "Meta" },
  { value: "TIKTOK", label: "TikTok" },
  { value: "X", label: "X" },
  { value: "LINKEDIN", label: "LinkedIn" },
  { value: "GOOGLE_ADS", label: "Google Ads" },
];

interface ExperimentFormModalProps {
  mode: "create" | "edit";
  experiment?: AMIExperimentDetail;
  onClose: () => void;
  onSaved: (id: string) => void;
}

export default function ExperimentFormModal({ mode, experiment, onClose, onSaved }: ExperimentFormModalProps) {
  const { createExperiment, updateExperiment, actionLoading, error, clearError } = useAIMarketingIntelligenceStore();

  const [name, setName] = useState(experiment?.name ?? "");
  const [hypothesis, setHypothesis] = useState(experiment?.hypothesis ?? "");
  const [platform, setPlatform] = useState<MIPlatform | "">(experiment?.platform ?? "");
  const [campaignExternalId, setCampaignExternalId] = useState(experiment?.campaignExternalId ?? "");
  const [metric, setMetric] = useState<AMIExperimentMetric>(experiment?.metric ?? "CTR");
  const [variantA, setVariantA] = useState(experiment?.variants[0]?.config?.format ?? "");
  const [variantB, setVariantB] = useState(experiment?.variants[1]?.config?.format ?? "");

  useEffect(() => () => clearError(), [clearError]);

  const isValid = name.trim().length > 0 && hypothesis.trim().length > 0 && variantA.trim().length > 0 && variantB.trim().length > 0;

  const handleSubmit = async () => {
    if (!isValid) return;
    const variants: AMIExperimentVariant[] = [
      { key: "A", label: "Control", config: { format: variantA } },
      { key: "B", label: "Variant", config: { format: variantB } },
    ];

    if (mode === "create") {
      const created = await createExperiment({
        name,
        hypothesis,
        platform: platform || undefined,
        campaignExternalId: campaignExternalId || undefined,
        metric,
        variants,
      });
      if (created) onSaved(created.id);
    } else if (experiment) {
      await updateExperiment(experiment.id, {
        name,
        hypothesis,
        platform: platform || undefined,
        campaignExternalId: campaignExternalId || undefined,
        metric,
        variants,
      });
      onSaved(experiment.id);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div className="relative w-full sm:max-w-lg bg-card rounded-t-[16px] sm:rounded-[14px] border border-border shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 border-b border-border sticky top-0 bg-card z-10">
          <h3 className="font-poppins text-[14px] font-semibold text-foreground">
            {mode === "create" ? "Create Experiment" : "Edit Experiment"}
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" strokeWidth={2} />
          </button>
        </div>

        <div className="p-4 sm:p-5 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="font-poppins text-[12px] font-medium text-foreground">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Carousel vs Single Image — Checkup Promo"
              className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="font-poppins text-[12px] font-medium text-foreground">Hypothesis</label>
            <textarea
              value={hypothesis}
              onChange={(e) => setHypothesis(e.target.value)}
              placeholder="A testable statement of what you expect to happen"
              rows={3}
              className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="font-poppins text-[12px] font-medium text-foreground">Platform (optional)</label>
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value as MIPlatform | "")}
                className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-2.5 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {PLATFORM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="font-poppins text-[12px] font-medium text-foreground">Metric</label>
              <select
                value={metric}
                onChange={(e) => setMetric(e.target.value as AMIExperimentMetric)}
                className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-2.5 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {METRIC_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="font-poppins text-[12px] font-medium text-foreground">Campaign (optional)</label>
            <input
              value={campaignExternalId}
              onChange={(e) => setCampaignExternalId(e.target.value)}
              placeholder="External campaign ID"
              className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="font-poppins text-[12px] font-medium text-foreground">Variant A (control)</label>
              <input
                value={variantA}
                onChange={(e) => setVariantA(e.target.value)}
                placeholder="e.g. Single image"
                className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="font-poppins text-[12px] font-medium text-foreground">Variant B</label>
              <input
                value={variantB}
                onChange={(e) => setVariantB(e.target.value)}
                placeholder="e.g. Carousel"
                className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <p className="font-poppins text-[11px] text-muted-foreground bg-muted/40 rounded-[8px] px-3 py-2">
            This record tracks an experiment only. It does not publish, pause, edit or deploy anything to an advertising provider.
          </p>

          {error && (
            <div className="flex items-center gap-2 rounded-[8px] border border-red-200 bg-red-50 px-3 py-2.5">
              <AlertCircle className="w-3.5 h-3.5 text-red-600 shrink-0" strokeWidth={2} />
              <p className="font-poppins text-[11px] text-red-700">{error}</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 sm:px-5 py-3.5 border-t border-border sticky bottom-0 bg-card">
          <button
            onClick={onClose}
            className="font-poppins text-[12px] font-medium px-3.5 py-2 rounded-[8px] border border-border text-foreground hover:border-muted-foreground/40"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!isValid || actionLoading === "create-experiment" || actionLoading?.startsWith("update-")}
            className="font-poppins text-[12px] font-medium px-3.5 py-2 rounded-[8px] bg-primary text-primary-foreground disabled:opacity-50"
          >
            {actionLoading === "create-experiment" || actionLoading?.startsWith("update-") ? "Saving…" : mode === "create" ? "Create draft" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}