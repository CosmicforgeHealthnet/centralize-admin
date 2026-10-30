"use client";

import { useEffect, useState } from "react";
import { AlertOctagon } from "lucide-react";
import { fetchAEIncidents } from "@/lib/advertising-execution.service";
import type {
  AEIncidentClassification,
  AEIncidentFilters,
  AEIncidentListItem,
  AEIncidentSeverity,
  AEProvider,
} from "@/types/advertising-execution.types";

interface DriftIncidentListPageProps {
  onOpenIncident: (id: string) => void;
}

const CLASSIFICATION_OPTIONS: Array<AEIncidentClassification | "all"> = ["all", "DRIFTED", "UNKNOWN", "EXTERNAL_CHANGE"];
const SEVERITY_OPTIONS: Array<AEIncidentSeverity | "all"> = ["all", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
const PROVIDER_OPTIONS: Array<AEProvider | "all"> = ["all", "META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"];

function SeverityBadge({ severity }: { severity: AEIncidentSeverity }) {
  const tone: Record<AEIncidentSeverity, string> = {
    LOW: "bg-muted text-muted-foreground",
    MEDIUM: "bg-amber-100 text-amber-700",
    HIGH: "bg-orange-100 text-orange-700",
    CRITICAL: "bg-red-100 text-red-700",
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 font-poppins text-[10px] font-medium ${tone[severity]}`}>
      {severity}
    </span>
  );
}

function ClassificationBadge({ classification }: { classification: AEIncidentClassification }) {
  const tone: Record<AEIncidentClassification, string> = {
    DRIFTED: "bg-amber-100 text-amber-700",
    UNKNOWN: "bg-purple-100 text-purple-700",
    EXTERNAL_CHANGE: "bg-blue-100 text-blue-700",
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 font-poppins text-[10px] font-medium ${tone[classification]}`}>
      {classification.replace(/_/g, " ")}
    </span>
  );
}

export default function DriftIncidentListPage({ onOpenIncident }: DriftIncidentListPageProps) {
  const [incidents, setIncidents] = useState<AEIncidentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Partial<AEIncidentFilters>>({
    classification: "all",
    severity: "all",
    provider: "all",
    onlyUnresolved: true,
  });

  const updateFilters: typeof setFilters = (updater) => {
    setLoading(true);
    setFilters(updater);
  };

  useEffect(() => {
    let mounted = true;
    fetchAEIncidents(filters).then((res) => {
      if (mounted) {
        setIncidents(res);
        setLoading(false);
      }
    });
    return () => {
      mounted = false;
    };
  }, [filters]);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-poppins text-[14px] font-semibold text-foreground">Drift & Incidents</h2>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={filters.classification}
          onChange={(e) => updateFilters((f) => ({ ...f, classification: e.target.value as AEIncidentClassification | "all" }))}
          className="rounded-[8px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card"
        >
          {CLASSIFICATION_OPTIONS.map((c) => (
            <option key={c} value={c}>{c === "all" ? "All Classifications" : c.replace(/_/g, " ")}</option>
          ))}
        </select>
        <select
          value={filters.severity}
          onChange={(e) => updateFilters((f) => ({ ...f, severity: e.target.value as AEIncidentSeverity | "all" }))}
          className="rounded-[8px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card"
        >
          {SEVERITY_OPTIONS.map((s) => (
            <option key={s} value={s}>{s === "all" ? "All Severities" : s}</option>
          ))}
        </select>
        <select
          value={filters.provider}
          onChange={(e) => updateFilters((f) => ({ ...f, provider: e.target.value as AEProvider | "all" }))}
          className="rounded-[8px] border border-border px-2.5 py-1.5 font-poppins text-[12px] bg-card"
        >
          {PROVIDER_OPTIONS.map((p) => (
            <option key={p} value={p}>{p === "all" ? "All Providers" : p}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 font-poppins text-[12px] text-foreground">
          <input
            type="checkbox"
            checked={filters.onlyUnresolved}
            onChange={(e) => updateFilters((f) => ({ ...f, onlyUnresolved: e.target.checked }))}
          />
          Only unresolved
        </label>
      </div>

      {loading ? (
        <div className="flex flex-col gap-3">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="h-20 rounded-[10px] bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : incidents.length === 0 ? (
        <p className="font-poppins text-[12px] text-muted-foreground">No incidents match the current filters.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {incidents.map((incident) => (
            <button
              key={incident.id}
              onClick={() => onOpenIncident(incident.id)}
              className="text-left rounded-[10px] border border-border bg-card p-4 flex flex-col gap-2 hover:border-primary/40 transition-colors"
            >
              <div className="flex items-start justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <AlertOctagon className="w-4 h-4 text-red-500 shrink-0" />
                  <div className="flex flex-col">
                    <span className="font-poppins text-[12px] font-medium text-foreground">{incident.summary}</span>
                    <span className="font-poppins text-[11px] text-muted-foreground">
                      {incident.provider} · {incident.accountLabel ?? "No account"}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <ClassificationBadge classification={incident.classification} />
                  <SeverityBadge severity={incident.severity} />
                </div>
              </div>
              <div className="flex items-center gap-3 font-poppins text-[11px] text-muted-foreground">
                <span>{incident.ageMinutes}m old</span>
                <span>{incident.acknowledged ? "Acknowledged (not resolved)" : "Not acknowledged"}</span>
                {incident.compensationPlanId && <span>Compensation plan linked</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}