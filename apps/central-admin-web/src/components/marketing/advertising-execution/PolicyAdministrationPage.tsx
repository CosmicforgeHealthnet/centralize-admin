"use client";

import { useEffect, useState } from "react";
import { Power } from "lucide-react";
import { fetchAEKillSwitches, fetchAEPolicies, updateAEPolicy } from "@/lib/advertising-execution.service";
import type { AEKillSwitch, AEPolicyRow } from "@/types/advertising-execution.types";

interface PolicyAdministrationPageProps {
  onOpenOverride: () => void;
}

export default function PolicyAdministrationPage({ onOpenOverride }: PolicyAdministrationPageProps) {
  const [policies, setPolicies] = useState<AEPolicyRow[]>([]);
  const [killSwitches, setKillSwitches] = useState<AEKillSwitch[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState<string>("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    let mounted = true;
    Promise.all([fetchAEPolicies(), fetchAEKillSwitches()]).then(([p, k]) => {
      if (mounted) {
        setPolicies(p);
        setKillSwitches(k);
        setLoading(false);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const startEdit = (row: AEPolicyRow) => {
    setEditingKey(row.key);
    setDraftValue(String(row.configuredValue ?? ""));
    setReason("");
  };

  const saveEdit = async (row: AEPolicyRow) => {
    if (!reason.trim()) return;
    const updated = await updateAEPolicy({
      key: row.key,
      scope: row.scope,
      value: draftValue === "" ? null : isNaN(Number(draftValue)) ? draftValue : Number(draftValue),
      reason: reason.trim(),
      expectedVersion: row.version,
    });
    setPolicies((prev) => prev.map((p) => (p.key === row.key ? updated : p)));
    setEditingKey(null);
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-16 rounded-[10px] bg-muted/40 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h2 className="font-poppins text-[14px] font-semibold text-foreground">Policies & Controls</h2>
        <button
          onClick={onOpenOverride}
          className="rounded-[8px] border border-red-300 px-3 py-1.5 font-poppins text-[12px] font-medium text-red-700 hover:bg-red-50"
        >
          Emergency Override
        </button>
      </div>

      <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-2.5">
        <h3 className="font-poppins text-[12px] font-semibold text-foreground">Kill Switches</h3>
        {killSwitches.map((ks) => (
          <div key={`${ks.scope}-${ks.provider ?? "global"}`} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Power className={`w-3.5 h-3.5 ${ks.enabled ? "text-emerald-600" : "text-muted-foreground"}`} />
              <span className="font-poppins text-[12px] text-foreground">
                {ks.scope}{ks.provider ? ` — ${ks.provider}` : ""}
              </span>
            </div>
            <span className={`font-poppins text-[11px] font-medium ${ks.enabled ? "text-emerald-600" : "text-muted-foreground"}`}>
              {ks.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
        ))}
        <p className="font-poppins text-[10px] text-muted-foreground">
          Kill switch changes require EDIT + Execution Administrator and are versioned with a reason.
        </p>
      </div>

      <div className="rounded-[10px] border border-border bg-card p-4 flex flex-col gap-3">
        <h3 className="font-poppins text-[12px] font-semibold text-foreground">Effective Policy Values</h3>
        {policies.map((row) => (
          <div key={row.key} className="flex flex-col gap-2 border-t border-border pt-2.5 first:border-t-0 first:pt-0">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex flex-col">
                <span className="font-poppins text-[12px] font-medium text-foreground">{row.key}</span>
                <span className="font-poppins text-[10px] text-muted-foreground">
                  Scope: {row.effectiveSourceScope} · v{row.version}
                </span>
              </div>
              <span className="font-poppins text-[12px] text-foreground">
                Effective: {row.effectiveValue !== null ? String(row.effectiveValue) : "Not set"}
              </span>
            </div>

            {editingKey === row.key ? (
              <div className="flex flex-col gap-1.5">
                <input
                  value={draftValue}
                  onChange={(e) => setDraftValue(e.target.value)}
                  className="rounded-[6px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card outline-none"
                />
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason for this change (required)"
                  rows={2}
                  className="rounded-[6px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card outline-none resize-none"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => saveEdit(row)}
                    disabled={!reason.trim()}
                    className="rounded-[6px] bg-primary px-3 py-1.5 font-poppins text-[11px] font-medium text-white disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditingKey(null)}
                    className="rounded-[6px] border border-border px-3 py-1.5 font-poppins text-[11px] font-medium text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => startEdit(row)}
                className="font-poppins text-[11px] text-primary hover:underline w-fit"
              >
                Edit
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}