"use client";

import { useState } from "react";
import type { AEBudgetExposure, AEBudgetType } from "@/types/advertising-execution.types";

interface BudgetConfigPanelProps {
  exposure: AEBudgetExposure;
  onChange: (exposure: AEBudgetExposure) => void;
  readOnly?: boolean;
}

const BUDGET_TYPES: AEBudgetType[] = ["DAILY", "LIFETIME", "TOTAL"];

export default function BudgetConfigPanel({ exposure, onChange, readOnly }: BudgetConfigPanelProps) {
  const [proposedValue, setProposedValue] = useState(exposure.proposedValue);
  const [budgetType, setBudgetType] = useState<AEBudgetType>(exposure.budgetType);

  const current = Number(exposure.currentValue ?? 0);
  const proposed = Number(proposedValue || 0);
  const delta = current > 0 ? ((proposed - current) / current) : null;
  const overCap = exposure.policyCap ? proposed > Number(exposure.policyCap) : false;

  const commit = (value: string, type: AEBudgetType) => {
    setProposedValue(value);
    setBudgetType(type);
    onChange({
      ...exposure,
      proposedValue: value,
      budgetType: type,
      deltaAbsolute: (Number(value || 0) - current).toFixed(2),
      deltaPct: current > 0 ? ((Number(value || 0) - current) / current).toFixed(2) : null,
    });
  };

  return (
    <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-3">
      <h3 className="font-poppins text-[12px] font-semibold text-foreground">Budget & Spend Configuration</h3>

      <div className="grid grid-cols-2 min-[600px]:grid-cols-3 gap-3">
        <div className="flex flex-col gap-1">
          <label className="font-poppins text-[10px] text-muted-foreground">Current Value</label>
          <span className="font-poppins text-[13px] font-medium text-foreground">
            {exposure.currentValue ?? "—"} {exposure.currency}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <label className="font-poppins text-[10px] text-muted-foreground">Proposed Value</label>
          <input
            value={proposedValue}
            disabled={readOnly}
            onChange={(e) => commit(e.target.value, budgetType)}
            className="rounded-[6px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card outline-none disabled:opacity-60"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="font-poppins text-[10px] text-muted-foreground">Budget Type</label>
          <select
            value={budgetType}
            disabled={readOnly}
            onChange={(e) => commit(proposedValue, e.target.value as AEBudgetType)}
            className="rounded-[6px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card disabled:opacity-60"
          >
            {BUDGET_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      </div>

      {delta !== null && (
        <div className={`font-poppins text-[12px] ${overCap ? "text-red-600" : "text-amber-600"}`}>
          Change: {delta >= 0 ? "+" : ""}{(delta * 100).toFixed(0)}% ({(proposed - current).toFixed(2)} {exposure.currency})
        </div>
      )}

      {exposure.policyCap && (
        <div className="font-poppins text-[11px] text-muted-foreground">
          Policy cap: {exposure.policyCap} {exposure.currency}
          {overCap && <span className="text-red-600 font-medium"> — exceeds cap, will block validation</span>}
        </div>
      )}

      {exposure.sharedBudgetImpact.length > 0 && (
        <div className="rounded-[8px] bg-amber-50 border border-amber-200 p-2.5">
          <span className="font-poppins text-[11px] text-amber-700">
            Shared budget impact: {exposure.sharedBudgetImpact.join(", ")}
          </span>
        </div>
      )}

      <p className="font-poppins text-[10px] text-muted-foreground">
        No FX conversion is performed. All values remain in the account&apos;s original currency.
      </p>
    </div>
  );
}