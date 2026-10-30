"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { cancelAEPlan, cancelAEQueuedPlan } from "@/lib/advertising-execution.service";
import type { AEJobStatus, AEPlanStatus } from "@/types/advertising-execution.types";

interface PlanCancellationModalProps {
  planId: string;
  planStatus: AEPlanStatus;
  jobStatus: AEJobStatus | null;
  onCancelled: () => void;
  onClose: () => void;
}

export default function PlanCancellationModal({ planId, planStatus, jobStatus, onCancelled, onClose }: PlanCancellationModalProps) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isQueuedOrRunning = jobStatus === "CLAIMED" || jobStatus === "RUNNING";

  const contextMessage = isQueuedOrRunning
    ? "This job has already been claimed by a worker. Cancellation is a request the owning worker must observe — it does not remove the lease immediately."
    : planStatus === "DRAFT" || planStatus === "PENDING_APPROVAL"
    ? "This plan has not yet executed. Cancelling now stops it before any provider write occurs."
    : "This plan's history will be preserved after cancellation.";

  const handleCancel = async () => {
    setSubmitting(true);
    try {
      if (isQueuedOrRunning) {
        await cancelAEQueuedPlan(planId, reason.trim() || undefined);
      } else {
        await cancelAEPlan(planId, reason.trim() || undefined);
      }
      onCancelled();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-[12px] border border-border p-5 max-w-md w-full flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="font-poppins text-[14px] font-semibold text-foreground">Cancel Plan</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="font-poppins text-[12px] text-muted-foreground">{contextMessage}</p>

        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional)"
          rows={2}
          className="rounded-[8px] border border-border px-3 py-2 font-poppins text-[12px] bg-card outline-none resize-none"
        />

        <div className="flex items-center gap-2">
          <button
            onClick={handleCancel}
            disabled={submitting}
            className="rounded-[8px] bg-red-600 px-4 py-2 font-poppins text-[12px] font-medium text-white disabled:opacity-50"
          >
            {submitting ? "Cancelling..." : isQueuedOrRunning ? "Request Cancellation" : "Cancel Plan"}
          </button>
          <button
            onClick={onClose}
            className="rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground"
          >
            Back
          </button>
        </div>
      </div>
    </div>
  );
}