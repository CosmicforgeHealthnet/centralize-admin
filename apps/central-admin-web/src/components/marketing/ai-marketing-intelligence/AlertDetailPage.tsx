"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, AlertCircle } from "lucide-react";
import { useAIMarketingIntelligenceStore } from "@/stores/ai-marketing-intelligence.store";
import ProviderBadge, { type BadgeProvider } from "@/components/marketing/shared/ProviderBadge";
import StatusChip from "@/components/marketing/shared/StatusChip";
import EvidencePanel from "@/components/marketing/shared/EvidencePanel";

interface AlertDetailPageProps {
  id: string;
  onBack: () => void;
}

function severityTone(severity: string): "danger" | "warning" | "info" {
  if (severity === "CRITICAL") return "danger";
  if (severity === "WARNING") return "warning";
  return "info";
}

export default function AlertDetailPage({ id, onBack }: AlertDetailPageProps) {
  const {
    alertDetail,
    isLoadingAlertDetail,
    error,
    actionLoading,
    fetchAlertDetail,
    acknowledgeAlert,
    resolveAlert,
  } = useAIMarketingIntelligenceStore();

  const [showResolveForm, setShowResolveForm] = useState(false);
  const [resolveReason, setResolveReason] = useState("");

  useEffect(() => {
    fetchAlertDetail(id);
  }, [id, fetchAlertDetail]);

  if (isLoadingAlertDetail && !alertDetail) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-8 w-32 rounded bg-muted animate-pulse" />
        <div className="h-48 rounded-[10px] bg-muted animate-pulse" />
      </div>
    );
  }

  if (error && !alertDetail) {
    return (
      <div className="flex flex-col gap-3">
        <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={2} /> Back to Alerts
        </button>
        <div className="flex items-center gap-2 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" strokeWidth={2} />
          <p className="font-poppins text-[12px] text-red-700">{error}</p>
        </div>
      </div>
    );
  }

  if (!alertDetail) return null;
  const a = alertDetail;

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1.5 font-poppins text-[12px] text-muted-foreground hover:text-foreground w-fit">
        <ArrowLeft className="w-3.5 h-3.5" strokeWidth={2} /> Back to Alerts
      </button>

      {/* Header */}
      <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusChip status={a.severity} tone={severityTone(a.severity)} />
            <StatusChip status={a.status} />
          </div>
          {a.platform && <ProviderBadge provider={a.platform as BadgeProvider} />}
        </div>

        <div>
          <h2 className="font-poppins text-[15px] font-semibold text-foreground">{a.type.replace(/_/g, " ")}</h2>
          <p className="font-poppins text-[12px] text-muted-foreground mt-0.5">{a.message}</p>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-poppins text-muted-foreground">
          <span>Occurrences: {a.occurrenceCount}</span>
          <span>First triggered: {new Date(a.firstTriggeredAt).toLocaleString()}</span>
          <span>Last triggered: {new Date(a.lastTriggeredAt).toLocaleString()}</span>
          {a.cooldownUntil && <span>Cooldown until: {new Date(a.cooldownUntil).toLocaleString()}</span>}
        </div>
      </div>

      {/* Evidence */}
      <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-3">
        <h3 className="font-poppins text-[13px] font-semibold text-foreground">Evidence</h3>
        <EvidencePanel
          rows={Object.entries(a.evidence).map(([label, value]) => ({
            label: label.replace(/([A-Z])/g, " $1").trim(),
            value: value as string | number | null,
          }))}
        />
      </div>

      {/* Trigger history */}
      <div className="bg-card rounded-[10px] border border-border p-4 sm:p-5 flex flex-col gap-2">
        <h3 className="font-poppins text-[13px] font-semibold text-foreground">Trigger History</h3>
        <div className="flex flex-col gap-1.5">
          {a.triggerHistory.map((h, i) => (
            <div key={i} className="flex items-center justify-between gap-2 text-[11px] font-poppins">
              <span className="text-muted-foreground">{new Date(h.at).toLocaleString()}</span>
              <span className="text-foreground text-right">{h.note}</span>
            </div>
          ))}
        </div>
        <div className="pt-2 border-t border-border/70 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-poppins text-muted-foreground">
          <span>Notification: {a.notificationState}</span>
          <span>Auto-recovered: {a.autoRecovered ? "Yes" : "No"}</span>
        </div>
      </div>

      {/* Resolution info */}
      {a.status === "RESOLVED" && (
        <div className="rounded-[10px] border border-green-200 bg-green-50 px-4 py-3 flex flex-col gap-1">
          <p className="font-poppins text-[12px] text-green-800">
            Resolved {a.resolvedAt && `on ${new Date(a.resolvedAt).toLocaleString()}`} {a.resolvedBy && `by ${a.resolvedBy}`}
          </p>
          {a.resolutionReason && <p className="font-poppins text-[11px] text-green-700">{a.resolutionReason}</p>}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" strokeWidth={2} />
          <p className="font-poppins text-[12px] text-red-700">{error}</p>
        </div>
      )}

      {/* Actions */}
      {(a.status === "OPEN" || a.status === "ACKNOWLEDGED") && (
        <div className="flex flex-col sm:flex-row gap-2 sticky bottom-0 bg-background/95 backdrop-blur-sm py-3 border-t border-border sm:border-0 sm:bg-transparent sm:py-0">
          {a.status === "OPEN" && (
            <button
              onClick={() => acknowledgeAlert(a.id)}
              disabled={actionLoading === `ack-${a.id}`}
              className="font-poppins text-[12px] font-medium px-4 py-2.5 rounded-[8px] bg-primary text-primary-foreground disabled:opacity-50 flex-1 sm:flex-none"
            >
              {actionLoading === `ack-${a.id}` ? "Acknowledging…" : "Acknowledge"}
            </button>
          )}

          {!showResolveForm ? (
            <button
              onClick={() => setShowResolveForm(true)}
              className="font-poppins text-[12px] font-medium px-4 py-2.5 rounded-[8px] border border-border text-foreground hover:border-muted-foreground/40 flex-1 sm:flex-none"
            >
              Resolve
            </button>
          ) : (
            <div className="flex flex-col sm:flex-row gap-2 flex-1">
              <input
                value={resolveReason}
                onChange={(e) => setResolveReason(e.target.value)}
                placeholder="Resolution reason"
                className="font-poppins text-[12px] bg-card border border-border rounded-[8px] px-3 py-2.5 flex-1"
              />
              <button
                onClick={() => { resolveAlert(a.id, resolveReason || undefined); setShowResolveForm(false); }}
                disabled={actionLoading === `resolve-${a.id}`}
                className="font-poppins text-[12px] font-medium px-4 py-2.5 rounded-[8px] bg-primary text-primary-foreground disabled:opacity-50"
              >
                Confirm resolve
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}