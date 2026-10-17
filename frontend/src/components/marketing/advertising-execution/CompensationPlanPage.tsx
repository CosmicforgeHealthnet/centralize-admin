"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { createAECompensationPlan, fetchAEIncidentDetail } from "@/lib/advertising-execution.service";
import type { AEIncidentDetail } from "@/types/advertising-execution.types";

interface CompensationPlanPageProps {
  incidentId: string;
  onDone: (planId: string) => void;
  onBack: () => void;
}

export default function CompensationPlanPage({ incidentId, onDone, onBack }: CompensationPlanPageProps) {
  const [incident, setIncident] = useState<AEIncidentDetail | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetchAEIncidentDetail(incidentId).then((res) => {
      if (mounted) setIncident(res);
    });
    return () => {
      mounted = false;
    };
  }, [incidentId]);

  if (!incident) {
    return <div className="h-40 rounded-[10px] bg-muted/40 animate-pulse" />;
  }

  const handleCreate = async () => {
    if (!reason.trim()) return;
    setSubmitting(true);
    try {
      const plan = await createAECompensationPlan({
        originalPlanId: incident.planId,
        originalRunId: incident.runId,
        originalOperationId: incident.operationId,
        incidentId: incident.id,
        reason: reason.trim(),
        proposedItems: [],
      });
      onDone(plan.id);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Incident
      </button>

      <h2 className="font-poppins text-[14px] font-semibold text-foreground">Create Compensation Plan</h2>

      <div className="rounded-[10px] border border-amber-200 bg-amber-50 p-3 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
        <span className="font-poppins text-[12px] text-amber-700">
          Compensation creates a new plan. It cannot erase delivery or spend that has already occurred, and follows the
          same validate → approve → queue workflow as any other plan.
        </span>
      </div>

      {/* Original / actual / proposed */}
      <div className="rounded-[10px] border border-border bg-card p-4 grid grid-cols-1 min-[700px]:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="font-poppins text-[11px] font-semibold text-muted-foreground">Original / Expected</span>
          <pre className="font-poppins text-[11px] text-foreground whitespace-pre-wrap">
            {JSON.stringify(incident.expectedState, null, 2)}
          </pre>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="font-poppins text-[11px] font-semibold text-muted-foreground">Actual</span>
          <pre className="font-poppins text-[11px] text-foreground whitespace-pre-wrap">
            {incident.actualState && Object.keys(incident.actualState).length > 0
              ? JSON.stringify(incident.actualState, null, 2)
              : "Not yet read back."}
          </pre>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="font-poppins text-[11px] font-medium text-foreground">Reason for compensation</label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="Explain why compensation is required and what safe state is intended."
          className="rounded-[8px] border border-border px-3 py-2 font-poppins text-[12px] bg-card outline-none resize-none"
        />
      </div>

      <p className="font-poppins text-[11px] text-muted-foreground">
        Proposed operations are added in the Plan Builder after this draft is created — this step only establishes
        the compensation lineage and reason.
      </p>

      <div className="flex items-center gap-2">
        <button
          onClick={handleCreate}
          disabled={!reason.trim() || submitting}
          className="rounded-[8px] bg-primary px-4 py-2 font-poppins text-[12px] font-medium text-white disabled:opacity-50"
        >
          {submitting ? "Creating..." : "Create Compensation DRAFT"}
        </button>
        <button
          onClick={onBack}
          className="rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}