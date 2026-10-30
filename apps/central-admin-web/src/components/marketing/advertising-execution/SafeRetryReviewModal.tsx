"use client";

import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { retryAEOperation } from "@/lib/advertising-execution.service";
import type { AEOperationDetail } from "@/types/advertising-execution.types";

interface SafeRetryReviewModalProps {
  operation: AEOperationDetail;
  onRetried: (updated: AEOperationDetail) => void;
  onClose: () => void;
}

export default function SafeRetryReviewModal({ operation, onRetried, onClose }: SafeRetryReviewModalProps) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const lastAttempt = operation.attempts[operation.attempts.length - 1];

  const handleRetry = async () => {
    if (!reason.trim()) return;
    setSubmitting(true);
    try {
      const updated = await retryAEOperation({ operationId: operation.id, reason: reason.trim() });
      onRetried(updated);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-[12px] border border-border p-5 max-w-md w-full flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="font-poppins text-[14px] font-semibold text-foreground">Safe Retry Review</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        {!operation.retryEligible ? (
          <div className="rounded-[8px] border border-purple-200 bg-purple-50 p-3 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-purple-600 mt-0.5 shrink-0" />
            <span className="font-poppins text-[12px] text-purple-700">
              {operation.retryIneligibleReason ?? "This operation is not currently eligible for retry."}
            </span>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5 font-poppins text-[12px]">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Original Failure</span>
                <span className="text-foreground font-medium">{lastAttempt?.errorCategory ?? "Unknown"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Last Outcome</span>
                <span className="text-foreground font-medium">{lastAttempt?.outcome ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Attempts So Far</span>
                <span className="text-foreground font-medium">{operation.attempts.length}</span>
              </div>
            </div>

            <p className="font-poppins text-[11px] text-muted-foreground">
              Fresh capability, policy, approval and precondition checks run before this retry is scheduled. Clicking
              retry repeatedly is never safe on its own — a review reason is required.
            </p>

            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason for scheduling this retry (required)"
              rows={2}
              className="rounded-[8px] border border-border px-3 py-2 font-poppins text-[12px] bg-card outline-none resize-none"
            />

            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={handleRetry}
                disabled={!reason.trim() || submitting}
                className="rounded-[8px] bg-primary px-4 py-2 font-poppins text-[12px] font-medium text-white disabled:opacity-50"
              >
                {submitting ? "Scheduling..." : "Schedule Retry"}
              </button>
              <button
                onClick={onClose}
                className="rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground"
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}