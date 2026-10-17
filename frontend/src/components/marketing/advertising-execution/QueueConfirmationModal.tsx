"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { queueAEPlan } from "@/lib/advertising-execution.service";
import type { AEApprovalPacket } from "@/types/advertising-execution.types";

interface QueueConfirmationModalProps {
  planId: string;
  packet: AEApprovalPacket;
  onQueued: (runId: string) => void;
  onClose: () => void;
}

export default function QueueConfirmationModal({ planId, packet, onQueued, onClose }: QueueConfirmationModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ runId: string; jobId: string } | null>(null);

  const handleQueue = async () => {
    setSubmitting(true);
    try {
      const res = await queueAEPlan(planId);
      setResult(res);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-[12px] border border-border p-5 max-w-md w-full flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="font-poppins text-[14px] font-semibold text-foreground">Queue Approved Plan</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        {!result ? (
          <>
            <div className="flex flex-col gap-1.5 font-poppins text-[12px]">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Fingerprint</span>
                <span className="text-foreground font-mono">{packet.fingerprint.slice(0, 12)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Approvals</span>
                <span className="text-foreground font-medium">
                  {packet.approvals.length}/{packet.requiredApprovals}
                </span>
              </div>
            </div>
            <p className="font-poppins text-[11px] text-muted-foreground">
              Queueing creates a durable run and job. No provider call happens on this page — execution and
              activation state depend on the current provider write gates.
            </p>
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={handleQueue}
                disabled={submitting}
                className="rounded-[8px] bg-primary px-4 py-2 font-poppins text-[12px] font-medium text-white disabled:opacity-50"
              >
                {submitting ? "Queueing..." : "Queue Approved Plan"}
              </button>
              <button
                onClick={onClose}
                className="rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground"
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="font-poppins text-[12px] text-foreground">
              The approved plan has been queued. No provider call was made by this page. Track progress in the
              execution run.
            </p>
            <button
              onClick={() => onQueued(result.runId)}
              className="rounded-[8px] bg-primary px-4 py-2 font-poppins text-[12px] font-medium text-white w-fit"
            >
              View Run
            </button>
          </>
        )}
      </div>
    </div>
  );
}