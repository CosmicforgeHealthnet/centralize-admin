"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { submitAEPlanForApproval } from "@/lib/advertising-execution.service";
import type { AEValidationResult } from "@/types/advertising-execution.types";

interface SubmitForApprovalModalProps {
  planId: string;
  validation: AEValidationResult;
  requiredApprovals: number;
  onSubmitted: () => void;
  onClose: () => void;
}

export default function SubmitForApprovalModal({
  planId,
  validation,
  requiredApprovals,
  onSubmitted,
  onClose,
}: SubmitForApprovalModalProps) {
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await submitAEPlanForApproval(planId);
      onSubmitted();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-[12px] border border-border p-5 max-w-md w-full flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="font-poppins text-[14px] font-semibold text-foreground">Submit for Approval</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col gap-1.5 font-poppins text-[12px]">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Version</span>
            <span className="text-foreground font-medium">{validation.version}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Fingerprint</span>
            <span className="text-foreground font-mono">{validation.fingerprint.slice(0, 12)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Validation Expiry</span>
            <span className="text-foreground font-medium">
              {validation.expiresAt ? new Date(validation.expiresAt).toLocaleString() : "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Required Approvals</span>
            <span className="text-foreground font-medium">{requiredApprovals}</span>
          </div>
        </div>

        <p className="font-poppins text-[11px] text-muted-foreground">
          Submitting freezes this exact version and fingerprint. Any further material edit will require a new
          validation and a new approval packet.
        </p>

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="rounded-[8px] bg-primary px-4 py-2 font-poppins text-[12px] font-medium text-white disabled:opacity-50"
          >
            {submitting ? "Submitting..." : "Submit"}
          </button>
          <button
            onClick={onClose}
            className="rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}