"use client";

import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import { fetchAEPlans } from "@/lib/advertising-execution.service";
import type { AEPlanFilters, AEPlanListItem, AEPlanStatus, AEProvider, AESource } from "@/types/advertising-execution.types";

interface PlansListPageProps {
  onOpenPlan: (id: string) => void;
  onCreatePlan: () => void;
}

const STATUS_OPTIONS: Array<AEPlanStatus | "all"> = [
  "all", "DRAFT", "VALIDATING", "VALIDATED", "PENDING_APPROVAL", "APPROVED", "QUEUED",
  "EXECUTING", "PARTIAL_SUCCESS", "SUCCEEDED", "FAILED", "ROLLBACK_PENDING", "ROLLED_BACK",
  "ROLLBACK_FAILED", "CANCELLED", "EXPIRED",
];

const PROVIDER_OPTIONS: Array<AEProvider | "all"> = ["all", "META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"];
const SOURCE_OPTIONS: Array<AESource | "all"> = ["all", "MANUAL", "RECOMMENDATION", "COMPENSATION"];

function StatusBadge({ status }: { status: AEPlanStatus }) {
  const tone: Record<AEPlanStatus, string> = {
    DRAFT: "bg-muted text-muted-foreground",
    VALIDATING: "bg-blue-100 text-blue-700",
    VALIDATED: "bg-blue-100 text-blue-700",
    PENDING_APPROVAL: "bg-amber-100 text-amber-700",
    APPROVED: "bg-emerald-100 text-emerald-700",
    QUEUED: "bg-blue-100 text-blue-700",
    EXECUTING: "bg-blue-100 text-blue-700",
    PARTIAL_SUCCESS: "bg-amber-100 text-amber-700",
    SUCCEEDED: "bg-emerald-100 text-emerald-700",
    FAILED: "bg-red-100 text-red-700",
    ROLLBACK_PENDING: "bg-amber-100 text-amber-700",
    ROLLED_BACK: "bg-muted text-muted-foreground",
    ROLLBACK_FAILED: "bg-red-100 text-red-700",
    CANCELLED: "bg-muted text-muted-foreground",
    EXPIRED: "bg-muted text-muted-foreground",
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 font-poppins text-[10px] font-medium ${tone[status]}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export default function PlansListPage({ onOpenPlan, onCreatePlan }: PlansListPageProps) {
  const [plans, setPlans] = useState<AEPlanListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Partial<AEPlanFilters>>({
    provider: "all",
    status: "all",
    source: "all",
    search: "",
  });

  const updateFilters: typeof setFilters = (updater) => {
    setLoading(true);
    setFilters(updater);
  };

  useEffect(() => {
    let mounted = true;
    fetchAEPlans(filters).then((res) => {
      if (mounted) {
        setPlans(res);
        setLoading(false);
      }
    });
    return () => {
      mounted = false;
    };
  }, [filters]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="font-poppins text-[14px] font-semibold text-foreground">Plans</h2>
        <button
          onClick={onCreatePlan}
          className="flex items-center gap-1.5 rounded-[8px] bg-primary px-3 py-1.5 font-poppins text-[12px] font-medium text-white hover:opacity-90"
        >
          <Plus className="w-3.5 h-3.5" /> Create Plan
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-[8px] border border-border px-2.5 py-1.5">
          <Search className="w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={filters.search ?? ""}
            onChange={(e) => updateFilters((f) => ({ ...f, search: e.target.value }))}
            placeholder="Search plans..."
            className="font-poppins text-[12px] bg-transparent outline-none w-40"
          />
        </div>
        <select
          value={filters.provider}
          onChange={(e) => updateFilters((f) => ({ ...f, provider: e.target.value as AEProvider | "all" }))}
          className="rounded-[8px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card"
        >
          {PROVIDER_OPTIONS.map((p) => (
            <option key={p} value={p}>{p === "all" ? "All Providers" : p}</option>
          ))}
        </select>
        <select
          value={filters.status}
          onChange={(e) => updateFilters((f) => ({ ...f, status: e.target.value as AEPlanStatus | "all" }))}
          className="rounded-[8px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s === "all" ? "All Statuses" : s.replace(/_/g, " ")}</option>
          ))}
        </select>
        <select
          value={filters.source}
          onChange={(e) => updateFilters((f) => ({ ...f, source: e.target.value as AESource | "all" }))}
          className="rounded-[8px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card"
        >
          {SOURCE_OPTIONS.map((s) => (
            <option key={s} value={s}>{s === "all" ? "All Sources" : s}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="rounded-[10px] border border-border overflow-hidden">
        <table className="w-full">
          <thead className="bg-muted/40">
            <tr>
              {["Plan", "Provider", "Account", "Status", "Approval", "Items", "Updated"].map((h) => (
                <th key={h} className="text-left font-poppins text-[11px] font-medium text-muted-foreground px-3 py-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center font-poppins text-[12px] text-muted-foreground">
                  Loading...
                </td>
              </tr>
            ) : plans.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center font-poppins text-[12px] text-muted-foreground">
                  No plans match the current filters.
                </td>
              </tr>
            ) : (
              plans.map((plan) => (
                <tr
                  key={plan.id}
                  onClick={() => onOpenPlan(plan.id)}
                  className="border-t border-border hover:bg-muted/20 cursor-pointer"
                >
                  <td className="px-3 py-2.5">
                    <div className="flex flex-col">
                      <span className="font-poppins text-[12px] font-medium text-foreground">{plan.name}</span>
                      <span className="font-poppins text-[10px] text-muted-foreground">{plan.source}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 font-poppins text-[12px] text-foreground">{plan.provider}</td>
                  <td className="px-3 py-2.5 font-poppins text-[12px] text-muted-foreground">{plan.accountLabel ?? "—"}</td>
                  <td className="px-3 py-2.5"><StatusBadge status={plan.status} /></td>
                  <td className="px-3 py-2.5 font-poppins text-[12px] text-foreground">
                    {plan.approvalProgress ? `${plan.approvalProgress.approved}/${plan.approvalProgress.required}` : "—"}
                  </td>
                  <td className="px-3 py-2.5 font-poppins text-[12px] text-foreground">{plan.itemCount}</td>
                  <td className="px-3 py-2.5 font-poppins text-[11px] text-muted-foreground">
                    {new Date(plan.updatedAt).toLocaleDateString()}
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