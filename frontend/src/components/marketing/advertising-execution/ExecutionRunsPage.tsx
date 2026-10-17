"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { fetchAERuns } from "@/lib/advertising-execution.service";
import type { AEJobStatus, AEProvider, AERunFilters, AERunListItem } from "@/types/advertising-execution.types";

interface ExecutionRunsPageProps {
  onOpenRun: (id: string) => void;
}

const PROVIDER_OPTIONS: Array<AEProvider | "all"> = ["all", "META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"];
const JOB_STATUS_OPTIONS: Array<AEJobStatus | "all"> = [
  "all", "PENDING", "CLAIMED", "RUNNING", "RETRY_SCHEDULED", "RECONCILING",
  "SUCCEEDED", "FAILED", "DEAD_LETTER", "CANCELLED",
];

function JobStatusBadge({ status }: { status: AEJobStatus }) {
  const tone: Record<AEJobStatus, string> = {
    PENDING: "bg-muted text-muted-foreground",
    CLAIMED: "bg-blue-100 text-blue-700",
    RUNNING: "bg-blue-100 text-blue-700",
    RETRY_SCHEDULED: "bg-amber-100 text-amber-700",
    RECONCILING: "bg-purple-100 text-purple-700",
    SUCCEEDED: "bg-emerald-100 text-emerald-700",
    FAILED: "bg-red-100 text-red-700",
    DEAD_LETTER: "bg-red-100 text-red-700",
    CANCELLED: "bg-muted text-muted-foreground",
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 font-poppins text-[10px] font-medium ${tone[status]}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export default function ExecutionRunsPage({ onOpenRun }: ExecutionRunsPageProps) {
  const [runs, setRuns] = useState<AERunListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Partial<AERunFilters>>({
    provider: "all",
    jobStatus: "all",
    onlyIncidents: false,
    onlyReconciliationPending: false,
  });

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    fetchAERuns(filters).then((res) => {
      if (mounted) {
        setRuns(res);
        setLoading(false);
      }
    });
    return () => {
      mounted = false;
    };
  }, [filters]);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-poppins text-[14px] font-semibold text-foreground">Execution Runs</h2>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={filters.provider}
          onChange={(e) => setFilters((f) => ({ ...f, provider: e.target.value as AEProvider | "all" }))}
          className="rounded-[8px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card"
        >
          {PROVIDER_OPTIONS.map((p) => (
            <option key={p} value={p}>{p === "all" ? "All Providers" : p}</option>
          ))}
        </select>
        <select
          value={filters.jobStatus}
          onChange={(e) => setFilters((f) => ({ ...f, jobStatus: e.target.value as AEJobStatus | "all" }))}
          className="rounded-[8px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card"
        >
          {JOB_STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s === "all" ? "All Statuses" : s.replace(/_/g, " ")}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 font-poppins text-[12px] text-foreground">
          <input
            type="checkbox"
            checked={filters.onlyIncidents}
            onChange={(e) => setFilters((f) => ({ ...f, onlyIncidents: e.target.checked }))}
          />
          Only incidents
        </label>
      </div>

      <div className="rounded-[10px] border border-border overflow-hidden">
        <table className="w-full">
          <thead className="bg-muted/40">
            <tr>
              {["Plan", "Provider", "Job Status", "Operations", "Started", "Completed"].map((h) => (
                <th key={h} className="text-left font-poppins text-[11px] font-medium text-muted-foreground px-3 py-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center font-poppins text-[12px] text-muted-foreground">
                  Loading...
                </td>
              </tr>
            ) : runs.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center font-poppins text-[12px] text-muted-foreground">
                  No runs match the current filters.
                </td>
              </tr>
            ) : (
              runs.map((run) => (
                <tr
                  key={run.id}
                  onClick={() => onOpenRun(run.id)}
                  className="border-t border-border hover:bg-muted/20 cursor-pointer"
                >
                  <td className="px-3 py-2.5">
                    <div className="flex flex-col">
                      <span className="font-poppins text-[12px] font-medium text-foreground">{run.planName}</span>
                      <span className="font-poppins text-[10px] text-muted-foreground font-mono">{run.fingerprint.slice(0, 8)}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 font-poppins text-[12px] text-foreground">{run.provider}</td>
                  <td className="px-3 py-2.5"><JobStatusBadge status={run.jobStatus} /></td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2 font-poppins text-[11px]">
                      <span className="text-emerald-600">{run.operationCounts.succeeded} ok</span>
                      {run.operationCounts.failed > 0 && <span className="text-red-600">{run.operationCounts.failed} failed</span>}
                      {run.operationCounts.unknown > 0 && (
                        <span className="flex items-center gap-0.5 text-purple-600">
                          <AlertTriangle className="w-3 h-3" /> {run.operationCounts.unknown} unknown
                        </span>
                      )}
                      {run.operationCounts.drifted > 0 && <span className="text-amber-600">{run.operationCounts.drifted} drifted</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 font-poppins text-[11px] text-muted-foreground">
                    {run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2.5 font-poppins text-[11px] text-muted-foreground">
                    {run.completedAt ? new Date(run.completedAt).toLocaleString() : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}