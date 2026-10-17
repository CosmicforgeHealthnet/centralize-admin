"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { fetchAEOperationDetail, retryAEOperation } from "@/lib/advertising-execution.service";
import type { AEOperationDetail } from "@/types/advertising-execution.types";

interface OperationDetailPageProps {
  id: string;
  onBack: () => void;
}

export default function OperationDetailPage({ id, onBack }: OperationDetailPageProps) {
  const [operation, setOperation] = useState<AEOperationDetail | null>(null);
  const [showRetryReview, setShowRetryReview] = useState(false);
  const [retryReason, setRetryReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetchAEOperationDetail(id).then((res) => {
      if (mounted) setOperation(res);
    });
    return () => {
      mounted = false;
    };
  }, [id]);

  if (!operation) {
    return <div className="h-40 rounded-[10px] bg-muted/40 animate-pulse" />;
  }

  const handleRetry = async () => {
    if (!retryReason.trim()) return;
    setSubmitting(true);
    try {
      const res = await retryAEOperation({ operationId: id, reason: retryReason.trim() });
      setOperation(res);
      setShowRetryReview(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Run
      </button>

      <div className="flex items-start justify-between flex-wrap gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="font-poppins text-[14px] font-semibold text-foreground">{operation.clientReference}</h2>
          <span className="font-poppins text-[11px] text-muted-foreground">
            {operation.operationType} · {operation.resourceType}
          </span>
        </div>
        <span className="inline-flex rounded-full bg-muted px-2.5 py-1 font-poppins text-[11px] font-medium text-muted-foreground">
          {operation.status.replace(/_/g, " ")}
        </span>
      </div>

      {operation.status === "UNKNOWN" && (
        <div className="rounded-[10px] border border-purple-200 bg-purple-50 p-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-purple-600 mt-0.5 shrink-0" />
          <span className="font-poppins text-[12px] text-purple-700">
            The provider outcome is uncertain. Do not retry this operation until read-back reconciliation resolves the state.
          </span>
        </div>
      )}

      {/* State comparison */}
      <div className="rounded-[10px] border border-border bg-card p-4 grid grid-cols-1 min-[700px]:grid-cols-3 gap-4">
        {[
          { label: "Before", value: operation.beforeState },
          { label: "Desired", value: operation.desiredState },
          { label: "After", value: operation.afterState },
        ].map(({ label, value }) => (
          <div key={label} className="flex flex-col gap-1.5">
            <span className="font-poppins text-[11px] font-semibold text-muted-foreground">{label}</span>
            <pre className="font-poppins text-[11px] text-foreground whitespace-pre-wrap">
              {value ? JSON.stringify(value, null, 2) : "—"}
            </pre>
          </div>
        ))}
      </div>

      {/* Attempts */}
      <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-2">
        <h3 className="font-poppins text-[12px] font-semibold text-foreground">Attempts ({operation.attempts.length})</h3>
        {operation.attempts.map((att) => (
          <div key={att.id} className="flex items-center justify-between border-t border-border pt-2 first:border-t-0 first:pt-0">
            <div className="flex flex-col">
              <span className="font-poppins text-[12px] text-foreground">Attempt {att.attemptNumber}</span>
              <span className="font-poppins text-[10px] text-muted-foreground">
                {att.errorCategory ?? "No error category"}
              </span>
            </div>
            <div className="flex flex-col items-end">
              <span className="font-poppins text-[12px] text-foreground">{att.outcome}</span>
              <span className="font-poppins text-[10px] text-muted-foreground">
                {new Date(att.attemptedAt).toLocaleString()}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Retry review */}
      {operation.retryEligible ? (
        showRetryReview ? (
          <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-2.5">
            <h3 className="font-poppins text-[12px] font-semibold text-foreground">Safe Retry Review</h3>
            <textarea
              value={retryReason}
              onChange={(e) => setRetryReason(e.target.value)}
              placeholder="Reason for scheduling this retry (required)"
              rows={2}
              className="rounded-[8px] border border-border px-3 py-2 font-poppins text-[12px] bg-card outline-none resize-none"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={handleRetry}
                disabled={!retryReason.trim() || submitting}
                className="rounded-[8px] bg-primary px-4 py-2 font-poppins text-[12px] font-medium text-white disabled:opacity-50"
              >
                {submitting ? "Scheduling..." : "Schedule Retry"}
              </button>
              <button
                onClick={() => setShowRetryReview(false)}
                className="rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowRetryReview(true)}
            className="rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground hover:bg-muted/40 w-fit"
          >
            Review Retry
          </button>
        )
      ) : (
        operation.retryIneligibleReason && (
          <p className="font-poppins text-[12px] text-muted-foreground">{operation.retryIneligibleReason}</p>
        )
      )}
    </div>
  );
}