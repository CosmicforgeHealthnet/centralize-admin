"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Pencil, ShieldCheck } from "lucide-react";
import { fetchAEPlanDetail } from "@/lib/advertising-execution.service";
import type { AEPlanDetail } from "@/types/advertising-execution.types";

interface PlanDetailPageProps {
  id: string;
  onBack: () => void;
  onEdit: () => void;
  onValidate: () => void;
}

export default function PlanDetailPage({ id, onBack, onEdit, onValidate }: PlanDetailPageProps) {
  const [plan, setPlan] = useState<AEPlanDetail | null>(null);

  useEffect(() => {
    let mounted = true;
    fetchAEPlanDetail(id).then((res) => {
      if (mounted) setPlan(res);
    });
    return () => {
      mounted = false;
    };
  }, [id]);

  if (!plan) {
    return <div className="h-40 rounded-[10px] bg-muted/40 animate-pulse" />;
  }

  const isDraft = plan.status === "DRAFT";

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Plans
      </button>

      <div className="flex items-start justify-between flex-wrap gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="font-poppins text-[15px] font-semibold text-foreground">{plan.name}</h2>
          <div className="flex items-center gap-2 font-poppins text-[11px] text-muted-foreground">
            <span>{plan.provider}</span>
            <span>·</span>
            <span>{plan.accountLabel ?? "No account"}</span>
            <span>·</span>
            <span>v{plan.version}</span>
            {plan.fingerprint && (
              <>
                <span>·</span>
                <span className="font-mono">{plan.fingerprint.slice(0, 8)}</span>
              </>
            )}
          </div>
        </div>
        <span className="inline-flex rounded-full px-2.5 py-1 font-poppins text-[11px] font-medium bg-muted text-muted-foreground">
          {plan.status.replace(/_/g, " ")}
        </span>
      </div>

      {plan.description && (
        <p className="font-poppins text-[12px] text-muted-foreground">{plan.description}</p>
      )}

      {/* Budget exposure */}
      {plan.budgetExposure.length > 0 && (
        <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-2">
          <h3 className="font-poppins text-[12px] font-semibold text-foreground">Budget Exposure</h3>
          {plan.budgetExposure.map((b, i) => (
            <div key={i} className="grid grid-cols-2 min-[600px]:grid-cols-4 gap-2">
              <div className="flex flex-col">
                <span className="font-poppins text-[10px] text-muted-foreground">Current</span>
                <span className="font-poppins text-[12px] text-foreground">{b.currentValue ?? "—"} {b.currency}</span>
              </div>
              <div className="flex flex-col">
                <span className="font-poppins text-[10px] text-muted-foreground">Proposed</span>
                <span className="font-poppins text-[12px] font-semibold text-foreground">{b.proposedValue} {b.currency}</span>
              </div>
              <div className="flex flex-col">
                <span className="font-poppins text-[10px] text-muted-foreground">Delta</span>
                <span className="font-poppins text-[12px] text-amber-600">
                  {b.deltaAbsolute ? `+${b.deltaAbsolute} (${(Number(b.deltaPct) * 100).toFixed(0)}%)` : "—"}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="font-poppins text-[10px] text-muted-foreground">Policy Cap</span>
                <span className="font-poppins text-[12px] text-foreground">{b.policyCap ?? "—"}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Plan items */}
      <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-2">
        <h3 className="font-poppins text-[12px] font-semibold text-foreground">Resource Hierarchy ({plan.items.length})</h3>
        {plan.items.map((item) => (
          <div key={item.id} className="flex items-center justify-between border-t border-border pt-2 first:border-t-0 first:pt-0">
            <div className="flex flex-col">
              <span className="font-poppins text-[12px] text-foreground">{item.clientReference}</span>
              <span className="font-poppins text-[10px] text-muted-foreground">{item.resourceType}</span>
            </div>
            <span className="font-poppins text-[11px] text-muted-foreground">{item.operationType}</span>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {isDraft && (
          <>
            <button
              onClick={onEdit}
              className="flex items-center gap-1.5 rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground hover:bg-muted/40"
            >
              <Pencil className="w-3.5 h-3.5" /> Edit Draft
            </button>
            <button
              onClick={onValidate}
              className="flex items-center gap-1.5 rounded-[8px] bg-primary px-4 py-2 font-poppins text-[12px] font-medium text-white"
            >
              <ShieldCheck className="w-3.5 h-3.5" /> Validate
            </button>
          </>
        )}
        {!isDraft && plan.validationCurrent && (
          <button
            onClick={onValidate}
            className="flex items-center gap-1.5 rounded-[8px] border border-border px-4 py-2 font-poppins text-[12px] font-medium text-foreground hover:bg-muted/40"
          >
            View Validation
          </button>
        )}
      </div>
    </div>
  );
}