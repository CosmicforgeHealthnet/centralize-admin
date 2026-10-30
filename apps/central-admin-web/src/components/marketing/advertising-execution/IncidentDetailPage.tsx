"use client";

import { useEffect, useState } from "react";
import { AlertOctagon, ArrowLeft, CheckCircle2 } from "lucide-react";
import { acknowledgeAEIncident, fetchAEIncidentDetail } from "@/lib/advertising-execution.service";
import type { AEIncidentDetail } from "@/types/advertising-execution.types";

interface IncidentDetailPageProps {
  id: string;
  onBack: () => void;
  onCreateCompensation: () => void;
}

export default function IncidentDetailPage({ id, onBack, onCreateCompensation }: IncidentDetailPageProps) {
  const [incident, setIncident] = useState<AEIncidentDetail | null>(null);
  const [showAckForm, setShowAckForm] = useState(false);
  const [ackReason, setAckReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetchAEIncidentDetail(id).then((res) => {
      if (mounted) setIncident(res);
    });
    return () => {
      mounted = false;
    };
  }, [id]);

  if (!incident) {
    return <div className="h-40 rounded-[10px] bg-muted/40 animate-pulse" />;
  }

  const handleAcknowledge = async () => {
    if (!ackReason.trim()) return;
    setSubmitting(true);
    try {
      const res = await acknowledgeAEIncident(id, ackReason.trim());
      setIncident(res);
      setShowAckForm(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Drift & Incidents
      </button>

      <div className="flex items-start gap-2">
        <AlertOctagon className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
        <div className="flex flex-col gap-1">
          <h2 className="font-poppins text-[14px] font-semibold text-foreground">{incident.summary}</h2>
          <span className="font-poppins text-[11px] text-muted-foreground">
            {incident.classification.replace(/_/g, " ")} · {incident.severity} · {incident.provider} · {incident.ageMinutes}m old
          </span>
        </div>
      </div>

      {/* Expected vs actual */}
      <div className="rounded-[10px] border border-border bg-card p-4 grid grid-cols-1 min-[700px]:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="font-poppins text-[11px] font-semibold text-muted-foreground">Expected State</span>
          <pre className="font-poppins text-[11px] text-foreground whitespace-pre-wrap">
            {JSON.stringify(incident.expectedState, null, 2)}
          </pre>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="font-poppins text-[11px] font-semibold text-muted-foreground">Actual State</span>
          <pre className="font-poppins text-[11px] text-foreground whitespace-pre-wrap">
            {incident.actualState && Object.keys(incident.actualState).length > 0
              ? JSON.stringify(incident.actualState, null, 2)
              : "Not yet read back from provider."}
          </pre>
        </div>
      </div>

      {incident.classification === "UNKNOWN" && !incident.readBackAt && (
        <div className="rounded-[10px] border border-purple-200 bg-purple-50 p-3">
          <span className="font-poppins text-[12px] text-purple-700">
            Read-back has not yet resolved this outcome. This is not the same as a resolved incident.
          </span>
        </div>
      )}

      {/* Acknowledgment */}
      <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-3">
        <h3 className="font-poppins text-[12px] font-semibold text-foreground">Acknowledgment</h3>
        {incident.acknowledged ? (
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span className="font-poppins text-[12px] text-foreground">
              Acknowledged by {incident.acknowledgedBy} on {incident.acknowledgedAt ? new Date(incident.acknowledgedAt).toLocaleString() : "—"}
            </span>
          </div>
        ) : showAckForm ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={ackReason}
              onChange={(e) => setAckReason(e.target.value)}
              placeholder="Reason for acknowledging (required)"
              rows={2}
              className="rounded-[8px] border border-border px-3 py-2 font-poppins text-[12px] bg-card outline-none resize-none"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={handleAcknowledge}
                disabled={!ackReason.trim() || submitting}
                className="rounded-[8px] bg-primary px-4 py-2 font-poppins text-[12px] font-medium text-white disabled:opacity-50"
              >
                Confirm Acknowledgment
              </button>
              <button
                onClick={() => setShowAckForm(false)}
                className="rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowAckForm(true)}
            className="rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground hover:bg-muted/40 w-fit"
          >
            Acknowledge
          </button>
        )}
        <p className="font-poppins text-[11px] text-muted-foreground">
          Acknowledging records that you reviewed this incident. It does not resolve the drift or change the provider resource.
        </p>
      </div>

      {/* Compensation */}
      {!incident.compensationPlanId && (
        <button
          onClick={onCreateCompensation}
          className="rounded-[8px] bg-primary px-4 py-2 font-poppins text-[12px] font-medium text-white w-fit"
        >
          Create Compensation Plan
        </button>
      )}
    </div>
  );
}