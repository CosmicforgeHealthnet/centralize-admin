"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, Ban, Clock, ShieldAlert } from "lucide-react";
import { fetchAEOverview } from "@/lib/advertising-execution.service";
import type { AEOverviewResponse, AEPlanStatus } from "@/types/advertising-execution.types";
import type { AESection } from "./AdvertisingExecutionSubNav";

interface OverviewPageProps {
  onNavigate: (section: AESection) => void;
}

const PLAN_STATUS_LABELS: Record<AEPlanStatus, string> = {
  DRAFT: "Draft",
  VALIDATING: "Validating",
  VALIDATED: "Validated",
  PENDING_APPROVAL: "Pending Approval",
  APPROVED: "Approved",
  QUEUED: "Queued",
  EXECUTING: "Executing",
  PARTIAL_SUCCESS: "Partial Success",
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  ROLLBACK_PENDING: "Rollback Pending",
  ROLLED_BACK: "Rolled Back",
  ROLLBACK_FAILED: "Rollback Failed",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};

function SafetyBanner({ data }: { data: AEOverviewResponse }) {
  const { safety } = data;
  if (safety.masterEnabled) return null;
  return (
    <div className="flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3">
      <Ban className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" strokeWidth={2} />
      <div className="flex flex-col gap-0.5">
        <p className="font-poppins text-[13px] font-semibold text-amber-800">
          Advertising execution is currently disabled
        </p>
        <p className="font-poppins text-[12px] text-amber-700">
          You can review, validate and approve plans, but provider writes cannot be queued or executed.
          {safety.dryRunEnabled ? " Dry-run mode is active." : ""}
        </p>
      </div>
    </div>
  );
}

function StatCard({ label, value, tone = "default" }: { label: string; value: string | number; tone?: "default" | "danger" | "warning" }) {
  const toneClass =
    tone === "danger" ? "text-red-600" : tone === "warning" ? "text-amber-600" : "text-foreground";
  return (
    <div className="rounded-[10px] border border-border bg-card px-4 py-3 flex flex-col gap-1">
      <span className="font-poppins text-[11px] text-muted-foreground">{label}</span>
      <span className={`font-poppins text-[20px] font-semibold ${toneClass}`}>{value}</span>
    </div>
  );
}

function SectionCard({
  title,
  onViewAll,
  children,
}: {
  title: string;
  onViewAll?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="font-poppins text-[13px] font-semibold text-foreground">{title}</h3>
        {onViewAll && (
          <button
            onClick={onViewAll}
            className="flex items-center gap-1 font-poppins text-[11px] text-primary hover:underline"
          >
            View all <ArrowRight className="w-3 h-3" />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

export default function OverviewPage({ onNavigate }: OverviewPageProps) {
  const [data, setData] = useState<AEOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    fetchAEOverview().then((res) => {
      if (mounted) {
        setData(res);
        setLoading(false);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (loading || !data) {
    return (
      <div className="flex flex-col gap-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-20 rounded-[10px] bg-muted/40 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <SafetyBanner data={data} />

      {/* Stat row */}
      <div className="grid grid-cols-2 min-[700px]:grid-cols-4 gap-3">
        <StatCard label="Pending Approvals" value={data.approvalQueue.pendingCount} tone={data.approvalQueue.pendingCount > 0 ? "warning" : "default"} />
        <StatCard label="Queued / Executing" value={data.queue.queuedCount + data.queue.executingCount} />
        <StatCard label="Unresolved Incidents" value={data.incidents.unresolvedCount} tone={data.incidents.unresolvedCount > 0 ? "danger" : "default"} />
        <StatCard label="Unknown Outcomes" value={data.incidents.unknownCount} tone={data.incidents.unknownCount > 0 ? "danger" : "default"} />
      </div>

      {/* Provider readiness row */}
      <SectionCard title="Provider Readiness" onViewAll={() => onNavigate("provider-readiness")}>
        <div className="grid grid-cols-2 min-[700px]:grid-cols-5 gap-2">
          {data.providerReadiness.map((p) => (
            <div key={p.provider} className="flex flex-col gap-1 rounded-[8px] border border-border px-3 py-2">
              <span className="font-poppins text-[11px] font-medium text-foreground">{p.provider}</span>
              <span className="font-poppins text-[10px] text-muted-foreground">
                {p.liveValidationStatus === "NOT_LIVE_VALIDATED" ? "Not live validated" : "Live validated"}
              </span>
              {p.blockerCount > 0 && (
                <span className="flex items-center gap-1 font-poppins text-[10px] text-amber-600">
                  <AlertTriangle className="w-3 h-3" /> {p.blockerCount} blocker{p.blockerCount > 1 ? "s" : ""}
                </span>
              )}
            </div>
          ))}
        </div>
      </SectionCard>

      <div className="grid grid-cols-1 min-[900px]:grid-cols-2 gap-4">
        {/* Plans by status */}
        <SectionCard title="Plans by Status" onViewAll={() => onNavigate("plans")}>
          <div className="flex flex-col gap-1.5">
            {Object.entries(data.plansByStatus).length === 0 && (
              <p className="font-poppins text-[12px] text-muted-foreground">No plans yet.</p>
            )}
            {Object.entries(data.plansByStatus).map(([status, count]) => (
              <div key={status} className="flex items-center justify-between">
                <span className="font-poppins text-[12px] text-foreground">
                  {PLAN_STATUS_LABELS[status as AEPlanStatus] ?? status}
                </span>
                <span className="font-poppins text-[12px] font-semibold text-foreground">{count}</span>
              </div>
            ))}
          </div>
        </SectionCard>

        {/* Incidents */}
        <SectionCard title="Drift & Incidents" onViewAll={() => onNavigate("drift-incidents")}>
          {data.incidents.unresolvedCount === 0 ? (
            <p className="font-poppins text-[12px] text-muted-foreground">No unresolved incidents.</p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 font-poppins text-[12px] text-foreground">
                <ShieldAlert className="w-3.5 h-3.5 text-red-500" />
                {data.incidents.unresolvedCount} unresolved — {data.incidents.unknownCount} unknown,{" "}
                {data.incidents.driftedCount} drifted, {data.incidents.externalChangeCount} external change
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      {/* Recent activity */}
      <SectionCard title="Recent Activity">
        {data.recentActivity.length === 0 ? (
          <p className="font-poppins text-[12px] text-muted-foreground">No recent activity.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {data.recentActivity.map((event) => (
              <div key={event.id} className="flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="font-poppins text-[12px] text-foreground">{event.type.replace(/_/g, " ")}</span>
                  <span className="font-poppins text-[11px] text-muted-foreground">{event.actorLabel}</span>
                </div>
                <span className="flex items-center gap-1 font-poppins text-[11px] text-muted-foreground">
                  <Clock className="w-3 h-3" />
                  {new Date(event.at).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}