"use client";

import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { convertAERecommendationToPlan, fetchAERecommendationConversionContext } from "@/lib/advertising-execution.service";
import type { AERecommendationConversionContext } from "@/types/advertising-execution.types";

interface RecommendationConversionPageProps {
  recommendationId: string;
  onCreated: (planId: string) => void;
  onBack: () => void;
}

export default function RecommendationConversionPage({ recommendationId, onCreated, onBack }: RecommendationConversionPageProps) {
  const [context, setContext] = useState<AERecommendationConversionContext | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetchAERecommendationConversionContext(recommendationId).then((res) => {
      if (mounted) setContext(res);
    });
    return () => {
      mounted = false;
    };
  }, [recommendationId]);

  if (!context) {
    return <div className="h-40 rounded-[10px] bg-muted/40 animate-pulse" />;
  }

  const handleConvert = async () => {
    setSubmitting(true);
    try {
      const plan = await convertAERecommendationToPlan(recommendationId);
      onCreated(plan.id);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
        <ArrowLeft className="w-3.5 h-3.5" /> Back
      </button>

      <h2 className="font-poppins text-[14px] font-semibold text-foreground">Convert Recommendation to Plan</h2>

      <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-2">
        <span className="font-poppins text-[12px] font-medium text-foreground">{context.recommendationType}</span>
        <p className="font-poppins text-[12px] text-muted-foreground">{context.evidenceSummary}</p>
        <span className="font-poppins text-[11px] text-muted-foreground">
          Confidence: {(context.confidence * 100).toFixed(0)}% · Suggested: {context.suggestedProvider}
        </span>
      </div>

      <div className="rounded-[10px] border border-amber-200 bg-amber-50 p-3">
        <p className="font-poppins text-[12px] text-amber-700">
          Confidence does not lower approval requirements. This conversion only creates a DRAFT plan — it does not
          queue, execute, or activate anything.
        </p>
      </div>

      {context.existingDraftPlanId ? (
        <button
          onClick={() => onCreated(context.existingDraftPlanId!)}
          className="rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground w-fit"
        >
          Open Existing Draft
        </button>
      ) : (
        <button
          onClick={handleConvert}
          disabled={submitting}
          className="rounded-[8px] bg-primary px-4 py-2 font-poppins text-[12px] font-medium text-white disabled:opacity-50 w-fit"
        >
          {submitting ? "Creating..." : "Create DRAFT Plan"}
        </button>
      )}
    </div>
  );
}