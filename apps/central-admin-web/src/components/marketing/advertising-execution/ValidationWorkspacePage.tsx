"use client";

import { useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import { fetchAEPlanDetail, submitAEPlanForApproval, validateAEPlan } from "@/lib/advertising-execution.service";
import type { AEPlanDetail, AEValidationResult } from "@/types/advertising-execution.types";

interface ValidationWorkspacePageProps {
  id: string;
  onSubmitted: () => void;
  onBack: () => void;
}

export default function ValidationWorkspacePage({ id, onSubmitted, onBack }: ValidationWorkspacePageProps) {
  const [result, setResult] = useState<AEValidationResult | null>(null);
  const [running, setRunning] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const runValidation = async () => {
    setRunning(true);
    setResult(null);
    try {
      const res = await validateAEPlan(id);
      setResult(res);
    } finally {
      setRunning(false);
    }
  };

  const handleSubmit = async () => {
    if (!result || result.status !== "SUCCEEDED") return;
    setSubmitting(true);
    try {
      await submitAEPlanForApproval(id);
      onSubmitted();
    } finally {
      setSubmitting(false);
    }
  };

  const errors = result?.issues.filter((i) => i.severity === "ERROR") ?? [];
  const warnings = result?.issues.filter((i) => i.severity === "WARNING") ?? [];

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Plan
      </button>

      <h2 className="font-poppins text-[14px] font-semibold text-foreground">Validation Workspace</h2>

      {!result && !running && (
        <button
          onClick={runValidation}
          className="rounded-[8px] bg-primary px-4 py-2 font-poppins text-[12px] font-medium text-white w-fit"
        >
          Run Validation
        </button>
      )}

      {running && (
        <div className="flex items-center gap-2 font-poppins text-[12px] text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Running domain, capability, policy and provider preflight checks...
        </div>
      )}

      {result && (
        <div className="flex flex-col gap-3">
          <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="font-poppins text-[12px] font-medium text-foreground">
                Version {result.version} · Fingerprint <span className="font-mono">{result.fingerprint.slice(0, 8)}</span>
              </span>
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-poppins text-[11px] font-medium ${
                  result.status === "SUCCEEDED" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                }`}
              >
                {result.status === "SUCCEEDED" ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                {result.status === "SUCCEEDED" ? "Validation Succeeded" : "Validation Failed"}
              </span>
            </div>
            {result.expiresAt && (
              <span className="font-poppins text-[11px] text-muted-foreground">
                Packet valid until {new Date(result.expiresAt).toLocaleString()}
              </span>
            )}
          </div>

          {errors.length > 0 && (
            <div className="rounded-[10px] border border-red-200 bg-red-50 p-3 flex flex-col gap-2">
              <span className="font-poppins text-[12px] font-semibold text-red-700">Blocking Errors ({errors.length})</span>
              {errors.map((issue, i) => (
                <div key={i} className="flex flex-col">
                  <span className="font-poppins text-[12px] text-red-700">{issue.message}</span>
                  {issue.fieldPath && <span className="font-poppins text-[10px] text-red-500 font-mono">{issue.fieldPath}</span>}
                </div>
              ))}
            </div>
          )}

          {warnings.length > 0 && (
            <div className="rounded-[10px] border border-amber-200 bg-amber-50 p-3 flex flex-col gap-2">
              <span className="font-poppins text-[12px] font-semibold text-amber-700">Warnings ({warnings.length})</span>
              {warnings.map((issue, i) => (
                <div key={i} className="flex flex-col">
                  <span className="font-poppins text-[12px] text-amber-700">{issue.message}</span>
                  {issue.fieldPath && <span className="font-poppins text-[10px] text-amber-600 font-mono">{issue.fieldPath}</span>}
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={runValidation}
              className="rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground hover:bg-muted/40"
            >
              Re-run Validation
            </button>
            <button
              onClick={handleSubmit}
              disabled={result.status !== "SUCCEEDED" || submitting}
              className="rounded-[8px] bg-primary px-4 py-2 font-poppins text-[12px] font-medium text-white disabled:opacity-50"
            >
              {submitting ? "Submitting..." : "Submit for Approval"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}