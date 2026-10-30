"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, XCircle } from "lucide-react";
import { approveAEPlan, fetchAEApprovalPacket, rejectAEPlan } from "@/lib/advertising-execution.service";
import type { AEApprovalPacket } from "@/types/advertising-execution.types";

interface ApprovalPacketDetailPageProps {
  planId: string;
  onBack: () => void;
}

export default function ApprovalPacketDetailPage({ planId, onBack }: ApprovalPacketDetailPageProps) {
  const [packet, setPacket] = useState<AEApprovalPacket | null>(null);
  const [spendAck, setSpendAck] = useState(false);
  const [activationAck, setActivationAck] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showReject, setShowReject] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [decided, setDecided] = useState<"APPROVED" | "REJECTED" | null>(null);

  useEffect(() => {
    let mounted = true;
    fetchAEApprovalPacket(planId).then((res) => {
      if (mounted) setPacket(res);
    });
    return () => {
      mounted = false;
    };
  }, [planId]);

  if (!packet) {
    return <div className="h-40 rounded-[10px] bg-muted/40 animate-pulse" />;
  }

  const requiresSpendAck = packet.budgetExposure.length > 0;
  const requiresActivationAck = packet.activationExposure.length > 0;
  const canApprove =
    packet.currentUserEligible &&
    (!requiresSpendAck || spendAck) &&
    (!requiresActivationAck || activationAck);

  const handleApprove = async () => {
    setSubmitting(true);
    try {
      await approveAEPlan(planId, { spend: spendAck, activation: activationAck });
      setDecided("APPROVED");
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (!rejectReason.trim()) return;
    setSubmitting(true);
    try {
      await rejectAEPlan(planId, rejectReason.trim());
      setDecided("REJECTED");
    } finally {
      setSubmitting(false);
    }
  };

  if (decided) {
    return (
      <div className="flex flex-col gap-3">
        <div className={`rounded-[10px] p-4 flex items-center gap-2 ${decided === "APPROVED" ? "bg-emerald-50 border border-emerald-200" : "bg-red-50 border border-red-200"}`}>
          {decided === "APPROVED" ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          ) : (
            <XCircle className="w-4 h-4 text-red-600" />
          )}
          <span className={`font-poppins text-[12px] font-medium ${decided === "APPROVED" ? "text-emerald-700" : "text-red-700"}`}>
            {decided === "APPROVED" ? "Approval recorded for this exact version and fingerprint." : "Rejection recorded. The author has been notified."}
          </span>
        </div>
        <button onClick={onBack} className="font-poppins text-[12px] text-primary hover:underline w-fit">
          Back to Approval Centre
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Approval Centre
      </button>

      <div className="flex flex-col gap-1">
        <h2 className="font-poppins text-[14px] font-semibold text-foreground">
          Version {packet.version} · <span className="font-mono">{packet.fingerprint.slice(0, 8)}</span>
        </h2>
        <span className="font-poppins text-[11px] text-muted-foreground">
          Authored by {packet.authorLabel} · Source: {packet.source}
        </span>
      </div>

      {!packet.currentUserEligible && (
        <div className="rounded-[10px] border border-amber-200 bg-amber-50 p-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
          <span className="font-poppins text-[12px] text-amber-700">
            {packet.currentUserIneligibleReason ?? "You are not eligible to approve this packet (separation of duties)."}
          </span>
        </div>
      )}

      {/* Before/desired diff */}
      <div className="rounded-[10px] border border-border bg-card p-4 grid grid-cols-1 min-[700px]:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="font-poppins text-[11px] font-semibold text-muted-foreground">Before</span>
          <pre className="font-poppins text-[11px] text-foreground whitespace-pre-wrap">{JSON.stringify(packet.beforeState, null, 2)}</pre>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="font-poppins text-[11px] font-semibold text-muted-foreground">Desired</span>
          <pre className="font-poppins text-[11px] text-foreground whitespace-pre-wrap">{JSON.stringify(packet.desiredState, null, 2)}</pre>
        </div>
      </div>

      {/* Budget exposure */}
      {packet.budgetExposure.length > 0 && (
        <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-2">
          <h3 className="font-poppins text-[12px] font-semibold text-foreground">Budget Exposure</h3>
          {packet.budgetExposure.map((b, i) => (
            <div key={i} className="flex items-center justify-between">
              <span className="font-poppins text-[12px] text-foreground">
                {b.currentValue ?? "—"} → {b.proposedValue} {b.currency}
              </span>
              <span className="font-poppins text-[11px] text-amber-600">
                {b.deltaAbsolute ? `+${b.deltaAbsolute} (${(Number(b.deltaPct) * 100).toFixed(0)}%)` : "—"}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Activation exposure */}
      {packet.activationExposure.length > 0 && (
        <div className="rounded-[10px] border border-amber-200 bg-amber-50 p-3 flex flex-col gap-1">
          <span className="font-poppins text-[12px] font-semibold text-amber-700">Activation Exposure</span>
          {packet.activationExposure.map((a, i) => (
            <span key={i} className="font-poppins text-[12px] text-amber-700">{a}</span>
          ))}
        </div>
      )}

      {/* Validation warnings */}
      {packet.validationWarnings.length > 0 && (
        <div className="rounded-[10px] border border-amber-200 bg-amber-50 p-3 flex flex-col gap-1.5">
          <span className="font-poppins text-[12px] font-semibold text-amber-700">Validation Warnings</span>
          {packet.validationWarnings.map((w, i) => (
            <span key={i} className="font-poppins text-[12px] text-amber-700">{w.message}</span>
          ))}
        </div>
      )}

      {/* Approval history */}
      <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-2">
        <h3 className="font-poppins text-[12px] font-semibold text-foreground">
          Approvals ({packet.approvals.length}/{packet.requiredApprovals})
        </h3>
        {packet.approvals.length === 0 ? (
          <span className="font-poppins text-[12px] text-muted-foreground">No decisions recorded yet.</span>
        ) : (
          packet.approvals.map((a) => (
            <div key={a.id} className="flex items-center justify-between">
              <span className="font-poppins text-[12px] text-foreground">{a.actorLabel}</span>
              <span className="font-poppins text-[11px] text-muted-foreground">
                {a.decision} · {new Date(a.decidedAt).toLocaleString()}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Decision panel */}
      {packet.currentUserEligible && (
        <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-3 sticky bottom-0">
          {requiresSpendAck && (
            <label className="flex items-center gap-2 font-poppins text-[12px] text-foreground">
              <input type="checkbox" checked={spendAck} onChange={(e) => setSpendAck(e.target.checked)} />
              I acknowledge the spend exposure shown above.
            </label>
          )}
          {requiresActivationAck && (
            <label className="flex items-center gap-2 font-poppins text-[12px] text-foreground">
              <input type="checkbox" checked={activationAck} onChange={(e) => setActivationAck(e.target.checked)} />
              I acknowledge this will activate resources that begin serving.
            </label>
          )}

          {showReject ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Reason for rejection (required)"
                rows={2}
                className="rounded-[8px] border border-border px-3 py-2 font-poppins text-[12px] bg-card outline-none resize-none"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleReject}
                  disabled={!rejectReason.trim() || submitting}
                  className="rounded-[8px] bg-red-600 px-4 py-2 font-poppins text-[12px] font-medium text-white disabled:opacity-50"
                >
                  Confirm Rejection
                </button>
                <button
                  onClick={() => setShowReject(false)}
                  className="rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={handleApprove}
                disabled={!canApprove || submitting}
                className="rounded-[8px] bg-primary px-4 py-2 font-poppins text-[12px] font-medium text-white disabled:opacity-50"
              >
                {submitting ? "Submitting..." : "Approve"}
              </button>
              <button
                onClick={() => setShowReject(true)}
                className="rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground"
              >
                Reject
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}