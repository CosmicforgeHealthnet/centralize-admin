"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { fetchAEHealth } from "@/lib/advertising-execution.service";
import type { AEHealthResponse, AEHealthState } from "@/types/advertising-execution.types";

function HealthStateBadge({ state }: { state: AEHealthState }) {
  const tone: Record<AEHealthState, string> = {
    READY: "bg-emerald-100 text-emerald-700",
    DEGRADED: "bg-amber-100 text-amber-700",
    DISABLED: "bg-muted text-muted-foreground",
    UNAVAILABLE: "bg-red-100 text-red-700",
  };
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 font-poppins text-[11px] font-medium ${tone[state]}`}>
      {state}
    </span>
  );
}

export default function SystemHealthPage() {
  const [health, setHealth] = useState<AEHealthResponse | null>(null);

  useEffect(() => {
    let mounted = true;
    fetchAEHealth().then((res) => {
      if (mounted) setHealth(res);
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (!health) {
    return <div className="h-40 rounded-[10px] bg-muted/40 animate-pulse" />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-poppins text-[14px] font-semibold text-foreground">System Health</h2>
        <HealthStateBadge state={health.overallState} />
      </div>

      <p className="font-poppins text-[12px] text-muted-foreground">
        {health.overallState === "DISABLED"
          ? "Advertising execution is disabled by configuration. This is a valid, intentional state — not a failure."
          : "Live status of workers, queues and provider readiness."}
      </p>

      <div className="grid grid-cols-2 min-[700px]:grid-cols-4 gap-3">
        <div className="rounded-[10px] border border-border bg-card px-4 py-3 flex flex-col gap-1">
          <span className="font-poppins text-[11px] text-muted-foreground">Schema</span>
          <div className="flex items-center gap-1.5">
            {health.schemaOk ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-red-600" />}
            <span className="font-poppins text-[12px] font-medium text-foreground">{health.schemaOk ? "OK" : "Issue"}</span>
          </div>
        </div>
        <div className="rounded-[10px] border border-border bg-card px-4 py-3 flex flex-col gap-1">
          <span className="font-poppins text-[11px] text-muted-foreground">Worker Status</span>
          <span className="font-poppins text-[12px] font-medium text-foreground">{health.workerStatus}</span>
        </div>
        <div className="rounded-[10px] border border-border bg-card px-4 py-3 flex flex-col gap-1">
          <span className="font-poppins text-[11px] text-muted-foreground">Master Enabled</span>
          <span className="font-poppins text-[12px] font-medium text-foreground">{health.safety.masterEnabled ? "Yes" : "No"}</span>
        </div>
        <div className="rounded-[10px] border border-border bg-card px-4 py-3 flex flex-col gap-1">
          <span className="font-poppins text-[11px] text-muted-foreground">Queue Age</span>
          <span className="font-poppins text-[12px] font-medium text-foreground">
            {health.queueAgeMinutes !== null ? `${health.queueAgeMinutes}m` : "—"}
          </span>
        </div>
      </div>

      <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-2">
        <h3 className="font-poppins text-[12px] font-semibold text-foreground">Provider Readiness</h3>
        {health.providerReadiness.map((p) => (
          <div key={p.provider} className="flex items-center justify-between border-t border-border pt-2 first:border-t-0 first:pt-0">
            <span className="font-poppins text-[12px] text-foreground">{p.provider}</span>
            <div className="flex items-center gap-2">
              {p.reason && <span className="font-poppins text-[11px] text-muted-foreground">{p.reason}</span>}
              <HealthStateBadge state={p.state} />
            </div>
          </div>
        ))}
      </div>

      {health.recentFailureCategories.length > 0 && (
        <div className="rounded-[10px] border border-amber-200 bg-amber-50 p-3 flex flex-col gap-1">
          <span className="font-poppins text-[12px] font-semibold text-amber-700">Recent Failure Categories</span>
          {health.recentFailureCategories.map((cat, i) => (
            <span key={i} className="font-poppins text-[12px] text-amber-700">{cat}</span>
          ))}
        </div>
      )}
    </div>
  );
}