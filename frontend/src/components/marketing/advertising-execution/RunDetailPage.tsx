"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, Clock } from "lucide-react";
import { fetchAERunDetail } from "@/lib/advertising-execution.service";
import type { AEOperationStatus, AERunDetail } from "@/types/advertising-execution.types";

interface RunDetailPageProps {
  id: string;
  onBack: () => void;
  onOpenOperation: (id: string) => void;
}

function OperationStatusBadge({ status }: { status: AEOperationStatus }) {
  const tone: Record<AEOperationStatus, string> = {
    PENDING: "bg-muted text-muted-foreground",
    VALIDATED: "bg-blue-100 text-blue-700",
    READY: "bg-blue-100 text-blue-700",
    EXECUTING: "bg-blue-100 text-blue-700",
    SUCCEEDED: "bg-emerald-100 text-emerald-700",
    FAILED: "bg-red-100 text-red-700",
    UNKNOWN: "bg-purple-100 text-purple-700",
    VERIFYING: "bg-blue-100 text-blue-700",
    VERIFIED: "bg-emerald-100 text-emerald-700",
    DRIFTED: "bg-amber-100 text-amber-700",
    RETRY_SCHEDULED: "bg-amber-100 text-amber-700",
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 font-poppins text-[10px] font-medium ${tone[status]}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export default function RunDetailPage({ id, onBack, onOpenOperation }: RunDetailPageProps) {
  const [run, setRun] = useState<AERunDetail | null>(null);

  useEffect(() => {
    let mounted = true;
    fetchAERunDetail(id).then((res) => {
      if (mounted) setRun(res);
    });
    return () => {
      mounted = false;
    };
  }, [id]);

  if (!run) {
    return <div className="h-40 rounded-[10px] bg-muted/40 animate-pulse" />;
  }

  const hasFailureOrUnknown = run.operations.some((op) => op.status === "FAILED" || op.status === "UNKNOWN");

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Runs
      </button>

      <div className="flex items-start justify-between flex-wrap gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="font-poppins text-[14px] font-semibold text-foreground">{run.planName}</h2>
          <span className="font-poppins text-[11px] text-muted-foreground">
            {run.provider} · v{run.planVersion} · <span className="font-mono">{run.fingerprint.slice(0, 8)}</span>
          </span>
        </div>
        {!hasFailureOrUnknown && run.jobStatus === "SUCCEEDED" ? (
          <span className="inline-flex rounded-full bg-emerald-100 px-2.5 py-1 font-poppins text-[11px] font-medium text-emerald-700">
            Succeeded
          </span>
        ) : (
          <span className="inline-flex rounded-full bg-amber-100 px-2.5 py-1 font-poppins text-[11px] font-medium text-amber-700">
            {run.jobStatus.replace(/_/g, " ")} — review required
          </span>
        )}
      </div>

      {/* Approval summary */}
      <div className="rounded-[10px] border border-border bg-card p-4 flex items-center justify-between">
        <span className="font-poppins text-[12px] text-foreground">Approval Summary</span>
        <span className="font-poppins text-[12px] font-medium text-foreground">
          {run.approvalSummary.approved}/{run.approvalSummary.required} approved
        </span>
      </div>

      {/* Operations */}
      <div className="rounded-[10px] border border-border overflow-hidden">
        <table className="w-full">
          <thead className="bg-muted/40">
            <tr>
              {["Reference", "Type", "Resource", "Status", "Native ID"].map((h) => (
                <th key={h} className="text-left font-poppins text-[11px] font-medium text-muted-foreground px-3 py-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {run.operations.map((op) => (
              <tr
                key={op.id}
                onClick={() => onOpenOperation(op.id)}
                className="border-t border-border hover:bg-muted/20 cursor-pointer"
              >
                <td className="px-3 py-2.5 font-poppins text-[12px] text-foreground">{op.clientReference}</td>
                <td className="px-3 py-2.5 font-poppins text-[12px] text-muted-foreground">{op.operationType}</td>
                <td className="px-3 py-2.5 font-poppins text-[12px] text-muted-foreground">{op.resourceType}</td>
                <td className="px-3 py-2.5"><OperationStatusBadge status={op.status} /></td>
                <td className="px-3 py-2.5 font-poppins text-[11px] text-muted-foreground">
                  {op.nativeSafeName ?? op.nativeSafeId ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Timeline */}
      <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-2">
        <h3 className="font-poppins text-[12px] font-semibold text-foreground">Timeline</h3>
        {run.timeline.map((event) => (
          <div key={event.id} className="flex items-center justify-between">
            <span className="font-poppins text-[12px] text-foreground">{event.type.replace(/_/g, " ")}</span>
            <span className="flex items-center gap-1 font-poppins text-[11px] text-muted-foreground">
              <Clock className="w-3 h-3" /> {new Date(event.at).toLocaleString()}
            </span>
          </div>
        ))}
      </div>

      {run.reconciliationStatus === "UNKNOWN" && (
        <div className="rounded-[10px] border border-purple-200 bg-purple-50 p-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-purple-600 mt-0.5 shrink-0" />
          <span className="font-poppins text-[12px] text-purple-700">
            The provider outcome is uncertain for one or more operations. Do not retry until read-back reconciliation resolves the state.
          </span>
        </div>
      )}
    </div>
  );
}