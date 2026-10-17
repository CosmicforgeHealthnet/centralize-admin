"use client";

import { useEffect, useState } from "react";
import { Settings2, AlertCircle, X, RefreshCcw } from "lucide-react";
import { useAIMarketingIntelligenceStore } from "@/stores/ai-marketing-intelligence.store";
import PermissionGate from "@/components/marketing/shared/PermissionGate";
import type { AMISettingKey, AMISettingRow } from "@/types/ai-marketing-intelligence.types";

const SETTING_GROUPS: { title: string; keys: AMISettingKey[] }[] = [
  { title: "Attribution", keys: ["attributionWindowDays"] },
  { title: "Analysis windows", keys: ["recommendationLookbackDays", "comparisonLookbackDays"] },
  {
    title: "Data sufficiency",
    keys: ["creativeMinimumImpressions", "minimumClicks", "minimumSignups", "minimumPayments", "minimumSpend"],
  },
  {
    title: "Performance rules",
    keys: ["targetCpa", "underperformThresholdPct", "scaleThresholdPct", "maximumRecommendedScalePct"],
  },
  { title: "Creative fatigue", keys: ["creativeFatigueThresholdPct"] },
  { title: "Alerts", keys: ["alertCooldownMinutes"] },
  { title: "Task workflow", keys: ["defaultMarketingAssigneeAdminUserId"] },
  {
    title: "Feature toggles",
    keys: ["creativeSyncEnabled", "recommendationEvaluationEnabled", "alertEvaluationEnabled", "llmCommentaryEnabled"],
  },
];

const SETTING_LABELS: Record<AMISettingKey, string> = {
  attributionWindowDays: "Attribution window (days)",
  recommendationLookbackDays: "Recommendation lookback (days)",
  comparisonLookbackDays: "Comparison lookback (days)",
  creativeMinimumImpressions: "Creative minimum impressions",
  minimumClicks: "Minimum clicks",
  minimumSignups: "Minimum signups",
  minimumPayments: "Minimum payments",
  minimumSpend: "Minimum spend",
  targetCpa: "Target CPA",
  underperformThresholdPct: "Underperform threshold",
  scaleThresholdPct: "Scale threshold",
  maximumRecommendedScalePct: "Maximum recommended scale",
  creativeFatigueThresholdPct: "Creative fatigue threshold",
  alertCooldownMinutes: "Alert cooldown (minutes)",
  defaultMarketingAssigneeAdminUserId: "Default Marketing assignee",
  creativeSyncEnabled: "Creative sync enabled",
  recommendationEvaluationEnabled: "Recommendation evaluation enabled",
  alertEvaluationEnabled: "Alert evaluation enabled",
  llmCommentaryEnabled: "LLM commentary enabled",
};

function SettingRow({
  row,
  isAdmin,
  onSave,
}: {
  row: AMISettingRow;
  isAdmin: boolean;
  onSave: (value: string | number | boolean | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(row.configuredValue === null ? "" : String(row.configuredValue));
  const [saving, setSaving] = useState(false);

  const isBoolean = typeof row.effectiveValue === "boolean" || typeof row.configuredValue === "boolean";

  const handleSave = async () => {
    setSaving(true);
    let value: string | number | boolean | null;
    if (isBoolean) value = draft === "true";
    else if (draft === "") value = null;
    else if (row.isPercentage) value = parseFloat(draft) / 100;
    else value = isNaN(Number(draft)) ? draft : Number(draft);
    await onSave(value);
    setSaving(false);
    setEditing(false);
  };

  const displayEffective = () => {
    if (row.effectiveValue === null || row.effectiveValue === undefined) return "Not configured";
    if (isBoolean) return row.effectiveValue ? "Enabled" : "Disabled";
    if (row.isPercentage) return `${(Number(row.effectiveValue) * 100).toFixed(0)}%`;
    if (row.isMonetary) return `${row.currency ?? ""} ${row.effectiveValue}`;
    return String(row.effectiveValue);
  };

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-3 border-b border-border/70 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="font-poppins text-[12px] font-medium text-foreground">{SETTING_LABELS[row.key]}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
          <span className={`font-poppins text-[13px] ${row.effectiveValue === null ? "text-muted-foreground italic" : "text-foreground"}`}>
            {displayEffective()}
          </span>
          <span className="font-poppins text-[10px] text-muted-foreground px-1.5 py-0.5 rounded-full bg-muted">
            from {row.effectiveSourceScope}
          </span>
        </div>
      </div>

      {!editing ? (
        <PermissionGate hasPermission={isAdmin} requiredGrant="EDIT + ADMIN">
          <button
            onClick={() => setEditing(true)}
            className="font-poppins text-[11px] font-medium text-primary hover:opacity-80 whitespace-nowrap shrink-0"
          >
            Edit
          </button>
        </PermissionGate>
      ) : (
        <div className="flex items-center gap-2 shrink-0">
          {isBoolean ? (
            <select
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-2 py-1.5"
            >
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
          ) : (
            <input
              value={row.isPercentage && draft !== "" ? String(Number(draft) * 100) : draft}
              onChange={(e) => setDraft(row.isPercentage ? String(Number(e.target.value) / 100) : e.target.value)}
              placeholder={row.isMonetary ? "Leave blank to clear" : ""}
              className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-2 py-1.5 w-28"
            />
          )}
          <button onClick={handleSave} disabled={saving} className="font-poppins text-[11px] font-medium px-2.5 py-1.5 rounded-[8px] bg-primary text-primary-foreground disabled:opacity-50">
            {saving ? "…" : "Save"}
          </button>
          <button onClick={() => setEditing(false)} className="font-poppins text-[11px] text-muted-foreground hover:text-foreground">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function VersionConflictModal({ onClose }: { onClose: () => void }) {
  const { settingConflict, clearSettingConflict } = useAIMarketingIntelligenceStore();
  if (!settingConflict) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-md bg-card rounded-[14px] border border-border shadow-xl">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h3 className="font-poppins text-[14px] font-semibold text-foreground">Setting Version Conflict</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" strokeWidth={2} />
          </button>
        </div>
        <div className="p-5 flex flex-col gap-3">
          <p className="font-poppins text-[12px] text-muted-foreground">
            This setting changed on the server since you loaded it. Review before reapplying your change.
          </p>
          <div className="rounded-[8px] border border-border bg-muted/30 p-3">
            <p className="font-poppins text-[11px] text-muted-foreground">Server value (v{settingConflict.serverVersion})</p>
            <p className="font-poppins text-[13px] font-medium text-foreground">{String(settingConflict.serverValue ?? "Not configured")}</p>
          </div>
          <div className="rounded-[8px] border border-primary/30 bg-primary/5 p-3">
            <p className="font-poppins text-[11px] text-muted-foreground">Your draft value</p>
            <p className="font-poppins text-[13px] font-medium text-foreground">{String(settingConflict.draftValue ?? "Not configured")}</p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-border">
          <button
            onClick={() => { clearSettingConflict(); onClose(); }}
            className="flex items-center gap-1.5 font-poppins text-[12px] font-medium px-3.5 py-2 rounded-[8px] border border-border text-foreground"
          >
            <RefreshCcw className="w-3.5 h-3.5" strokeWidth={2} /> Reload and retry
          </button>
        </div>
      </div>
    </div>
  );
}

interface SettingsControlsPageProps {
  isAdmin?: boolean; // EDIT + ADMIN grant — wire to real auth context when available
}

export default function SettingsControlsPage({ isAdmin = false }: SettingsControlsPageProps) {
  const { settings, isLoadingSettings, error, settingConflict, fetchSettings, updateSetting } =
    useAIMarketingIntelligenceStore();
  const clearSettingConflict = useAIMarketingIntelligenceStore((s) => s.clearSettingConflict);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const findRow = (key: AMISettingKey) => settings.find((s) => s.key === key);

  const handleSave = async (row: AMISettingRow, value: string | number | boolean | null) => {
    await updateSetting({
      key: row.key,
      scope: row.scope,
      platform: row.platform ?? undefined,
      connectionId: row.connectionId ?? undefined,
      currency: row.currency ?? undefined,
      value,
      expectedVersion: row.version,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Settings2 className="w-4 h-4 text-primary" strokeWidth={2} />
        <div>
          <h2 className="font-poppins text-[14px] font-semibold text-foreground">Settings & Controls</h2>
          <p className="font-poppins text-[11px] text-muted-foreground">
            Thresholds, scope overrides and feature toggles. Updates require EDIT + ADMIN.
          </p>
        </div>
      </div>

      {!isAdmin && (
        <div className="flex items-center gap-2 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" strokeWidth={2} />
          <p className="font-poppins text-[12px] text-amber-700">
            You can view current settings, but editing requires EDIT + ADMIN permission.
          </p>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" strokeWidth={2} />
          <p className="font-poppins text-[12px] text-red-700">{error}</p>
        </div>
      )}

      {isLoadingSettings && settings.length === 0 ? (
        <div className="flex flex-col gap-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-32 rounded-[10px] bg-muted animate-pulse" />)}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {SETTING_GROUPS.map((group) => (
            <div key={group.title} className="bg-card rounded-[10px] border border-border p-4 sm:p-5">
              <h3 className="font-poppins text-[13px] font-semibold text-foreground mb-1">{group.title}</h3>
              <div className="flex flex-col">
                {group.keys.map((key) => {
                  const row = findRow(key);
                  if (!row) return null;
                  return (
                    <SettingRow
                      key={key}
                      row={row}
                      isAdmin={isAdmin}
                      onSave={(value) => handleSave(row, value)}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {settingConflict && <VersionConflictModal onClose={clearSettingConflict} />}
    </div>
  );
}