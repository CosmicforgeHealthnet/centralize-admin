"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, ShieldAlert } from "lucide-react";
import { fetchAEOverrides, requestAEOverride } from "@/lib/advertising-execution.service";
import type { AEOverrideRecord, AEOverrideRequestPayload } from "@/types/advertising-execution.types";

interface EmergencyOverridePageProps {
  onBack: () => void;
}

export default function EmergencyOverridePage({ onBack }: EmergencyOverridePageProps) {
  const [overrides, setOverrides] = useState<AEOverrideRecord[]>([]);
  const [scopeId, setScopeId] = useState("");
  const [justification, setJustification] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [mfaEvidence, setMfaEvidence] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetchAEOverrides().then((res) => {
      if (mounted) setOverrides(res);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const canSubmit =
    scopeId.trim() && justification.trim() && expiresAt && mfaEvidence.trim() && confirmText === "OVERRIDE";

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const payload: AEOverrideRequestPayload = {
        scope: "PLAN",
        scopeId: scopeId.trim(),
        controlsRequested: ["EXECUTION_APPROVAL_REQUIRED"],
        justification: justification.trim(),
        expiresAt,
        mfaEvidence: mfaEvidence.trim(),
      };
      const record = await requestAEOverride(payload);
      setOverrides((prev) => [record, ...prev]);
      setScopeId("");
      setJustification("");
      setExpiresAt("");
      setMfaEvidence("");
      setConfirmText("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Policies & Controls
      </button>

      <div className="flex items-center gap-2">
        <ShieldAlert className="w-5 h-5 text-red-600" />
        <h2 className="font-poppins text-[14px] font-semibold text-foreground">Emergency Override</h2>
      </div>

      <div className="rounded-[10px] border border-red-200 bg-red-50 p-3 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
        <span className="font-poppins text-[12px] text-red-700">
          This is a high-friction, tightly scoped bypass — never a normal shortcut. It requires MFA evidence, an exact
          scope, an expiry, and cannot bypass non-overridable controls such as self-approval prevention.
        </span>
      </div>

      <div className="flex flex-col gap-3 max-w-xl">
        <div className="flex flex-col gap-1">
          <label className="font-poppins text-[11px] font-medium text-foreground">Plan / Run / Operation ID (scope)</label>
          <input
            value={scopeId}
            onChange={(e) => setScopeId(e.target.value)}
            className="rounded-[8px] border border-border px-3 py-2 font-poppins text-[12px] bg-card outline-none"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="font-poppins text-[11px] font-medium text-foreground">Justification (required)</label>
          <textarea
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            rows={3}
            className="rounded-[8px] border border-border px-3 py-2 font-poppins text-[12px] bg-card outline-none resize-none"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="font-poppins text-[11px] font-medium text-foreground">Expiry</label>
          <input
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className="rounded-[8px] border border-border px-3 py-2 font-poppins text-[12px] bg-card outline-none"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="font-poppins text-[11px] font-medium text-foreground">MFA Evidence</label>
          <input
            value={mfaEvidence}
            onChange={(e) => setMfaEvidence(e.target.value)}
            placeholder="MFA confirmation code or reference"
            className="rounded-[8px] border border-border px-3 py-2 font-poppins text-[12px] bg-card outline-none"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="font-poppins text-[11px] font-medium text-foreground">
            Type OVERRIDE to confirm
          </label>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            className="rounded-[8px] border border-border px-3 py-2 font-poppins text-[12px] bg-card outline-none"
          />
        </div>

        <button
          onClick={handleSubmit}
          disabled={!canSubmit || submitting}
          className="rounded-[8px] bg-red-600 px-4 py-2 font-poppins text-[12px] font-medium text-white disabled:opacity-50 w-fit"
        >
          {submitting ? "Submitting..." : "Submit Override Request"}
        </button>
      </div>

      <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-2">
        <h3 className="font-poppins text-[12px] font-semibold text-foreground">Override History</h3>
        {overrides.length === 0 ? (
          <p className="font-poppins text-[12px] text-muted-foreground">No overrides have been requested.</p>
        ) : (
          overrides.map((o) => (
            <div key={o.id} className="flex items-center justify-between border-t border-border pt-2 first:border-t-0 first:pt-0">
              <div className="flex flex-col">
                <span className="font-poppins text-[12px] text-foreground">{o.scope} · {o.scopeId}</span>
                <span className="font-poppins text-[10px] text-muted-foreground">{o.actorLabel}</span>
              </div>
              <span className="font-poppins text-[11px] text-muted-foreground">
                {o.usedAt ? "Used" : "Not yet used"} · Expires {new Date(o.expiresAt).toLocaleString()}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}